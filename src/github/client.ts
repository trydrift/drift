import { gzipSync } from 'node:zlib';
import { Octokit } from '@octokit/rest';
import type { RepoContext } from '../types.js';
import type { Logger } from '../util/logger.js';
import type { RepoProvider } from '../repo/provider.js';
import type { RepoPermission } from '../approval/authorize.js';

// Mirrors `DRIFT_LABEL` in `dispatch/index.ts`. Not imported from there:
// dispatch already imports this module for the `GitHubClient` type, and a
// label string is not worth a cycle.
const DRIFT_LABEL = 'drift';

/**
 * GitHub API access.
 *
 * Drift uses two distinct tokens and the distinction is not incidental — it is
 * the reason this MVP needs no database:
 *
 *   `repoToken`     — the Action's built-in GITHUB_TOKEN or a GitHub App
 *                     installation token. Reads the repo, opens issues,
 *                     creates branches, posts check runs.
 *
 *   `copilotToken`  — a *user-scoped* token, supplied by the user as a repo
 *                     secret. Required because GitHub bills Copilot per user
 *                     and rejects server-to-server tokens on the agent API.
 *
 * Drift never stores the Copilot token. It lives in the customer's own GitHub
 * secret store and is read from the environment at run time. See
 * docs/copilot-integration.md for why this shapes the whole architecture.
 */

export interface GitHubClientOptions {
  repoToken: string;
  logger: Logger;
  baseUrl?: string;
}

export class GitHubClient {
  private readonly octokit: Octokit;
  private readonly logger: Logger;
  /** `undefined` = not yet asked, `null` = asked and unavailable. */
  private selfLogin: string | null | undefined;

  constructor(options: GitHubClientOptions) {
    this.octokit = new Octokit({
      auth: options.repoToken,
      baseUrl: options.baseUrl ?? 'https://api.github.com',
      userAgent: 'drift-bot/0.1',
    });
    this.logger = options.logger;
  }

  /**
   * Read a file at a ref. Returns `null` for a confirmed 404 (the file does not
   * exist there); any other failure (rate limit, network, auth) throws rather
   * than being reported as a missing file, since callers treat `null` as a fact
   * about the repository's contents, not as "the API call did not work."
   */
  async readFile(repo: RepoContext, path: string, ref: string): Promise<string | null> {
    try {
      const response = await this.octokit.repos.getContent({
        owner: repo.owner,
        repo: repo.repo,
        path,
        ref,
      });

      const data = response.data;
      if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return null;

      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (err) {
      if (isNotFound(err)) return null;
      this.logger.debug(`Failed to read ${path}@${ref}: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Every file in the tree at a ref, for expanding configured path patterns.
   *
   * Returns `null` rather than `[]` on any failure, and on a tree GitHub
   * truncated. A partial listing is worse than no listing here: the caller
   * expands globs against it, so a file missing from the list becomes a
   * contract that was silently never compared.
   */
  async listFiles(repo: RepoContext, ref: string): Promise<string[] | null> {
    try {
      const response = await this.octokit.git.getTree({
        owner: repo.owner,
        repo: repo.repo,
        tree_sha: ref,
        recursive: 'true',
      });

      if (response.data.truncated) {
        this.logger.warn(
          `The file tree at ${ref} is too large for GitHub to return in full, so path patterns ` +
            `cannot be expanded against it. List the contract documents by literal path instead.`,
        );
        return null;
      }

      return response.data.tree
        .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string')
        .map((entry) => entry.path as string);
    } catch (err) {
      this.logger.debug(`Could not list the tree at ${ref}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Files changed between two commits, for locating manifest edits.
   *
   * Returns `[]` only for a genuinely empty diff. A failed comparison (rate
   * limit, network, auth, 5xx) throws instead, since an empty list here reads
   * as "nothing changed" to every caller.
   */
  async changedFiles(repo: RepoContext): Promise<string[]> {
    try {
      const response = await this.octokit.repos.compareCommitsWithBasehead({
        owner: repo.owner,
        repo: repo.repo,
        basehead: `${repo.beforeSha}...${repo.afterSha}`,
      });
      const files = response.data.files ?? [];

      // GitHub caps the compare endpoint's `files` array at 300 entries, with
      // no `truncated` flag — 300 exactly is the only signal. Below that cap,
      // or with fewer commits than exist between the two SHAs (paginated at
      // 250), a manifest past the cutoff would silently vanish from analysis.
      const commits = response.data.commits ?? [];
      const truncated = files.length >= 300 || commits.length < response.data.total_commits;
      if (!truncated) return files.map((f) => f.filename);

      this.logger.warn(
        `Comparison ${repo.beforeSha}...${repo.afterSha} exceeds GitHub's per-request limits ` +
          `(${response.data.total_commits} commits); falling back to per-commit file listing.`,
      );
      return await this.changedFilesByCommit(repo);
    } catch (err) {
      this.logger.warn(`Could not compare ${repo.beforeSha}...${repo.afterSha}: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Fallback for `changedFiles` when the comparison is too large for a single
   * request: walk every commit between the two SHAs (paginated) and union
   * each commit's own file list (also paginated per-commit, since a single
   * commit can itself touch more than 300 files).
   */
  private async changedFilesByCommit(repo: RepoContext): Promise<string[]> {
    const shas = new Set<string>();
    for await (const page of this.octokit.paginate.iterator(this.octokit.repos.compareCommitsWithBasehead, {
      owner: repo.owner,
      repo: repo.repo,
      basehead: `${repo.beforeSha}...${repo.afterSha}`,
      per_page: 250,
    })) {
      const data = page.data as { commits?: { sha: string }[] };
      for (const commit of data.commits ?? []) shas.add(commit.sha);
    }

    const filenames = new Set<string>();
    for (const sha of shas) {
      for await (const page of this.octokit.paginate.iterator(this.octokit.repos.getCommit, {
        owner: repo.owner,
        repo: repo.repo,
        ref: sha,
        per_page: 300,
      })) {
        const data = page.data as { files?: { filename: string }[] };
        for (const file of data.files ?? []) filenames.add(file.filename);
      }
    }
    return [...filenames];
  }

  /**
   * Create a branch at a commit.
   *
   * Idempotent by design: a re-run on the same commit finds the branch already
   * present and proceeds rather than failing. Drift runs are content-addressed,
   * so the same input genuinely should produce the same branch.
   */
  async createBranch(repo: RepoContext, branchName: string, sha: string): Promise<boolean> {
    try {
      await this.octokit.git.createRef({
        owner: repo.owner,
        repo: repo.repo,
        ref: `refs/heads/${branchName}`,
        sha,
      });
      this.logger.info(`Created branch ${branchName} at ${sha.slice(0, 7)}`);
      return true;
    } catch (err) {
      if (isAlreadyExists(err)) {
        // The branch name is stable across retries of the same analysed
        // commit, so finding it already there is the common case. But a
        // same-day retry after the base branch has moved must not silently
        // reuse a branch built on a different tree — exact-line-anchored
        // fixes would then apply to the wrong commit. Only reuse the branch
        // when `sha` is the tip it already has, or is an ancestor of it (the
        // branch already carries remediation commits on top of `sha`).
        const head = await this.getBranchHead(repo, branchName);
        if (head === sha) {
          this.logger.info(`Branch ${branchName} already exists at ${sha.slice(0, 7)}; reusing it`);
          return true;
        }
        if (head && (await this.isAncestor(repo, sha, head))) {
          // Being ahead of `sha` only says the branch has *some* extra
          // commits — it says nothing about who made them. A later
          // `commitFiles` call rebuilds its tree from the branch's current
          // tip and overlays whole-file blobs for the paths it touches, so
          // reusing a branch that a human pushed manual edits to would
          // silently overwrite those edits with content derived from the
          // stale `sha` checkout. Only reuse when every commit ahead of
          // `sha` is Drift's own.
          if (await this.commitsAreAllBots(repo, sha, head)) {
            this.logger.info(
              `Branch ${branchName} already exists ahead of ${sha.slice(0, 7)}; reusing it`,
            );
            return true;
          }
          this.logger.error(
            `Branch ${branchName} already exists ahead of ${sha.slice(0, 7)} with commit(s) not made by ` +
              `Drift; refusing to reuse a branch that may carry manual changes`,
          );
          return false;
        }
        this.logger.error(
          `Branch ${branchName} already exists but is not based on ${sha.slice(0, 7)} ` +
            `(current head: ${head ?? 'unknown'}); refusing to reuse a stale branch`,
        );
        return false;
      }
      this.logger.error(`Could not create branch ${branchName}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Whether `ancestor` is `descendant` itself or an ancestor of it. */
  private async isAncestor(repo: RepoContext, ancestor: string, descendant: string): Promise<boolean> {
    if (ancestor === descendant) return true;
    try {
      const response = await this.octokit.repos.compareCommitsWithBasehead({
        owner: repo.owner,
        repo: repo.repo,
        basehead: `${ancestor}...${descendant}`,
      });
      // `ahead` means `descendant` has `ancestor` in its history plus more
      // commits; `identical` means they are the same commit.
      return response.data.status === 'ahead' || response.data.status === 'identical';
    } catch {
      return false;
    }
  }

  /**
   * Whether every commit strictly after `base` up to and including `head` was
   * authored by a bot identity (login ending in `[bot]` — how GitHub renders
   * both Actions' own token and any GitHub App installation, which is
   * everything Drift itself ever commits as). A human-authored commit
   * anywhere in that range means the branch carries changes Drift did not
   * make and must not silently build on top of.
   */
  private async commitsAreAllBots(repo: RepoContext, base: string, head: string): Promise<boolean> {
    try {
      const response = await this.octokit.repos.compareCommitsWithBasehead({
        owner: repo.owner,
        repo: repo.repo,
        basehead: `${base}...${head}`,
      });
      const commits = response.data.commits ?? [];
      if (commits.length === 0) return true;
      return commits.every((c) => (c.author?.login ?? c.committer?.login ?? '').endsWith('[bot]'));
    } catch {
      // Unable to prove it — the ancestor check already established the
      // branch isn't behind `base`, so fail closed and decline the reuse.
      return false;
    }
  }

  /**
   * Commit a set of file edits directly to a branch via the Git Data API.
   *
   * Used only for remediation Drift can prove correct without a model — its
   * own codemods, and (only when explicitly enabled) a pinned community
   * recipe's output — so committing without a review step is acceptable the
   * same way it is in the VS Code extension: the fix, not the act of
   * committing it, is what carries the trust.
   *
   * Blob → tree → commit → ref update, rather than a local `git push`: the
   * Action's checkout may not have push-capable remote credentials wired up,
   * while `repoToken` already has API access. Fails closed — any error at any
   * step aborts without moving the branch ref, so a partial failure can never
   * leave the branch pointing at a half-written tree.
   */
  async commitFiles(
    repo: RepoContext,
    branch: string,
    files: readonly { path: string; content: string }[],
    message: string,
  ): Promise<{ sha: string } | null> {
    if (files.length === 0) return null;

    try {
      const ref = await this.octokit.git.getRef({
        owner: repo.owner,
        repo: repo.repo,
        ref: `heads/${branch}`,
      });
      const parentSha = ref.data.object.sha;

      const parentCommit = await this.octokit.git.getCommit({
        owner: repo.owner,
        repo: repo.repo,
        commit_sha: parentSha,
      });

      const tree = await Promise.all(
        files.map(async (file) => {
          const blob = await this.octokit.git.createBlob({
            owner: repo.owner,
            repo: repo.repo,
            content: Buffer.from(file.content, 'utf8').toString('base64'),
            encoding: 'base64',
          });
          return {
            path: file.path,
            mode: '100644' as const,
            type: 'blob' as const,
            sha: blob.data.sha,
          };
        }),
      );

      const newTree = await this.octokit.git.createTree({
        owner: repo.owner,
        repo: repo.repo,
        base_tree: parentCommit.data.tree.sha,
        tree,
      });

      const commit = await this.octokit.git.createCommit({
        owner: repo.owner,
        repo: repo.repo,
        message,
        tree: newTree.data.sha,
        parents: [parentSha],
      });

      await this.octokit.git.updateRef({
        owner: repo.owner,
        repo: repo.repo,
        ref: `heads/${branch}`,
        sha: commit.data.sha,
      });

      this.logger.info(`Committed ${files.length} file(s) to ${branch}: ${commit.data.sha.slice(0, 7)}`);
      return { sha: commit.data.sha };
    } catch (err) {
      this.logger.error(`Could not commit to ${branch}: ${(err as Error).message}`);
      return null;
    }
  }

  async createIssue(
    repo: RepoContext,
    params: { title: string; body: string; labels?: string[]; assignees?: string[] },
  ): Promise<{ number: number; url: string } | null> {
    try {
      const response = await this.octokit.issues.create({
        owner: repo.owner,
        repo: repo.repo,
        title: params.title,
        body: params.body,
        labels: params.labels,
        assignees: params.assignees,
      });
      return { number: response.data.number, url: response.data.html_url };
    } catch (err) {
      this.logger.error(`Could not create issue: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * The commenter's permission on this repository.
   *
   * Returns `null` when the answer is unknown — a 5xx, a rate limit, a token
   * without the scope to ask, or a permission string GitHub has added since
   * this was written. Every one of those is a case where Drift must refuse
   * rather than assume, so they are deliberately not collapsed into `'none'`:
   * "definitely has no access" and "could not find out" are different answers
   * and only one of them is a fact.
   *
   * A 404 *is* collapsed to `'none'`, because that is what GitHub returns for a
   * user who is not a collaborator, which is a real answer.
   */
  async getCollaboratorPermission(
    repo: RepoContext,
    username: string,
  ): Promise<RepoPermission | null> {
    try {
      const response = await this.octokit.repos.getCollaboratorPermissionLevel({
        owner: repo.owner,
        repo: repo.repo,
        username,
      });

      const level = response.data.permission;
      // GitHub reports `maintain` and `triage` through `role_name`; the older
      // `permission` field flattens both into `write`/`read`, which would
      // over-grant triage. Prefer the specific one when it is present.
      const roleName = (response.data as { role_name?: string }).role_name;
      const raw = (roleName ?? level ?? '').toLowerCase();

      switch (raw) {
        case 'admin':
        case 'maintain':
        case 'write':
        case 'triage':
        case 'read':
        case 'none':
          return raw;
        // `push`/`pull` are the REST spellings of write/read.
        case 'push':
          return 'write';
        case 'pull':
          return 'read';
        default:
          this.logger.warn(
            `Unrecognised permission \`${raw}\` for ${username}; treating it as unknown and refusing.`,
          );
          return null;
      }
    } catch (err) {
      if (isNotFound(err)) return 'none';
      this.logger.warn(
        `Could not determine ${username}'s permission on ${repo.owner}/${repo.repo}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * The login Drift is acting as.
   *
   * Used to make sure Drift never treats its own comments as approvals. Cached
   * because it is asked once per approval and never changes within a run.
   */
  async getAuthenticatedLogin(): Promise<string | null> {
    if (this.selfLogin !== undefined) return this.selfLogin;
    try {
      const response = await this.octokit.users.getAuthenticated();
      this.selfLogin = response.data.login;
    } catch {
      // An installation token cannot call this endpoint. That is expected, and
      // the caller pairs this with a static list of known bot logins.
      this.selfLogin = null;
    }
    return this.selfLogin;
  }

  /**
   * Fetch an issue.
   *
   * Webhook payloads carry the issue body, but Actions event payloads can be
   * truncated on large issues — and a truncated body is exactly the case where
   * the plan footer, which sits at the bottom, goes missing. Re-reading makes
   * the difference between "this plan is unreadable" and a correct approval.
   */
  async getIssue(
    repo: RepoContext,
    issueNumber: number,
  ): Promise<{
    number: number;
    body: string | null;
    state: string;
    labels: string[];
    pullRequest: boolean;
  } | null> {
    try {
      const response = await this.octokit.issues.get({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: issueNumber,
      });
      return {
        number: response.data.number,
        body: response.data.body ?? null,
        state: response.data.state,
        labels: response.data.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
        pullRequest: Boolean(response.data.pull_request),
      };
    } catch (err) {
      this.logger.warn(`Could not read issue #${issueNumber}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Comments on an issue, oldest first. Used to detect an already-applied plan. */
  async listIssueComments(
    repo: RepoContext,
    issueNumber: number,
  ): Promise<{ body: string | null; authorLogin: string | null }[]> {
    try {
      const response = await this.octokit.issues.listComments({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: issueNumber,
        per_page: 100,
      });
      return response.data.map((c) => ({ body: c.body ?? null, authorLogin: c.user?.login ?? null }));
    } catch (err) {
      this.logger.warn(`Could not list comments on #${issueNumber}: ${(err as Error).message}`);
      // An empty list would read as "never dispatched" and permit a duplicate
      // run, so this failure is reported to the caller rather than swallowed.
      throw err;
    }
  }

  /** True when the commit exists in this repository. */
  async commitExists(repo: RepoContext, sha: string): Promise<boolean> {
    try {
      await this.octokit.repos.getCommit({ owner: repo.owner, repo: repo.repo, ref: sha });
      return true;
    } catch {
      return false;
    }
  }

  /** Tip commit of a branch, or `null` if the branch is gone. */
  async getBranchHead(repo: RepoContext, branch: string): Promise<string | null> {
    try {
      const response = await this.octokit.repos.getBranch({
        owner: repo.owner,
        repo: repo.repo,
        branch,
      });
      return response.data.commit.sha;
    } catch {
      return null;
    }
  }

  /**
   * Returns whether the comment was actually posted.
   *
   * Some callers post a comment purely for visibility and can treat a failure
   * as best-effort. Others — the dispatch idempotency marker in
   * `approval/apply.ts` chief among them — depend on the comment existing to
   * make a later retry a no-op, and cannot tell that apart from success unless
   * this returns it. A `Promise<void>` here was exactly what let that class of
   * bug through: the marker read is entirely happy, but never happened.
   */
  async commentOnIssue(repo: RepoContext, issueNumber: number, body: string): Promise<boolean> {
    try {
      await this.octokit.issues.createComment({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: issueNumber,
        body,
      });
      return true;
    } catch (err) {
      this.logger.warn(`Could not comment on #${issueNumber}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Find an open Drift issue for the same plan.
   *
   * This is how the approval flow stays stateless: rather than a database of
   * pending plans, Drift asks GitHub whether it already filed this one. Plan
   * IDs are content-derived, so the same analysis always looks up the same
   * issue.
   */
  async findOpenPlanIssue(repo: RepoContext, planId: string): Promise<number | null> {
    try {
      const response = await this.octokit.search.issuesAndPullRequests({
        q: `repo:${repo.owner}/${repo.repo} is:issue is:open in:body "${planId}"`,
        per_page: 1,
      });
      return response.data.items[0]?.number ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Every open issue Drift has filed for a code-scanning alert, with the
   * hidden marker it embedded in the body.
   *
   * This is what lets a rescan tell "still open, not mentioned this run" from
   * "still affected": without enumerating what is currently open, there is no
   * way to notice that a finding disappeared and its issue should close.
   */
  async findOpenAlertIssues(repo: RepoContext): Promise<{ number: number; marker: string }[]> {
    try {
      const response = await this.octokit.search.issuesAndPullRequests({
        q: `repo:${repo.owner}/${repo.repo} is:issue is:open label:${DRIFT_LABEL} "drift-alert:"`,
        per_page: 100,
      });
      const found: { number: number; marker: string }[] = [];
      for (const item of response.data.items) {
        const match = /<!--\s*(drift-alert:\S+)\s*-->/.exec(item.body ?? '');
        if (match) found.push({ number: item.number, marker: match[1]! });
      }
      return found;
    } catch {
      return [];
    }
  }

  async updateIssueBody(repo: RepoContext, issueNumber: number, body: string): Promise<void> {
    try {
      await this.octokit.issues.update({ owner: repo.owner, repo: repo.repo, issue_number: issueNumber, body });
    } catch (err) {
      this.logger.warn(`Could not update issue #${issueNumber}: ${(err as Error).message}`);
    }
  }

  /** Close an issue Drift filed, optionally saying why before closing it. */
  async closeIssue(repo: RepoContext, issueNumber: number, comment?: string): Promise<void> {
    try {
      if (comment) await this.commentOnIssue(repo, issueNumber, comment);
      await this.octokit.issues.update({ owner: repo.owner, repo: repo.repo, issue_number: issueNumber, state: 'closed' });
    } catch (err) {
      this.logger.warn(`Could not close issue #${issueNumber}: ${(err as Error).message}`);
    }
  }

  async createCheckRun(
    repo: RepoContext,
    params: {
      name: string;
      conclusion: 'success' | 'neutral' | 'action_required' | 'failure';
      title: string;
      summary: string;
      text?: string;
    },
  ): Promise<void> {
    try {
      await this.octokit.checks.create({
        owner: repo.owner,
        repo: repo.repo,
        name: params.name,
        head_sha: repo.afterSha,
        status: 'completed',
        conclusion: params.conclusion,
        output: {
          title: params.title,
          summary: params.summary,
          text: params.text,
        },
      });
    } catch (err) {
      // Check runs need a GitHub App token; the Action's GITHUB_TOKEN cannot
      // always create them. This is cosmetic, so a failure is not fatal.
      this.logger.debug(`Could not create check run: ${(err as Error).message}`);
    }
  }

  /**
   * Upload a SARIF log to the repository's code scanning dashboard, so
   * Drift's findings show up as alerts next to CodeQL's and Scorecard's.
   *
   * Requires the workflow to grant `security-events: write`; a token without
   * it gets a 403, logged here as a warning that names the missing
   * permission rather than a stack trace, since a repository that never
   * added it is a normal, unremarkable state — not a bug in Drift.
   *
   * `ref` must be a fully-qualified ref (`refs/heads/main`), which is what
   * distinguishes this alert set from the same commit analysed on a
   * different branch — GitHub keys code scanning results by `(ref,
   * commit_sha)`, not by commit alone.
   */
  /**
   * A `500` here is usually GitHub's own upload endpoint hiccuping, not a
   * problem with the payload (verified by hand: a SARIF file GitHub had just
   * rejected with a `500` uploaded and processed cleanly seconds later, no
   * changes made). A transient `5xx` or network error is worth a couple of
   * retries before giving up; a `403` or other `4xx` is not — the payload or
   * the token won't be any different on the next attempt.
   */
  async uploadSarif(
    repo: RepoContext,
    params: { sarif: Record<string, unknown>; commitSha: string; ref: string },
  ): Promise<boolean> {
    const gzipped = gzipSync(Buffer.from(JSON.stringify(params.sarif), 'utf8'));
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.octokit.codeScanning.uploadSarif({
          owner: repo.owner,
          repo: repo.repo,
          commit_sha: params.commitSha,
          ref: params.ref,
          sarif: gzipped.toString('base64'),
        });
        this.logger.info('Uploaded SARIF results to code scanning.');
        return true;
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 403) {
          this.logger.warn(
            'Could not upload code scanning results: the token is missing `security-events: write`. ' +
              'Add it to the workflow job\'s `permissions` to enable Drift\'s code scanning alerts.',
          );
          return false;
        }

        const retryable = status === undefined || status >= 500;
        if (retryable && attempt < maxAttempts) {
          const delayMs = 500 * 2 ** (attempt - 1);
          this.logger.warn(
            `Code scanning upload failed (attempt ${attempt}/${maxAttempts}${status ? `, HTTP ${status}` : ''}); retrying in ${delayMs}ms.`,
          );
          await sleep(delayMs);
          continue;
        }

        // `error`, not `warn`: this is the last attempt, findings that exist
        // are simply not visible in the Security tab, and a warning-level
        // annotation is easy to miss in a run that otherwise reports success.
        this.logger.error(
          `Could not upload code scanning results after ${attempt} attempt${attempt === 1 ? '' : 's'}: ` +
            `${(err as Error).message || `HTTP ${status ?? 'unknown'}`}.`,
        );
        return false;
      }
    }
    return false;
  }

  async findPullRequestForBranch(repo: RepoContext, branchName: string): Promise<{ number: number; url: string } | null> {
    try {
      const response = await this.octokit.pulls.list({
        owner: repo.owner,
        repo: repo.repo,
        head: `${repo.owner}:${branchName}`,
        state: 'all',
        per_page: 1,
      });
      const pr = response.data[0];
      return pr ? { number: pr.number, url: pr.html_url } : null;
    } catch {
      return null;
    }
  }

  /**
   * Open a pull request, or return the one that already exists for this branch.
   *
   * Re-running an upgrade on a branch that already has a pull request is an
   * ordinary thing to do, and GitHub answers it with a 422 rather than a
   * pointer to the existing one. Turning that into "here is your pull request"
   * is the difference between a retry that works and an error a workflow log
   * shows in red for a run that actually succeeded.
   */
  async createPullRequest(
    repo: RepoContext,
    params: {
      head: string;
      base: string;
      title: string;
      body: string;
      draft?: boolean;
      labels?: readonly string[];
      reviewers?: readonly string[];
    },
  ): Promise<{ number: number; url: string; existing: boolean } | null> {
    try {
      const response = await this.octokit.pulls.create({
        owner: repo.owner,
        repo: repo.repo,
        head: params.head,
        base: params.base,
        title: params.title,
        body: params.body,
        draft: params.draft ?? false,
      });

      const number = response.data.number;
      await this.decoratePullRequest(repo, number, params);
      this.logger.info(`Opened pull request #${number}: ${params.head} → ${params.base}`);
      return { number, url: response.data.html_url, existing: false };
    } catch (err) {
      const existing = await this.findPullRequestForBranch(repo, params.head);
      if (existing) {
        this.logger.info(`Pull request #${existing.number} already open for ${params.head}`);
        return { ...existing, existing: true };
      }
      this.logger.error(`Could not open a pull request: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Labels and reviewers, applied after the fact.
   *
   * Separate calls because they need permissions the pull request itself does
   * not, and because failing to add a label must never lose the pull request
   * that was just opened successfully.
   */
  private async decoratePullRequest(
    repo: RepoContext,
    number: number,
    params: { labels?: readonly string[]; reviewers?: readonly string[] },
  ): Promise<void> {
    if (params.labels?.length) {
      try {
        await this.octokit.issues.addLabels({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: number,
          labels: [...params.labels],
        });
      } catch (err) {
        this.logger.warn(`Could not label #${number}: ${(err as Error).message}`);
      }
    }

    if (params.reviewers?.length) {
      try {
        // A team slug carries a `/`; GitHub takes the two in different fields.
        const teams = params.reviewers.filter((r) => r.includes('/')).map((r) => r.split('/').pop()!);
        const users = params.reviewers.filter((r) => !r.includes('/'));
        await this.octokit.pulls.requestReviewers({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: number,
          reviewers: users,
          team_reviewers: teams,
        });
      } catch (err) {
        this.logger.warn(`Could not request reviewers on #${number}: ${(err as Error).message}`);
      }
    }
  }

  async updatePullRequestBody(repo: RepoContext, number: number, body: string): Promise<void> {
    try {
      await this.octokit.pulls.update({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        body,
      });
    } catch (err) {
      this.logger.warn(`Could not update PR #${number}: ${(err as Error).message}`);
    }
  }

  async getDefaultBranch(owner: string, repo: string): Promise<string | null> {
    try {
      const response = await this.octokit.repos.get({ owner, repo });
      return response.data.default_branch;
    } catch {
      return null;
    }
  }

  /**
   * Adapt this client to the transport-agnostic RepoProvider interface.
   *
   * The analysis pipeline depends on the interface, never on Octokit, so the
   * same stages run unchanged against a local checkout in the editor and
   * against the API in CI.
   */
  asRepoProvider(repo: RepoContext): RepoProvider {
    return {
      changedFiles: () => this.changedFiles(repo),
      readFile: (path, ref) => this.readFile(repo, path, ref),
      listFiles: (ref) => this.listFiles(repo, ref),
    };
  }

  /** Escape hatch for calls the wrapper does not cover. */
  get rest(): Octokit {
    return this.octokit;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNotFound(err: unknown): boolean {
  return (err as { status?: number })?.status === 404;
}

function isAlreadyExists(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  const message = (err as Error)?.message ?? '';
  return status === 422 && /already exists/i.test(message);
}
