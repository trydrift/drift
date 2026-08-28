import semver from 'semver';

import { fetchText } from '../util/http.js';
import { readComputed, writeComputed } from '../util/artifact-cache.js';

/**
 * Rust toolchain (`rustup`) channel syntax.
 *
 * A `rust-toolchain.toml` `channel`, a `rust-toolchain` file, or a CI matrix
 * entry can say `1.75.0`, `stable`, `beta`, `nightly`, or a *dated* nightly
 * like `nightly-2025-11-12`. The generic semver runtime comparator can read
 * only the first form; the rest all fell through to `runtimeCompatibility:
 * unknown`, which then contaminated the severity of every dependency in the
 * recording.
 *
 * This module classifies the spec and, for a dated nightly, resolves the real
 * `rustc` semantic version from Rust's *immutable* per-day distribution
 * manifest — never by approximating it from the calendar date.
 */

export type RustToolchainSpec =
  | { kind: 'exact'; version: string }
  /** `nightly-YYYY-MM-DD` — resolvable from that day's frozen manifest. */
  | { kind: 'dated-nightly'; date: string }
  /** A bare moving channel Drift will not pretend to pin. */
  | { kind: 'moving-stable' }
  | { kind: 'moving-beta' }
  | { kind: 'moving-nightly' }
  | { kind: 'unknown' };

const DATED_NIGHTLY = /^nightly-(\d{4}-\d{2}-\d{2})$/;
const DATED_BETA = /^beta-(\d{4}-\d{2}-\d{2})$/;

/**
 * Classify a rustup toolchain spec.
 *
 * Leading/trailing whitespace and an optional host triple suffix
 * (`nightly-2025-11-12-x86_64-unknown-linux-gnu`) are tolerated: only the
 * channel part decides the kind.
 */
export function classifyRustToolchain(raw: string): RustToolchainSpec {
  const spec = raw.trim().replace(/^rust-/i, '');
  if (!spec) return { kind: 'unknown' };

  const datedNightly = DATED_NIGHTLY.exec(stripHostTriple(spec, 'nightly'));
  if (datedNightly) return { kind: 'dated-nightly', date: datedNightly[1]! };

  // A dated beta is a moving target between point releases — the manifest for
  // that day exists, but "beta" is not a version a dependency's MSRV is ever
  // written against. Treated as the moving beta channel.
  if (DATED_BETA.test(stripHostTriple(spec, 'beta'))) return { kind: 'moving-beta' };

  if (/^stable$/i.test(spec) || /^stable-/i.test(spec)) return { kind: 'moving-stable' };
  if (/^beta$/i.test(spec) || /^beta-/i.test(spec)) return { kind: 'moving-beta' };
  if (/^nightly$/i.test(spec) || /^nightly-/i.test(spec)) return { kind: 'moving-nightly' };

  const exact = normalizeExact(spec);
  if (exact) return { kind: 'exact', version: exact };

  return { kind: 'unknown' };
}

function stripHostTriple(spec: string, channel: 'nightly' | 'beta'): string {
  const m = new RegExp(`^(${channel}(?:-\\d{4}-\\d{2}-\\d{2})?)`).exec(spec);
  return m ? m[1]! : spec;
}

/** `1.75`, `1.75.0`, `1.75.0-x86_64-...` -> a clean semver, else null. */
function normalizeExact(spec: string): string | null {
  const head = spec.split(/-(?=[a-z])/i)[0]!.trim();
  if (semver.valid(head)) return head;
  if (/^\d+\.\d+$/.test(head)) return `${head}.0`;
  return null;
}

/* ------------------------------------------------------------------ */
/* Dated-nightly resolution                                            */
/* ------------------------------------------------------------------ */

/** Per-process memo. `null` marks a lookup that failed this run (stays retryable). */
const nightlyMemo = new Map<string, string | null>();

const MANIFEST_URL = (date: string): string =>
  `https://static.rust-lang.org/dist/${date}/channel-rust-nightly.toml`;

const diskKey = (date: string): string => `rust-nightly-version:v1:${date}`;

/**
 * The `rustc` semantic version a dated nightly shipped, from that day's frozen
 * manifest — cached indefinitely (the manifest is immutable). `null` on any
 * network failure, which the caller keeps as `unknown` rather than guessing.
 */
export async function resolveDatedNightly(date: string): Promise<string | null> {
  if (nightlyMemo.has(date)) return nightlyMemo.get(date) ?? null;

  const cached = await readComputed<{ version: string }>(diskKey(date));
  if (cached?.version) {
    nightlyMemo.set(date, cached.version);
    return cached.version;
  }

  let toml: string | null = null;
  try {
    toml = await fetchText(MANIFEST_URL(date), { immutable: true, retries: 1 });
  } catch {
    toml = null;
  }
  const version = toml ? rustcVersionFromManifest(toml) : null;

  nightlyMemo.set(date, version);
  if (version) await writeComputed(diskKey(date), { version });
  return version;
}

/** The already-resolved version for a dated nightly, without touching the network. */
export function datedNightlyFromMemo(date: string): string | null {
  return nightlyMemo.get(date) ?? null;
}

/** Test seam. */
export function clearRustRuntimeMemo(): void {
  nightlyMemo.clear();
}

/**
 * `[pkg.rust] version = "1.86.0-nightly (bef3c3b01 2025-01-16)"` -> `1.86.0`.
 *
 * Read out of the `[pkg.rust]` table specifically; other tables in the
 * manifest (`pkg.cargo`, `pkg.rustfmt`) carry their own `version` keys.
 */
export function rustcVersionFromManifest(toml: string): string | null {
  const table = /\[pkg\.rust\]([\s\S]*?)(?:\n\[|$)/.exec(toml);
  if (!table) return null;
  const version = /(?:^|\n)\s*version\s*=\s*"([^"]+)"/.exec(table[1]!);
  if (!version) return null;
  const semverPart = /^\d+\.\d+\.\d+/.exec(version[1]!.trim());
  return semverPart ? semverPart[0] : null;
}

/* ------------------------------------------------------------------ */
/* Comparison-version resolution                                       */
/* ------------------------------------------------------------------ */

export interface RustComparisonVersion {
  /** A concrete semver to feed the existing comparator, or `null` if none. */
  version: string | null;
  /** Why there is no comparison version, for the honest `unknown` path. */
  reason?: 'moving-channel' | 'unresolved-nightly' | 'unparseable';
}

/**
 * Map a rustup toolchain spec to the concrete compiler version the existing
 * semantic-version machinery should compare against. Never hits the network —
 * a dated nightly must have been warmed by {@link resolveDatedNightly} first.
 */
export function rustComparisonVersion(raw: string): RustComparisonVersion {
  const spec = classifyRustToolchain(raw);
  switch (spec.kind) {
    case 'exact':
      return { version: spec.version };
    case 'dated-nightly': {
      const resolved = datedNightlyFromMemo(spec.date);
      return resolved ? { version: resolved } : { version: null, reason: 'unresolved-nightly' };
    }
    case 'moving-stable':
    case 'moving-beta':
    case 'moving-nightly':
      return { version: null, reason: 'moving-channel' };
    default:
      return { version: null, reason: 'unparseable' };
  }
}

/**
 * Warm the dated-nightly cache for every Rust toolchain spec in `specs`.
 * Called from the async analysis pass so the synchronous compatibility check
 * downstream can resolve them from memory.
 */
export async function warmRustDatedNightlies(specs: Iterable<string>): Promise<void> {
  const dates = new Set<string>();
  for (const spec of specs) {
    const classified = classifyRustToolchain(spec);
    if (classified.kind === 'dated-nightly') dates.add(classified.date);
  }
  await Promise.all([...dates].map((date) => resolveDatedNightly(date)));
}
