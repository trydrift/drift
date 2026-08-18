import type { AgentConfig, ExplicitAgentProvider } from '../config/schema.js';

export type AgentSelectionSource =
  | 'override'
  | 'repository'
  | 'local-preference'
  | 'legacy-copilot'
  | 'single-available'
  | 'unresolved';

export interface AgentCredentialSet {
  /** User-scoped token for GitHub's Copilot coding-agent API. */
  copilotToken?: string;
}

export interface AgentRuntimeState {
  credentials?: AgentCredentialSet;
  eligibleProviders: readonly ExplicitAgentProvider[];
  interactive: boolean;
  surface: 'cli' | 'action' | 'webhook' | 'extension';
}

export interface AgentSelection {
  provider: ExplicitAgentProvider;
  config: AgentConfig;
  source: Exclude<AgentSelectionSource, 'unresolved'>;
  runtime: AgentRuntimeState;
}

export interface UnresolvedAgentSelection {
  provider: 'auto';
  config: AgentConfig;
  source: 'unresolved';
  runtime: AgentRuntimeState;
  reason: string;
}

export type ResolvedAgentSelection = AgentSelection | UnresolvedAgentSelection;

export interface ResolveAgentSelectionOptions {
  config: AgentConfig;
  runtime: AgentRuntimeState;
  override?: Partial<AgentConfig>;
  /**
   * Local CLI convenience only. Callers outside the CLI must not pass it; the
   * core resolver treats it as ordinary input rather than reading the home
   * directory itself.
   */
  localPreference?: Partial<AgentConfig>;
  /** Compatibility input translated at the boundary, never persisted. */
  legacyCopilot?: { token?: string; model?: string };
}

/**
 * Resolve policy plus invocation/runtime facts into one provider choice.
 *
 * No registry ordering is used to choose an unattended agent. If an unattended
 * run reaches `auto` with more than one usable provider, the result is
 * unresolved and callers must fall back safely.
 */
export function resolveAgentSelection(options: ResolveAgentSelectionOptions): ResolvedAgentSelection {
  const runtime = options.runtime;
  const override = compactAgentConfig(options.override);
  if (override.provider && override.provider !== 'auto') {
    return selected(override.provider, mergeAgentConfig(options.config, override), 'override', runtime);
  }

  if (options.config.provider !== 'auto') {
    return selected(options.config.provider, mergeAgentConfig(options.config, override), 'repository', runtime);
  }

  const local = compactAgentConfig(options.localPreference);
  if (runtime.surface === 'cli' && local.provider && local.provider !== 'auto') {
    return selected(local.provider, mergeAgentConfig(options.config, local, override), 'local-preference', runtime);
  }

  if (options.legacyCopilot?.token || options.legacyCopilot?.model) {
    return selected(
      'copilot-cloud',
      mergeAgentConfig(options.config, { provider: 'copilot-cloud', model: options.legacyCopilot.model }, override),
      'legacy-copilot',
      { ...runtime, credentials: { ...runtime.credentials, copilotToken: options.legacyCopilot.token } },
    );
  }

  if (runtime.eligibleProviders.length === 1) {
    return selected(
      runtime.eligibleProviders[0]!,
      mergeAgentConfig(options.config, override),
      'single-available',
      runtime,
    );
  }

  return {
    provider: 'auto',
    config: mergeAgentConfig(options.config, override),
    source: 'unresolved',
    runtime,
    reason:
      runtime.eligibleProviders.length === 0
        ? 'No usable AI agent was detected.'
        : `Multiple AI agents are available (${runtime.eligibleProviders.join(', ')}); choose one explicitly with \`--agent\`, the Action \`agent\` input, or \`remediation.agent.provider\`.`,
  };
}

function selected(
  provider: ExplicitAgentProvider,
  config: AgentConfig,
  source: AgentSelection['source'],
  runtime: AgentRuntimeState,
): AgentSelection {
  return { provider, config: { ...config, provider }, source, runtime };
}

function compactAgentConfig(input: Partial<AgentConfig> | undefined): Partial<AgentConfig> {
  const out: Partial<AgentConfig> = {};
  if (!input) return out;
  if (input.provider !== undefined) out.provider = input.provider;
  if (input.model !== undefined && input.model !== '') out.model = input.model;
  if (input.effort !== undefined) out.effort = input.effort;
  if (input.fast !== undefined) out.fast = input.fast;
  if (input.timeoutSeconds !== undefined) out.timeoutSeconds = input.timeoutSeconds;
  return out;
}

function mergeAgentConfig(base: AgentConfig, ...overrides: Partial<AgentConfig>[]): AgentConfig {
  return Object.assign({}, base, ...overrides);
}
