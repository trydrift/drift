import { Octokit } from '@octokit/rest';
import type { RepoContext } from '../types.js';
import type { Logger } from '../util/logger.js';
import type { RepoProvider } from '../repo/provider.js';
import type { RepoPermission } from '../approval/authorize.js';

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

  /** Read a file at a ref. Returns `null` for missing files rather than throwing. */
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
      return null;
    }
  }

  /** Files changed between two commits, for locating manifest edits. */
  async changedFiles(repo: RepoContext): Promise<string[]> {
    try {
      const response = await this.octokit.repos.compareCommitsWithBasehead({
        owner: repo.owner,
        repo: repo.repo,
        basehead: `${repo.beforeSha}...${repo.afterSha}`,
      });
      return (response.data.files ?? []).map((f) => f.filename);
    } catch (err) {
      this.logger.warn(`Could not compare ${repo.beforeSha}...${repo.afterSha}: ${(err as Error).message}`);
      return [];
    }
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
        this.logger.info(`Branch ${branchName} already exists; reusing it`);
        return true;
      }
      this.logger.error(`Could not create branch ${branchName}: ${(err as Error).message}`);
      return false;
    }
  }

  async createIssue(
    repo: RepoContext,
    params: { title: string; body: string; labels?: string[] },
  ): Promise<{ number: number; url: string } | null> {
    try {
      const response = await this.octokit.issues.create({
        owner: repo.owner,
        repo: repo.repo,
        title: params.title,
        body: params.body,
        labels: params.labels,
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
    };
  }

  /** Escape hatch for calls the wrapper does not cover. */
  get rest(): Octokit {
    return this.octokit;
  }
}

function isNotFound(err: unknown): boolean {
  return (err as { status?: number })?.status === 404;
}

function isAlreadyExists(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  const message = (err as Error)?.message ?? '';
  return status === 422 && /already exists/i.test(message);
}
