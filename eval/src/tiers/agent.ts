import { createHash } from 'node:crypto';
import { changedFilesAgainst, diffAgainst, initWorkspaceRepo, notAttempted, scopeEscapes, type RepairContext, type TrackOutcome } from './context.ts';
import { patchStatsOf } from '../artifacts/prediction.ts';
import {
  CLI_AGENT_SPECS,
  CliFixAgent,
  createRemediationWorktree,
  removeRemediationWorktree,
  runAgentCommitsInWorktree,
  type CommitUnit,
  type RepoContext,
} from '../../../dist/index.js';

/**
 * R3 — repair by a coding agent, through Drift's own production handoff.
 *
 * The distinction this track exists to preserve: it benchmarks *Drift plus its
 * Codex handoff*, not Codex. Nothing here writes a prompt. The agent is
 * constructed from Drift's own `CLI_AGENT_SPECS` registry entry, handed a
 * `CommitUnit` the production planner built, and run by
 * `runAgentCommitsInWorktree`, which supplies the prompt via Drift's
 * `buildFixPrompt`, snapshots the commit's allowed files, isolates the run in
 * a disposable `git worktree`, and validates the agent's changed paths against
 * the plan's declared scope *before* accepting anything.
 *
 * A benchmark that instead called `codex exec` with its own prompt would be
 * measuring a different product — one in which Drift's scope validation, its
 * per-commit partitioning and its instructions do not exist — and would report
 * the result as Drift's.
 *
 * Everything the runner rejects is retained as a distinct outcome:
 * `scope-validation-rejected` (the agent edited outside the plan, and Drift
 * correctly refused it) is a very different fact from `agent-error`, and both
 * are different again from an agent that ran cleanly and changed nothing.
 */

export const TRACK_VERSION = 'repair-agent-v1';

export interface AgentTrackOptions {
  /** Registry id from Drift's own specs. `codex` is the configured default for this benchmark. */
  agentId?: string;
  /** Passed through Drift's config so the agent receives it the way production sends it. */
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  timeoutSeconds?: number;
}

export async function runAgentTrack(context: RepairContext, options: AgentTrackOptions = {}): Promise<TrackOutcome> {
  const agentId = options.agentId ?? 'codex';
  const spec = CLI_AGENT_SPECS.find((candidate) => candidate.id === agentId);
  if (!spec) {
    return { repair: notAttempted('agent-unavailable'), provenance: { agentId, agentLabel: agentId } };
  }

  const timeoutMs = (options.timeoutSeconds ?? context.config.remediation.agent.timeoutSeconds) * 1000;
  const agent = new CliFixAgent(spec, timeoutMs);
  const availability = await agent.detect();

  if (!availability.available) {
    // Recorded, never fabricated around. A track that could not run reports
    // `agent-unavailable` with the detected reason and contributes to no
    // success or failure rate.
    context.observedCommands.push(`agent detect ${agentId}: unavailable — ${availability.reason ?? 'no reason given'}`);
    return {
      repair: notAttempted('agent-unavailable'),
      provenance: { agentId, agentLabel: spec.label, provider: spec.label, agentCliVersion: 'unavailable' },
    };
  }

  const commits = context.plan.commits.filter((commit) => !commit.codemod);
  if (commits.length === 0) return { repair: notAttempted('no-repairable-commit') };

  const provenance = {
    agentId,
    agentLabel: spec.label,
    provider: spec.label,
    model: options.model ?? context.config.remediation.agent.model ?? context.config.remediation.model ?? 'unavailable',
    modelVersion: 'unavailable',
    agentCliVersion: availability.detail ?? 'unavailable',
    // The prompt is Drift's, so the version and hash identify Drift's
    // instructions for these exact commit units — which is the thing that
    // would change a result and therefore the thing worth pinning.
    promptVersion: 'drift-buildFixPrompt',
    promptHash: hashCommitInstructions(commits),
    effort: String(options.effort ?? context.config.remediation.agent.effort ?? 'unavailable'),
    fastMode: String(context.config.remediation.agent.fast ?? false),
  };

  const afterSha = await initWorkspaceRepo(context.workspace.root);
  const repo: RepoContext = {
    owner: 'drift-bench',
    repo: context.publicCase.id,
    baseBranch: 'main',
    beforeSha: afterSha,
    afterSha,
    workspace: context.workspace.root,
  };

  const plan = { ...context.plan, headSha: afterSha };
  let worktree: string | null = null;

  try {
    worktree = await createRemediationWorktree({ repo, plan, workspace: context.workspace.root });
    const config = withAgentSelection(context.config, options);

    const result = await runAgentCommitsInWorktree({
      repo,
      plan,
      config,
      worktree,
      commits,
      agent,
      logger: {
        ...context.logger,
        info: (message: string) => context.observedCommands.push(message),
        warn: (message: string) => context.observedCommands.push(`warn: ${message}`),
      },
    });

    // What the agent says it actually used beats what Drift asked for. Codex
    // resolves its own model and reasoning effort from its config when the
    // flags are absent, so recording the request would attribute a result to a
    // model that never ran it. Read from the agent's own banner, which Drift
    // already captures verbatim.
    Object.assign(provenance, observedSelection(context.observedCommands));

    const changedFiles = await changedFilesAgainst(worktree, afterSha);
    const patch = await diffAgainst(worktree, afterSha);

    if (result.resolved.length === 0) {
      // Drift's runner resets the worktree on both rejection paths, so an
      // unresolved commit leaves no diff. The *reason* is the product signal,
      // and it is preserved here rather than collapsed into "failed".
      const reasons = result.unresolved.map((entry) => entry.message);
      const rejected = reasons.some((reason) => /outside the remediation plan|protected path|above the limit/.test(reason));
      const noChange = reasons.some((reason) => /without changing any files/.test(reason));
      const timedOut = reasons.some((reason) => /timed out|timeout/i.test(reason));

      return {
        repair: {
          ...notAttempted(
            rejected ? 'scope-validation-rejected' : noChange ? 'empty-patch' : timedOut ? 'agent-timeout' : 'agent-error',
          ),
          scopeValidationReasons: reasons,
        },
        provenance,
      };
    }

    return {
      repair: {
        attempted: true,
        notAttemptedReason: null,
        resolvedByTier: result.resolved.map((commit) => ({ commitId: commit.id, tier: 'agent' })),
        patch,
        changedFiles,
        scopeEscapeFiles: scopeEscapes(changedFiles, result.resolved),
        scopeValidationReasons: result.unresolved.map((entry) => entry.message),
        patchStats: patchStatsOf(patch),
        residualImpactSites: residualFor(context, result.resolved),
      },
      provenance,
    };
  } catch (err) {
    return { repair: { ...notAttempted('agent-error'), scopeValidationReasons: [(err as Error).message] }, provenance };
  } finally {
    if (worktree) await removeRemediationWorktree(context.workspace.root, worktree).catch(() => undefined);
  }
}

/**
 * Model and effort are pushed through Drift's own config rather than passed to
 * the agent directly, because that is the only path production has: the
 * runner reads `config.remediation.agent`, and an agent handed a model any
 * other way would be running a code path no user reaches.
 */
function withAgentSelection(config: RepairContext['config'], options: AgentTrackOptions): RepairContext['config'] {
  return {
    ...config,
    remediation: {
      ...config.remediation,
      agent: {
        ...config.remediation.agent,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
      },
    },
  };
}

/**
 * Model and effort as the agent itself reported them.
 *
 * Only fields the agent actually printed are returned, so an agent that says
 * nothing leaves the recorded value at `unavailable` rather than having a
 * requested-but-unconfirmed value written over it.
 */
export function observedSelection(lines: readonly string[]): Partial<{ model: string; effort: string; provider: string }> {
  const found: Partial<{ model: string; effort: string; provider: string }> = {};
  for (const line of lines) {
    const model = /^\s*model:\s*(?<value>\S+)\s*$/.exec(line);
    if (model?.groups) found.model = model.groups['value']!;
    const provider = /^\s*provider:\s*(?<value>\S+)\s*$/.exec(line);
    if (provider?.groups) found.provider = provider.groups['value']!;
    const effort = /^\s*reasoning effort:\s*(?<value>\S+)\s*$/.exec(line);
    if (effort?.groups) found.effort = effort.groups['value']!;
  }
  return found;
}

/** Hashes exactly what the agent was asked to do, so two trials can be shown to have received the same task. */
function hashCommitInstructions(commits: readonly CommitUnit[]): string {
  const hash = createHash('sha256');
  for (const commit of [...commits].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(commit.id);
    hash.update('\0');
    hash.update(commit.instructions);
    hash.update('\0');
    hash.update([...commit.allowedFiles].sort().join(','));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function residualFor(context: RepairContext, resolved: readonly CommitUnit[]): number {
  const addressed = new Set(resolved.flatMap((commit) => commit.breakingChangeIds));
  return context.plan.impactSites.filter((site) => !addressed.has(site.breakingChangeId)).length;
}
