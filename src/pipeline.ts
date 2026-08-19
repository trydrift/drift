import type { DispatchResult, RemediationPlan, RepoContext } from './types.js';
import type { DriftConfig } from './config/schema.js';
import type { Logger } from './util/logger.js';
import type { GitHubClient } from './github/client.js';
import type { RepoProvider } from './repo/provider.js';
import type { FixAgent } from './agents/types.js';
import { analyzeRepository } from './analysis.js';
import { dispatch } from './dispatch/index.js';
import { renderSummaryLine } from './report/markdown.js';
import { buildUpgradeOutcomeEvent, sendTelemetryEvent, telemetryEnabled } from './telemetry.js';

/**
 * The full Drift pipeline: analyse, then act.
 *
 * Analysis lives in `analysis.ts` and is deliberately separable — it needs no
 * credentials and writes nothing, so it can run in an editor, a CI job, or a
 * webhook server unchanged. This module adds the half that acts: creating a
 * branch, handing the plan to a coding agent, or filing an approval issue.
 *
 * The split is what lets one codebase serve both the GitHub Action and the VS
 * Code extension without either being a special case.
 */

export interface PipelineOptions {
  repo: RepoContext;
  config: DriftConfig;
  logger: Logger;
  github: GitHubClient;
  /**
   * Optional, used only to raise the public GitHub API rate limit for
   * evidence gathering (release notes, changelogs). Reading is never blocked
   * on this being set.
   */
  githubToken?: string;
  /**
   * Where to read changed files and file contents from. Defaults to the
   * GitHub API via `github`. Pass a `LocalGitProvider` to read a local
   * checkout directly instead — no network, no credentials — the same seam
   * that lets the VS Code extension analyse without a token.
   */
  provider?: RepoProvider;
  /** Analyse and report without creating branches, issues, or tasks. */
  dryRun?: boolean;
  /** Provider-neutral agent selected by the surface after applying its own rules. */
  agent?: FixAgent;
  /** A human approved this plan via `/drift apply`. */
  approved?: boolean;
  /** Local checkout to index. Falls back to `repo.workspace`. */
  workspace?: string;
}

export interface PipelineResult {
  plan: RemediationPlan | null;
  dispatch: DispatchResult;
  summary: string;
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { repo, config, logger, github, githubToken, dryRun, approved, agent } = options;
  const started = Date.now();

  const { plan, summary } = await logger.group('Drift: analysing', () =>
    analyzeRepository({
      repo,
      config,
      logger,
      provider: options.provider ?? github.asRepoProvider(repo),
      workspace: options.workspace ?? repo.workspace,
      githubToken,
      onProgress: (stage, detail) => logger.info(`[${stage}] ${detail}`),
    }),
  );

  if (!plan) {
    logger.info(summary);
    return {
      plan: null,
      dispatch: { status: 'skipped', planId: 'none', message: summary },
      summary,
    };
  }

  logger.info(renderSummaryLine(plan));
  for (const blocker of plan.blockers) logger.warn(`Blocker: ${blocker}`);

  const result = await logger.group('Drift: dispatching', () =>
    dispatch({ repo, plan, config, github, logger, agent, dryRun, approved }),
  );

  logger.info(result.message);

  await reportTelemetry({
    config,
    plan,
    result,
    dryRun,
    approved,
    latencyMs: Date.now() - started,
    logger,
  });

  return { plan, dispatch: result, summary: result.message };
}

/**
 * Best-effort product telemetry for the outcome of this run.
 *
 * Never affects the return value or throws into the caller: a telemetry
 * endpoint being unreachable is not a reason to report a plan as failed. Off
 * unless a team has both enabled it and given it somewhere to send events.
 * This repository does not include a hosted collector; `drift telemetry print`
 * exists only to inspect the event shape before wiring one up.
 */
/**
 * Exported so `/drift apply` can report the same event this module sends for
 * every other dispatch — that path calls `analyzeRepository`/`dispatch`
 * directly rather than through `runPipeline`, because approval has its own
 * verification steps (digest, commit range, idempotency) that don't belong in
 * the ordinary pipeline. Without this it dispatched real agent tasks with
 * no telemetry at all, and `userAction: 'approved'` — the one user action
 * Drift's own process ever directly witnesses — was consequently unreachable.
 */
export async function reportTelemetry(args: {
  config: DriftConfig;
  plan: RemediationPlan;
  result: DispatchResult;
  dryRun?: boolean;
  approved?: boolean;
  latencyMs: number;
  logger: Logger;
}): Promise<void> {
  const { config, plan, result, dryRun, approved, latencyMs, logger } = args;
  if (!telemetryEnabled(config.telemetry)) return;
  const endpoint = config.telemetry.endpoint;
  if (!endpoint) return;

  try {
    const event = buildUpgradeOutcomeEvent({
      plan,
      result,
      // Only `dispatched` actually put an agent to work.
      // `skipped`, `blocked`, and `failed` all mean no agent ever ran — a
      // plan that was filed for approval or fell back to one is not a cloud
      // agent run, and reporting it as one would overstate how often Drift
      // actually executes unattended.
      agentType: !dryRun && result.status === 'dispatched' ? 'cloud' : 'none',
      // This run's own wall-clock time — analysis plus dispatch. Not the
      // agent's own execution time, which Drift is never told, but a real
      // measurement rather than the `0` every event reported before.
      latencyMs,
      // `approved` is only ever true when this run was triggered by a human
      // commenting `/drift apply` — the one user action this call site
      // actually witnesses. Everything else (dismissed, merged, opened,
      // ignored) happens outside this process and is not fabricated here.
      ...(approved ? { userAction: 'approved' as const } : {}),
      featureFlags: {
        behaviouralVerification: config.verification.behavioural.enabled,
        automaticDispatch: config.mode === 'auto',
        approvalRequired: config.mode === 'approve',
        planDag: true,
      },
      ...(config.telemetry.installationId ? { installationId: config.telemetry.installationId } : {}),
      ...(config.telemetry.rotationSalt ? { rotationSalt: config.telemetry.rotationSalt } : {}),
      ...(config.telemetry.retentionDays !== undefined
        ? { retentionDays: config.telemetry.retentionDays }
        : {}),
    });

    const outcome = await sendTelemetryEvent(event, { endpoint });
    if (!outcome.sent) logger.debug(`Telemetry event not sent: ${outcome.reason ?? outcome.status}`);
  } catch (err) {
    logger.debug(`Telemetry event not sent: ${(err as Error).message}`);
  }
}

export { analyzeRepository } from './analysis.js';
export type { AnalysisOptions, AnalysisResult, AnalysisStage } from './analysis.js';
