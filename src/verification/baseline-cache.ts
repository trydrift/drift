/**
 * Remembering what a project looked like before anything was upgraded.
 *
 * Verification cannot say an upgrade broke something without first knowing what
 * was already broken. So every probe prepares a clean checkout, installs the
 * project's dependencies, and runs its typecheck, build and test suite
 * *unchanged* — the baseline — before it touches a single version number. A
 * repository with one pre-existing type error would otherwise have that error
 * attributed to every dependency in it.
 *
 * That baseline is the single largest thing standing between a developer and a
 * scan result, and it is also entirely deterministic: run `drift outdated`
 * twice against the same commit with the same lockfile and the second run
 * re-derives, at full cost, an answer identical to the first. This is where
 * that answer is kept.
 *
 * # What is cached, and what is deliberately not
 *
 * Only the *verdict*: which checks this project has, and which of them were
 * green before the upgrade. A few hundred bytes of JSON.
 *
 * The install is not cached, and could not usefully be. The probe has to
 * install the upgrade *on top of* a populated dependency tree, so those
 * dependencies have to be on disk either way — that work is required, not
 * repeated. What is repeated is running a typecheck, a build and a test suite
 * to learn the same thing they said last time, and that is what this removes.
 *
 * # What the key has to cover
 *
 * Everything that could change the answer, and nothing that could not:
 *
 * - **The commit.** Different source, different type errors.
 * - **Every manifest and lockfile in the group.** A dependency edit changes
 *   what gets installed even when `HEAD` has not moved, and an uncommitted
 *   lockfile is exactly the case where the commit alone would lie.
 * - **The commands.** `verify.checks` narrowing from three checks to one is a
 *   different baseline, not the same one with rows hidden.
 * - **The runtime.** A typecheck that passes on Node 22 and fails on Node 26
 *   is not a cache hit; neither is a different package manager.
 *
 * Anything not in the key is a way for this cache to answer a question nobody
 * asked, so entries are written only when every input could be read. A hash
 * that silently skipped an unreadable lockfile would be a hash that matches
 * across a change it cannot see.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckKind, CheckOutcome } from './checks.js';
import type { PackageManagerId } from '../detect/package-manager.js';

/** Bumped whenever the shape below changes, so old entries are simply misses. */
const FORMAT = 1;

/**
 * How long an entry is worth trusting.
 *
 * The key already covers everything that decides the answer, so this is not
 * about correctness — it is about a machine that has moved on. A compiler
 * upgraded through the system package manager, a global toolchain replaced, a
 * registry that started resolving a floating dependency differently: none of
 * those appear in a lockfile, and after a week the cost of re-measuring is
 * small next to the cost of being confidently wrong about them.
 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Above this many entries the oldest are dropped; each is well under a kilobyte. */
const MAX_ENTRIES = 200;

/**
 * The part of a baseline worth keeping.
 *
 * Not the whole `CheckOutcome`: the output of a green check is thousands of
 * lines nobody will read, and the duration is a fact about the machine that
 * afternoon. What survives is what `prepareGroup` actually consults — which
 * checks ran, and which of them passed.
 */
export interface CachedCheck {
  kind: CheckKind;
  label: string;
  compileCapable: boolean;
  status: CheckOutcome['status'];
  /** Kept for a failed check only, so a cached unusable baseline can still say why. */
  reason?: string;
}

export interface BaselineEntry {
  format: number;
  key: string;
  measuredAt: number;
  checks: CachedCheck[];
}

/** Everything that decides whether a measured baseline still applies. */
export interface BaselineKeyInputs {
  /** The commit the worktree was made from. */
  head: string;
  /** Member directory the checks run in. `''` is the repository root. */
  dir: string;
  packageManager: PackageManagerId;
  /** The check kinds requested — `config.verify.checks`. */
  kinds: readonly CheckKind[];
  /**
   * Manifest and lockfile contents, already read. Passing contents rather than
   * paths keeps the hash honest about files that are not committed: an
   * uncommitted lockfile edit is precisely the case where `head` alone would
   * claim a baseline that no longer holds.
   */
  files: readonly { path: string; content: string }[];
  /** `process.version`, or whatever runtime the checks will run under. */
  runtime: string;
}

export function baselineKey(inputs: BaselineKeyInputs): string {
  const hash = createHash('sha256');
  hash.update(`v${FORMAT}\n`);
  hash.update(`${inputs.head}\n`);
  hash.update(`${inputs.dir}\n`);
  hash.update(`${inputs.packageManager}\n`);
  hash.update(`${[...inputs.kinds].sort().join(',')}\n`);
  hash.update(`${inputs.runtime}\n`);
  // Sorted by path so two runs that read the same files in a different order
  // agree, and the path is hashed alongside the content so moving a lockfile is
  // not mistaken for leaving it alone.
  for (const file of [...inputs.files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${file.path}\n`);
    hash.update(createHash('sha256').update(file.content).digest('hex'));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * A place to keep baselines, or nowhere at all.
 *
 * `null` is a first-class answer, not a failure: the Action runs on a fresh
 * container every time, and a test must never write into a developer's home
 * directory. Both pass `null` and get an inert cache rather than a special
 * code path at every call site.
 */
export interface BaselineCache {
  read(key: string): Promise<CachedCheck[] | null>;
  write(key: string, checks: readonly CheckOutcome[]): Promise<void>;
}

const INERT: BaselineCache = {
  async read() {
    return null;
  },
  async write() {
    // Nothing to do, and deliberately not an error: "do not cache" is a
    // configuration, not a fault.
  },
};

export function noBaselineCache(): BaselineCache {
  return INERT;
}

export function createBaselineCache(dir: string | null): BaselineCache {
  if (!dir) return INERT;

  return {
    async read(key) {
      try {
        const raw = await readFile(join(dir, `${key}.json`), 'utf8');
        const entry = JSON.parse(raw) as BaselineEntry;
        // A collision, an entry from an older format, or one this key does not
        // own. All three mean "measure it again", which is always safe.
        if (entry.format !== FORMAT || entry.key !== key) return null;
        if (Date.now() - entry.measuredAt > TTL_MS) return null;
        return Array.isArray(entry.checks) ? entry.checks : null;
      } catch {
        return null;
      }
    },

    async write(key, checks) {
      // A baseline nothing could run is not worth remembering: it is usually a
      // transient failure — a half-finished install, a machine that ran out of
      // memory — and caching it would turn one bad afternoon into a week of
      // skipped verification.
      if (!checks.some((check) => check.status === 'passed')) return;

      const entry: BaselineEntry = {
        format: FORMAT,
        key,
        measuredAt: Date.now(),
        checks: checks.map((check) => ({
          kind: check.kind,
          label: check.label,
          compileCapable: check.compileCapable,
          status: check.status,
          ...(check.status === 'passed' ? {} : { reason: check.reason ?? check.output.split('\n').slice(-3).join(' ') }),
        })),
      };

      try {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${key}.json`), JSON.stringify(entry), 'utf8');
        await prune(dir);
      } catch {
        // A cache write must never fail a scan. The worst outcome of losing
        // this is the run everybody had before it existed.
      }
    },
  };
}

/** Drop the oldest entries once there are too many, and anything past its TTL. */
async function prune(dir: string): Promise<void> {
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json'));
  if (names.length <= MAX_ENTRIES) return;

  const aged = await Promise.all(
    names.map(async (name) => {
      const at = join(dir, name);
      const info = await stat(at).catch(() => null);
      return { at, mtime: info?.mtimeMs ?? 0 };
    }),
  );
  aged.sort((a, b) => a.mtime - b.mtime);
  await Promise.all(
    aged.slice(0, aged.length - MAX_ENTRIES).map((entry) => rm(entry.at, { force: true }).catch(() => undefined)),
  );
}
