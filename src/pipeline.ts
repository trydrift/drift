import type { DispatchResult, RemediationPlan, RepoContext } from './types.js';
import type { DriftConfig } from './config/schema.js';
import type { Logger } from './util/logger.js';
import type { GitHubClient } from './github/client.js';
import { analyzeRepository } from './analysis.js';
import { dispatch } from './dispatch/index.js';
import { renderSummaryLine } from './report/markdown.js';

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

  return { plan, dispatch: result, summary: result.message };
}

export { analyzeRepository } from './analysis.js';
export type { AnalysisOptions, AnalysisResult, AnalysisStage } from './analysis.js';
