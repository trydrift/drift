import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolMetrics, Usage } from '../schema.ts';
import type { AgentProvider, AgentRunRequest, AgentRunResult, AgentSessionInfo } from './types.ts';

const run = promisify(execFile);

/**
 * Claude Code as a benchmark subject.
 *
 * The session is started the way Drift's own registry starts it — `claude -p`
 * with the prompt on stdin, `--model` and `--effort` as flags — plus the
 * flags that make the session observable and clean:
 *
 *   --output-format stream-json --verbose   one JSON event per line, including
 *                                           the provider's usage on every
 *                                           model response and a final
 *                                           `result` event with the CLI's own
 *                                           cumulative per-model accounting
 *   isolation (see `cleanEnvironment`)      no user or repository CLAUDE.md,
 *                                           memory, settings, plugins, hooks
 *                                           or MCP servers from this machine
 *                                           leak into the session
 *   --no-session-persistence                nothing is written to the user's
 *                                           session history
 *   --disallowedTools WebFetch WebSearch    (default) the agent cannot browse
 *                                           for the historical fix
 *   --dangerously-skip-permissions          the session runs unattended inside
 *                                           a disposable workspace; both
 *                                           conditions get the same permissions
 *
 * Token accounting reads the provider's own numbers and nothing else. The
 * event stream format was checked against the installed CLI (2.1.267) and the
 * parser is covered by fixture tests in `claude-code.test.ts`; a future CLI
 * that renames a field fails those tests rather than silently under-counting.
 */

export const CLAUDE_STREAM_FORMAT_VERSION = 'claude-code-2.1.x-stream-json';

export const DEFAULT_DISALLOWED_WEB_TOOLS = ['WebFetch', 'WebSearch'];

/**
 * Built-in tools the provider exposes to some sessions and not others, with
 * nothing on this machine changing. In v3 two sessions loaded them and had to
 * be excluded as environment mismatches; an orchestrated trial starts several
 * sessions, so the flicker would exclude far more. They have nothing to do with
 * editing a repository, and every condition disallows them identically.
 */
export const UNSTABLE_BUILT_IN_TOOLS = ['ArtifactComments', 'ArtifactData'];

/** How tool activity is counted. Printed verbatim in every report. */
export const TOOL_COUNTING_NOTE =
  'Counts are `tool_use` blocks in the session event stream, deduplicated by block id. "File reads" are Read calls; ' +
  '"unique files read" are distinct Read paths; "searches" are Grep and Glob calls; "shell commands" are Bash tool ' +
  'invocations, each counted once regardless of how many programs the command line ran; "edits" are Edit, Write, ' +
  'MultiEdit and NotebookEdit calls. Files read through a shell command (cat, sed, head) are not counted as file reads.';

interface UsageRecord {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

interface ModelUsageRecord {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

export interface ParsedStream {
  init: {
    model: string | null;
    claudeCodeVersion: string | null;
    permissionMode: string | null;
    tools: string[];
    mcpServers: string[];
    /** Everything the session reports having loaded, for the environment audit. */
    environment: SessionEnvironment;
  } | null;
  /** One entry per distinct assistant message id, with the last usage seen for it. */
  ledger: { messageId: string; model: string; usage: UsageRecord; parentToolUseId: string | null }[];
  /**
   * `ledgerIndex` is the position in `ledger` of the model call that issued the
   * tool use; `at` is the CLI's timestamp on the event that carried it.
   */
  toolUses: { id: string; name: string; input: Record<string, unknown>; ledgerIndex: number; at: number | null }[];
  /** Tool results as the session recorded them, by tool_use id: characters handed back to the model, and when. */
  toolResults: Map<string, { chars: number; isError: boolean; at: number | null; guardRefused?: boolean }>;
  result: {
    subtype: string | null;
    isError: boolean;
    numTurns: number | null;
    durationMs: number | null;
    durationApiMs: number | null;
    totalCostUsd: number | null;
    terminalReason: string | null;
    apiErrorStatus: number | null;
    permissionDenials: number;
    usage: UsageRecord | null;
    modelUsage: Record<string, ModelUsageRecord> | null;
    resultText: string;
  } | null;
  /** Lines that were not JSON, kept for the audit record. */
  unparsedLines: number;
}

export function parseClaudeStream(lines: Iterable<string>): ParsedStream {
  const parsed: ParsedStream = { init: null, ledger: [], toolUses: [], toolResults: new Map(), result: null, unparsedLines: 0 };
  const ledgerIndex = new Map<string, number>();
  const seenToolUses = new Set<string>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      parsed.unparsedLines += 1;
      continue;
    }

    const type = event['type'];
    if (type === 'system' && event['subtype'] === 'init') {
      parsed.init = {
        model: typeof event['model'] === 'string' ? event['model'] : null,
        claudeCodeVersion: typeof event['claude_code_version'] === 'string' ? event['claude_code_version'] : null,
        permissionMode: typeof event['permissionMode'] === 'string' ? event['permissionMode'] : null,
        tools: Array.isArray(event['tools']) ? (event['tools'] as unknown[]).filter((t): t is string => typeof t === 'string') : [],
        mcpServers: Array.isArray(event['mcp_servers'])
          ? (event['mcp_servers'] as { name?: unknown }[]).map((s) => (typeof s.name === 'string' ? s.name : 'unknown'))
          : [],
        environment: sessionEnvironmentFrom(event),
      };
      continue;
    }

    if (type === 'assistant') {
      const message = event['message'] as Record<string, unknown> | undefined;
      if (!message) continue;
      const messageId = typeof message['id'] === 'string' ? message['id'] : `anonymous-${parsed.ledger.length}`;
      const model = typeof message['model'] === 'string' ? message['model'] : 'unknown';
      const usage = (message['usage'] as UsageRecord | undefined) ?? {};
      const parentToolUseId = typeof event['parent_tool_use_id'] === 'string' ? event['parent_tool_use_id'] : null;

      // The CLI emits one `assistant` event per content block, all carrying
      // the same message id and the same usage. Summing them naively would
      // multiply a message's tokens by its block count.
      const existing = ledgerIndex.get(messageId);
      if (existing === undefined) {
        ledgerIndex.set(messageId, parsed.ledger.length);
        parsed.ledger.push({ messageId, model, usage, parentToolUseId });
      } else {
        parsed.ledger[existing]!.usage = usage;
      }

      const content = Array.isArray(message['content']) ? (message['content'] as Record<string, unknown>[]) : [];
      for (const block of content) {
        if (block['type'] !== 'tool_use') continue;
        const id = typeof block['id'] === 'string' ? block['id'] : `${messageId}:${parsed.toolUses.length}`;
        if (seenToolUses.has(id)) continue;
        seenToolUses.add(id);
        parsed.toolUses.push({
          id,
          name: typeof block['name'] === 'string' ? block['name'] : 'unknown',
          input: (block['input'] as Record<string, unknown> | undefined) ?? {},
          ledgerIndex: ledgerIndex.get(messageId)!,
          at: timestampOf(event),
        });
      }
      continue;
    }

    if (type === 'user') {
      const message = event['message'] as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.['content']) ? (message!['content'] as Record<string, unknown>[]) : [];
      for (const block of content) {
        if (block['type'] !== 'tool_result' || typeof block['tool_use_id'] !== 'string') continue;
        const text = toolResultText(block['content']);
        parsed.toolResults.set(block['tool_use_id'], {
          chars: text.length,
          isError: block['is_error'] === true,
          at: timestampOf(event),
          ...(block['is_error'] === true && text.includes(GUARD_MESSAGE) ? { guardRefused: true } : {}),
        });
      }
      continue;
    }

    if (type === 'result') {
      const usage = (event['usage'] as UsageRecord | undefined) ?? null;
      const modelUsage = (event['modelUsage'] as Record<string, ModelUsageRecord> | undefined) ?? null;
      const denials = Array.isArray(event['permission_denials']) ? (event['permission_denials'] as unknown[]).length : 0;
      parsed.result = {
        subtype: typeof event['subtype'] === 'string' ? event['subtype'] : null,
        isError: event['is_error'] === true,
        numTurns: typeof event['num_turns'] === 'number' ? event['num_turns'] : null,
        durationMs: typeof event['duration_ms'] === 'number' ? event['duration_ms'] : null,
        durationApiMs: typeof event['duration_api_ms'] === 'number' ? event['duration_api_ms'] : null,
        totalCostUsd: typeof event['total_cost_usd'] === 'number' ? event['total_cost_usd'] : null,
        terminalReason: typeof event['terminal_reason'] === 'string' ? event['terminal_reason'] : null,
        apiErrorStatus: typeof event['api_error_status'] === 'number' ? event['api_error_status'] : null,
        permissionDenials: denials,
        usage,
        modelUsage,
        resultText: typeof event['result'] === 'string' ? event['result'] : '',
      };
    }
  }

  return parsed;
}

function timestampOf(event: Record<string, unknown>): number | null {
  const value = event['timestamp'];
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * What a session reports having loaded, from its `system/init` record.
 *
 * Recorded on every trial so equivalence across conditions is checked from
 * evidence, not assumed: `fingerprint` hashes everything except Drift's own
 * MCP server and tools, so two conditions that differ only by the Drift server
 * share it.
 */
export interface SessionEnvironment {
  tools: string[];
  mcpServers: { name: string; status: string }[];
  skills: string[];
  slashCommands: string[];
  agents: string[];
  plugins: string[];
  memoryPaths: string[];
  outputStyle: string | null;
  apiKeySource: string | null;
  fingerprint: string;
}

const DRIFT_SERVER = 'drift';

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v : typeof v === 'object' && v && 'name' in v ? String((v as { name: unknown }).name) : JSON.stringify(v))).sort() : [];
}

export function sessionEnvironmentFrom(event: Record<string, unknown>): SessionEnvironment {
  const mcpServers = Array.isArray(event['mcp_servers'])
    ? (event['mcp_servers'] as { name?: unknown; status?: unknown }[])
        .map((s) => ({ name: String(s.name ?? 'unknown'), status: String(s.status ?? 'unknown') }))
        .sort((a, b) => (a.name < b.name ? -1 : 1))
    : [];
  const memory = event['memory_paths'];
  const memoryPaths = memory && typeof memory === 'object' ? Object.values(memory as Record<string, unknown>).map(String).sort() : [];
  const environment = {
    tools: strings(event['tools']),
    mcpServers,
    skills: strings(event['skills']),
    slashCommands: strings(event['slash_commands']),
    agents: strings(event['agents']),
    plugins: strings(event['plugins']),
    memoryPaths,
    outputStyle: typeof event['output_style'] === 'string' ? event['output_style'] : null,
    apiKeySource: typeof event['apiKeySource'] === 'string' ? event['apiKeySource'] : null,
  };
  const withoutDrift = {
    ...environment,
    tools: environment.tools.filter((tool) => !tool.startsWith(`mcp__${DRIFT_SERVER}__`)),
    mcpServers: environment.mcpServers.filter((server) => server.name !== DRIFT_SERVER),
  };
  return { ...environment, fingerprint: createHash('sha256').update(JSON.stringify(withoutDrift)).digest('hex').slice(0, 16) };
}

/**
 * Why a session's loaded environment is not the one the condition declared.
 *
 * Empty means it matched. Anything else makes the trial an infrastructure
 * exclusion (`environment_mismatch`): a session that loaded an unexpected MCP
 * server, a plugin, memory, or failed to connect Drift did not run the
 * condition it is labelled as.
 */
export function environmentProblems(environment: SessionEnvironment | null, expectedServers: readonly string[]): string[] {
  if (!environment) return ['the session reported no init record'];
  const problems: string[] = [];
  const names = environment.mcpServers.map((s) => s.name);
  const expected = [...expectedServers].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    problems.push(`MCP servers ${JSON.stringify(names)}, expected ${JSON.stringify(expected)}`);
  }
  for (const server of environment.mcpServers) {
    if (expected.includes(server.name) && server.status !== 'connected') problems.push(`MCP server ${server.name} is ${server.status}`);
  }
  const foreignTools = environment.tools.filter((tool) => tool.startsWith('mcp__') && !expected.some((name) => tool.startsWith(`mcp__${name}__`)));
  if (foreignTools.length > 0) problems.push(`unexpected MCP tools: ${foreignTools.join(', ')}`);
  if (environment.plugins.length > 0) problems.push(`plugins loaded: ${environment.plugins.join(', ')}`);
  if (environment.memoryPaths.length > 0) problems.push(`memory loaded: ${environment.memoryPaths.join(', ')}`);
  return problems;
}

/** Text a tool result carried back to the model: a string, or text blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Record<string, unknown>[]).map((part) => (typeof part['text'] === 'string' ? part['text'] : '')).join('');
}

/** The product verification guard's refusal text (`VERIFICATION_GUARD_MARKER`), kept literal so the parser has no product import. */
export const GUARD_MESSAGE = 'Drift runs this repository';

const n = (value: number | undefined): number => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

/**
 * The usage record, from the provider's own numbers.
 *
 * Primary source: the `result` event's `modelUsage`, which is the CLI's own
 * cumulative account for every model the session used — including the small
 * auxiliary model the CLI calls for its own housekeeping, which never appears
 * as an assistant message. Both conditions pay that overhead identically.
 *
 * Cross-check: the per-message ledger, deduplicated by message id, re-summed.
 * A session that ended without a `result` event (killed at the timeout) falls
 * back to the ledger and says so in `source`.
 */
export function usageFromStream(parsed: ParsedStream): Usage {
  const byModelLedger: Usage['byModel'] = {};
  let ledgerGross = 0;
  for (const entry of parsed.ledger) {
    const model = entry.model;
    const bucket = (byModelLedger[model] ??= { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 });
    bucket.inputTokens += n(entry.usage.input_tokens);
    bucket.cacheReadTokens += n(entry.usage.cache_read_input_tokens);
    bucket.cacheCreationTokens += n(entry.usage.cache_creation_input_tokens);
    bucket.outputTokens += n(entry.usage.output_tokens);
    ledgerGross += n(entry.usage.input_tokens) + n(entry.usage.cache_read_input_tokens) + n(entry.usage.cache_creation_input_tokens);
  }

  const modelUsage = parsed.result?.modelUsage;
  if (modelUsage && Object.keys(modelUsage).length > 0) {
    const byModel: Usage['byModel'] = {};
    let input = 0;
    let cacheRead = 0;
    let cacheCreation = 0;
    let output = 0;
    for (const [model, record] of Object.entries(modelUsage)) {
      byModel[model] = {
        inputTokens: n(record.inputTokens),
        cacheReadTokens: n(record.cacheReadInputTokens),
        cacheCreationTokens: n(record.cacheCreationInputTokens),
        outputTokens: n(record.outputTokens),
      };
      input += n(record.inputTokens);
      cacheRead += n(record.cacheReadInputTokens);
      cacheCreation += n(record.cacheCreationInputTokens);
      output += n(record.outputTokens);
    }

    // The ledger only sees the conversation's own model responses, so it is
    // compared against the primary model's record rather than the total.
    const primaryModel = parsed.init?.model ?? null;
    const primary = primaryModel ? modelUsage[primaryModel] : undefined;
    const primaryLedger = primaryModel ? byModelLedger[primaryModel] : undefined;
    const ledgerAgreesWithResult =
      primary && primaryLedger
        ? n(primary.cacheReadInputTokens) === primaryLedger.cacheReadTokens &&
          n(primary.cacheCreationInputTokens) === primaryLedger.cacheCreationTokens
        : null;

    return {
      grossInputTokens: input + cacheRead + cacheCreation,
      uncachedInputTokens: input + cacheCreation,
      inputTokens: input,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      outputTokens: output,
      modelCalls: parsed.ledger.length,
      byModel,
      source: 'result-model-usage',
      ledgerGrossInputTokens: ledgerGross,
      ledgerAgreesWithResult,
      costUsd: parsed.result?.totalCostUsd ?? null,
    };
  }

  let input = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let output = 0;
  for (const bucket of Object.values(byModelLedger)) {
    input += bucket.inputTokens;
    cacheRead += bucket.cacheReadTokens;
    cacheCreation += bucket.cacheCreationTokens;
    output += bucket.outputTokens;
  }
  return {
    grossInputTokens: input + cacheRead + cacheCreation,
    uncachedInputTokens: input + cacheCreation,
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    outputTokens: output,
    modelCalls: parsed.ledger.length,
    byModel: byModelLedger,
    source: 'event-ledger',
    ledgerGrossInputTokens: ledgerGross,
    ledgerAgreesWithResult: null,
    costUsd: null,
  };
}

const READ_TOOLS = new Set(['Read']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const SHELL_TOOLS = new Set(['Bash']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

export function toolMetricsFromStream(parsed: ParsedStream): ToolMetrics {
  const byTool: Record<string, number> = {};
  const filesRead = new Set<string>();
  let fileReads = 0;
  let searches = 0;
  let shellCommands = 0;
  let edits = 0;
  let webRequests = 0;
  let subagentCalls = 0;

  for (const use of parsed.toolUses) {
    byTool[use.name] = (byTool[use.name] ?? 0) + 1;
    if (READ_TOOLS.has(use.name)) {
      fileReads += 1;
      const path = use.input['file_path'];
      if (typeof path === 'string') filesRead.add(path);
    } else if (SEARCH_TOOLS.has(use.name)) searches += 1;
    else if (SHELL_TOOLS.has(use.name)) shellCommands += 1;
    else if (EDIT_TOOLS.has(use.name)) edits += 1;
    else if (WEB_TOOLS.has(use.name)) webRequests += 1;
    else if (SUBAGENT_TOOLS.has(use.name)) subagentCalls += 1;
  }

  return {
    toolCalls: parsed.toolUses.length,
    byTool,
    fileReads,
    uniqueFilesRead: filesRead.size,
    searches,
    shellCommands,
    edits,
    webRequests,
    subagentCalls,
    counting: TOOL_COUNTING_NOTE,
  };
}

/**
 * How a session is kept clean of this machine's configuration.
 *
 * `safe-mode` is what #320's runs used: `--safe-mode`, which drops user and
 * repository CLAUDE.md, skills, plugins, hooks — and every MCP server,
 * including one passed with `--mcp-config`. It cannot run the MCP condition.
 *
 * `isolated` loads nothing from the machine or the repository except what a
 * condition declares, and keeps MCP available:
 * `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
 * (no CLAUDE.md from the user or the repository, no memory),
 * `--setting-sources ""` (no user, project or local settings: no env, hooks,
 * permissions or plugins from any of them), and `--strict-mcp-config` with an
 * explicit `--mcp-config` (only the servers the condition declares; an empty
 * set for every non-MCP condition, which also excludes claude.ai connectors).
 *
 * Measured on 2.1.267 against a canary repository carrying a CLAUDE.md,
 * .claude/CLAUDE.md, CLAUDE.local.md, AGENTS.md, project and local settings
 * with env and SessionStart hooks, a project skill, agent and command, and a
 * project .mcp.json (see `eval/results/agent/isolation/`): none of them reached
 * an isolated session. `--safe-mode` itself still applied both settings files'
 * env, and `--setting-sources local` still applied the local one, which is why
 * neither is used for the v3 runs. Every trial records its session's loaded
 * environment and is excluded when it differs from the condition's
 * (`environmentProblems`).
 *
 * `bare` needs ANTHROPIC_API_KEY. `none` is for debugging only.
 */
export type CleanEnvironment = 'safe-mode' | 'isolated' | 'bare' | 'none';

export const ISOLATED_ENVIRONMENT: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
};


export interface ClaudeCodeProviderOptions {
  command?: string;
  cleanEnvironment?: CleanEnvironment;
  /** Seam for tests: replaces the spawn with a scripted stream. */
  spawnImpl?: typeof spawn;
}

export function buildClaudeArgs(
  request: Pick<AgentRunRequest, 'model' | 'effort' | 'webTools' | 'maxBudgetUsd' | 'maxTurns' | 'mcpServers' | 'settings'>,
  options: ClaudeCodeProviderOptions,
): {
  argv: string[];
  env: Record<string, string>;
  disallowedTools: string[];
  cleanEnvironment: string;
} {
  const clean = options.cleanEnvironment ?? 'safe-mode';
  const servers = request.mcpServers ?? {};
  if (clean === 'safe-mode' && Object.keys(servers).length > 0) {
    throw new Error('--safe-mode disables every MCP server; an MCP condition needs cleanEnvironment "isolated".');
  }
  const disallowedTools = [
    ...(request.webTools === 'disabled' ? DEFAULT_DISALLOWED_WEB_TOOLS : []),
    ...UNSTABLE_BUILT_IN_TOOLS,
  ];
  const argv = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--no-session-persistence',
    '--strict-mcp-config',
    ...(clean === 'safe-mode' ? ['--safe-mode'] : clean === 'bare' ? ['--bare'] : []),
    ...(clean === 'isolated' ? ['--setting-sources', '', '--mcp-config', JSON.stringify({ mcpServers: servers })] : []),
    '--model',
    request.model,
    '--effort',
    request.effort,
    ...(disallowedTools.length > 0 ? ['--disallowedTools', ...disallowedTools] : []),
    ...(request.maxBudgetUsd !== null ? ['--max-budget-usd', String(request.maxBudgetUsd)] : []),
    ...(request.maxTurns !== null ? ['--max-turns', String(request.maxTurns)] : []),
    ...(request.settings ? ['--settings', JSON.stringify(request.settings)] : []),
  ];
  return { argv, env: clean === 'isolated' ? { ...ISOLATED_ENVIRONMENT } : {}, disallowedTools, cleanEnvironment: clean };
}

export class ClaudeCodeProvider implements AgentProvider {
  readonly id = 'claude-code';
  readonly label = 'Claude Code';
  private readonly command: string;
  private readonly options: ClaudeCodeProviderOptions;

  constructor(options: ClaudeCodeProviderOptions = {}) {
    this.options = options;
    this.command = options.command ?? 'claude';
  }

  async detect(): Promise<{ available: boolean; version: string; detail: string }> {
    try {
      const { stdout } = await run(this.command, ['--version'], { timeout: 15_000 });
      const version = stdout.trim().split('\n')[0] ?? 'unknown';
      return { available: true, version, detail: `${this.command}: ${version}` };
    } catch (err) {
      return { available: false, version: 'unavailable', detail: (err as Error).message };
    }
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const { argv, env, disallowedTools, cleanEnvironment } = buildClaudeArgs(request, this.options);
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const started = Date.now();
    const lines: string[] = [];
    let stderr = '';

    const outcome = await new Promise<{ code: number | null; timedOut: boolean; launchError: string | null }>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawnImpl(this.command, argv, { cwd: request.cwd, env: { ...request.env, ...env }, windowsHide: true });
      } catch (err) {
        resolve({ code: null, timedOut: false, launchError: (err as Error).message });
        return;
      }

      let timedOut = false;
      let buffered = '';
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, request.timeoutMs);

      const flush = (chunk: string, final: boolean) => {
        buffered += chunk;
        const parts = buffered.split('\n');
        buffered = final ? '' : (parts.pop() ?? '');
        for (const line of parts) {
          if (!line.trim()) continue;
          lines.push(line);
          request.onEventLine?.(line);
          if (request.onProgress) {
            try {
              const event = JSON.parse(line) as { type?: string; message?: { content?: { type?: string; name?: string }[] } };
              if (event.type === 'assistant') {
                for (const block of event.message?.content ?? []) {
                  if (block.type === 'tool_use') request.onProgress(`tool: ${block.name ?? 'unknown'}`);
                }
              }
            } catch {
              // Not JSON; the audit log keeps it regardless.
            }
          }
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => flush(chunk.toString(), false));
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: null, timedOut: false, launchError: err.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        flush('', true);
        resolve({ code, timedOut, launchError: null });
      });

      child.stdin?.write(request.prompt);
      child.stdin?.end();
    });

    const parsed = parseClaudeStream(lines);
    const usage = usageFromStream(parsed);
    const tools = toolMetricsFromStream(parsed);
    const durationMs = Date.now() - started;

    const session: AgentSessionInfo = {
      agentCliVersion: parsed.init?.claudeCodeVersion ?? 'unavailable',
      confirmedModel: parsed.init?.model ?? parsed.ledger[0]?.model ?? 'unavailable',
      permissionMode: parsed.init?.permissionMode ?? 'unavailable',
      tools: parsed.init?.tools ?? [],
      mcpServers: parsed.init?.mcpServers ?? [],
      environment: parsed.init?.environment ?? null,
      argv: [this.command, ...argv],
      disallowedTools,
      cleanEnvironment,
    };

    const status = classifyStatus(outcome, parsed);

    return {
      status,
      exitCode: outcome.code,
      terminalReason: parsed.result?.terminalReason ?? null,
      resultSubtype: parsed.result?.subtype ?? null,
      apiErrorStatus: parsed.result?.apiErrorStatus ?? null,
      numTurns: parsed.result?.numTurns ?? null,
      durationMs,
      apiDurationMs: parsed.result?.durationApiMs ?? null,
      finalMessage: (parsed.result?.resultText ?? '').slice(0, 4000),
      permissionDenials: parsed.result?.permissionDenials ?? 0,
      usage,
      tools,
      session,
      assistantMessages: parsed.ledger.length,
      stderr: stderr.slice(-4000) + (outcome.launchError ? `\nlaunch error: ${outcome.launchError}` : ''),
    };
  }
}

/**
 * How the session ended, for the validity rule.
 *
 * `timeout` and `error` are agent outcomes and count as failed trials.
 * `launch-failure` and `provider-error` are infrastructure: the agent never
 * got to work, or the provider refused it, and the trial is excluded with
 * that reason rather than charged to either condition.
 */
export function classifyStatus(
  outcome: { code: number | null; timedOut: boolean; launchError: string | null },
  parsed: ParsedStream,
): AgentRunResult['status'] {
  if (outcome.launchError) return 'launch-failure';
  if (outcome.timedOut) return 'timeout';
  if (parsed.result?.apiErrorStatus !== null && parsed.result?.apiErrorStatus !== undefined) return 'provider-error';
  if (parsed.ledger.length === 0) {
    // Nothing the model said ever arrived: the session died before work began.
    return parsed.result && !parsed.result.isError ? 'completed' : 'launch-failure';
  }
  if (parsed.result?.isError) return 'error';
  if (outcome.code !== 0 && outcome.code !== null) return 'error';
  return 'completed';
}
