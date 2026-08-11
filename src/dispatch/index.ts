import type { DispatchResult, RemediationPlan, RepoContext } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import type { GitHubClient } from '../github/client.js';
import type { Exec } from '../util/exec.js';
import { isAutoDispatchable } from '../plan/index.js';
import { renderApprovalIssue, renderPullRequestBody, renderSummaryLine } from '../report/markdown.js';
import { titleFor } from '../plan/pull-request.js';
import { dispatchToCopilot } from './copilot.js';
import { applyDeterministicRemediation } from '../github/local-commit.js';
import { planForCommits } from '../remediation/partition.js';

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
  /** Injectable for tests; defaults to actually running commands. */
  exec?: Exec;
}

export async function dispatch(options: DispatchOptions): Promise<DispatchResult> {
  const { repo, plan, config, github, logger, copilotToken, dryRun = false, approved = false } = options;

  // Zero commits only means "not affected" when the plan has no blocking gap.
  // A blocker at this point — most often localization never having run, as on
  // the webhook path, which has no checkout to search — means impact was never
  // established, not ruled out. That case falls through to the same
  // canDispatch/requestApproval logic below, which already treats blockers as
  // reason to ask a human rather than to report success.
  if (plan.commits.length === 0 && plan.blockers.length === 0) {
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

  if (dryRun) {
    logger.info(`Dry run: would dispatch ${plan.commits.length} commit(s) on ${plan.branchName}`);
    const preview = copilotToken
      ? await dispatchToCopilot({ copilotToken, repo, plan, config, logger, dryRun: true })
      : undefined;
    if (preview) logger.debug('Copilot prompt preview', { length: preview.prompt.length });
    return {
      status: 'skipped',
      planId: plan.id,
      branchName: plan.branchName,
      message: `Dry run — no changes made. Would create branch \`${plan.branchName}\` and resolve ${plan.commits.length} commit(s) (deterministically where possible, otherwise via agent).`,
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

  // Resolve everything Drift can prove correct itself — its own codemods
  // always, a matching community recipe only when `remediation.communityRecipes`
  // is enabled — directly on the branch, before ever considering an agent.
  // A commit successfully committed this way is never handed to Copilot.
  const { committedIds } = await applyDeterministicRemediation({
    repo,
    plan,
    config,
    github,
    logger,
    exec: options.exec,
  });
  const remaining = plan.commits.filter((commit) => !committedIds.has(commit.id));

  if (remaining.length === 0) {
    logger.info(`Resolved all ${plan.commits.length} commit(s) deterministically; no agent was dispatched.`);
    await postCheckRun(
      options,
      'success',
      `Resolved ${plan.commits.length} breaking change commit(s) without an agent`,
    );
    const pr = await ensurePullRequest(options, undefined, undefined);
    return {
      status: 'dispatched',
      planId: plan.id,
      branchName: plan.branchName,
      pullRequestNumber: pr?.number,
      pullRequestUrl: pr?.url,
      message: pr
        ? `Resolved ${plan.commits.length} commit(s) on \`${plan.branchName}\` deterministically — no agent call was made. Tracked in pull request #${pr.number} into \`${plan.baseBranch}\`.`
        : `Resolved ${plan.commits.length} commit(s) on \`${plan.branchName}\` deterministically — no agent call was made. A pull request into \`${plan.baseBranch}\` will follow.`,
    };
  }

  if (committedIds.size > 0) {
    logger.info(`Resolved ${committedIds.size} commit(s) deterministically; dispatching the remaining ${remaining.length} to Copilot.`);
  }

  if (!copilotToken) {
    logger.warn(
      'Drift is in auto mode with commit(s) that need an agent, but no Copilot token is available. Falling back to approval.',
    );
    return requestApproval({
      ...options,
      plan: {
        ...plan,
        blockers: [
          ...plan.blockers,
          'No Copilot token was available. Set the `DRIFT_COPILOT_TOKEN` secret to a user-scoped fine-grained token with `Agent tasks: read and write` — that is the only permission the Agent Tasks endpoint checks. The Copilot agent API does not accept GitHub App installation tokens.',
        ],
      },
    });
  }

  const agentPlan = planForCommits(plan, remaining);
  const result = await dispatchToCopilot({ copilotToken, repo, plan: agentPlan, config, logger });

  if (!result.ok) {
    logger.error(`Copilot dispatch failed: ${result.error}`);
    // A dispatch failure falls back to approval rather than silently dropping
    // the analysis — the work is still valuable to a human. Anything already
    // resolved deterministically stays committed on the branch either way.
    const fallback = await requestApproval({
      ...options,
      plan: { ...plan, blockers: [...plan.blockers, result.error ?? 'Copilot dispatch failed.'] },
    });
    return { ...fallback, status: 'failed', message: result.error ?? 'Copilot dispatch failed.' };
  }

  await postCheckRun(options, 'neutral', `Copilot is fixing ${agentPlan.breakingChanges.length} breaking change(s)`);

  const task = result.task;
  logger.info(`Dispatched to Copilot: task ${task?.id ?? 'unknown'} on ${plan.branchName}`);

  const pr = await ensurePullRequest(options, task?.pullRequestNumber, task?.pullRequestUrl);

  const resolvedNote = committedIds.size > 0 ? `${committedIds.size} commit(s) resolved deterministically; ` : '';

  return {
    status: 'dispatched',
    planId: plan.id,
    branchName: plan.branchName,
    taskId: task?.id,
    pullRequestNumber: pr?.number ?? task?.pullRequestNumber,
    pullRequestUrl: pr?.url ?? task?.pullRequestUrl,
    message: pr
      ? `${resolvedNote}Copilot is working on ${remaining.length} commit(s) on \`${plan.branchName}\`, tracked in pull request #${pr.number} into \`${plan.baseBranch}\`.`
      : `${resolvedNote}Copilot is working on ${remaining.length} commit(s) on \`${plan.branchName}\`. A pull request into \`${plan.baseBranch}\` will follow.`,
  };
}

/**
 * Make sure there is a pull request for this branch.
 *
 * The Action is the one surface with nobody to ask, so it finishes the job.
 * Leaving a workflow run at "there is a branch somewhere, go find it" is asking
 * a human to do the single step the automation existed to remove — and a branch
 * with no pull request is invisible to every review process a team already has.
 *
 * Copilot sometimes opens the pull request itself, which is why the task's own
 * number is honoured first: opening a second one for the same branch would be
 * worse than opening none.
 *
 * A failure here is deliberately not fatal. The branch exists and the work is
 * on it; reporting the run as failed because a label could not be applied would
 * misrepresent what happened.
 */
async function ensurePullRequest(
  options: DispatchOptions,
  existingNumber: number | undefined,
  existingUrl: string | undefined,
): Promise<{ number: number; url: string } | null> {
  const { repo, plan, config, github, logger } = options;

  if (existingNumber && existingUrl) return { number: existingNumber, url: existingUrl };
  if (!config.pullRequest.enabled) {
    logger.info('pullRequest.enabled is false; leaving the branch without a pull request.');
    return null;
  }

  // The base is the branch the dependency change landed on — which is, by
  // construction, the branch this work was started from. `plan.baseBranch`
  // already carries it, and the config toggle exists for teams that always want
  // the repository default instead.
  const base =
    config.pullRequest.base === 'default-branch'
      ? ((await github.getDefaultBranch(repo.owner, repo.repo)) ?? plan.baseBranch)
      : plan.baseBranch;

  if (base === plan.branchName) return null;

  const created = await github.createPullRequest(repo, {
    head: plan.branchName,
    base,
    title: titleFor(
      { changes: plan.changes },
      { title: config.pullRequest.titleTemplate, prefix: config.remediation.branchPrefix },
    ),
    body: renderPullRequestBody(plan, config),
    draft: config.pullRequest.draft || config.remediation.draftPr,
    labels: [DRIFT_LABEL, ...config.pullRequest.labels],
    reviewers: config.pullRequest.reviewers,
  });

  return created ? { number: created.number, url: created.url } : null;
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
