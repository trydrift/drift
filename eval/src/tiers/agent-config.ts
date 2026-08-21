import type { DriftConfig } from '../../../dist/index.js';
import type { TrackOutcome } from './context.ts';

/**
 * One place where a benchmark-selected agent configuration becomes a
 * `DriftConfig`, and one place where "what we asked for" becomes provenance.
 *
 * Both existed twice before, subtly differently. The standalone agent track
 * built a config with the requested model, effort and timeout and handed *that*
 * to `runAgentCommitsInWorktree`; the full-remediation track recorded the same
 * requested values in provenance and handed `context.config` — the unmodified
 * one — to the runner. So an artifact from a `--model X` run could say `model:
 * X` while a different model actually ran. There is no benchmark result worth
 * having on top of that, so the two paths now share this module and cannot
 * drift apart again.
 */

export interface AgentSelection {
  /** Registry id from Drift's own `CLI_AGENT_SPECS`. `codex` is this benchmark's configured default. */
  agentId?: string;
  /** Passed through Drift's config so the agent receives it the way production sends it. */
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  timeoutSeconds?: number;
  /** Provider-specific "fast" toggle, where the provider exposes one. */
  fast?: boolean;
}

/**
 * The config the production runner is actually given.
 *
 * Selection is pushed through `config.remediation.agent` rather than to the
 * agent directly, because that is the only path production has: the runner
 * reads that block, and an agent handed a model any other way would be running
 * a code path no user reaches.
 */
export function withAgentSelection(config: DriftConfig, selection: AgentSelection): DriftConfig {
  return {
    ...config,
    remediation: {
      ...config.remediation,
      agent: {
        ...config.remediation.agent,
        ...(selection.agentId ? { provider: selection.agentId } : {}),
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.effort ? { effort: selection.effort } : {}),
        ...(selection.timeoutSeconds ? { timeoutSeconds: selection.timeoutSeconds } : {}),
        ...(selection.fast === undefined ? {} : { fast: selection.fast }),
      },
    },
  };
}

/** Milliseconds the agent is given, resolved the same way in both tracks. */
export function agentTimeoutMs(config: DriftConfig, selection: AgentSelection): number {
  return (selection.timeoutSeconds ?? config.remediation.agent.timeoutSeconds) * 1000;
}

/**
 * What the run asked for — never what it got.
 *
 * These fields are deliberately separate from `model`/`effort`/`fastMode`,
 * which stay `unavailable` until the agent itself reports something. A CLI
 * agent resolves its own model and reasoning effort from its own config when
 * the flags are absent, so a requested value written into `model` would
 * attribute a result to a model that never ran it — and an artifact that
 * cannot tell a request from a confirmation is not provenance.
 */
export function requestedProvenance(config: DriftConfig, selection: AgentSelection): NonNullable<TrackOutcome['provenance']> {
  const effective = withAgentSelection(config, selection).remediation.agent;
  return {
    requestedModel: effective.model ?? 'unavailable',
    requestedEffort: effective.effort ?? 'unavailable',
    requestedFastMode: String(effective.fast),
    requestedTimeoutSeconds: String(effective.timeoutSeconds),
    requestedAgentId: selection.agentId ?? 'codex',
  };
}

/**
 * Model, effort and provider as the agent itself reported them, read from the
 * agent's own banner which Drift already captures verbatim.
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
