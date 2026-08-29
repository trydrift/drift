import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Exec } from '../../util/exec.js';
import { readComputed, writeComputed } from '../../util/artifact-cache.js';
import { diffSurfaces, type SurfaceApi, type SurfaceEntry, type SurfaceKind } from '../type-surface.js';
import {
  unavailable,
  tryAutoInstall,
  type SurfaceProvider,
  type SurfaceRequest,
  type SurfaceOutcome,
} from './types.js';

/* ------------------------------------------------------------------ */
/* Cargo package-cache contention control                              */
/* ------------------------------------------------------------------ */

/**
 * How many `cargo public-api` probes may run at once, process-wide.
 *
 * The scratch crate directories are isolated, but `$CARGO_HOME` — the registry
 * index and the downloaded-crate cache — is shared, and two `cargo` processes
 * writing it race on a file lock (`Blocking waiting for file lock on package
 * cache`). Drift was creating that contention itself by running the old and
 * new probes for the same crate simultaneously, and several crates' probes on
 * top of that. One at a time removes the self-inflicted lock fight without
 * touching global scan concurrency: all the network/evidence work for other
 * packages keeps overlapping, only the Cargo builds serialize.
 */
const CARGO_SURFACE_CONCURRENCY = 1;

/** Bounded retries for a probe that lost a package-cache lock race to an external cargo. */
const MAX_CONTENTION_RETRIES = 3;
const CONTENTION_BACKOFF_MS = 750;

/** Bump when anything in `parseCargoPublicApi` or the probe invocation changes the surface. */
const RUST_SURFACE_CACHE_VERSION = 1;

let activeCargoProbes = 0;
const cargoQueue: Array<() => void> = [];

/**
 * Acquire one Cargo-probe permit; returns the release function.
 *
 * The permit count is only ever changed by a caller that genuinely *enters*
 * with a free permit, or one that *leaves* with nobody waiting. On release
 * with a waiter, the permit is handed straight to that waiter and the count is
 * left untouched — there is no transient "free" state for a third caller to
 * observe between the release and the waiter resuming. A queued caller has
 * therefore already been given its permit by the time its promise resolves,
 * and must not increment the count again.
 */
export async function acquireCargoSlot(): Promise<() => void> {
  if (activeCargoProbes < CARGO_SURFACE_CONCURRENCY) {
    activeCargoProbes += 1;
  } else {
    await new Promise<void>((resolve) => cargoQueue.push(resolve));
    // The releasing probe transferred its permit to us; the count is unchanged.
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = cargoQueue.shift();
    if (next) {
      next(); // hand this permit directly to the next waiter; count stays put
    } else {
      activeCargoProbes -= 1;
    }
  };
}

/**
 * Is this failure Cargo losing a package-cache lock race — infrastructure, and
 * retryable — rather than a real build or toolchain error?
 *
 * A genuine compile failure can *also* print the blocking line (cargo waited,
 * got the lock, then failed to compile), so the presence of any real-error
 * marker disqualifies it.
 */
export function isCargoLockContention(stderr: string): boolean {
  if (!/waiting for file lock on (?:package cache|build directory|the registry index)/i.test(stderr)) {
    return false;
  }
  return !/error\[E\d+\]|could not compile|error: could not|linking with|error: linker|failed to run custom build|toolchain '[^']*' is not installed/i.test(
    stderr,
  );
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rust public-API diffing via `cargo public-api`.
 *
 * `cargo public-api` reads rustdoc's JSON output, which is the compiler's own
 * account of what a crate exports — the Rust equivalent of a `.d.ts`, and for
 * the same reason the strongest evidence available. Drift shells out to it
 * rather than reimplementing it: rustdoc JSON is unstable and version-tied, and
 * a half-correct reimplementation would produce confident wrong answers.
 *
 * Each version is built in a throwaway crate that depends on it, because the
 * old version is by definition no longer what `Cargo.toml` asks for.
 */

const TOOL = 'cargo public-api';
const CARGO_REMEDY = 'Install Rust and Cargo with rustup, or make sure `cargo` is on PATH.';
const PUBLIC_API_INSTALL = {
  id: 'cargo-public-api',
  label: 'Install cargo-public-api',
  command: 'cargo',
  // --locked pins to the published lockfile so an unrelated dependency bump
  // (e.g. cargo-util raising its MSRV) can't break installs on older rustc.
  args: ['install', 'cargo-public-api', '--locked'],
} as const;
const PUBLIC_API_REMEDY = 'Drift can install the missing `cargo-public-api` helper for you after approval.';
const NIGHTLY_INSTALL = {
  id: 'rustup-nightly',
  label: 'Install the Rust nightly toolchain',
  command: 'rustup',
  args: ['toolchain', 'install', 'nightly', '--profile', 'minimal'],
} as const;
// `cargo public-api` reads rustdoc's unstable `-Z unstable-options --output-format json`,
// which only nightly rustc emits, so the nightly toolchain is a hard requirement of the
// tool itself, not of the crate being probed.
const NIGHTLY_REMEDY =
  'Drift can install the Rust nightly toolchain for you after approval, or run `rustup toolchain install nightly` yourself.';

export const rustSurface: SurfaceProvider = {
  ecosystem: 'cargo',
  tool: TOOL,
  weight: 1.0,

  async compute(request: SurfaceRequest): Promise<SurfaceOutcome> {
    // Every version probe that decides the analyzer identity has to resolve the
    // *same* toolchain the real `cargo public-api` build will. That build runs
    // in `request.workdir/probe-<version>` with `request.env`; rustup picks a
    // toolchain from the process cwd (a `rust-toolchain`/`rust-toolchain.toml`
    // or a directory override), so an identity probe run from Drift's own cwd —
    // typically the repository root — can name a different compiler than the one
    // that actually emits the rustdoc JSON. `request.workdir` is Drift's own
    // mkdtemp directory and the parent of every `probe-<version>` dir, so it
    // shares their toolchain selection and carries no repo-local override.
    const idCwd = request.workdir;
    const idStdout = (command: string, args: readonly string[]): Promise<string | null> =>
      commandStdout(request.exec, command, args, request.env, idCwd);
    const idWorks = (command: string, args: readonly string[]): Promise<boolean> =>
      commandWorks(request.exec, command, args, request.env, idCwd);

    const cargoVersion = await idStdout('cargo', ['--version']);
    if (cargoVersion === null) {
      return unavailable(
        TOOL,
        'tool-missing',
        `The Rust Cargo toolchain is not installed or is not on PATH, so ${request.name}'s public API could not be compared directly.`,
        CARGO_REMEDY,
      );
    }

    let cpaVersion = await idStdout('cargo', ['public-api', '--version']);
    if (cpaVersion === null) {
      const installed =
        (await tryAutoInstall(request, PUBLIC_API_INSTALL)) &&
        ((cpaVersion = await idStdout('cargo', ['public-api', '--version'])) !== null);
      if (!installed) {
        return unavailable(
          TOOL,
          'tool-missing',
          `Rust and Cargo are installed, but Drift's Rust API helper is missing. ${request.name}'s public API could not be compared directly.`,
          PUBLIC_API_REMEDY,
          PUBLIC_API_INSTALL,
        );
      }
    }

    // `cargo public-api` builds rustdoc JSON with a nightly compiler, but *which*
    // one is decided the same way `cargo-public-api` itself decides it, from the
    // active `cargo --version` (resolved above under the probe's own cwd/env):
    //
    //   - the active build is recognisably stable (`cargo 1.x`, no `nightly`
    //     in the string) -> `cargo-public-api` shells out to the `nightly`
    //     rustup alias, so the compiler identity is a *moving* target that
    //     `rustup run nightly rustc --version` reports;
    //   - the active build carries `nightly` in its version -> `cargo-public-api`
    //     stays on the active toolchain, so the compiler is the pinned
    //     `rustc --version` under the same cwd/env, and the moving `nightly`
    //     alias is irrelevant;
    //   - anything else (an unmodelled version string, e.g. a future `cargo 2`)
    //     -> Drift cannot prove which compiler the tool will pick, so it runs
    //     the probe but does not persist a cache entry keyed on a guess.
    //
    // Keying the surface cache on the wrong one either never invalidates when
    // the real compiler rolled (active nightly, alias read) or needlessly
    // invalidates when only the unused alias rolled.
    const activeCargoIsProbablyStable = /^cargo 1\b/.test(cargoVersion) && !/nightly/.test(cargoVersion);
    const activeCargoIsNightly = /nightly/.test(cargoVersion);
    let compilerVersion: string | null = null;
    let compilerTag = 'nightly';
    if (activeCargoIsNightly) {
      compilerTag = 'active';
      compilerVersion = await idStdout('rustc', ['--version']);
      // `rustc` missing under an active nightly `cargo` should not happen, but
      // if it does the identity is unprovable — degrade caching, not evidence.
    } else if (activeCargoIsProbablyStable && (await idWorks('rustup', ['--version']))) {
      // Only rustup-managed installs can be checked/fixed here; a nightly toolchain
      // installed some other way (e.g. a distro package) is invisible to `rustup` but
      // still works, so its absence is not treated as a failure on its own.
      compilerVersion = await idStdout('rustup', ['run', 'nightly', 'rustc', '--version']);
      if (compilerVersion === null) {
        const installed =
          (await tryAutoInstall(request, NIGHTLY_INSTALL)) &&
          ((compilerVersion = await idStdout('rustup', ['run', 'nightly', 'rustc', '--version'])) !== null);
        if (!installed) {
          return unavailable(
            TOOL,
            'tool-missing',
            `\`cargo public-api\` needs the Rust nightly toolchain to read rustdoc's JSON output, and it is not installed. ${request.name}'s public API could not be compared directly.`,
            NIGHTLY_REMEDY,
            NIGHTLY_INSTALL,
          );
        }
      }
    }
    // else: stable `cargo` with no `rustup` on PATH, or a `cargo` version string
    // Drift does not model — the probe is allowed to run, but Drift cannot name
    // the compiler it builds with, so `compilerVersion` stays `null`.

    // Everything that decides what a probe produces, so a cached surface from an
    // older analyzer is never reused: the `cargo public-api` build, the nightly
    // rustc that emits the rustdoc JSON it reads, and this parser's own version.
    // (The crate name and exact version are added per probe below.)
    //
    // `compilerVersion` is `null` only when the compiler identity cannot be
    // proven (no `rustup` and a stable `cargo`, or a missing `rustc` under an
    // active nightly). An unprovable identity must degrade caching, never
    // evidence — so `analyzerId` is `null` and the persistent surface cache is
    // switched off for this probe rather than keyed on a guessed identity.
    const analyzerId =
      cpaVersion === null || compilerVersion === null
        ? null
        : [`cpa=${cpaVersion}`, `${compilerTag}=${compilerVersion}`, `parser=${RUST_SURFACE_CACHE_VERSION}`].join(
            '|',
          );

    const beforePromise = surfaceOf(request, request.from, analyzerId);
    const afterPromise = surfaceOf(request, request.to, analyzerId);
    afterPromise.catch(() => undefined);
    const before = await beforePromise;
    if (!before.ok) return before.failure;
    const after = await afterPromise;
    if (!after.ok) return after.failure;

    return {
      available: true,
      changes: diffSurfaces(before.api, after.api),
      tool: TOOL,
      weight: 1.0,
      locator: `${request.name} ${request.from} → ${request.to} (rustdoc JSON)`,
    };
  },
};

type SurfaceAttempt = { ok: true; api: SurfaceApi } | { ok: false; failure: SurfaceOutcome };

async function surfaceOf(
  request: SurfaceRequest,
  version: string,
  analyzerId: string | null,
): Promise<SurfaceAttempt> {
  const dir = join(request.workdir, `probe-${version}`);

  // `null` when the compiler identity behind `cargo public-api` could not be
  // established (see `analyzerId` above). No key means no persistent read and
  // no persistent write: the probe still runs and still returns a real surface,
  // it just is not remembered across invocations.
  const cacheKey =
    analyzerId === null
      ? null
      : `rust-surface:v${RUST_SURFACE_CACHE_VERSION}:${request.name}@${version}#${analyzerId}`;

  // A published crate version is immutable, and so is the analyzer identity in
  // the key, so a previously computed surface can be replayed without a build.
  // Only *successful* surfaces are ever written, so a hit is always real.
  if (cacheKey) {
    const cached = await readComputed<[string, SurfaceEntry][]>(cacheKey);
    if (cached && cached.length > 0) return { ok: true, api: new Map(cached) };
  }

  try {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'Cargo.toml'), probeManifest(request.name, version), 'utf8');
    await writeFile(join(dir, 'src', 'lib.rs'), '', 'utf8');
  } catch (err) {
    return {
      ok: false,
      failure: unavailable(TOOL, 'toolchain-failed', `Could not prepare a scratch crate: ${(err as Error).message}`),
    };
  }

  // Immutable downloaded crates stay in the shared `$CARGO_HOME` cache (safe
  // once the probe pool serializes the writers); mutable build output goes in
  // this probe's own directory so two probes never stomp each other's target.
  const baseEnv = request.env ?? process.env;
  const probeEnv: NodeJS.ProcessEnv = { ...baseEnv, CARGO_TARGET_DIR: join(dir, 'target') };

  const deadline = Date.now() + request.timeoutMs;
  const outOfTime = (): SurfaceAttempt => ({
    ok: false,
    failure: unavailable(
      TOOL,
      'toolchain-failed',
      `\`cargo public-api\` on ${request.name} ${version} ran out of time waiting for the Cargo package-cache lock.`,
    ),
  });

  let result!: Awaited<ReturnType<Exec>>;
  for (let attempt = 0; ; attempt += 1) {
    if (deadline - Date.now() <= 0) return outOfTime();

    const release = await acquireCargoSlot();
    let releasedForTimeout = false;
    try {
      // The slot wait consumed the same one deadline. Recompute after
      // acquisition: a probe that queued behind a long-running one and only got
      // the slot after its budget expired must return the timeout, never spawn
      // Cargo with a stale or negative window.
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        release();
        releasedForTimeout = true;
        return outOfTime();
      }

      result = await request.exec(
        'cargo',
        ['public-api', '--simplified', '--package', request.name],
        { cwd: dir, timeoutMs: remaining, env: probeEnv },
      );
    } finally {
      if (!releasedForTimeout) release();
    }

    if (result.code === 0) break;

    // Cargo lost a package-cache lock race to some *other* cargo process (the
    // pool prevents Drift racing itself). Retryable infrastructure, bounded,
    // and only while the caller's own budget still allows it.
    if (
      attempt < MAX_CONTENTION_RETRIES &&
      isCargoLockContention(result.stderr) &&
      Date.now() + CONTENTION_BACKOFF_MS < deadline
    ) {
      await delay(CONTENTION_BACKOFF_MS);
      continue;
    }
    break;
  }

  if (result.code !== 0) {
    // A crate that cannot be resolved at all is a different fact from one that
    // fails to build, and a developer acts on them differently.
    const missing = /could not find|no matching package|failed to select a version/i.test(result.stderr);
    // Caught proactively in `compute` when rustup is present; this is the fallback for
    // rustup being absent or the check having raced an uninstall, so the developer still
    // gets an actionable message instead of raw rustup stderr.
    const nightlyMissing = /toolchain '[^']*nightly[^']*' is not installed/i.test(result.stderr);
    return {
      ok: false,
      failure: nightlyMissing
        ? unavailable(
            TOOL,
            'tool-missing',
            `\`cargo public-api\` needs the Rust nightly toolchain to read rustdoc's JSON output, and it is not installed.`,
            NIGHTLY_REMEDY,
            NIGHTLY_INSTALL,
          )
        : unavailable(
            TOOL,
            missing ? 'version-unavailable' : 'toolchain-failed',
            missing
              ? `crates.io has no ${request.name} ${version}; it may have been yanked, or the crate may be private.`
              : `\`cargo public-api\` failed on ${request.name} ${version}: ${summarizeCargoFailure(result.stderr)}`,
          ),
    };
  }

  const api = parseCargoPublicApi(result.stdout);
  if (api.size === 0) {
    // Not cached: an empty result here is "the tool read nothing", which is a
    // failure state, not a surface. Caching it would freeze that failure in.
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'no-public-surface',
        `${request.name} ${version} exposes no public items that \`cargo public-api\` could read.`,
      ),
    };
  }

  if (cacheKey) await writeComputed(cacheKey, [...api]);
  return { ok: true, api };
}

function probeManifest(name: string, version: string): string {
  return [
    '[package]',
    'name = "drift-surface-probe"',
    'version = "0.0.0"',
    'edition = "2021"',
    '',
    '[dependencies]',
    // `=` pins exactly. Without it cargo is free to resolve a compatible
    // version and we would diff something we did not ask for.
    `${escapeToml(name)} = "=${escapeToml(version)}"`,
    '',
    '[workspace]',
  ].join('\n');
}

/** Cargo item kinds, mapped onto the shared surface vocabulary. */
const KINDS: Record<string, SurfaceKind> = {
  fn: 'function',
  struct: 'class',
  enum: 'enum',
  trait: 'interface',
  type: 'type',
  const: 'variable',
  static: 'variable',
  mod: 'namespace',
  union: 'class',
  macro: 'function',
};

/**
 * Parse `cargo public-api` output into the shared surface shape.
 *
 * Each line is one public item, written as Rust: `pub fn serde_json::from_str
 * <'a, T>(s: &'a str) -> Result<T>`. The path is the identity and the rest is
 * the signature, so a changed parameter list is a changed signature and a
 * vanished path is a removed export — the same two facts the `.d.ts` diff
 * reports, which is what lets `analyze` stay ecosystem-blind.
 *
 * Impl blocks are attributed to their type, so a removed method shows up as a
 * member removal on the type rather than as an unrelated export.
 */
export function parseCargoPublicApi(output: string, into: SurfaceApi = new Map()): SurfaceApi {
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line || !line.startsWith('pub ')) continue;

    const match = /^pub\s+(?:unsafe\s+|async\s+|extern\s+"[^"]*"\s+)*([a-z]+)\s+(.+)$/.exec(line);
    if (!match) continue;

    const kind = KINDS[match[1]!];
    if (!kind) continue;

    const path = itemPath(match[2]!);
    if (!path) continue;

    // An item under a *type* is one of its methods or associated items; an item
    // under a module is an export in its own right. Folding the second into the
    // first would lose every free function in the crate.
    const parent = into.get(ownerOf(path) ?? '');
    if (parent && parent.kind !== 'namespace') {
      const member = path.slice(parent.name.length + 2);
      if (!parent.members.includes(member)) parent.members.push(member);
      continue;
    }

    const existing = into.get(path);
    if (existing) {
      // Trait impls and inherent impls produce several lines per path; joining
      // them means losing one is visible as a signature change.
      existing.signature = `${existing.signature} | ${line}`;
      continue;
    }

    into.set(path, { name: path, kind, signature: line, members: [], requiredMembers: [] } satisfies SurfaceEntry);
  }

  return into;
}

/** `serde::de::from_str<'a, T>(s: &str)` -> `serde::de::from_str`. */
function itemPath(rest: string): string | null {
  // Matched rather than split, because `::` is part of the path while a single
  // `:` starts a type annotation.
  return /^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*/.exec(rest)?.[0] ?? null;
}

/** The path one level up, when it is a type we already recorded. */
function ownerOf(path: string): string | null {
  const at = path.lastIndexOf('::');
  return at === -1 ? null : path.slice(0, at);
}

function escapeToml(value: string): string {
  return value.replace(/["\\]/g, '');
}

/**
 * Cargo narrates its progress on stderr before it says anything useful, so the
 * first line of a failed run is almost always `Updating crates.io index`.
 * Reporting that as the reason a crate could not be analysed told the
 * developer nothing and, worse, read as though fetching the index were the
 * failure.
 */
const CARGO_PROGRESS =
  /^(Updating|Downloading|Downloaded|Compiling|Checking|Building|Blocking|Waiting|Adding|Locking|Installing|Fresh|Finished|Ignored|Removing|Unpacking|Verifying)\b/i;

/**
 * Causal diagnostics, most specific first. The first pattern that matches any
 * line wins, so a concrete `error[E0433]` outranks the generic `error: could
 * not compile ... due to 3 previous errors` summary Cargo prints after it.
 */
const CARGO_CAUSES: readonly RegExp[] = [
  /^error\[E\d+\]/i,
  /failed to select a version/i,
  /no matching package/i,
  /failed to run custom build command/i,
  /requires rustc |rust-version|package requires.*rustc/i,
  /linking with .* failed|error: linker|cannot find -l/i,
  /feature .*(?:not found|does not exist|is not available)|does not have (?:the )?feature/i,
  /^error: could not find/i,
  /^error:/i,
  /could not compile/i,
];

/**
 * The one or two lines that actually explain a failed Cargo run.
 *
 * Full stderr is still carried in the run diagnostics; this is only what the
 * developer is shown in place of the failure.
 */
export function summarizeCargoFailure(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return 'no output';

  for (const pattern of CARGO_CAUSES) {
    const index = lines.findIndex((line) => pattern.test(line));
    if (index === -1) continue;
    const cause = lines[index]!;
    // A location or `caused by` line immediately after the diagnostic is the
    // other half of the same sentence; anything else is noise.
    const detail = lines[index + 1];
    return detail && /^(-->|caused by:)/i.test(detail) ? `${cause} ${detail}` : cause;
  }

  // Nothing causal was printed. The last substantive line is a better account
  // than the first progress line; if the run really only ever narrated
  // progress, that narration is the honest answer.
  return lines.filter((line) => !CARGO_PROGRESS.test(line)).at(-1) ?? lines[0]!;
}

async function commandWorks(
  exec: Exec,
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<boolean> {
  const result = await exec(command, args, { timeoutMs: 20_000, env, cwd });
  return result.failure !== 'not-found' && result.code === 0;
}

/**
 * Trimmed stdout of a probe command, or `null` if it could not run / failed.
 *
 * `cwd` matters for the toolchain-selection commands: rustup resolves the
 * toolchain relative to it, so identity probes pass the same directory the real
 * `cargo public-api` build will run in.
 */
async function commandStdout(
  exec: Exec,
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<string | null> {
  const result = await exec(command, args, { timeoutMs: 20_000, env, cwd });
  if (result.failure === 'not-found' || result.code !== 0) return null;
  return result.stdout.trim();
}
