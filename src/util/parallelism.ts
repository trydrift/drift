/**
 * How much of this machine a scan is allowed to use at once.
 *
 * Every one of these numbers used to be a literal — `8` packages in flight,
 * `2` worktrees being prepared — chosen on one laptop and then applied
 * unchanged to a 4-core CI runner and a 24-core workstation alike. On the
 * runner that oversubscribes the box until everything is slower than it would
 * have been serially; on the workstation it leaves most of the machine idle
 * through the longest part of a scan.
 *
 * The right number is not one number, because the three kinds of work a scan
 * does have nothing in common:
 *
 * - **Network work** — registry lookups, changelog fetches — is pure waiting.
 *   It scales with how many requests a registry will tolerate, not with cores,
 *   so a 4-core machine can and should have as many of these in flight as a
 *   32-core one.
 * - **Analysis** — downloading and parsing declaration trees, diffing API
 *   surfaces, searching the index — is network *and* CPU *and* memory, so it
 *   scales with cores, and is bounded by RAM because each worker holds a whole
 *   type surface in memory.
 * - **Local work** — `git worktree add`, `npm install`, a typecheck — saturates
 *   the disk and every core it is given all by itself. Running many at once
 *   makes each one slower without finishing the set any sooner, so this stays
 *   deliberately small however large the machine is.
 *
 * Every function here is overridable by an environment variable, because the
 * one thing a heuristic cannot know is that this process is sharing a runner
 * with four others.
 */

import { availableParallelism, totalmem } from 'node:os';

/** Cores this process may actually use — respects cgroup limits on Linux. */
export function cpuCount(): number {
  try {
    return Math.max(1, availableParallelism());
  } catch {
    return 4;
  }
}

/**
 * How many analysis workers this machine has memory for.
 *
 * A worker holds one package's declaration tree, its parsed API surface on both
 * sides, and the diff between them. Half a gigabyte each is generous for most
 * packages and roughly right for the ones that matter — a machine that runs out
 * of memory mid-scan loses the whole run, which is far worse than running the
 * last few packages a little later.
 */
function memoryBudget(): number {
  try {
    return Math.max(2, Math.floor(totalmem() / (512 * 1024 * 1024)));
  } catch {
    return 8;
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Math.floor(value)));
}

/** An explicit override, when it is a usable positive number. */
function override(name: string, env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : undefined;
}

/**
 * Registry and changelog requests in flight at once.
 *
 * Bounded well above the core count because none of this is computation, and
 * bounded below 32 because the far end is someone else's rate limit: npm, PyPI
 * and the GitHub API all start refusing requests before a fast connection runs
 * out of bandwidth, and a refused request costs an entire package's evidence.
 */
export function networkConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return override('DRIFT_NETWORK_CONCURRENCY', env) ?? clamp(cpuCount() * 4, 8, 32);
}

/**
 * Packages being analysed at once — evidence gathered, surfaces diffed, impact
 * localized.
 */
export function analysisConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return override('DRIFT_CONCURRENCY', env) ?? clamp(Math.min(cpuCount() * 2, memoryBudget()), 4, 16);
}

/**
 * Installs, worktrees and project checks running at once.
 *
 * The one number that should *not* grow with the machine as fast as the others.
 * Two `npm install`s on one disk take about as long as two run back to back,
 * and two typechecks each try to use every core on their own.
 */
export function localConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return override('DRIFT_LOCAL_CONCURRENCY', env) ?? clamp(cpuCount() / 4, 2, 6);
}

/** One line for the debug log, so a slow scan can be read against the machine it ran on. */
export function describeParallelism(env: NodeJS.ProcessEnv = process.env): string {
  return (
    `${cpuCount()} cores · ${networkConcurrency(env)} network, ` +
    `${analysisConcurrency(env)} analysis, ${localConcurrency(env)} local`
  );
}
