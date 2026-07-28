import type { DispatchResult, RemediationPlan, RepoContext } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import type { GitHubClient } from '../github/client.js';
import { isAutoDispatchable } from '../plan/index.js';
import { renderApprovalIssue, renderPullRequestBody, renderSummaryLine } from '../report/markdown.js';
import { dispatchToCopilot } from './copilot.js';

/**
 * Dispatch: decide what to do with a plan, and do it.
 *
 * The decision tree is deliberately shallow and has exactly one branch that
 * results in code being written:
 *
 *   nothing to fix      -> report and stop
 *   blocked or approve  -> file an issue with the full plan and stop
 *   auto and unblocked  -> create branch, hand to Copilot, open PR
 *
 * Even the last path stops short of merging. Drift's output is always something
 * a human opens, never something that has already landed.
 */

export const DRIFT_LABEL = 'drift';

export interface DispatchOptions {
  repo: RepoContext;
  plan: RemediationPlan;
  config: DriftConfig;
  github: GitHubClient;
  logger: Logger;
  /** User-scoped Copilot token. Absent means dispatch cannot proceed. */
  copilotToken?: string;
  /** Analyse and report, but never create branches, issues, or tasks. */
  dryRun?: boolean;
  /**
   * Force dispatch despite `approve` mode — set when a human has explicitly
   * approved via `/drift apply`. Guardrail blockers are still enforced.
   */
  approved?: boolean;
}

export async function dispatch(options: DispatchOptions): Promise<DispatchResult> {
  const { repo, plan, config, github, logger, copilotToken, dryRun = false, approved = false } = options;

  if (plan.commits.length === 0) {
    logger.info('No affected code found; nothing to dispatch.');
    await postCheckRun(options, 'success', 'No action needed');
    return {
      status: 'skipped',
      planId: plan.id,
      message: 'Dependency changed, but no code in this repository uses the affected APIs.',
    };
  }

  const canDispatch = approved ? plan.blockers.length === 0 : isAutoDispatchable(plan, config);

  if (!canDispatch) {
    return requestApproval(options);
  }

  if (!copilotToken) {
    logger.warn(
      'Drift is in auto mode with an actionable plan, but no Copilot token is available. Falling back to approval.',
    );
    return requestApproval({
      ...options,
      plan: {
        ...plan,
        blockers: [
          ...plan.blockers,
          'No Copilot token was available. Set the `DRIFT_COPILOT_TOKEN` secret to a user-scoped token with `actions`, `contents`, `issues`, and `pull_requests` write access. The Copilot agent API does not accept GitHub App installation tokens.',
        ],
      },
    });
  }

  if (dryRun) {
    logger.info(`Dry run: would dispatch ${plan.commits.length} commit(s) on ${plan.branchName}`);
    const preview = await dispatchToCopilot({
      copilotToken,
      repo,
      plan,
      config,
      logger,
      dryRun: true,
    });
    logger.debug('Copilot prompt preview', { length: preview.prompt.length });
    return {
      status: 'skipped',
      planId: plan.id,
      branchName: plan.branchName,
      message: `Dry run — no changes made. Would create branch \`${plan.branchName}\` and dispatch ${plan.commits.length} commit(s).`,
    };
  }

  // The branch is created by Drift rather than left to the agent so the base
  // ref is pinned to the exact commit that was analysed. If the branch moved
  // under us, the plan's impact sites would no longer be trustworthy.
  const branchCreated = await github.createBranch(repo, plan.branchName, repo.afterSha);
  if (!branchCreated) {
    return {
      status: 'failed',
      planId: plan.id,
      message: `Could not create branch \`${plan.branchName}\`. Check that the token has \`contents: write\`.`,
    };
  }

  const result = await dispatchToCopilot({ copilotToken, repo, plan, config, logger });

  if (!result.ok) {
    logger.error(`Copilot dispatch failed: ${result.error}`);
    // A dispatch failure falls back to approval rather than silently dropping
    // the analysis — the work is still valuable to a human.
    const fallback = await requestApproval({
      ...options,
      plan: { ...plan, blockers: [...plan.blockers, result.error ?? 'Copilot dispatch failed.'] },
    });
    return { ...fallback, status: 'failed', message: result.error ?? 'Copilot dispatch failed.' };
  }

  await postCheckRun(options, 'neutral', `Copilot is fixing ${plan.breakingChanges.length} breaking change(s)`);

  const task = result.task;
  logger.info(`Dispatched to Copilot: task ${task?.id ?? 'unknown'} on ${plan.branchName}`);

  return {
    status: 'dispatched',
    planId: plan.id,
    branchName: plan.branchName,
    taskId: task?.id,
    pullRequestNumber: task?.pullRequestNumber,
    pullRequestUrl: task?.pullRequestUrl,
    message: `Copilot is working on ${plan.commits.length} commit(s) on \`${plan.branchName}\`. A pull request into \`${plan.baseBranch}\` will follow.`,
  };
}

/**
 * File the plan for a human.
 *
 * The issue *is* the state store. Plan IDs are content-derived, so re-running
 * the same analysis finds the existing issue instead of filing a duplicate —
 * which is how the approval flow works without a database.
 */
async function requestApproval(options: DispatchOptions): Promise<DispatchResult> {
  const { repo, plan, config, github, logger, dryRun = false } = options;

  const reason =
    plan.blockers.length > 0
      ? `blocked by ${plan.blockers.length} guardrail(s)`
      : `mode is \`${config.mode}\``;

  logger.info(`Requesting human approval (${reason})`);
  await postCheckRun(options, 'action_required', 'Drift needs your approval');

  if (dryRun) {
    return {
      status: 'blocked',
      planId: plan.id,
      message: `Dry run — would open an approval issue (${reason}).`,
    };
  }

  const existing = await github.findOpenPlanIssue(repo, plan.id);
  if (existing !== null) {
    logger.info(`Plan ${plan.id} already filed as issue #${existing}; not duplicating`);
    return {
      status: 'blocked',
      planId: plan.id,
      approvalIssueNumber: existing,
      message: `Already awaiting approval in #${existing}.`,
    };
  }

  const issue = await github.createIssue(repo, {
    title: approvalTitle(plan),
    body: renderApprovalIssue(plan, config),
    labels: [DRIFT_LABEL, `drift:risk-${plan.risk}`],
  });

  if (!issue) {
    return {
      status: 'failed',
      planId: plan.id,
      message: 'Could not open an approval issue. Check that the token has `issues: write`.',
    };
  }

  return {
    status: 'blocked',
    planId: plan.id,
    approvalIssueNumber: issue.number,
    message: `Awaiting approval in #${issue.number} (${reason}). Comment \`/drift apply\` to proceed.`,
  };
}

function approvalTitle(plan: RemediationPlan): string {
  if (plan.changes.length === 1) {
    const change = plan.changes[0]!;
    return `[Drift] ${change.name} ${change.from ?? '—'} → ${change.to ?? '—'} needs ${plan.commits.length} fix(es)`;
  }
  return `[Drift] ${plan.changes.length} dependency updates need ${plan.commits.length} fix(es)`;
}

async function postCheckRun(
  options: DispatchOptions,
  conclusion: 'success' | 'neutral' | 'action_required' | 'failure',
  title: string,
): Promise<void> {
  const { repo, plan, config, github, dryRun } = options;
  if (dryRun) return;

  await github.createCheckRun(repo, {
    name: 'Drift',
    conclusion,
    title,
    summary: renderSummaryLine(plan),
    text: renderPullRequestBody(plan, config),
  });
}

export * from './copilot.js';
