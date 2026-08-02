import type { DispatchResult, RemediationPlan, RepoContext } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import type { GitHubClient } from '../github/client.js';
import { loadConfig } from '../config/load.js';
import { execCommand } from '../util/exec.js';
import { analyzeRepository } from '../analysis.js';
import { dispatch, DRIFT_LABEL } from '../dispatch/index.js';
import { authorizeApproval, type ApprovalRequest } from './authorize.js';
import { planDigest } from './digest.js';
import { findPriorDispatch, renderDispatchMarker } from './metadata.js';

/**
 * `/drift apply`, end to end.
 *
 * Shared by the Action and the webhook runner because an approval must mean the
 * same thing on both. They previously implemented it separately and disagreed:
 * the webhook re-analysed the recorded commit, while the Action re-analysed
 * `GITHUB_SHA` — which on an `issue_comment` event is the current tip of the
 * default branch, not the commit anyone reviewed. Approving a plan for commit A
 * would execute a plan for commit B.
 *
 * The order of checks matters and is the security property worth stating:
 * nothing writes to the repository until identity, provenance, the exact
 * commit, and the plan digest have all been confirmed. Re-analysis happens
 * before dispatch specifically so the digest can be compared against a freshly
 * computed plan rather than trusted from the issue.
 */

export type ApprovalOutcome =
  /** Not an approval comment. Nothing was done and nothing was said. */
  | { status: 'ignored'; reason: string }
  /** An approval attempt that failed a check. Explained on the issue. */
  | { status: 'rejected'; reason: string; issueNumber: number }
  /** This exact plan was already applied; the earlier result is reported again. */
  | { status: 'already-applied'; issueNumber: number; message: string }
  | { status: 'applied'; issueNumber: number; plan: RemediationPlan; dispatch: DispatchResult };

export interface ApplyApprovalOptions {
  /** The raw `issue_comment` event payload. */
  payload: Record<string, unknown>;
  owner: string;
  repo: string;
  github: GitHubClient;
  logger: Logger;
  copilotToken?: string;
  dryRun?: boolean;
  /** Local checkout, when the runner has one. Enables localization. */
  workspace?: string;
  /** Overrides the committed config, as the Action's `mode` input does. */
  configOverride?: Partial<DriftConfig>;
}

/**
 * Logins that are Drift and must never be able to approve a Drift plan.
 *
 * The authenticated login is asked for at run time; these cover the case where
 * that call is unavailable, which is the norm for a GitHub App installation
 * token and for the Action's built-in token.
 */
const KNOWN_SELF_LOGINS = ['github-actions[bot]', 'drift[bot]'];

export async function applyApproval(options: ApplyApprovalOptions): Promise<ApprovalOutcome> {
  const { payload, owner, repo: repoName, github, logger } = options;

  // A context good enough for issue and permission calls. The commit range is
  // filled in from the plan footer once it has been verified — deriving it any
  // earlier would mean trusting the event for the one value that matters most.
  const apiContext: RepoContext = {
    owner,
    repo: repoName,
    baseBranch: '',
    beforeSha: '',
    afterSha: '',
  };

  const eventIssue = payload.issue as ApprovalRequest['issue'];
  const issueNumber = typeof eventIssue?.number === 'number' ? eventIssue.number : null;

  // Re-read the issue rather than trusting the payload. Event payloads truncate
  // long bodies, and the plan footer is at the very bottom — so on exactly the
  // large plans that most need review, the payload body arrives without it.
  // Labels and state come from the same read, so provenance is checked against
  // the repository's current answer rather than a snapshot in the event.
  const hydrated = issueNumber !== null ? await github.getIssue(apiContext, issueNumber) : null;

  const request: ApprovalRequest = {
    action: payload.action as string | undefined,
    comment: payload.comment as ApprovalRequest['comment'],
    issue: hydrated
      ? {
          number: hydrated.number,
          body: hydrated.body,
          labels: hydrated.labels,
          state: hydrated.state,
          ...(hydrated.pullRequest ? { pull_request: true } : {}),
        }
      : eventIssue,
  };

  const selfLogin = await github.getAuthenticatedLogin();
  const selfLogins = selfLogin ? [...KNOWN_SELF_LOGINS, selfLogin] : KNOWN_SELF_LOGINS;

  const decision = await authorizeApproval({
    request,
    selfLogins,
    requiredLabel: DRIFT_LABEL,
    lookupPermission: (login) => github.getCollaboratorPermission(apiContext, login),
  });

  if (decision.status === 'not-an-approval') {
    logger.debug(`Ignoring comment: ${decision.reason}`);
    return { status: 'ignored', reason: decision.reason };
  }

  if (decision.status === 'rejected') {
    logger.warn(`Refused /drift apply on #${decision.issueNumber}: ${decision.reason}`);
    await reject(options, apiContext, decision.issueNumber, decision.reason);
    return { status: 'rejected', reason: decision.reason, issueNumber: decision.issueNumber };
  }

  const { metadata, actor, permission } = decision;
  logger.info(
    `\`/drift apply\` on #${decision.issueNumber} by ${actor} (${permission}) for plan ${metadata.planId}`,
  );

  // --- The commit must still exist, and still be the one that was reviewed ---

  if (!(await github.commitExists(apiContext, metadata.headSha))) {
    const reason =
      `commit \`${metadata.headSha.slice(0, 7)}\` is no longer in this repository. ` +
      'It may have been removed by a force-push or a branch deletion. Re-run Drift to analyse the current code.';
    await reject(options, apiContext, decision.issueNumber, reason);
    return { status: 'rejected', reason, issueNumber: decision.issueNumber };
  }

  const baseHead = await github.getBranchHead(apiContext, metadata.baseBranch);
  if (baseHead === null) {
    const reason =
      `the base branch \`${metadata.baseBranch}\` no longer exists, so Drift cannot tell what this plan would merge into.`;
    await reject(options, apiContext, decision.issueNumber, reason);
    return { status: 'rejected', reason, issueNumber: decision.issueNumber };
  }

  if (baseHead !== metadata.headSha) {
    // Deliberately strict. The plan's impact sites are line-and-file facts
    // about one commit; once the branch has moved, Drift can no longer claim
    // the analysis a human read still describes the code that would be
    // changed. Saying so and asking for a fresh plan is the honest option — the
    // alternative is applying a stale analysis without mentioning it.
    const reason =
      `\`${metadata.baseBranch}\` has advanced since this plan was generated ` +
      `(reviewed \`${metadata.headSha.slice(0, 7)}\`, now at \`${baseHead.slice(0, 7)}\`). ` +
      'The impact analysis in this issue describes the older commit, so Drift will not apply it. ' +
      'Re-run Drift to generate a plan for the current code.';
    await reject(options, apiContext, decision.issueNumber, reason);
    return { status: 'rejected', reason, issueNumber: decision.issueNumber };
  }

  // --- Re-analyse exactly the reviewed commit -------------------------------

  // A workspace is only usable if it is checked out at the reviewed commit.
  // On an `issue_comment` event `actions/checkout` takes the default branch,
  // which is not necessarily the branch this plan targets — localizing against
  // the wrong tree would attach real-looking file and line numbers to code that
  // was never analysed. Degrading to no localization is the safe direction, and
  // the pipeline already says so in the report.
  const workspace = await usableWorkspace(options, metadata.headSha);

  const repo: RepoContext = {
    owner,
    repo: repoName,
    baseBranch: metadata.baseBranch,
    beforeSha: `${metadata.headSha}^`,
    afterSha: metadata.headSha,
    ...(workspace ? { workspace } : {}),
  };

  // Config is read *at the reviewed commit*, not at the tip. A policy change
  // landing between filing and approval must not retroactively loosen the
  // guardrails the plan was checked against.
  const { config: loaded, problems } = await loadConfig((path) =>
    github.readFile(repo, path, metadata.headSha),
  );
  for (const problem of problems) logger.warn(problem);
  const config = options.configOverride ? { ...loaded, ...options.configOverride } : loaded;

  const { plan, summary } = await analyzeRepository({
    repo,
    config,
    logger,
    provider: github.asRepoProvider(repo),
    ...(workspace ? { workspace } : {}),
  });

  if (!plan) {
    const reason = `re-analysing \`${metadata.headSha.slice(0, 7)}\` produced no plan (${summary}).`;
    await reject(options, apiContext, decision.issueNumber, reason);
    return { status: 'rejected', reason, issueNumber: decision.issueNumber };
  }

  // --- The plan must be the plan that was reviewed --------------------------

  const digest = planDigest(plan);
  if (digest !== metadata.planDigest) {
    const reason =
      'the plan Drift just computed does not match the plan recorded on this issue, so the approval does not apply to it.\n\n' +
      `- recorded: \`${metadata.planDigest.slice(0, 16)}…\`\n` +
      `- computed: \`${digest.slice(0, 16)}…\`\n\n` +
      'This happens when the evidence behind the plan changed after it was filed — a new upstream release, ' +
      'an edited changelog, a newly disclosed advisory. Nothing is wrong, but what you approved is no longer ' +
      'what would run. Re-run Drift to generate a current plan and review that one.';
    await reject(options, apiContext, decision.issueNumber, reason);
    return { status: 'rejected', reason, issueNumber: decision.issueNumber };
  }

  // --- Idempotency ----------------------------------------------------------

  // Deliberately after digest verification: an unverified plan should never
  // reach the point of consulting, let alone writing, dispatch state.
  let priorComments: { body: string | null; authorLogin: string | null }[];
  try {
    priorComments = await github.listIssueComments(apiContext, decision.issueNumber);
  } catch (err) {
    // Not knowing whether this plan already ran means not knowing whether
    // dispatching now would duplicate it, so this refuses rather than risks a
    // second branch and a second agent on the same work.
    const reason =
      `Drift could not read this issue's comments (${(err as Error).message}), so it cannot tell whether this ` +
      'plan was already applied. It stopped rather than risk dispatching the same work twice. Try again.';
    await reject(options, apiContext, decision.issueNumber, reason);
    return { status: 'rejected', reason, issueNumber: decision.issueNumber };
  }

  const prior = findPriorDispatch(
    priorComments.map((c) => ({
      body: c.body,
      authorIsDrift: Boolean(
        c.authorLogin && selfLogins.some((l) => l.toLowerCase() === c.authorLogin!.toLowerCase()),
      ),
    })),
    digest,
  );

  if (prior) {
    const where = prior.pullRequestNumber
      ? `pull request #${prior.pullRequestNumber}`
      : prior.branchName
        ? `branch \`${prior.branchName}\``
        : 'an earlier run';
    const message = `This plan was already applied — see ${where}. Nothing further to do.`;
    logger.info(`Plan ${metadata.planId} already dispatched; treating the approval as a no-op.`);
    await github.commentOnIssue(apiContext, decision.issueNumber, `**Drift**: ${message}`);
    return { status: 'already-applied', issueNumber: decision.issueNumber, message };
  }

  // --- Dispatch -------------------------------------------------------------

  const result = await dispatch({
    repo,
    plan,
    config,
    github,
    logger,
    ...(options.copilotToken ? { copilotToken: options.copilotToken } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    approved: true,
  });

  if (result.status === 'dispatched' && !options.dryRun) {
    // The marker is what makes a repeated `/drift apply` a no-op, so it is
    // written even though the summary comment below would read similarly to a
    // human: prose is not a protocol.
    const marker = renderDispatchMarker({
      planDigest: digest,
      branchName: result.branchName ?? plan.branchName,
      ...(result.taskId ? { taskId: result.taskId } : {}),
      ...(result.pullRequestNumber !== undefined ? { pullRequestNumber: result.pullRequestNumber } : {}),
    });
    await github.commentOnIssue(
      apiContext,
      decision.issueNumber,
      `**Drift**: applied by @${actor}.\n\n${result.message}\n\n${marker}`,
    );
  } else {
    await github.commentOnIssue(apiContext, decision.issueNumber, `**Drift**: ${result.message}`);
  }

  return { status: 'applied', issueNumber: decision.issueNumber, plan, dispatch: result };
}

/**
 * The workspace, but only if it is checked out at the commit being approved.
 *
 * Localization reads files from disk and reports exact file-and-line impact
 * sites. If the checkout is at a different commit than the one the plan
 * describes, those line numbers are confident and wrong — the worst kind of
 * output this tool can produce. Returning `undefined` costs localization on
 * that run, which the report already states plainly as a gap.
 */
async function usableWorkspace(
  options: ApplyApprovalOptions,
  headSha: string,
): Promise<string | undefined> {
  const { workspace, logger } = options;
  if (!workspace) return undefined;

  const result = await execCommand('git', ['rev-parse', 'HEAD'], { cwd: workspace, timeoutMs: 10_000 });

  if (result.code !== 0) {
    logger.warn(
      `Could not determine what \`${workspace}\` is checked out at, so Drift is not using it for localization.`,
    );
    return undefined;
  }

  const localHead = result.stdout.trim();
  if (localHead !== headSha) {
    logger.warn(
      `The checkout is at ${localHead.slice(0, 7)} but this plan describes ${headSha.slice(0, 7)}. ` +
        'Skipping localization rather than reporting impact sites from the wrong tree.',
    );
    return undefined;
  }

  return workspace;
}

/**
 * Say why an approval was refused, on the issue where it was attempted.
 *
 * A refusal that only appears in a workflow log is a refusal nobody sees. The
 * text names the failed check and the fix; it never echoes tokens, permission
 * API responses, or anything else the commenter could not already read.
 */
async function reject(
  options: ApplyApprovalOptions,
  apiContext: RepoContext,
  issueNumber: number,
  reason: string,
): Promise<void> {
  if (options.dryRun) return;
  await options.github.commentOnIssue(
    apiContext,
    issueNumber,
    `**Drift did not apply this plan.**\n\n${reason}`,
  );
}
