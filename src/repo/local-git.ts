import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RefRange, RepoProvider } from './provider.js';
import { isManifestPath } from '../detect/index.js';
import { DEPENDENCY_FILE_GLOBS } from '../detect/manifest-globs.js';

const run = promisify(execFile);

/**
 * Repository access backed by a local git checkout.
 *
 * No network, no credentials, no rate limits. This is what the VS Code
 * extension uses, and it is why the extension can analyse a dependency change
 * the moment you open the folder — before you have signed in to anything.
 *
 * Every method degrades to an empty result rather than throwing: a shallow
 * clone, a missing parent commit, or a brand-new repository with one commit
 * are all normal states, not errors worth failing a run over.
 */
/**
 * Sentinel `ref` meaning "the working tree as it is right now".
 *
 * The editor's most common case is a dependency the user just installed but has
 * not committed. That state is not a commit and has no SHA, so it needs its own
 * marker rather than being forced into one.
 */
export const WORKING_TREE = ':working-tree:';

export class LocalGitProvider implements RepoProvider {
  constructor(
    private readonly cwd: string,
    private readonly range: RefRange,
  ) {}

  async changedFiles(): Promise<string[]> {
    // Against the working tree, `git diff <before>` already means "compare the
    // tree to that commit" — passing a second ref would be a syntax error.
    const args =
      this.range.after === WORKING_TREE
        ? ['diff', '--name-only', this.range.before]
        : ['diff', '--name-only', this.range.before, this.range.after];

    const out = await this.git(args);
    if (out === null) return [];

    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async readFile(path: string, ref: string): Promise<string | null> {
    if (ref === WORKING_TREE) {
      // Read from disk rather than the index, so unstaged edits are included —
      // "what the file says now" is what the user means.
      try {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        return await readFile(join(this.cwd, path), 'utf8');
      } catch {
        return null;
      }
    }
    return this.git(['show', `${ref}:${path}`]);
  }

  async listFiles(ref: string): Promise<string[] | null> {
    // The working tree is the index plus whatever is on disk, so `ls-files`
    // is the honest answer there; `ls-tree` would describe a commit that is
    // not what the user is asking about.
    const out =
      ref === WORKING_TREE
        ? await this.git(['ls-files', '--cached', '--others', '--exclude-standard'])
        : await this.git(['ls-tree', '-r', '--name-only', ref]);
    if (out === null) return null;

    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /** Run a git command, returning `null` on any failure. */
  private async git(args: readonly string[]): Promise<string | null> {
    try {
      const { stdout } = await run('git', [...args], {
        cwd: this.cwd,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout;
    } catch {
      return null;
    }
  }
}

/**
 * Manifest patterns as git pathspecs.
 *
 * Re-exported from the one registry rather than listed again here. This was a
 * second hand-written copy, and it had fallen behind the first: no
 * `npm-shrinkwrap.json`, no `bun.lock`, no Gradle version catalog, no
 * `*.gemspec` — so `lastCommitTouching` could not find a dependency commit that
 * only moved one of those, and `analyze` reported "nothing changed" on a
 * repository where something plainly had.
 */
export const MANIFEST_GLOBS = DEPENDENCY_FILE_GLOBS;

/**
 * Work out which commit range to analyse from a local checkout, with no range
 * given explicitly.
 *
 * Order of preference, most-likely-to-be-what-you-meant first:
 *   1. Uncommitted manifest edits — you just changed a dependency.
 *   2. The last commit that touched a manifest — the bump you merged.
 *   3. `parentSha..headSha`, but only if that diff itself touched a manifest.
 *   4. Nothing. Better to say so than to analyse an unrelated diff.
 *
 * Shared by the VS Code extension and the CLI's `analyze`/`fix` commands, so
 * both answer "what changed?" the same way — diffing `HEAD^..HEAD` blindly
 * finds whatever commit happens to be most recent, which is usually unrelated
 * work rather than the dependency bump the user actually wants to see.
 */
export async function chooseManifestRange(
  cwd: string,
  info: { headSha: string; parentSha: string | null },
  opts: {
    /**
     * Whether uncommitted manifest edits can win (step 1). Callers that need
     * a real commit to build from — `fix`, which checks out `after` into a
     * worktree — must disable this, since `WORKING_TREE` is not a ref.
     */
    includeWorkingTree?: boolean;
  } = {},
): Promise<RefRange | null> {
  const { includeWorkingTree = true } = opts;

  const git = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await run('git', args, { cwd, windowsHide: true });
      return stdout;
    } catch {
      return null;
    }
  };

  // 1 — uncommitted manifest changes, staged or not.
  if (includeWorkingTree) {
    const dirty = await git(['status', '--porcelain']);
    if (dirty) {
      const dirtyManifests = dirty
        .split('\n')
        .map((l) => l.slice(3).trim())
        .filter((p) => p && isManifestPath(p));

      if (dirtyManifests.length > 0) {
        return { before: info.headSha, after: WORKING_TREE };
      }
    }
  }

  // 2 — the most recent commit that moved a manifest.
  const recent = await lastCommitTouching(cwd, MANIFEST_GLOBS);
  if (recent) return { before: recent.parent, after: recent.sha };

  // 3 — fall back to HEAD^..HEAD only if it actually touched a manifest.
  if (info.parentSha) {
    const changed = await git(['diff', '--name-only', info.parentSha, info.headSha]);
    if (changed?.split('\n').some((p) => p.trim() && isManifestPath(p.trim()))) {
      return { before: info.parentSha, after: info.headSha };
    }
  }

  return null;
}

export interface LocalRepoInfo {
  /** Current branch, or `HEAD` when detached. */
  branch: string;
  headSha: string;
  /** First parent of HEAD, or `null` for a root commit. */
  parentSha: string | null;
  /** `owner/repo` parsed from the origin remote, when there is one. */
  slug: string | null;
  /** True when there are uncommitted changes. */
  dirty: boolean;
}

/**
 * Describe a local checkout.
 *
 * Returns `null` when the directory is not a git repository, which the caller
 * treats as "nothing to analyse" rather than an error — plenty of folders
 * opened in an editor are not repositories.
 */
export async function inspectLocalRepo(cwd: string): Promise<LocalRepoInfo | null> {
  const git = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await run('git', args, { cwd, windowsHide: true });
      return stdout.trim();
    } catch {
      return null;
    }
  };

  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return null;

  const headSha = await git(['rev-parse', 'HEAD']);
  if (!headSha) return null; // A repository with no commits yet.

  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])) ?? 'HEAD';
  const parentSha = await git(['rev-parse', 'HEAD^']);
  const status = await git(['status', '--porcelain']);
  const remote = await git(['remote', 'get-url', 'origin']);

  return {
    branch,
    headSha,
    parentSha,
    slug: parseSlug(remote),
    dirty: Boolean(status && status.length > 0),
  };
}

/** `owner/repo` from any of the shapes a GitHub remote URL takes. */
export function parseSlug(remote: string | null): string | null {
  if (!remote) return null;
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(remote.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Find the most recent commit that touched any of the given paths.
 *
 * This is what lets the extension answer "what dependency change am I looking
 * at?" without being told. Opening a repository mid-work, the interesting
 * range is rarely `HEAD^..HEAD` — it is whatever commit last moved a manifest.
 */
/**
 * Turn uncommitted manifest edits into a real commit, without touching
 * anything the developer can see.
 *
 * `drift outdated --upgrade` leaves exactly the state `npm install pkg@version`
 * would: an edited manifest and lockfile, uncommitted. `analyze` reads that
 * happily, because it can diff against the working tree. `fix` cannot — it
 * checks `after` out into an isolated worktree, and the working tree is not a
 * ref. So the command Drift recommended after an upgrade would analyse the
 * *previous* dependency commit and report on a version the developer had
 * already moved off.
 *
 * This closes that gap by writing a commit object whose tree is HEAD plus the
 * manifest changes, and nothing else. It uses a scratch index file, so the
 * developer's index, working tree, branches, and stash are all untouched — the
 * commit is created, handed to the worktree, and only ever reachable from the
 * fix branch. Unrelated work in progress is deliberately excluded: only paths
 * Drift recognises as manifests are staged, so a half-finished refactor
 * sitting in the same tree is never swept into a dependency commit.
 *
 * Returns `null` when there is nothing uncommitted to capture.
 */
export async function commitWorkingTreeManifests(
  cwd: string,
  message: string,
): Promise<string | null> {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const git = async (args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> => {
    try {
      const { stdout } = await run('git', args, {
        cwd,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      return stdout;
    } catch {
      return null;
    }
  };

  const status = await git(['status', '--porcelain']);
  if (!status) return null;

  const dirtyManifests = status
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((path) => path && isManifestPath(path));
  if (dirtyManifests.length === 0) return null;

  const head = (await git(['rev-parse', 'HEAD']))?.trim();
  if (!head) return null;

  const dir = await mkdtemp(join(tmpdir(), 'drift-index-'));
  const indexFile = join(dir, 'index');
  const env = { GIT_INDEX_FILE: indexFile };

  try {
    if ((await git(['read-tree', 'HEAD'], env)) === null) return null;
    // `--all` so a manifest deleted in the working tree is recorded as deleted
    // rather than silently kept from HEAD.
    if ((await git(['add', '--all', '--', ...dirtyManifests], env)) === null) return null;

    const tree = (await git(['write-tree'], env))?.trim();
    if (!tree) return null;

    // Identical tree means the edits cancelled out; there is no commit to make.
    const headTree = (await git(['rev-parse', 'HEAD^{tree}']))?.trim();
    if (tree === headTree) return null;

    const sha = (await git(['commit-tree', tree, '-p', head, '-m', message]))?.trim();
    return sha || null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function lastCommitTouching(
  cwd: string,
  paths: readonly string[],
  maxCommits = 50,
): Promise<{ sha: string; parent: string } | null> {
  if (paths.length === 0) return null;

  try {
    const { stdout } = await run(
      'git',
      ['log', `-${maxCommits}`, '--format=%H', '--', ...paths],
      { cwd, windowsHide: true },
    );

    const sha = stdout.split('\n')[0]?.trim();
    if (!sha) return null;

    const { stdout: parentOut } = await run('git', ['rev-parse', `${sha}^`], {
      cwd,
      windowsHide: true,
    });

    return { sha, parent: parentOut.trim() };
  } catch {
    return null;
  }
}
