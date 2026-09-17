import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BriefStats } from './agent-context.ts';
import type { Condition, TrialArtifact } from './schema.ts';
import { DRIFT_BRIEF_HEADER, DRIFT_MCP_PREAMBLE, DRIFT_PREAMBLE_HEADER } from './task.ts';
import type { Workspace } from './workspace.ts';
import {
  GitHubClient,
  LocalGitProvider,
  availableChecks,
  buildAgentBrief,
  renderAgentBrief,
  createLogger,
  loadConfig,
  renderPullRequestBody,
  resolvePlanVerdict,
  runPipeline,
  type DriftConfig,
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
  /** For `drift-agent-brief`: what the production brief selected. */
  brief: BriefStats | null;
  /** For `drift-mcp`: the server the session connects to. Nothing is analysed before the session. */
  mcpServers: Record<string, { command: string; args: string[] }> | null;
}

export interface DriftContextOptions {
  verify: boolean;
  githubToken?: string;
}

/** The production CLI this checkout builds, which is what `drift mcp` runs for a user. */
export const DRIFT_CLI = fileURLToPath(new URL('../../../dist/cli.js', import.meta.url));

export async function buildDriftContext(condition: Condition, workspace: Workspace, options: DriftContextOptions): Promise<DriftContext> {
  const started = Date.now();

  if (condition === 'drift-mcp') {
    // Same server a user adds with `claude mcp add drift -- drift mcp`,
    // built from this checkout. Its working directory is the session's.
    return {
      preamble: DRIFT_MCP_PREAMBLE,
      status: 'not-applicable',
      failure: null,
      analysisMs: 0,
      command: 'drift mcp',
      plan: null,
      rawPlan: null,
      brief: null,
      mcpServers: { drift: { command: process.execPath, args: [DRIFT_CLI, 'mcp'] } },
    };
  }

  const render = condition === 'drift-agent-brief' ? '--agent' : '--markdown';
  const command = `drift analyze --before ${workspace.baseCommit.slice(0, 12)} --after ${workspace.startCommit.slice(0, 12)} ${render}${options.verify ? ' --verify' : ''}`;

  try {
    const { config, result } = await analyzeWorkspace(workspace, options);

    if (!result.plan) {
      return {
        preamble: '',
        status: 'no-plan',
        failure: result.summary,
        analysisMs: Date.now() - started,
        command,
        plan: null,
        rawPlan: null,
        brief: null,
        mcpServers: null,
      };
    }

    const plan = ablate(condition, result.plan);
    const verdict = String(resolvePlanVerdict(result.plan));
    let preamble: string;
    let brief: BriefStats | null = null;
    if (condition === 'drift-agent-brief') {
      // Exactly what `drift analyze --agent` prints, with no retrieval named:
      // this session has no Drift tools to fetch omitted detail with.
      const checks = (await availableChecks(workspace.project)).map((check) => ({ label: check.label, kind: check.kind }));
      const built = buildAgentBrief(plan, { config, availableChecks: checks });
      const rendered = renderAgentBrief(built, { retrieval: 'none' });
      preamble = `${DRIFT_BRIEF_HEADER}\n${rendered.text.trim()}\n`;
      brief = {
        findingsInPlan: plan.breakingChanges.length,
        findingsInInitialBrief: rendered.findings.full.length + rendered.findings.compacted.length,
        nonLocalFindingsOmitted: built.omitted.noLocatedUsage + built.omitted.notSearched + built.omitted.unaffected,
        deterministicSitesCovered: built.units.reduce((sum, unit) => sum + (unit.deterministic?.covered ?? 0), 0),
        residualSitesSentToAgent: built.findings.reduce((sum, finding) => sum + finding.sites.length, 0) -
          built.units.reduce((sum, unit) => sum + (unit.deterministic?.covered ?? 0), 0),
      };
    } else {
      preamble = `${DRIFT_PREAMBLE_HEADER}\n${renderPullRequestBody(plan, config).trim()}\n`;
    }
    return {
      preamble,
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
      brief,
      mcpServers: null,
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
      brief: null,
      mcpServers: null,
    };
  }
}

/**
 * Drift's production analysis of the workspace's upgrade: `runPipeline` over
 * `LocalGitProvider`, dry run, config loaded from the repository the way the
 * CLI loads it. Shared by every condition that uses Drift's plan.
 */
export async function analyzeWorkspace(
  workspace: Pick<Workspace, 'repo' | 'baseCommit' | 'startCommit'>,
  options: DriftContextOptions,
): Promise<{ config: DriftConfig; result: Awaited<ReturnType<typeof runPipeline>> }> {
  const logger = createLogger('error');
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
  return { config, result };
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
