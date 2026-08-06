import type { DispatchResult, RemediationPlan, RepoContext } from './types.js';
import type { DriftConfig } from './config/schema.js';
import type { Logger } from './util/logger.js';
import type { GitHubClient } from './github/client.js';
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
  /** User-scoped token for the Copilot agent API. */
  copilotToken?: string;
  /** Analyse and report without creating branches, issues, or tasks. */
  dryRun?: boolean;
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
  const { repo, config, logger, github, copilotToken, dryRun, approved } = options;

  const { plan, summary } = await logger.group('Drift: analysing', () =>
    analyzeRepository({
      repo,
      config,
      logger,
      provider: github.asRepoProvider(repo),
      workspace: options.workspace ?? repo.workspace,
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
    dispatch({ repo, plan, config, github, logger, copilotToken, dryRun, approved }),
  );

  logger.info(result.message);

  await reportTelemetry({ config, plan, result, dryRun, logger });

  return { plan, dispatch: result, summary: result.message };
}

/**
 * Best-effort product telemetry for the outcome of this run.
 *
 * Never affects the return value or throws into the caller: a telemetry
 * endpoint being unreachable is not a reason to report a plan as failed. Off
 * unless a team has both enabled it and given it somewhere to send events —
 * enabling it with no endpoint configured is silently a no-op rather than an
 * error, since there is nothing wrong with wanting the event *shape* (see
 * `drift telemetry print`) without shipping any yet.
 */
async function reportTelemetry(args: {
  config: DriftConfig;
  plan: RemediationPlan;
  result: DispatchResult;
  dryRun?: boolean;
  logger: Logger;
}): Promise<void> {
  const { config, plan, result, dryRun, logger } = args;
  if (!telemetryEnabled(config.telemetry)) return;

  try {
    const event = buildUpgradeOutcomeEvent({
      plan,
      result,
      // Every dispatch on this path goes through the Copilot Agent Tasks API;
      // `dryRun` is the only case where nothing was executed at all.
      agentType: dryRun ? 'none' : 'cloud',
      ...(config.telemetry.installationId ? { installationId: config.telemetry.installationId } : {}),
      ...(config.telemetry.rotationSalt ? { rotationSalt: config.telemetry.rotationSalt } : {}),
      ...(config.telemetry.retentionDays !== undefined
        ? { retentionDays: config.telemetry.retentionDays }
        : {}),
    });

    if (!config.telemetry.endpoint) {
      logger.debug('Telemetry is enabled but no endpoint is configured; the event was built but not sent.');
      return;
    }

    const outcome = await sendTelemetryEvent(event, { endpoint: config.telemetry.endpoint });
    if (!outcome.sent) logger.debug(`Telemetry event not sent: ${outcome.reason ?? outcome.status}`);
  } catch (err) {
    logger.debug(`Telemetry event not sent: ${(err as Error).message}`);
  }
}

export { analyzeRepository } from './analysis.js';
export type { AnalysisOptions, AnalysisResult, AnalysisStage } from './analysis.js';
