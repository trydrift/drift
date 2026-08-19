import { createHash } from 'node:crypto';
import { changedFilesAgainst, diffAgainst, initWorkspaceRepo, notAttempted, scopeEscapes, type RepairContext, type TrackOutcome } from './context.ts';
import { agentTimeoutMs, observedSelection, requestedProvenance, withAgentSelection, type AgentSelection } from './agent-config.ts';
import { patchStatsOf } from '../artifacts/prediction.ts';
import {
  CLI_AGENT_SPECS,
  CliFixAgent,
  createRemediationWorktree,
  removeRemediationWorktree,
  runAgentCommitsInWorktree,
  type CommitUnit,
  type FixAgent,
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

export type AgentTrackOptions = AgentSelection;

/**
 * Seams for testing, and only for testing.
 *
 * A benchmark that mocked the production runner in its real runs would be
 * benchmarking the mock, so these are never supplied by `bench.ts`. They exist
 * so a test can assert what configuration `runAgentCommitsInWorktree` was
 * actually handed — the thing that was wrong and that no amount of reading the
 * provenance would have revealed.
 */
export interface AgentTrackDeps {
  createAgent?: (spec: (typeof CLI_AGENT_SPECS)[number], timeoutMs: number) => FixAgent;
  runAgentCommits?: typeof runAgentCommitsInWorktree;
}

export async function runAgentTrack(
  context: RepairContext,
  options: AgentTrackOptions = {},
  deps: AgentTrackDeps = {},
): Promise<TrackOutcome> {
  const agentId = options.agentId ?? 'codex';
  const spec = CLI_AGENT_SPECS.find((candidate) => candidate.id === agentId);
  if (!spec) {
    return { repair: notAttempted('agent-unavailable'), provenance: { agentId, agentLabel: agentId, ...requestedProvenance(context.config, options) } };
  }

  const timeoutMs = agentTimeoutMs(context.config, options);
  const agent = deps.createAgent ? deps.createAgent(spec, timeoutMs) : new CliFixAgent(spec, timeoutMs);
  const availability = await agent.detect();

  if (!availability.available) {
    // Recorded, never fabricated around. A track that could not run reports
    // `agent-unavailable` with the detected reason and contributes to no
    // success or failure rate.
    context.observedCommands.push(`agent detect ${agentId}: unavailable — ${availability.reason ?? 'no reason given'}`);
    return {
      repair: notAttempted('agent-unavailable'),
      provenance: {
        agentId,
        agentLabel: spec.label,
        provider: spec.label,
        agentCliVersion: 'unavailable',
        ...requestedProvenance(context.config, options),
      },
    };
  }

  const commits = context.plan.commits.filter((commit) => !commit.codemod);
  if (commits.length === 0) return { repair: notAttempted('no-repairable-commit') };

  // `model`, `effort` and `fastMode` stay `unavailable` here on purpose. They
  // are the *confirmed* fields, filled only from what the agent itself
  // reported; what this run asked for lives in the `requested*` fields, which
  // no later merge can promote into a confirmation.
  const provenance = {
    agentId,
    agentLabel: spec.label,
    provider: spec.label,
    modelVersion: 'unavailable',
    agentCliVersion: availability.detail ?? 'unavailable',
    // The prompt is Drift's, so the version and hash identify Drift's
    // instructions for these exact commit units — which is the thing that
    // would change a result and therefore the thing worth pinning.
    promptVersion: 'drift-buildFixPrompt',
    promptHash: hashCommitInstructions(commits),
    ...requestedProvenance(context.config, options),
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
    const runAgentCommits = deps.runAgentCommits ?? runAgentCommitsInWorktree;

    const result = await runAgentCommits({
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
