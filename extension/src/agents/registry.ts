import * as vscode from 'vscode';
import { CopilotLanguageModelAgent } from './copilot-lm.js';
import { CopilotCloudAgent } from './copilot-cloud.js';
import { OllamaAgent } from './ollama.js';
import { CLI_AGENT_SPECS, CliFixAgent } from './cli.js';
import type { AgentAvailability, FixAgent } from './types.js';

/**
 * Agent discovery.
 *
 * Drift asks the machine what is already installed rather than asking the user
 * to configure anything. Everything below is probed in parallel and the results
 * are cached briefly, so the picker opens instantly and shows real state — not
 * a list of things the user might theoretically have.
 *
 * Unavailable agents are shown too, greyed out, each with a one-line reason and
 * how to fix it. Hiding them would leave the user wondering why their agent
 * isn't listed.
 */

export interface DiscoveredAgent {
  agent: FixAgent;
  availability: AgentAvailability;
}

export interface RegistryContext {
  /** `owner/repo` from the git remote, if any. */
  slug: string | null;
  baseBranch: string;
}

const CACHE_TTL_MS = 30_000;

let cache: { at: number; key: string; agents: DiscoveredAgent[] } | null = null;

export function buildAgents(ctx: RegistryContext): FixAgent[] {
  const config = vscode.workspace.getConfiguration('drift');
  const timeoutMs = Math.max(30, config.get<number>('agent.timeoutSeconds', 600)) * 1000;

  // A model picked in the composer outranks the one in settings. The setting is
  // the default for a subscription; the composer is what the developer chose
  // for this repository, and detection has to probe what will actually run.
  const chosen = config.get<Record<string, string>>('agent.models', {}) ?? {};

  return [
    new CopilotLanguageModelAgent(chosen['copilot-lm'] || config.get<string>('agent.copilotModelFamily') || undefined),
    new CopilotCloudAgent(ctx.slug, ctx.baseBranch),
    ...CLI_AGENT_SPECS.map((spec) => new CliFixAgent(spec, timeoutMs)),
    new OllamaAgent(
      config.get<string>('agent.ollamaHost', 'http://localhost:11434').replace(/\/$/, ''),
      chosen['ollama'] || config.get<string>('agent.ollamaModel', 'qwen2.5-coder'),
      timeoutMs,
    ),
  ];
}

export async function discoverAgents(
  ctx: RegistryContext,
  options: { force?: boolean } = {},
): Promise<DiscoveredAgent[]> {
  const key = `${ctx.slug ?? ''}|${ctx.baseBranch}`;

  if (!options.force && cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.agents;
  }

  const agents = buildAgents(ctx);

  // Probing in parallel matters: a serial sweep across five CLI lookups plus a
  // network check makes opening the picker feel broken.
  const discovered = await Promise.all(
    agents.map(async (agent) => ({
      agent,
      availability: await agent.detect().catch((err: unknown) => ({
        available: false,
        reason: (err as Error)?.message ?? 'Detection failed.',
      })),
    })),
  );

  const sorted = discovered.sort((a, b) => {
    if (a.availability.available !== b.availability.available) {
      return a.availability.available ? -1 : 1;
    }
    return 0;
  });

  cache = { at: Date.now(), key, agents: sorted };
  return sorted;
}

export function invalidateAgentCache(): void {
  cache = null;
}

/**
 * Resolve the agent to use.
 *
 * Honours an explicit setting when that agent is actually usable, and otherwise
 * falls back to the best available one rather than failing. A configured agent
 * that has since been uninstalled should not block the user from getting work
 * done — it should say so and carry on.
 */
export async function resolveAgent(
  ctx: RegistryContext,
): Promise<{ agent: FixAgent; fellBackFrom?: string } | null> {
  const preferred = vscode.workspace.getConfiguration('drift').get<string>('agent.preferred', 'auto');
  const discovered = await discoverAgents(ctx);

  if (preferred && preferred !== 'auto') {
    const match = discovered.find((d) => d.agent.id === preferred);
    if (match?.availability.available) return { agent: match.agent };

    const best = discovered.find((d) => d.availability.available);
    if (best) return { agent: best.agent, fellBackFrom: preferred };
    return null;
  }

  const best = discovered.find((d) => d.availability.available);
  return best ? { agent: best.agent } : null;
}

export type { AgentModel, FixAgent, AgentAvailability } from './types.js';
