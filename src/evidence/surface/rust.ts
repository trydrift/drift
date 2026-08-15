import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Exec } from '../../util/exec.js';
import { diffSurfaces, type SurfaceApi, type SurfaceEntry, type SurfaceKind } from '../type-surface.js';
import {
  unavailable,
  tryAutoInstall,
  type SurfaceProvider,
  type SurfaceRequest,
  type SurfaceOutcome,
} from './types.js';

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
    if (!(await commandWorks(request.exec, 'cargo', ['--version'], request.env))) {
      return unavailable(
        TOOL,
        'tool-missing',
        `The Rust Cargo toolchain is not installed or is not on PATH, so ${request.name}'s public API could not be compared directly.`,
        CARGO_REMEDY,
      );
    }

    if (!(await commandWorks(request.exec, 'cargo', ['public-api', '--version'], request.env))) {
      const installed =
        (await tryAutoInstall(request, PUBLIC_API_INSTALL)) &&
        (await commandWorks(request.exec, 'cargo', ['public-api', '--version'], request.env));
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

    if (await commandWorks(request.exec, 'rustup', ['--version'], request.env)) {
      // Only rustup-managed installs can be checked/fixed here; a nightly toolchain
      // installed some other way (e.g. a distro package) is invisible to `rustup` but
      // still works, so its absence is not treated as a failure on its own.
      if (!(await nightlyAvailable(request.exec, request.env))) {
        const installed =
          (await tryAutoInstall(request, NIGHTLY_INSTALL)) &&
          (await nightlyAvailable(request.exec, request.env));
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

    const before = await surfaceOf(request, request.from);
    if (!before.ok) return before.failure;
    const after = await surfaceOf(request, request.to);
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

async function surfaceOf(request: SurfaceRequest, version: string): Promise<SurfaceAttempt> {
  const dir = join(request.workdir, `probe-${version}`);

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

  const result = await request.exec(
    'cargo',
    ['public-api', '--simplified', '--package', request.name],
    { cwd: dir, timeoutMs: request.timeoutMs, env: request.env },
  );

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
              : `\`cargo public-api\` failed on ${request.name} ${version}: ${firstLine(result.stderr)}`,
          ),
    };
  }

  const api = parseCargoPublicApi(result.stdout);
  if (api.size === 0) {
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'no-public-surface',
        `${request.name} ${version} exposes no public items that \`cargo public-api\` could read.`,
      ),
    };
  }

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

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'no output';
}

async function nightlyAvailable(exec: Exec, env?: NodeJS.ProcessEnv): Promise<boolean> {
  return commandWorks(exec, 'rustup', ['run', 'nightly', 'rustc', '--version'], env);
}

async function commandWorks(
  exec: Exec,
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  const result = await exec(command, args, { timeoutMs: 20_000, env });
  return result.failure !== 'not-found' && result.code === 0;
}
