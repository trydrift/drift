import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitHubClient } from '../github/client.js';
import type { RepoContext } from '../types.js';
import type { Logger } from '../util/logger.js';
import {
  branchNameFor,
  buildIssueContent,
  issueMarker,
  type IssueBranchOutcome,
  type IssueBranchTarget,
} from './issue-branch.js';

const run = promisify(execFile);

/**
 * The CLI's side of the one-click issue/branch action: plain `git` shelled
 * out with `execFile` (there is no extension-style `Git` wrapper outside
 * `extension/src/git.ts`, and this needs none of its worktree machinery),
 * and the `GitHubClient` the CLI already constructs for every command.
 * Every function here returns an `IssueBranchOutcome` and never throws — a
 * missing repo, a missing token, or a rejected API call is data the caller
 * decides what to do with, not a crash.
 */

/** File (or find) the GitHub issue for a target. */
export async function createIssueForTarget(
  github: GitHubClient | null,
  repo: RepoContext,
  target: IssueBranchTarget,
  logger: Logger,
  linkedBranch?: string,
): Promise<IssueBranchOutcome> {
  if (!github) return { kind: 'unavailable', reason: 'no-token' };

  const marker = issueMarker(target);
  const existing = await github.findOpenPlanIssue(repo, marker);
  if (existing !== null) {
    logger.debug(`${target.dependency} already filed as issue #${existing}; not duplicating`);
    return {
      kind: 'issue',
      status: 'existing',
      number: existing,
      url: `https://github.com/${repo.owner}/${repo.repo}/issues/${existing}`,
    };
  }

  const content = buildIssueContent(target, linkedBranch);
  const issue = await github.createIssue(repo, content);
  if (!issue) {
    return { kind: 'failed', message: 'GitHub did not accept the issue. Check that the token has `issues: write`.' };
  }
  return { kind: 'issue', status: 'created', number: issue.number, url: issue.url };
}

/** Create (or check out) a local branch for a target. */
export async function createBranchForTarget(
  workspace: string,
  target: IssueBranchTarget,
  logger: Logger,
): Promise<IssueBranchOutcome> {
  const insideRepo = await git(['rev-parse', '--is-inside-work-tree'], workspace);
  if (insideRepo?.trim() !== 'true') return { kind: 'unavailable', reason: 'no-git-repo' };

  const name = branchNameFor(target);
  const exists = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], workspace)) !== null;

  try {
    if (exists) {
      await run('git', ['checkout', name], { cwd: workspace, windowsHide: true });
      return { kind: 'branch', status: 'existing', name };
    }
    await run('git', ['checkout', '-b', name], { cwd: workspace, windowsHide: true });
    return { kind: 'branch', status: 'created', name };
  } catch (err) {
    logger.warn(`Could not create branch ${name}: ${(err as Error).message}`);
    return { kind: 'failed', message: (err as Error).message };
  }
}

/** Run both actions for a target, linking the issue to the branch it creates. */
export async function createIssueAndBranchForTarget(
  github: GitHubClient | null,
  repo: RepoContext,
  workspace: string,
  target: IssueBranchTarget,
  logger: Logger,
): Promise<{ branch: IssueBranchOutcome; issue: IssueBranchOutcome }> {
  const branch = await createBranchForTarget(workspace, target, logger);
  const linkedBranch = branch.kind === 'branch' ? branch.name : undefined;
  const issue = await createIssueForTarget(github, repo, target, logger, linkedBranch);
  return { branch, issue };
}

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, { cwd, windowsHide: true });
    return stdout;
  } catch {
    return null;
  }
}
