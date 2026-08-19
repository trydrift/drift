import type { DriftConfig } from '../config/schema.js';
import type { RepoContext } from '../types.js';
import type { Logger } from '../util/logger.js';
import { CLI_AGENT_SPECS, CliFixAgent, type CliAgentSpec } from './cli.js';
import { CopilotCloudAgent } from './copilot-cloud.js';
import { COPILOT_CLOUD_PROVIDER_ID } from './compat.js';
import type { AgentAvailability, AgentCapabilities, CloudFixAgent, FixAgent } from './types.js';
import type { AgentCredentialSet } from './selection.js';

export interface AgentRuntimeContext {
  repo?: RepoContext;
  config: DriftConfig;
  logger: Logger;
  credentials?: AgentCredentialSet;
  dryRun?: boolean;
  surface: 'cli' | 'action' | 'webhook' | 'extension';
}

export interface AgentProviderMetadata {
  id: string;
  label: string;
  description: string;
  capabilities: AgentCapabilities;
}

export interface AgentProviderAdapter extends AgentProviderMetadata {
  create(context: AgentRuntimeContext): Promise<FixAgent | null>;
  detect(context: AgentRuntimeContext): Promise<AgentAvailability>;
}

export class AgentProviderRegistry {
  private readonly adapters = new Map<string, AgentProviderAdapter>();

  constructor(adapters: readonly AgentProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: AgentProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): AgentProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): AgentProviderMetadata[] {
    return [...this.adapters.values()].map(({ id, label, description, capabilities }) => ({
      id,
      label,
      description,
      capabilities,
    }));
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }

  async detect(id: string, context: AgentRuntimeContext): Promise<AgentAvailability> {
    const adapter = this.adapters.get(id);
    if (!adapter) return { available: false, reason: `No provider adapter is registered for \`${id}\`.` };
    return adapter.detect(context);
  }

  async available(context: AgentRuntimeContext): Promise<Map<string, AgentAvailability>> {
    const entries = await Promise.all(
      [...this.adapters.values()].map(async (adapter) => {
        const availability = await adapter.detect(context).catch((err: Error) => ({
          available: false,
          reason: err.message,
        }));
        return [adapter.id, availability] as const;
      }),
    );
    return new Map(entries.filter(([, availability]) => availability.available));
  }

  async create(id: string, context: AgentRuntimeContext): Promise<FixAgent | null> {
    return (await this.adapters.get(id)?.create(context)) ?? null;
  }
}

export function isCloudFixAgent(agent: FixAgent): agent is CloudFixAgent {
  return agent.capabilities.execution === 'cloud' && 'status' in agent && 'isTerminalState' in agent;
}

export function createDefaultAgentProviderRegistry(): AgentProviderRegistry {
  const registry = new AgentProviderRegistry();
  for (const spec of CLI_AGENT_SPECS) registry.register(cliProviderAdapter(spec));
  registry.register(copilotCloudProviderAdapter());
  return registry;
}

export const defaultAgentProviderRegistry = createDefaultAgentProviderRegistry();

function cliProviderAdapter(spec: CliAgentSpec): AgentProviderAdapter {
  const capabilities = {
    execution: 'workspace',
    canAwaitCompletion: false,
    canInspectResult: true,
  } as const;
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    capabilities,
    async create(context) {
      if (context.surface === 'webhook') return null;
      return new CliFixAgent(spec, context.config.remediation.agent.timeoutSeconds * 1000);
    },
    async detect(context) {
      if (context.surface === 'webhook') {
        return { available: false, reason: 'Local CLI agents require a checked-out workspace.' };
      }
      return new CliFixAgent(spec, context.config.remediation.agent.timeoutSeconds * 1000).detect();
    },
  };
}

function copilotCloudProviderAdapter(): AgentProviderAdapter {
  const capabilities = {
    execution: 'cloud',
    canAwaitCompletion: true,
    canInspectResult: false,
  } as const;
  return {
    id: COPILOT_CLOUD_PROVIDER_ID,
    label: 'Copilot Cloud',
    description: 'Runs on GitHub through the Copilot coding-agent API.',
    capabilities,
    async create(context) {
      if (!context.repo) return null;
      const token = copilotTokenFrom(context.credentials);
      return new CopilotCloudAgent({
        repo: context.repo,
        config: context.config,
        token,
        logger: context.logger,
        dryRun: context.dryRun,
      });
    },
    async detect(context) {
      if (!context.repo) return { available: false, reason: 'Cloud agents require repository context.' };
      return new CopilotCloudAgent({
        repo: context.repo,
        config: context.config,
        token: copilotTokenFrom(context.credentials),
        logger: context.logger,
        dryRun: context.dryRun,
      }).detect();
    },
  };
}

function copilotTokenFrom(credentials: AgentCredentialSet | undefined): string | undefined {
  const credential = credentials?.[COPILOT_CLOUD_PROVIDER_ID];
  if (typeof credential === 'string') return credential;
  if (credential && typeof credential === 'object' && 'token' in credential) {
    const token = (credential as { token?: unknown }).token;
    return typeof token === 'string' ? token : undefined;
  }
  return undefined;
}
