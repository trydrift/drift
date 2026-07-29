import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RefRange, RepoProvider } from './provider.js';

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
