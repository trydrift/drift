import type { PendingCloudTask } from '../queue/types.js';
import type { RemediationPlan, RepoContext } from '../types.js';
import type { GitHubClient } from '../github/client.js';
import type { Logger } from '../util/logger.js';
import { validateCloudChangedFiles } from '../agents/scope.js';
import type { CloudAgentTaskRef, CloudFixAgent } from '../agents/types.js';

export interface CloudTaskMonitor {
  provider: string;
  label: string;
  status(task: PendingCloudTask, repo: RepoContext): Promise<{ state: string; pullRequestUrl?: string } | null>;
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
  task: PendingCloudTask;
  agent: CloudFixAgent;
  github: GitHubClient;
  logger: Logger;
}): Promise<CloudTaskReconciliation> {
  const { task, agent, github, logger } = options;
  const label = agent.label;
  const repo: RepoContext = {
    owner: task.owner,
    repo: task.repo,
    baseBranch: '',
    beforeSha: '',
    afterSha: task.headSha,
  };

  const status = await agent.status({
    provider: task.provider,
    id: task.taskId,
    state: task.state ?? undefined,
    branch: task.branchName,
    url: task.prUrl ?? undefined,
  });
  if (!status || !agent.isTerminalState(status.state)) return { terminal: false };

  if (status.state !== 'completed') {
    return {
      terminal: true,
      state: status.state,
      conclusion: 'failure',
      title: `${label} did not finish (${status.state})`,
      summary: `The ${label} task ended in state \`${status.state}\` without finishing the fix. ${
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
      title: `${label} finished; scope validation unavailable`,
      summary:
        `${label} completed, but this pending task was recorded without a remediation plan. ` +
        'Drift cannot validate allowed files or protected paths after completion; review the branch manually.',
    };
  }

  const head = task.branchName ? await github.getBranchHead(repo, task.branchName) : null;
  if (!head) {
    return {
      terminal: true,
      state: status.state,
      conclusion: 'failure',
      title: `${label} finished, but Drift could not inspect the branch`,
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
      title: `${label} finished; diff inspection failed`,
      summary: `Drift could not inspect the branch diff after ${label} completed, so protected-path validation did not run.`,
    };
  }

  const validation = validateCloudChangedFiles({ plan, changedFiles });
  const where = task.prUrl ?? status.pullRequestUrl;
  if (!validation.ok) {
    return {
      terminal: true,
      state: status.state,
      conclusion: 'failure',
      title: `${label} changed files outside Drift's allowed scope`,
      summary: [`${label} completed, but Drift found post-agent scope violations:`, ...validation.reasons.map((reason) => `- ${reason}`), where ? `\nSee ${where}.` : ''].filter(Boolean).join('\n'),
    };
  }

  return {
    terminal: true,
    state: status.state,
    conclusion: 'success',
    title: `${label} finished and Drift reconciled the branch`,
    summary: [
      where ? `See ${where} for the result.` : 'The cloud agent task completed.',
      ...validation.warnings.map((warning) => `\n${warning}`),
    ].join(''),
  };
}

export async function awaitTerminalCloudTask(options: {
  agent: CloudFixAgent;
  handle: CloudAgentTaskRef;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<{ state: string; pullRequestUrl?: string } | null> {
  const deadline = Date.now() + options.timeoutMs;
  let current = options.handle;

  while (Date.now() <= deadline) {
    const status = await options.agent.status(current);
    if (status && options.agent.isTerminalState(status.state)) return status;
    if (status) current = { ...current, state: status.state, url: status.pullRequestUrl ?? current.url };
    await sleep(Math.min(options.pollIntervalMs, Math.max(0, deadline - Date.now())));
  }

  return null;
}

function parsePlan(json: string | null): RemediationPlan | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as RemediationPlan;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
