import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { attributedMessage, type Author } from '../../src/repo/attribution.js';

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
    /**
     * Whatever the command managed to print before failing.
     *
     * Carried because `git diff` exits non-zero to mean "these differ" — its
     * stdout on that path is the diff, not debris.
     */
    readonly stdout?: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface CommitOptions {
  /**
   * Credit Drift, and any agent that helped, as co-authors. Defaults to on.
   *
   * Off is a real setting rather than a hypothetical: repositories with commit
   * linting or a signed-commit policy sometimes reject trailers they did not
   * expect, and a tool that cannot be told to stop adding one is a tool that
   * gets uninstalled.
   */
  coAuthors?: readonly Author[] | false;
}

/**
 * The final commit message, with attribution.
 *
 * Centralised so that every commit Drift makes is credited the same way. The
 * human stays the author — they chose the upgrade and reviewed the diff — and
 * Drift is added as a co-author alongside them.
 */
function message(subject: string, body: string, options: CommitOptions): string {
  if (options.coAuthors === false) return attributedMessage(subject, body, { enabled: false });
  return attributedMessage(subject, body, {
    ...(options.coAuthors ? { coAuthors: options.coAuthors } : {}),
  });
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
      const e = err as { stderr?: string; stdout?: string; message: string };
      throw new GitError(`git ${args[0]} failed: ${e.message}`, e.stderr, e.stdout);
    }
  }

  private async tryExec(args: string[]): Promise<string | null> {
    try {
      return await this.exec(args);
    } catch {
      return null;
    }
  }

  /**
   * Run git and keep stdout even when it exits non-zero.
   *
   * `git diff` is the reason this exists: it signals "these differ" with exit
   * code 1, so the ordinary error path would throw away the diff in exactly
   * the case the diff was wanted.
   */
  private async execAllowingFailure(args: string[]): Promise<string> {
    try {
      return await this.exec(args);
    } catch (err) {
      return err instanceof GitError ? (err.stdout ?? '') : '';
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

  async init(defaultBranch = 'main'): Promise<void> {
    try {
      await this.exec(['init', '--initial-branch', defaultBranch]);
    } catch {
      await this.exec(['init']);
      await this.exec(['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`]);
    }
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

  /**
   * The uncommitted work as a diff, including files git does not track yet.
   *
   * Used to show an agent the attempt a developer just rejected. `--no-index`
   * against `/dev/null` is how an untracked file gets into a diff at all, and
   * without it a fix that created a new file would be invisible in exactly the
   * retry that needs to see it.
   */
  async diffAgainstHead(): Promise<string> {
    const tracked = await this.execAllowingFailure(['diff', 'HEAD']);

    const untracked = (await this.tryExec(['ls-files', '--others', '--exclude-standard'])) ?? '';
    const paths = untracked.split('\n').map((p) => p.trim()).filter(Boolean);

    const additions: string[] = [];
    for (const path of paths.slice(0, 50)) {
      // `git diff --no-index` exits non-zero when the files differ, which is
      // always here — so its output comes back through the failure path.
      const patch = await this.execAllowingFailure(['diff', '--no-index', '--', '/dev/null', path]);
      if (patch.trim()) additions.push(patch);
    }

    return [tracked, ...additions].filter((part) => part.trim()).join('\n');
  }

  /**
   * Move this branch back to `ref`, discarding the commits and files after it.
   *
   * The one history-rewriting operation in this file, and it is deliberately
   * narrow: it only ever runs on an explicit, modal confirmation, only on a
   * branch Drift created, and only before anything is pushed. `git reflog`
   * still holds the discarded commit, which is what makes this recoverable by
   * someone who knows to look — but the caller says "cannot be undone" rather
   * than relying on that, because most people do not.
   */
  async resetHard(ref: string): Promise<void> {
    await this.exec(['reset', '--hard', ref]);
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
   * The branch this one was created from.
   *
   * Git records it: creating a branch writes `branch: Created from <ref>` as
   * the first entry of that branch's reflog. That is a *fact* about what
   * happened, unlike every other way of answering this question — merge-base
   * arithmetic against every branch guesses, and guesses wrong as soon as two
   * branches share history, which is always.
   *
   * `null` when the reflog has been pruned, the branch predates the reflog, or
   * it was created from a bare SHA. Callers fall back to the default branch and
   * say that they did, rather than presenting a guess as a finding.
   */
  async branchedFrom(branch: string): Promise<string | null> {
    const reflog = await this.tryExec(['reflog', 'show', '--date=unix', branch]);
    if (!reflog) return null;

    // The creation entry is the oldest, so read from the bottom.
    const lines = reflog.split('\n').filter((line) => line.trim());
    for (const line of lines.reverse()) {
      const created = /\bbranch: Created from (.+)$/.exec(line.trim());
      if (!created) continue;

      const ref = created[1]!.trim();
      // `Created from HEAD` names no branch — it is what `git checkout -b`
      // writes when the starting point was the current commit. The commit is
      // known but which branch it belonged to is not recorded, so there is
      // nothing honest to return.
      if (!ref || ref === 'HEAD') return null;

      const name = ref.replace(/^refs\/(heads|remotes)\//, '').replace(/^origin\//, '');
      if (name === branch) return null;

      // Only report a branch that still exists; a base that has been deleted
      // would fail at the API with a message about the wrong thing.
      const exists =
        (await this.tryExec(['rev-parse', '--verify', `refs/heads/${name}`])) ??
        (await this.tryExec(['rev-parse', '--verify', `refs/remotes/origin/${name}`]));

      return exists ? name : null;
    }

    return null;
  }

  /**
   * Every local branch, current one first.
   *
   * Used where a caller needs to offer a real choice of target branch rather
   * than the auto-resolved one — the branch the developer actually wants to
   * land on is not always the one `resolveBaseBranch` guesses.
   */
  async listBranches(): Promise<string[]> {
    const out = (await this.tryExec(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])) ?? '';
    const names = out.split('\n').map((line) => line.trim()).filter(Boolean);
    const current = await this.currentBranch().catch(() => null);
    if (!current) return names;
    return [current, ...names.filter((name) => name !== current)];
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
    options: CommitOptions = {},
  ): Promise<string | null> {
    if (paths.length === 0) return null;

    // `--` guards against a path that looks like a flag.
    await this.exec(['add', '--', ...paths]);

    const staged = await this.exec(['diff', '--cached', '--name-only']);
    if (!staged.trim()) return null;

    await this.exec(['commit', '-m', message(subject, body, options)]);

    return this.headSha();
  }

  async commitAll(
    subject: string,
    body = '',
    options: CommitOptions & {
      allowEmpty?: boolean;
      identity?: { name: string; email: string };
    } = {},
  ): Promise<string | null> {
    await this.exec(['add', '-A']);

    const staged = await this.exec(['diff', '--cached', '--name-only']);
    if (!staged.trim() && !options.allowEmpty) return null;

    const message_ = message(subject, body, options);
    await this.exec(
      ['commit', ...(options.allowEmpty ? ['--allow-empty'] : []), '-m', message_],
      options.identity
        ? {
            GIT_AUTHOR_NAME: options.identity.name,
            GIT_AUTHOR_EMAIL: options.identity.email,
            GIT_COMMITTER_NAME: options.identity.name,
            GIT_COMMITTER_EMAIL: options.identity.email,
          }
        : undefined,
    );

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
  /* Worktrees — the machinery behind running agents side by side        */
  /* ------------------------------------------------------------------ */

  /**
   * A second working tree, checked out at `ref`, sharing this repository.
   *
   * The whole reason parallel fixes are possible at all. Two agents pointed at
   * one directory overwrite each other's edits and each other's commit scopes;
   * two agents in two worktrees cannot see each other, and Drift reconciles
   * their output afterwards, in plan order, through the workspace API.
   *
   * Always `--detach`. A worktree that checked out a branch would take that
   * branch hostage — git refuses to have one branch checked out in two places,
   * so the developer's own branch would become unusable while a fix ran, and a
   * crashed run would leave it that way.
   */
  async addWorktree(path: string, ref: string): Promise<void> {
    await this.exec(['worktree', 'add', '--detach', '--quiet', path, ref]);
  }

  /**
   * Take a worktree back down.
   *
   * `--force` because the point of the worktree is that an agent edited it: a
   * clean removal would refuse precisely when the run succeeded. Nothing is
   * lost — the caller has already read the file contents it cares about back
   * into the real working tree by the time this runs.
   */
  async removeWorktree(path: string): Promise<void> {
    await this.exec(['worktree', 'remove', '--force', path]);
  }

  /** Forget worktrees whose directories are gone, after a crash or a manual delete. */
  async pruneWorktrees(): Promise<void> {
    await this.tryExec(['worktree', 'prune']);
  }

  /** Whether this git can do worktrees at all. Added in 2.5; older ones exist in the wild. */
  async supportsWorktrees(): Promise<boolean> {
    return (await this.tryExec(['worktree', 'list', '--porcelain'])) !== null;
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

  /**
   * Turn a tree object into a real commit, without moving any ref.
   *
   * The commit is reachable only by the SHA this returns — nothing points at
   * it, so it never shows up in `git log`, never becomes a branch tip, and is
   * ordinary garbage the next `git gc` is free to collect once nothing (like a
   * worktree) still references it. That is exactly the property a disposable
   * agent worktree needs: a real commit to check out at, built from whatever
   * is in the working tree right now — including edits nothing has committed
   * yet — without disturbing the branch the developer is actually on.
   */
  async commitTree(tree: string, parent: string, message: string): Promise<string> {
    return (await this.exec(['commit-tree', tree, '-p', parent, '-m', message])).trim();
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
