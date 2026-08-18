/**
 * Whether the tool a check would run is on this machine at all.
 *
 * Asked *before* a test checkout is built, which is the whole point. Preparing
 * a group is the most expensive thing a scan does — a `git worktree add` of a
 * large repository is thousands of files on disk, and an install on top of it
 * is minutes — and none of it can make a missing binary appear. Scanning Deno
 * on a machine without `cargo` built fifteen worktrees of a 15,000-file
 * checkout, spent two minutes of cumulative work doing it, ran `cargo check`,
 * got ENOENT, and threw all fifteen away. The answer was knowable from `PATH`
 * before the first one was created.
 *
 * The outcome is unchanged: a check whose binary is missing cannot pass, so the
 * baseline has nothing usable in it and the group is abandoned either way. Only
 * the cost of reaching that conclusion is different — and the stated reason,
 * which now names the tool rather than describing a baseline nobody could run.
 *
 * # Existence, not exit code
 *
 * The probe reads `failure === 'not-found'` and nothing else. Whether
 * `cargo --version` exits zero is irrelevant and actively misleading: plenty of
 * real tools answer a bare `--version` with a usage error (`go` does), and
 * treating that as "not installed" would skip verification on a machine that
 * has a perfectly good toolchain.
 */

import type { Exec } from '../util/exec.js';

/**
 * One positive answer per binary and path-like environment, for the life of the
 * process.
 *
 * A scan asks about the same three or four tools once per workspace member, and
 * a monorepo has dozens. The scan-local promise is cached rather than the value
 * so members being prepared concurrently share one probe instead of racing.
 *
 * The environment is part of the key because a long-running editor process can
 * learn a better PATH later. A negative answer from the GUI launch environment
 * must not poison a later scan that explicitly supplies the user's shell PATH.
 *
 * Negative answers are not process-global. A developer can install `cargo` into
 * the same PATH a minute later, and the next scan must discover it without an
 * editor restart. Positive answers may stay process-global: if a tool later
 * disappears, the real check invocation still reports that ordinary failure.
 */
const presentProbes = new Map<string, Promise<boolean>>();

export interface ToolAvailabilityCache {
  probes: Map<string, Promise<boolean>>;
}

export function createToolAvailabilityCache(): ToolAvailabilityCache {
  return { probes: new Map() };
}

/** Drop every memoised answer. Test seam. */
export function clearToolAvailability(): void {
  presentProbes.clear();
}

export function toolAvailable(
  exec: Exec,
  command: string,
  env?: NodeJS.ProcessEnv,
  cache?: ToolAvailabilityCache,
): Promise<boolean> {
  const key = availabilityKey(command, env);
  const present = presentProbes.get(key);
  if (present) return present;

  const cached = cache?.probes.get(key);
  if (cached) return cached;

  const probe = exec(command, ['--version'], {
    // Long enough for a cold JVM or a first-run toolchain shim, short enough
    // that a wedged binary does not hold the scan open.
    timeoutMs: 20_000,
    ...(env ? { env } : {}),
  })
    .then((result) => result.failure !== 'not-found')
    // A probe that could not run at all says nothing about the tool, and
    // guessing "missing" would silently skip verification. Assume present and
    // let the real invocation report the truth.
    .catch(() => true);
  const remembered = probe.then((available) => {
    if (!available) presentProbes.delete(key);
    return available;
  });

  presentProbes.set(key, remembered);
  cache?.probes.set(key, remembered);
  return remembered;
}

/**
 * The first tool in `commands` that this machine has, or `null` when it has
 * none of them.
 *
 * Probes are issued together rather than in sequence: they are independent, and
 * a project that offers three checks would otherwise pay three round trips
 * through the process table to learn the same thing.
 */
export async function anyToolAvailable(
  exec: Exec,
  commands: readonly string[],
  env?: NodeJS.ProcessEnv,
  cache?: ToolAvailabilityCache,
): Promise<string | null> {
  const distinct = [...new Set(commands)];
  if (distinct.length === 0) return null;
  const present = await Promise.all(distinct.map((command) => toolAvailable(exec, command, env, cache)));
  const at = present.indexOf(true);
  return at >= 0 ? distinct[at]! : null;
}

export async function toolsAvailable(
  exec: Exec,
  commands: readonly string[],
  env?: NodeJS.ProcessEnv,
  cache?: ToolAvailabilityCache,
): Promise<Map<string, boolean>> {
  const distinct = [...new Set(commands)];
  const present = await Promise.all(distinct.map((command) => toolAvailable(exec, command, env, cache)));
  return new Map(distinct.map((command, index) => [command, present[index]!] as const));
}

function availabilityKey(command: string, env?: NodeJS.ProcessEnv): string {
  const source = env ?? process.env;
  const path = source.PATH ?? source.Path ?? source.path ?? '';
  const pathExt = source.PATHEXT ?? source.PathExt ?? '';
  return JSON.stringify([command, path, pathExt, process.platform]);
}
