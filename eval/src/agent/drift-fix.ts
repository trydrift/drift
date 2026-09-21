import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentProvider, AgentRunRequest, AgentRunResult } from './providers/types.ts';
import type { ToolMetrics, Usage } from './schema.ts';
import {
  DriftConfigSchema,
  composeAgentPrompt,
  createLogger,
  runAgentUpgradeFix,
  type RemediationPlan,
} from '../../../dist/index.js';

const execFile = promisify(execFileCb);

/**
 * The `drift-fix` condition: the product's own "Fix with AI", not a report
 * pasted in front of a task.
 *
 * Every other Drift condition gives one agent session the benchmark's task
 * plus some rendering of Drift's analysis. That answers whether the analysis
 * helps an agent that is otherwise working alone. It does not measure what the
 * CLI and the extension actually do when a developer asks Drift to fix an
 * upgrade with a local agent, which is `runAgentUpgradeFix`: one session over
 * the whole repository, prompted with `composeAgentPrompt` in upgrade mode
 * (Drift's findings and the project's measured failures as a head start),
 * then each changed file validated on its own by `validateUpgradeFix` and only
 * the ones that break a rule reverted. It replaced `runAgentCommitsInWorktree`,
 * the unit-by-unit pipeline, after this condition measured that one fixing
 * none of ten upgrades a plain agent fixed nearly all of.
 *
 * So this condition runs that function, unmodified, in the trial's workspace.
 * The only substitution is the transport: each agent session goes through the
 * benchmark's own provider rather than the product's CLI adapter, so it
 * launches with the same isolation as the baseline (web tools off, no MCP
 * servers, no session persistence) and its tokens are counted by the same
 * parser. What Drift decides — the units, their prompts, their scope, which
 * results survive — is all the product's.
 *
 * Deterministic tiers (codemods, fix plans) run before any agent in `drift
 * fix`. None fire on this suite (`eval/results/swe-bump-*` records 0 codemod
 * units over 57 real upgrades), so units carrying one are recorded rather than
 * silently skipped, and would need the deterministic path added here first.
 */

export interface DriftFixOutcome {
  /** The sessions' results merged into one, so the trial records one agent run. */
  agent: AgentRunResult;
  /** One line per unit: what Drift planned and what became of it. */
  summary: string;
}

type SessionRequest = Omit<AgentRunRequest, 'prompt' | 'cwd'>;

export async function runDriftFix(options: {
  plan: RemediationPlan;
  workspace: string;
  provider: AgentProvider;
  session: SessionRequest;
  model: string;
  effort: string;
}): Promise<DriftFixOutcome> {
  const { plan, workspace, provider, session } = options;

  // `runAgentCommitsInWorktree` commits what it accepts. The benchmark diffs
  // from its own recorded start commit, so those commits are part of the
  // measured patch exactly as uncommitted edits would be; they need only an
  // identity to be made at all.
  await execFile('git', ['config', 'user.email', 'bench@drift.invalid'], { cwd: workspace });
  await execFile('git', ['config', 'user.name', 'Drift Benchmark'], { cwd: workspace });
  await execFile('git', ['config', 'commit.gpgsign', 'false'], { cwd: workspace });

  const deterministic = plan.commits.filter((commit) => commit.codemod || commit.fixPlan);

  const sessions: AgentRunResult[] = [];
  const agent = {
    id: 'benchmark-claude-code',
    label: 'Claude Code',
    description: "The benchmark's Claude Code provider, standing in for the product's CLI adapter.",
    kind: 'cli' as const,
    capabilities: { execution: 'workspace' as const, canAwaitCompletion: true, canInspectResult: true },
    async detect() {
      const found = await provider.detect();
      return { available: found.available, detail: found.detail };
    },
    async run(task: Parameters<typeof composeAgentPrompt>[0]) {
      // No effort keywords: Claude Code takes `--effort` as a flag, which the
      // provider passes, so the product's CLI adapter would add none either.
      const prompt = composeAgentPrompt(task);
      const result = await provider.run({ ...session, prompt, cwd: task.workspaceRoot });
      sessions.push(result);
      return result.status === 'completed'
        ? { status: 'applied' as const, message: result.finalMessage }
        : { status: 'failed' as const, message: `${result.status}: ${result.finalMessage.slice(0, 500)}` };
    },
  };

  const config = DriftConfigSchema.parse({ remediation: { agent: { model: options.model, effort: options.effort } } });
  const run = await runAgentUpgradeFix({ plan, config, worktree: workspace, agent: agent as never, logger: createLogger('error') });

  const lines = [
    `drift-fix: ${plan.commits.length} unit(s) planned, ${deterministic.length} deterministic (not run here); one whole-upgrade session`,
    `outcome ${run.status}: kept ${run.kept.length} file(s), reverted ${run.reverted.length}`,
    ...run.reverted.map((offender) => `reverted ${offender.path}: ${offender.reasons.join(' ').replace(/\s+/g, ' ').slice(0, 240)}`),
  ];

  return { agent: mergeSessions(sessions, lines.join('\n')), summary: lines.join('\n') };
}

/**
 * One trial records one agent run, so the sessions are summed: tokens, tool
 * calls, turns and time add up, and the run's status is the worst any session
 * had — a provider error in the second unit is still a provider error.
 */
function mergeSessions(sessions: AgentRunResult[], summary: string): AgentRunResult {
  if (sessions.length === 0) {
    return {
      status: 'completed',
      exitCode: 0,
      terminalReason: 'no-agent-units',
      resultSubtype: null,
      apiErrorStatus: null,
      numTurns: 0,
      durationMs: 0,
      apiDurationMs: 0,
      finalMessage: summary,
      permissionDenials: 0,
      usage: emptyUsage(),
      tools: emptyTools(),
      session: { agentCliVersion: 'unavailable', confirmedModel: 'unavailable', tools: [], mcpServers: [], argv: [] } as never,
      assistantMessages: 0,
      stderr: '',
    };
  }

  const severity: Record<AgentRunResult['status'], number> = { completed: 0, error: 1, timeout: 2, 'launch-failure': 3, 'provider-error': 4 };
  const worst = sessions.reduce((a, b) => (severity[b.status] > severity[a.status] ? b : a));
  const sum = (pick: (r: AgentRunResult) => number | null) => sessions.reduce((total, r) => total + (pick(r) ?? 0), 0);

  const byModel: Usage['byModel'] = {};
  for (const r of sessions) {
    for (const [model, u] of Object.entries(r.usage.byModel)) {
      const into = (byModel[model] ??= { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 });
      into.inputTokens += u.inputTokens;
      into.cacheReadTokens += u.cacheReadTokens;
      into.cacheCreationTokens += u.cacheCreationTokens;
      into.outputTokens += u.outputTokens;
    }
  }
  const byTool: Record<string, number> = {};
  for (const r of sessions) for (const [tool, n] of Object.entries(r.tools.byTool)) byTool[tool] = (byTool[tool] ?? 0) + n;

  const costs = sessions.map((r) => r.usage.costUsd);
  return {
    ...worst,
    numTurns: sum((r) => r.numTurns),
    durationMs: sum((r) => r.durationMs),
    apiDurationMs: sum((r) => r.apiDurationMs),
    permissionDenials: sum((r) => r.permissionDenials),
    assistantMessages: sum((r) => r.assistantMessages),
    finalMessage: `${summary}\n\n${sessions.map((r) => r.finalMessage).join('\n---\n')}`.slice(0, 20_000),
    stderr: sessions.map((r) => r.stderr).filter(Boolean).join('\n---\n'),
    usage: {
      grossInputTokens: sum((r) => r.usage.grossInputTokens),
      uncachedInputTokens: sum((r) => r.usage.uncachedInputTokens),
      inputTokens: sum((r) => r.usage.inputTokens),
      cacheReadTokens: sum((r) => r.usage.cacheReadTokens),
      cacheCreationTokens: sum((r) => r.usage.cacheCreationTokens),
      outputTokens: sum((r) => r.usage.outputTokens),
      modelCalls: sum((r) => r.usage.modelCalls),
      byModel,
      source: sessions.every((r) => r.usage.source === 'result-model-usage') ? 'result-model-usage' : 'event-ledger',
      ledgerGrossInputTokens: sum((r) => r.usage.ledgerGrossInputTokens),
      ledgerAgreesWithResult: sessions.every((r) => r.usage.ledgerAgreesWithResult !== false) ? (sessions.some((r) => r.usage.ledgerAgreesWithResult === null) ? null : true) : false,
      costUsd: costs.every((c) => c !== null) ? costs.reduce((a, b) => a! + b!, 0) : null,
    },
    tools: {
      toolCalls: sum((r) => r.tools.toolCalls),
      byTool,
      fileReads: sum((r) => r.tools.fileReads),
      uniqueFilesRead: sum((r) => r.tools.uniqueFilesRead),
      searches: sum((r) => r.tools.searches),
      shellCommands: sum((r) => r.tools.shellCommands),
      edits: sum((r) => r.tools.edits),
      webRequests: sum((r) => r.tools.webRequests),
      subagentCalls: sum((r) => r.tools.subagentCalls),
      counting: `${sessions[0]!.tools.counting} (summed over ${sessions.length} session(s))`,
    },
  };
}

function emptyUsage(): Usage {
  return {
    grossInputTokens: 0,
    uncachedInputTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    modelCalls: 0,
    byModel: {},
    source: 'event-ledger',
    ledgerGrossInputTokens: 0,
    ledgerAgreesWithResult: null,
    costUsd: 0,
  };
}

function emptyTools(): ToolMetrics {
  return { toolCalls: 0, byTool: {}, fileReads: 0, uniqueFilesRead: 0, searches: 0, shellCommands: 0, edits: 0, webRequests: 0, subagentCalls: 0, counting: 'no agent session ran' };
}
