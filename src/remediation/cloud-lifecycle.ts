import type { PendingCopilotTask } from '../queue/types.js';
import type { RemediationPlan, RepoContext } from '../types.js';
import type { GitHubClient } from '../github/client.js';
import type { Logger } from '../util/logger.js';
import { validateCloudChangedFiles } from '../agents/scope.js';

export interface CloudTaskStatus {
  state: string;
  pullRequestUrl?: string;
}

export interface CloudTaskMonitor {
  provider: string;
  label: string;
  status(task: PendingCopilotTask, repo: RepoContext): Promise<CloudTaskStatus | null>;
  isTerminalState(state: string): boolean;
}

export interface CloudTaskReconciliation {
  terminal: boolean;
  state?: string;
  conclusion?: 'success' | 'failure' | 'action_required';
  title?: string;
  summary?: string;
}

export async function reconcileCloudTask(options: {
  task: PendingCopilotTask;
  monitor: CloudTaskMonitor;
  github: GitHubClient;
  logger: Logger;
}): Promise<CloudTaskReconciliation> {
  const { task, monitor, github, logger } = options;
  const repo: RepoContext = {
    owner: task.owner,
    repo: task.repo,
    baseBranch: '',
    beforeSha: '',
    afterSha: task.headSha,
  };

  const status = await monitor.status(task, repo);
  if (!status || !monitor.isTerminalState(status.state)) return { terminal: false };

  if (status.state !== 'completed') {
    return {
      terminal: true,
      state: status.state,
      conclusion: 'failure',
      title: `${monitor.label} did not finish (${status.state})`,
      summary: `The ${monitor.label} task ended in state \`${status.state}\` without finishing the fix. ${
        task.prUrl ?? status.pullRequestUrl ? `See ${task.prUrl ?? status.pullRequestUrl} for what it left behind.` : 'A human needs to look at this.'
      }`,
    };
  }

  const plan = parsePlan(task.planJson);
  if (!plan) {
    return {
      terminal: true,
      state: status.state,
      conclusion: 'action_required',
      title: `${monitor.label} finished; scope validation unavailable`,
      summary:
        `${monitor.label} completed, but this pending task was recorded without a remediation plan. ` +
        'Drift cannot validate allowed files or protected paths after completion; review the branch manually.',
    };
  }

  const head = task.branchName ? await github.getBranchHead(repo, task.branchName) : null;
  if (!head) {
    return {
      terminal: true,
      state: status.state,
      conclusion: 'failure',
      title: `${monitor.label} finished, but Drift could not inspect the branch`,
      summary: `Drift could not read the head of branch \`${task.branchName || '(unknown)'}\`, so it could not reconcile the cloud result.`,
    };
  }

  let changedFiles: string[];
  try {
    changedFiles = await github.changedFiles({ ...repo, beforeSha: task.headSha, afterSha: head });
  } catch (err) {
    logger.warn(`Could not compare ${task.headSha}...${head} for ${task.owner}/${task.repo}: ${(err as Error).message}`);
    return {
      terminal: true,
      state: status.state,
      conclusion: 'action_required',
      title: `${monitor.label} finished; diff inspection failed`,
      summary: `Drift could not inspect the branch diff after ${monitor.label} completed, so protected-path validation did not run.`,
    };
  }

  const validation = validateCloudChangedFiles({ plan, changedFiles });
  const where = task.prUrl ?? status.pullRequestUrl;
  if (!validation.ok) {
    return {
      terminal: true,
      state: status.state,
      conclusion: 'failure',
      title: `${monitor.label} changed files outside Drift's allowed scope`,
      summary: [`${monitor.label} completed, but Drift found post-agent scope violations:`, ...validation.reasons.map((reason) => `- ${reason}`), where ? `\nSee ${where}.` : ''].filter(Boolean).join('\n'),
    };
  }

  return {
    terminal: true,
    state: status.state,
    conclusion: 'success',
    title: `${monitor.label} finished and Drift reconciled the branch`,
    summary: [
      where ? `See ${where} for the result.` : 'The cloud agent task completed.',
      ...validation.warnings.map((warning) => `\n${warning}`),
    ].join(''),
  };
}

function parsePlan(json: string | null): RemediationPlan | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as RemediationPlan;
  } catch {
    return null;
  }
}
