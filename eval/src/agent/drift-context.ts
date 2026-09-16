import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Condition, TrialArtifact } from './schema.ts';
import { DRIFT_PREAMBLE_HEADER } from './task.ts';
import type { Workspace } from './workspace.ts';
import {
  GitHubClient,
  LocalGitProvider,
  createLogger,
  loadConfig,
  renderPullRequestBody,
  resolvePlanVerdict,
  runPipeline,
  type RemediationPlan,
  type RepoContext,
} from '../../../dist/index.js';

/**
 * The Drift condition's context, produced by the product.
 *
 * This runs the same code path as `drift analyze --before <base> --after
 * <start> --markdown --verify` in the workspace: `runPipeline` over
 * production's `LocalGitProvider`, `dryRun` forced, config loaded from the
 * repository the way the CLI loads it, and the report rendered by the same
 * `renderPullRequestBody` the CLI prints and the GitHub Action posts. Nothing
 * here writes a prompt; the only benchmark-authored text is the
 * `DRIFT_PREAMBLE_HEADER` sentence saying what the report is.
 *
 * Two ablations are provided for diagnostics and never for a headline:
 * `drift-evidence-only` renders the plan with its impact sites removed, and
 * `drift-localization-only` renders it with the evidence excerpts removed.
 * Both still go through the production renderer.
 *
 * A Drift failure — the pipeline throwing, or finding no dependency change —
 * is a product outcome and is recorded on the trial, which then runs with the
 * task alone. It is not excluded: a tool that crashes on a real repository
 * has not helped the agent.
 */

export interface DriftContext {
  preamble: string;
  status: TrialArtifact['context']['driftStatus'];
  failure: string | null;
  analysisMs: number;
  command: string;
  plan: TrialArtifact['context']['driftPlan'];
  /** The full plan, kept in memory for diagnostics; never written into the prompt beyond what the renderer prints. */
  rawPlan: RemediationPlan | null;
}

export interface DriftContextOptions {
  verify: boolean;
  githubToken?: string;
}

export async function buildDriftContext(condition: Condition, workspace: Workspace, options: DriftContextOptions): Promise<DriftContext> {
  const started = Date.now();
  const command = `drift analyze --before ${workspace.baseCommit.slice(0, 12)} --after ${workspace.startCommit.slice(0, 12)} --markdown${options.verify ? ' --verify' : ''}`;
  const logger = createLogger('error');

  try {
    const { config } = await loadConfig(async (candidate) => {
      try {
        return await readFile(resolve(workspace.repo, candidate), 'utf8');
      } catch {
        return null;
      }
    });

    const repo: RepoContext = {
      owner: 'local',
      repo: 'workspace',
      baseBranch: 'main',
      beforeSha: workspace.baseCommit,
      afterSha: workspace.startCommit,
      workspace: workspace.repo,
    };

    const github = new GitHubClient({ repoToken: options.githubToken ?? '', logger });
    const result = await runPipeline({
      repo,
      config,
      logger,
      github,
      provider: new LocalGitProvider(workspace.repo, { before: workspace.baseCommit, after: workspace.startCommit }),
      githubToken: options.githubToken,
      dryRun: true,
      workspace: workspace.repo,
      verify: { enabled: options.verify && config.verify.enabled },
    });

    if (!result.plan) {
      return {
        preamble: '',
        status: 'no-plan',
        failure: result.summary,
        analysisMs: Date.now() - started,
        command,
        plan: null,
        rawPlan: null,
      };
    }

    const plan = ablate(condition, result.plan);
    const report = renderPullRequestBody(plan, config);
    const verdict = String(resolvePlanVerdict(result.plan));
    return {
      preamble: `${DRIFT_PREAMBLE_HEADER}\n${report.trim()}\n`,
      status: 'completed',
      failure: null,
      analysisMs: Date.now() - started,
      command,
      plan: {
        breakingChanges: result.plan.breakingChanges.length,
        impactSites: result.plan.impactSites.length,
        impactFiles: [...new Set(result.plan.impactSites.map((site) => site.file))].sort(),
        symbols: [...new Set(result.plan.breakingChanges.flatMap((change) => change.symbols))].sort(),
        verdict,
        verificationStatus: result.plan.verification?.status ?? null,
        evidenceSources: result.plan.evidence.length,
      },
      rawPlan: result.plan,
    };
  } catch (err) {
    return {
      preamble: '',
      status: 'failed',
      failure: (err as Error).message,
      analysisMs: Date.now() - started,
      command,
      plan: null,
      rawPlan: null,
    };
  }
}

function ablate(condition: Condition, plan: RemediationPlan): RemediationPlan {
  if (condition === 'drift-evidence-only') return { ...plan, impactSites: [], commits: [] };
  if (condition === 'drift-localization-only') {
    return {
      ...plan,
      evidence: plan.evidence.map((record) => ({ ...record, content: '(withheld in this ablation)' })),
    };
  }
  return plan;
}
