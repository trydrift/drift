import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execCommand, type Exec } from '../util/exec.js';

/**
 * A throwaway checkout of the repository, for work that must not touch the
 * developer's tree.
 *
 * Drift installs upgrades and runs the project's own checks against them. Doing
 * that where someone is working means their `node_modules` moves under them,
 * their editor reindexes, and a scan they did not ask to be invasive has edited
 * their tree. A worktree is git's own answer to that: the same commit, a
 * separate directory, removed when the work is done.
 *
 * Three places grew their own copy of this — the extension's `Git` class, the
 * CLI's fix runner, and (now) the scan probe — with three different cleanup
 * stories. This is the one both `src/` consumers use, so an interrupted run
 * leaves the same trace everywhere and `dispose` means the same thing.
 */

export interface Worktree {
  /** Absolute path of the checkout. */
  path: string;
  /** Remove it. Safe to call more than once, and never throws. */
  dispose(): Promise<void>;
}

export interface WorktreeOptions {
  /** Commit-ish to check out. Defaults to `HEAD`. */
  at?: string;
  /** Runs the git commands. Injected by tests. */
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
}

/**
 * Check `root`'s HEAD out into a fresh directory under the repository's own
 * git dir.
 *
 * Detached on purpose: this checkout exists to be measured, never to be
 * committed to, and a named branch would show up in the developer's branch list
 * as something they might reasonably try to merge.
 *
 * Throws when git will not produce one — no repository, a corrupt index, a
 * commit that does not resolve. A caller that can degrade should catch and say
 * what it could not verify rather than failing the whole scan.
 */
export async function createWorktree(
  root: string,
  label: string,
  options: WorktreeOptions = {},
): Promise<Worktree> {
  const exec = options.exec ?? execCommand;
  const env = options.env ?? process.env;
  const at = options.at ?? 'HEAD';

  const common = await exec('git', ['rev-parse', '--git-common-dir'], { cwd: root, env });
  if (common.code !== 0) {
    throw new Error(`\`${root}\` is not a git repository, so there is nowhere safe to test an upgrade.`);
  }

  const gitDir = common.stdout.trim() || '.git';
  const path = join(root, gitDir, 'drift-worktrees', sanitize(label));

  // A previous run that was killed rather than finished leaves both a directory
  // and a registration behind, and `worktree add` refuses either. Clearing both
  // before adding is what makes an interrupted scan recoverable without the
  // developer being told to run `git worktree prune` by hand.
  await exec('git', ['worktree', 'remove', '--force', path], { cwd: root, env });
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  await exec('git', ['worktree', 'prune'], { cwd: root, env });

  const added = await exec('git', ['worktree', 'add', '--detach', path, at], { cwd: root, env });
  if (added.code !== 0) {
    throw new Error(
      `Could not create a worktree to test upgrades in: ${added.stderr.trim() || added.stdout.trim() || 'git failed'}`,
    );
  }

  let disposed = false;
  return {
    path,
    async dispose() {
      if (disposed) return;
      disposed = true;
      // Every step is best-effort and independently attempted: a worktree left
      // behind is a wasted gigabyte, but a cleanup that throws would replace
      // whatever real error the caller is already handling.
      await exec('git', ['worktree', 'remove', '--force', path], { cwd: root, env }).catch(() => undefined);
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      await exec('git', ['worktree', 'prune'], { cwd: root, env }).catch(() => undefined);
    },
  };
}

/**
 * Run `work` in a fresh worktree and remove it afterwards, whatever happens.
 *
 * The pattern every caller wants, in the shape that makes leaking one
 * impossible.
 */
export async function withWorktree<T>(
  root: string,
  label: string,
  work: (worktree: Worktree) => Promise<T>,
  options: WorktreeOptions = {},
): Promise<T> {
  const worktree = await createWorktree(root, label, options);
  try {
    return await work(worktree);
  } finally {
    await worktree.dispose();
  }
}

/** Directory-safe, collision-resistant enough for one label per scan. */
function sanitize(label: string): string {
  const cleaned = label.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'probe';
}
