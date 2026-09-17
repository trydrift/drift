import type { ToolMetrics, Usage } from '../schema.ts';

/**
 * A coding agent the benchmark can drive.
 *
 * One provider today (Claude Code). The interface is what a second one —
 * Codex, Gemini CLI — has to satisfy: start a fresh session in a directory
 * with a prompt, and come back with the provider's *own* structured usage
 * record, its tool activity, and how it ended. Nothing here estimates tokens.
 */

export interface AgentRunRequest {
  prompt: string;
  cwd: string;
  model: string;
  effort: string;
  timeoutMs: number;
  /** Browsing tools are disabled by default so an agent cannot look up the historical fix. */
  webTools: 'allowed' | 'disabled';
  maxBudgetUsd: number | null;
  maxTurns: number | null;
  env: NodeJS.ProcessEnv;
  /** MCP servers for this session only, as `--mcp-config` declares them. Empty for every non-MCP condition. */
  mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  /** An inline settings document (`--settings`), e.g. the controller's verification guard. Absent for the baseline. */
  settings?: Record<string, unknown>;
  /** Receives the raw event stream, line by line, for the audit log. */
  onEventLine?: (line: string) => void;
  onProgress?: (message: string) => void;
}

export interface AgentSessionInfo {
  agentCliVersion: string;
  confirmedModel: string;
  permissionMode: string;
  tools: string[];
  mcpServers: string[];
  /** The session's full loaded environment, from its init record. `null` when no init record arrived. */
  environment: import('./claude-code.ts').SessionEnvironment | null;
  argv: string[];
  disallowedTools: string[];
  cleanEnvironment: string;
}

export interface AgentRunResult {
  status: 'completed' | 'timeout' | 'error' | 'launch-failure' | 'provider-error';
  exitCode: number | null;
  terminalReason: string | null;
  resultSubtype: string | null;
  apiErrorStatus: number | null;
  numTurns: number | null;
  durationMs: number;
  apiDurationMs: number | null;
  finalMessage: string;
  permissionDenials: number;
  usage: Usage;
  tools: ToolMetrics;
  session: AgentSessionInfo;
  /** Distinct model responses seen, so an empty session can be told from a failed launch. */
  assistantMessages: number;
  stderr: string;
}

export interface AgentProvider {
  readonly id: string;
  readonly label: string;
  /** Resolve the binary and its version, without starting a session. */
  detect(): Promise<{ available: boolean; version: string; detail: string }>;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
