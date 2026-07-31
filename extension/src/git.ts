import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Local git operations for the fix flow.
 *
 * Deliberately conservative. Drift creates a branch and makes commits; it never
 * force-pushes, never rewrites history, never touches the base branch, and
 * never merges. Everything it does is reversible with `git checkout` and a
 * branch delete.
 */

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export class Git {
  constructor(private readonly cwd: string) {}

  private async exec(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    try {
      const { stdout } = await run('git', args, {
        cwd: this.cwd,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: env ? { ...process.env, ...env } : undefined,
      });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      throw new GitError(`git ${args[0]} failed: ${e.message}`, e.stderr);
    }
  }

  private async tryExec(args: string[]): Promise<string | null> {
    try {
      return await this.exec(args);
    } catch {
      return null;
    }
  }

  async gitDir(): Promise<string> {
    return (await this.exec(['rev-parse', '--absolute-git-dir'])).trim();
  }

  /**
   * The working-tree root for this directory, or `null` outside a repository.
   *
   * A VS Code workspace folder is not necessarily a repository's root — it
   * can be a subdirectory of a larger checkout, or itself contain a nested
   * repository (most often a submodule). This is what lets the caller tell
   * those apart instead of assuming `cwd` and "the repo" are the same thing.
   */
  async repoRoot(): Promise<string | null> {
    const out = await this.tryExec(['rev-parse', '--show-toplevel']);
    return out?.trim() || null;
  }

  async currentBranch(): Promise<string> {
    return (await this.exec(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  }

  async headSha(): Promise<string> {
    return (await this.exec(['rev-parse', 'HEAD'])).trim();
  }

  /** Paths with uncommitted modifications, staged or not. */
  async dirtyFiles(): Promise<string[]> {
    const out = await this.exec(['status', '--porcelain']);
    return out
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      // Rename entries read `old -> new`; the new path is what matters.
      .map((path) => (path.includes(' -> ') ? path.split(' -> ')[1]! : path));
  }

  async isClean(): Promise<boolean> {
    return (await this.dirtyFiles()).length === 0;
  }

  async branchExists(name: string): Promise<boolean> {
    return (await this.tryExec(['rev-parse', '--verify', `refs/heads/${name}`])) !== null;
  }

  /**
   * Create and check out a branch.
   *
   * If the branch already exists, switches to it rather than failing — a
   * re-run of the same plan should be idempotent, and Drift's branch names are
   * derived from the analysed commit.
   */
  async createBranch(name: string): Promise<{ created: boolean }> {
    if (await this.branchExists(name)) {
      await this.exec(['checkout', name]);
      return { created: false };
    }
    await this.exec(['checkout', '-b', name]);
    return { created: true };
  }

  async checkout(ref: string): Promise<void> {
    await this.exec(['checkout', ref]);
  }

  /** True when HEAD points at a commit rather than a branch. */
  async isDetached(): Promise<boolean> {
    return (await this.currentBranch()) === 'HEAD';
  }

  /** True when the repository has no commits yet, so there is no HEAD to branch from. */
  async isUnborn(): Promise<boolean> {
    return (await this.tryExec(['rev-parse', '--verify', 'HEAD'])) === null;
  }

  /** Stage paths without committing, for the developer who wants to write their own commit. */
  async stagePaths(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.exec(['add', '--', ...paths]);
  }

  async remoteUrl(remote = 'origin'): Promise<string | null> {
    return (await this.tryExec(['remote', 'get-url', remote]))?.trim() || null;
  }

  /** True when `branch` already tracks something upstream. */
  async hasUpstream(branch: string): Promise<boolean> {
    return (await this.tryExec(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`])) !== null;
  }

  /**
   * The branch a pull request should target.
   *
   * `origin/HEAD` is the remote's own answer and the only authoritative one, but
   * it is a local symbolic ref that plenty of clones simply never set. The
   * fallbacks are conventional rather than authoritative, which is why the
   * caller shows the result before opening anything against it.
   */
  async defaultBranch(remote = 'origin'): Promise<string | null> {
    const head = await this.tryExec(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
    const named = head?.trim().replace(`${remote}/`, '');
    if (named) return named;

    for (const candidate of ['main', 'master']) {
      if (await this.tryExec(['rev-parse', '--verify', `refs/remotes/${remote}/${candidate}`])) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Stage specific paths and commit.
   *
   * Scoping `git add` to the commit's own files is what keeps separation of
   * concerns real: an agent that also touched an unrelated file does not get
   * that change swept into this commit.
   *
   * Returns `null` when there was nothing staged — a legitimate outcome when
   * the agent decided no change was needed.
   */
  async commitPaths(
    paths: readonly string[],
    subject: string,
    body: string,
  ): Promise<string | null> {
    if (paths.length === 0) return null;

    // `--` guards against a path that looks like a flag.
    await this.exec(['add', '--', ...paths]);

    const staged = await this.exec(['diff', '--cached', '--name-only']);
    if (!staged.trim()) return null;

    const message = body.trim() ? `${subject}\n\n${body.trim()}` : subject;
    await this.exec(['commit', '-m', message]);

    return this.headSha();
  }

  /** Files changed relative to a ref. Used to see what an agent actually did. */
  async changedSince(ref: string): Promise<string[]> {
    const out = await this.exec(['diff', '--name-only', ref]);
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  async diffStat(ref: string): Promise<string> {
    return (await this.tryExec(['diff', '--stat', ref])) ?? '';
  }

  /**
   * Discard all uncommitted changes.
   *
   * The escape hatch when an agent produces something unusable. Only ever
   * called on an explicit user action, never automatically — silently throwing
   * away someone's working tree would be unforgivable.
   */
  async discardAll(): Promise<void> {
    await this.exec(['checkout', '--', '.']);
    await this.exec(['clean', '-fd']);
  }

  async push(branch: string, remote = 'origin'): Promise<void> {
    // `-u` sets upstream so the user's next `git push` just works. No force.
    await this.exec(['push', '-u', remote, branch]);
  }

  async hasRemote(remote = 'origin'): Promise<boolean> {
    return (await this.tryExec(['remote', 'get-url', remote])) !== null;
  }

  /** Stash uncommitted work, returning true if anything was stashed. */
  async stash(message: string): Promise<boolean> {
    if (await this.isClean()) return false;
    await this.exec(['stash', 'push', '--include-untracked', '-m', message]);
    return true;
  }

  async stashPop(): Promise<void> {
    await this.exec(['stash', 'pop']);
  }

  /* ------------------------------------------------------------------ */
  /* Snapshots — the machinery behind rewind                             */
  /* ------------------------------------------------------------------ */

  /**
   * Record the working tree as a git tree object, without touching anything.
   *
   * Everything here runs against a scratch index file, so the developer's own
   * staging area is exactly as they left it afterwards. That matters: a
   * checkpoint is taken on every turn, silently, and a feature that quietly
   * restaged someone's half-built commit each time they typed would be worse
   * than having no rewind at all.
   *
   * The snapshot is what `git add -A` would stage, which means `.gitignore` is
   * honoured — `node_modules` is not copied, but `package.json` and the lockfile
   * are, and those are the files an upgrade actually changes.
   */
  async snapshotTree(): Promise<string> {
    const indexFile = join(await this.gitDir(), 'drift-snapshot-index');
    const env = { GIT_INDEX_FILE: indexFile };

    await rm(indexFile, { force: true });
    try {
      // Seed from HEAD so the snapshot records deletions, not just edits. A
      // repository with no commits yet has no HEAD to seed from, and an empty
      // index is the right starting point there.
      if (await this.tryExec(['rev-parse', '--verify', 'HEAD'])) {
        await this.exec(['read-tree', 'HEAD'], env);
      }
      await this.exec(['add', '-A'], env);
      return (await this.exec(['write-tree'], env)).trim();
    } finally {
      await rm(indexFile, { force: true });
    }
  }

  /** Paths that differ between a snapshot tree and the working tree right now. */
  async changedAgainstTree(tree: string): Promise<string[]> {
    const tracked = (await this.tryExec(['diff', '--name-only', tree])) ?? '';
    const untracked = (await this.tryExec(['ls-files', '--others', '--exclude-standard'])) ?? '';
    return [
      ...new Set(
        [...tracked.split('\n'), ...untracked.split('\n')].map((line) => line.trim()).filter(Boolean),
      ),
    ];
  }

  /**
   * Put the working tree back to a snapshot.
   *
   * Files edited since are reverted, files created since are removed, files
   * deleted since come back. Commits are left alone — Drift does not rewrite
   * history, so rewinding past a commit restores the files and leaves the commit
   * in the log, which is the honest outcome and the recoverable one.
   */
  async restoreTree(tree: string): Promise<void> {
    // Staging first is what lets `read-tree -u --reset` see files created after
    // the snapshot; git will only remove a path from the working tree if it
    // knows about it.
    await this.exec(['add', '-A']);
    await this.exec(['read-tree', '-u', '--reset', tree]);
    // `read-tree --reset` leaves the index matching the snapshot rather than
    // HEAD, which would show every restored file as staged. Resetting to HEAD
    // gives the ordinary reading: file contents exactly as they were, changes
    // against HEAD shown as unstaged. What a rewind does not reproduce is which
    // of those changes had been staged at the time — content is restored, the
    // staging area is not.
    await this.exec(['reset', '-q']);
  }
}
