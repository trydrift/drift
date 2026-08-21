import { changedFilesAgainst, diffAgainst, initWorkspaceRepo, notAttempted, scopeEscapes, type RepairContext, type TrackOutcome } from './context.ts';
import { patchStatsOf } from '../artifacts/prediction.ts';
import { runAgentTrack, type AgentTrackDeps, type AgentTrackOptions } from './agent.ts';
import { agentTimeoutMs, observedSelection, requestedProvenance, withAgentSelection } from './agent-config.ts';
import {
  CLI_AGENT_SPECS,
  CliFixAgent,
  runAgentCommitsInWorktree,
  runWorktreeRemediation,
  type RepoContext,
} from '../../../dist/index.js';

/**
 * R4 — the complete production remediation hierarchy, with Drift choosing.
 *
 * This is the headline repair result, and the only one that answers the
 * question a user actually asks: starting from a dependency update, does Drift
 * produce a valid migration? Every other track answers "could mechanism X
 * repair this if it were chosen", which is a capability question.
 *
 * The order is production's, not the benchmark's: `runWorktreeRemediation`
 * applies the built-in codemod, then a validated fix plan (cache, recipe or
 * model, all through one gate), and returns whatever is left as `needsAgent` —
 * including commits whose fix plan applied but left residual call sites, which
 * is a case worth its own attention: nine of ten sites resolved is not a
 * finished repair, and a tier that reported success there would be wrong.
 *
 * `resolvedByTier` is recorded per commit so a report can say *which*
 * mechanism actually did the work, rather than crediting the hierarchy as a
 * whole. That is the difference between "Drift repaired 8 of 10 cases" and
 * "Drift repaired 8 of 10, 6 of them deterministically and free".
 */

export const TRACK_VERSION = 'repair-full-remediation-v1';

export interface FullRemediationOptions extends AgentTrackOptions {
  /** When false, the hierarchy stops before the agent tier and reports what deterministic repair alone achieved. */
  allowAgentFallback?: boolean;
}

export async function runFullRemediationTrack(
  context: RepairContext,
  options: FullRemediationOptions = {},
  deps: AgentTrackDeps = {},
): Promise<TrackOutcome> {
  if (context.plan.commits.length === 0) return { repair: notAttempted('no-repairable-commit') };

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

  const resolvedByTier: { commitId: string; tier: string }[] = [];
  const scopeValidationReasons: string[] = [];
  /** The hierarchy routed work to the agent tier and found no agent there. A delivery failure, never an abstention. */
  let agentTierUnavailable = false;
  /** Commits the agent was given and did not resolve — errored, timed out, or failed Drift's scope gate. */
  let agentUnresolved = 0;
  let run: Awaited<ReturnType<typeof runWorktreeRemediation>> | null = null;

  try {
    run = await runWorktreeRemediation({
      repo,
      plan,
      config: context.config,
      logger: {
        ...context.logger,
        info: (message: string) => context.observedCommands.push(message),
        warn: (message: string) => context.observedCommands.push(`warn: ${message}`),
      },
      workspace: context.workspace.root,
      // Unattended: only what `dispositionFor` clears without a human is
      // applied. Answering the interactive prompt for it would benchmark a
      // mode Drift does not offer non-interactively.
      nonInteractive: true,
    });

    // Which tier resolved what, derived from the plan rather than from counts:
    // `builtinResolved`/`fixPlanResolved` are totals, and a report needs to
    // name the commit so a per-case row can say how it was fixed.
    const needsAgentIds = new Set(run.needsAgent.map((commit) => commit.id));
    for (const commit of plan.commits) {
      if (needsAgentIds.has(commit.id)) continue;
      if (commit.codemod) resolvedByTier.push({ commitId: commit.id, tier: 'codemod' });
      else if (commit.fixPlan) resolvedByTier.push({ commitId: commit.id, tier: 'fixplan' });
    }

    let agentProvenance: TrackOutcome['provenance'];

    if (run.needsAgent.length > 0 && options.allowAgentFallback !== false) {
      const agentId = options.agentId ?? 'codex';
      const spec = CLI_AGENT_SPECS.find((candidate) => candidate.id === agentId);
      const timeoutMs = agentTimeoutMs(context.config, options);
      const agent = spec ? (deps.createAgent ? deps.createAgent(spec, timeoutMs) : new CliFixAgent(spec, timeoutMs)) : null;
      const availability = agent ? await agent.detect() : { available: false, reason: `No spec for ${agentId}.` };
      const requested = requestedProvenance(context.config, options);

      if (agent && availability.available) {
        // Confirmed fields stay empty until the agent reports something; the
        // request lives in the `requested*` block. This track previously
        // recorded the requested model and effort *and* handed the runner
        // `context.config`, so an artifact could name one model while another
        // one ran.
        agentProvenance = {
          agentId,
          agentLabel: spec!.label,
          provider: spec!.label,
          agentCliVersion: availability.detail ?? 'unavailable',
          promptVersion: 'drift-buildFixPrompt',
          ...requested,
        };

        // The same config the standalone agent track builds, from the same
        // helper. Handing the runner `context.config` here was the defect:
        // provenance said `--model X` and the runner ran whatever the agent's
        // own defaults resolved to.
        const runAgentCommits = deps.runAgentCommits ?? runAgentCommitsInWorktree;
        const agentRun = await runAgentCommits({
          repo,
          plan,
          config: withAgentSelection(context.config, options),
          worktree: run.worktree,
          commits: run.needsAgent,
          agent,
          logger: {
            ...context.logger,
            info: (message: string) => context.observedCommands.push(message),
            warn: (message: string) => context.observedCommands.push(`warn: ${message}`),
          },
        });

        Object.assign(agentProvenance, observedSelection(context.observedCommands));

        for (const commit of agentRun.resolved) resolvedByTier.push({ commitId: commit.id, tier: 'agent' });
        for (const failure of agentRun.unresolved) {
          agentUnresolved += 1;
          scopeValidationReasons.push(`${failure.commit.id}: ${failure.message}`);
        }
      } else {
        // The hierarchy routed work here and found nothing to route it to.
        // Recorded as its own reason, not as a policy abstention: Drift did
        // not decline this case, it could not finish it, and the difference is
        // the whole of what an end-to-end number means.
        agentTierUnavailable = true;
        scopeValidationReasons.push(`agent tier required but unavailable: ${availability.reason ?? 'unavailable'}`);
        agentProvenance = { agentId, agentLabel: spec?.label ?? agentId, ...requested };
      }
    }

    const changedFiles = await changedFilesAgainst(run.worktree, afterSha);
    const patch = await diffAgainst(run.worktree, afterSha);

    if (changedFiles.length === 0) {
      /**
       * Nothing changed on disk — but *why* nothing changed is four different
       * facts, and this used to report three of them as the fourth.
       *
       * `abstained-by-policy` is a product decision: every tier looked and
       * declined. It is the only one of these a reader should read as Drift
       * behaving correctly, and it was previously also what a missing agent
       * binary and a failed agent run produced, which turned an operational
       * hole into a considered decision to decline.
       */
      const reason = agentTierUnavailable
        ? ('agent-required-unavailable' as const)
        : agentUnresolved > 0
          ? ('agent-error' as const)
          : resolvedByTier.length > 0
            ? ('empty-patch' as const)
            : ('abstained-by-policy' as const);
      return {
        repair: { ...notAttempted(reason), scopeValidationReasons },
        ...(agentProvenance ? { provenance: agentProvenance } : {}),
      };
    }

    const resolvedIds = new Set(resolvedByTier.map((entry) => entry.commitId));
    const resolvedCommits = plan.commits.filter((commit) => resolvedIds.has(commit.id));

    return {
      repair: {
        attempted: true,
        notAttemptedReason: null,
        resolvedByTier,
        patch,
        changedFiles,
        scopeEscapeFiles: scopeEscapes(changedFiles, resolvedCommits),
        scopeValidationReasons,
        patchStats: patchStatsOf(patch),
        residualImpactSites: residualFor(context, resolvedIds),
      },
      ...(agentProvenance ? { provenance: agentProvenance } : {}),
    };
  } finally {
    if (run) await run.teardown().catch(() => undefined);
  }
}

function residualFor(context: RepairContext, resolvedCommitIds: ReadonlySet<string>): number {
  const addressed = new Set(
    context.plan.commits.filter((commit) => resolvedCommitIds.has(commit.id)).flatMap((commit) => commit.breakingChangeIds),
  );
  return context.plan.impactSites.filter((site) => !addressed.has(site.breakingChangeId)).length;
}

export { runAgentTrack };
