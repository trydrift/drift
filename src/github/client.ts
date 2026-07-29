import { Octokit } from '@octokit/rest';
import type { RepoContext } from '../types.js';
import type { Logger } from '../util/logger.js';
import type { RepoProvider } from '../repo/provider.js';

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

  async commentOnIssue(repo: RepoContext, issueNumber: number, body: string): Promise<void> {
    try {
      await this.octokit.issues.createComment({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: issueNumber,
        body,
      });
    } catch (err) {
      this.logger.warn(`Could not comment on #${issueNumber}: ${(err as Error).message}`);
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
