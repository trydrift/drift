import type { AgentConfig } from '../config/schema.js';
import type { AgentCredentialSet } from './selection.js';

export const COPILOT_CLOUD_PROVIDER_ID = 'copilot-cloud';

export interface LegacyCopilotInputs {
  token?: string;
  model?: string;
}

export function credentialsWithLegacyCopilot(
  credentials: AgentCredentialSet | undefined,
  token: string | undefined,
): AgentCredentialSet | undefined {
  if (!token) return credentials;
  return { ...(credentials ?? {}), [COPILOT_CLOUD_PROVIDER_ID]: { token } };
}

export function agentConfigWithLegacyCopilot(
  config: AgentConfig,
  legacy: LegacyCopilotInputs | undefined,
): AgentConfig {
  if (!legacy?.token && !legacy?.model) return config;
  if (config.provider !== 'auto') return config;
  return {
    ...config,
    provider: COPILOT_CLOUD_PROVIDER_ID,
    ...(legacy.model ? { model: legacy.model } : {}),
  };
}
