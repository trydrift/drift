import { execFile } from 'node:child_process';
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

  private async exec(args: string[]): Promise<string> {
    try {
      const { stdout } = await run('git', args, {
        cwd: this.cwd,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
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
}
