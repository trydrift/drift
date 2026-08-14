import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
  /**
   * Repo-relative paths of gitignored files carried over from `root` — the
   * same files a `build` run in the developer's own checkout would see.
   * Empty when `copyIgnoredFiles` was off or there was nothing gitignored
   * outside the usual regenerable directories.
   */
  copiedFiles: readonly string[];
  /**
   * Gitignored files that qualified for copying but were skipped for being
   * larger than {@link MAX_COPY_BYTES}. Reported rather than silently
   * dropped: a build that still fails in the worktree because of one of
   * these should say so, not repeat the same unexplained failure this
   * feature exists to prevent.
   */
  oversizedFiles: readonly string[];
  /** Remove it. Safe to call more than once, and never throws. */
  dispose(): Promise<void>;
}

export interface WorktreeOptions {
  /** Commit-ish to check out. Defaults to `HEAD`. */
  at?: string;
  /** Runs the git commands. Injected by tests. */
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  /**
   * Carry over gitignored files from `root`, e.g. generated code a build
   * step expects to already exist. On by default — see
   * {@link copyIgnoredSourceFiles}. Set `false` for work that means to
   * measure the commit exactly as checked in, with nothing local added.
   */
  copyIgnoredFiles?: boolean;
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

  const { copied, oversized } =
    options.copyIgnoredFiles === false
      ? { copied: [], oversized: [] }
      : await copyIgnoredSourceFiles(root, path, exec, env);

  let disposed = false;
  return {
    path,
    copiedFiles: copied,
    oversizedFiles: oversized,
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

/**
 * Directory segments that mark a gitignored path as regenerable rather than a
 * checked-in input: caches, dependency trees, and build output a fresh
 * install or build step recreates on its own. Never worth carrying into a
 * worktree, and often too large to try.
 */
const REGENERABLE_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.angular',
  'coverage',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.gradle',
  '.idea',
  '.vscode',
  'tmp',
  '.tmp',
]);

/**
 * Ignored files this large are copied output or data, not the kind of small
 * hand-generated source a build reads as an input — and copying one this size
 * on every worktree would make the feature cost more than the failure it
 * prevents. Reported rather than silently skipped, in case it's wrong for a
 * given repository.
 */
const MAX_COPY_BYTES = 25 * 1024 * 1024;

/**
 * Carry gitignored-but-locally-necessary files from `root` into a fresh
 * worktree.
 *
 * A worktree is `git worktree add`'s checkout: tracked files only. Most
 * repositories are fine with that — `npm install` and a build step rebuild
 * everything gitignored from scratch. Some are not: a codegen step run once
 * and committed nowhere, whose output is `.gitignore`d because it is
 * derived, but which the build reads as if it were source. Without it, every
 * check in the worktree fails the same way a fresh clone would, and Drift
 * reports the whole project as unbuildable rather than saying nothing about
 * the upgrade at all.
 *
 * There is no manifest of which gitignored files are like this, so this
 * copies what the developer's own `npm run build` already sees: everything
 * `git` reports as ignored, minus the directories a fresh install or build
 * regenerates on its own ({@link REGENERABLE_SEGMENTS}). An earlier version
 * of this tried to guess relevance by grepping tracked source for each
 * file's name, which is exactly backwards — it can miss a file referenced
 * indirectly (a dynamic import, a path built at runtime) and silently
 * reproduce the very failure this exists to prevent. Copying everything the
 * denylist doesn't rule out has no such blind spot.
 */
export async function copyIgnoredSourceFiles(
  root: string,
  worktreePath: string,
  exec: Exec,
  env: NodeJS.ProcessEnv,
  /** Overridable by tests; production callers get {@link MAX_COPY_BYTES}. */
  maxBytes: number = MAX_COPY_BYTES,
): Promise<{ copied: string[]; oversized: string[] }> {
  const listed = await exec('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], {
    cwd: root,
    env,
  });
  if (listed.code !== 0 || !listed.stdout) return { copied: [], oversized: [] };

  const candidates = listed.stdout
    .split('\0')
    .filter((rel) => rel.length > 0 && !rel.split('/').some((segment) => REGENERABLE_SEGMENTS.has(segment)));

  const copied: string[] = [];
  const oversized: string[] = [];
  for (const rel of candidates) {
    const source = join(root, rel);
    const info = await stat(source).catch(() => null);
    if (!info || !info.isFile()) continue;
    if (info.size > maxBytes) {
      oversized.push(rel);
      continue;
    }

    const destination = join(worktreePath, rel);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination).catch(() => undefined);
    copied.push(rel);
  }

  return { copied, oversized };
}

/** Directory-safe, collision-resistant enough for one label per scan. */
function sanitize(label: string): string {
  const cleaned = label.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'probe';
}
