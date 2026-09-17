import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { researchSignals, firstEditSplit } from './agent-context.ts';
import { analyzeWorkspace } from './drift-context.ts';
import { parseClaudeStream, toolMetricsFromStream, type ParsedStream } from './providers/claude-code.ts';
import type { AgentProvider, AgentRunResult } from './providers/types.ts';
import type { AgentCase, Condition, InfrastructureFailure, OrchestrationRecord, TrialArtifact, Usage } from './schema.ts';
import { renderGenericOrchestratedTask, sha256 } from './task.ts';
import { agentVerificationCommands } from './verification-commands.ts';
import type { Workspace } from './workspace.ts';
import {
  applyDeterministicCommits,
  composeAgentPrompt,
  createLogger,
  createProjectVerifier,
  detectRemediationChecks,
  measureBaseline,
  parseScopeRequests,
  verificationGuardSettings,
  runRemediationController,
  upgradedDependencyFindings,
  workaroundFindings,
  isProtectedPath,
  type ControllerRecord,
  type DriftConfig,
  type FixAgent,
  type FixOutcome,
  type FixTask,
  type RemediationPlan,
  type RemediationVerifier,
} from '../../../dist/index.js';
import { DriftConfigSchema } from '../../../dist/config/schema.js';

const execFileAsync = promisify(execFile);

/**
 * The two orchestrated conditions: a controller, not the agent, owns the loop.
 *
 * Both use the product's own controller (`runRemediationController`), the
 * product's own verifier (check discovery, pre-upgrade baseline subtraction,
 * side-effect restore), and the product's own session prompt
 * (`composeAgentPrompt`). What differs is only what Drift's analysis supplies:
 *
 *   generic-orchestrated   one open session with the task (told that an
 *                          orchestrator verifies), then the controller with an
 *                          empty plan — no findings, no impact sites, no
 *                          units, no codemods. Repairs are scoped from the
 *                          check output and the files already edited, which is
 *                          what any orchestrator could do.
 *   drift-orchestrated     Drift's analysis, its deterministic tiers, then the
 *                          controller over Drift's units.
 *
 * Every agent session is a fresh `provider.run` in the same isolated
 * environment as the baseline, with the same model, effort and tools. The
 * sessions share one agent-time budget equal to the case's session timeout,
 * the same limit the baseline's single session has; controller verification
 * runs outside it and is reported separately. Usage is the sum of every
 * session's provider-reported usage.
 */

export type OrchestratedCondition = Extract<Condition, 'generic-orchestrated' | 'drift-orchestrated'>;

export interface OrchestratedOptions {
  condition: OrchestratedCondition;
  agentCase: AgentCase;
  workspace: Workspace;
  provider: AgentProvider;
  model: string;
  effort: string;
  webTools: 'allowed' | 'disabled';
  env: NodeJS.ProcessEnv;
  driftVerify: boolean;
  githubToken?: string;
  onProgress?: (message: string) => void;
  /** Seams for tests. Production uses the product's analysis and verifier. */
  seams?: {
    analyze?: (workspace: Workspace) => Promise<{ config: DriftConfig; plan: RemediationPlan | null; failure: string | null }>;
    verifier?: (workspace: Workspace, agentCase: AgentCase) => Promise<{ verifier: RemediationVerifier | null; checks: string[]; baselineMs: number }>;
  };
}

export interface CapturedSession {
  index: number;
  kind: 'open' | 'unit' | 'repair';
  unitId: string | null;
  round: number;
  prompt: string;
  result: AgentRunResult;
  lines: string[];
  parsed: ParsedStream;
}

export interface OrchestratedResult {
  agent: AgentRunResult;
  streamLines: string[];
  /** Every session's prompt, in order, for the prompt hash. */
  prompts: string[];
  orchestration: OrchestrationRecord;
  driftPlan: TrialArtifact['context']['driftPlan'];
  driftStatus: TrialArtifact['context']['driftStatus'];
  driftFailure: string | null;
  analysisMs: number;
  infrastructure: { failure: InfrastructureFailure; detail: string } | null;
  sessions: CapturedSession[];
}

/** Separator written into the stored stream before each session's events. `parseClaudeStream` ignores it. */
export const SESSION_MARKER_TYPE = 'drift_benchmark_session';

export async function runOrchestrated(options: OrchestratedOptions): Promise<OrchestratedResult> {
  const started = Date.now();
  const { agentCase, workspace } = options;
  const budgetMs = agentCase.agent.timeoutSeconds * 1000;
  const sessions: CapturedSession[] = [];
  const abort = new AbortController();
  let infrastructure: OrchestratedResult['infrastructure'] = null;
  let budgetExhausted = false;
  let usedMs = 0;
  let pending: { kind: CapturedSession['kind']; unitId: string | null; round: number } = { kind: 'unit', unitId: null, round: 0 };

  // Both orchestrated conditions verify outside the agent, so every session in
  // either gets the product's verification guard — identical tools otherwise.
  const guard = verificationGuardSettings();
  const guarded = new Set<number>();
  const session = async (prompt: string): Promise<AgentRunResult | null> => {
    const remaining = budgetMs - usedMs;
    if (remaining < 30_000) {
      budgetExhausted = true;
      abort.abort();
      return null;
    }
    const lines: string[] = [];
    options.onProgress?.(`    session ${sessions.length + 1} (${pending.kind}${pending.unitId ? ` ${pending.unitId}` : ''}, round ${pending.round})`);
    const result = await options.provider.run({
      prompt,
      cwd: workspace.repo,
      model: options.model,
      effort: options.effort,
      timeoutMs: remaining,
      webTools: options.webTools,
      maxBudgetUsd: null,
      maxTurns: null,
      env: options.env,
      mcpServers: {},
      settings: guard,
      onEventLine: (line) => lines.push(line),
      onProgress: (message) => options.onProgress?.(`      ${message}`),
    });
    usedMs += result.durationMs;
    guarded.add(sessions.length + 1);
    sessions.push({ index: sessions.length + 1, ...pending, prompt, result, lines, parsed: parseClaudeStream(lines) });
    if (result.status === 'provider-error' || result.status === 'launch-failure') {
      infrastructure = {
        failure: result.status === 'provider-error' ? 'provider_error' : 'agent_launch_failure',
        detail: `session ${sessions.length}: ${result.status === 'provider-error' ? `api error status ${result.apiErrorStatus}: ${result.finalMessage.slice(0, 300)}` : result.stderr.trim().slice(0, 300)}`,
      };
      abort.abort();
    } else if (result.status === 'timeout') {
      budgetExhausted = true;
      abort.abort();
    }
    return result;
  };

  const agent: FixAgent = {
    id: `benchmark-${options.provider.id}`,
    label: options.provider.label,
    description: 'A benchmark session driven through the isolated provider.',
    kind: 'cli',
    capabilities: { execution: 'workspace', canAwaitCompletion: false, canInspectResult: true },
    detect: async () => ({ available: true }),
    run: async (task: FixTask): Promise<FixOutcome> => {
      const result = await session(composeAgentPrompt(task));
      if (!result) return { status: 'failed', message: 'The agent-time budget for this trial is exhausted.' };
      const message = result.finalMessage;
      return {
        status: result.status === 'completed' ? 'applied' : 'failed',
        message: message || `session ended: ${result.status}`,
        scopeRequests: parseScopeRequests(message),
      };
    },
  };

  const logger = createLogger('error');
  let analysisMs = 0;
  let deterministicMs = 0;
  let driftPlan: TrialArtifact['context']['driftPlan'] = null;
  let driftStatus: TrialArtifact['context']['driftStatus'] = 'not-applicable';
  let driftFailure: string | null = null;
  const units = { total: 0, resolvedByCodemod: 0, resolvedByFixPlan: 0, sentToAgent: 0, skippedProtected: 0, merged: 0, requiringRepair: 0 };
  let analysis: OrchestrationRecord['analysis'] = null;
  let plan: RemediationPlan;
  let config: DriftConfig;
  let commits: RemediationPlan['commits'] = [];

  if (options.condition === 'drift-orchestrated') {
    const t0 = Date.now();
    options.onProgress?.('  drift analysis');
    const analyzed = await (options.seams?.analyze ?? productAnalysis(options))(workspace);
    analysisMs = Date.now() - t0;
    config = analyzed.config;
    if (!analyzed.plan) {
      driftStatus = analyzed.failure?.startsWith('failed:') ? 'failed' : 'no-plan';
      driftFailure = analyzed.failure;
      // No plan is a product outcome: the controller still verifies and repairs, with nothing from Drift.
      plan = neutralPlan(agentCase);
    } else {
      driftStatus = 'completed';
      plan = analyzed.plan;
      driftPlan = {
        breakingChanges: plan.breakingChanges.length,
        impactSites: plan.impactSites.length,
        impactFiles: [...new Set(plan.impactSites.map((site) => site.file))].sort(),
        symbols: [...new Set(plan.breakingChanges.flatMap((change) => change.symbols))].sort(),
        verdict: 'n/a',
        verificationStatus: plan.verification?.status ?? null,
        evidenceSources: plan.evidence.length,
      };
      analysis = { breakingChanges: plan.breakingChanges.length, impactSites: plan.impactSites.length, commits: plan.commits.length, verificationStatus: plan.verification?.status ?? null };
      const t1 = Date.now();
      const deterministic = await applyDeterministicCommits({ worktree: workspace.repo, plan, config, logger, nonInteractive: true });
      deterministicMs = Date.now() - t1;
      units.total = plan.commits.length;
      units.resolvedByCodemod = deterministic.builtinResolved;
      units.resolvedByFixPlan = deterministic.fixPlanResolved;
      commits = deterministic.needsAgent;
    }
  } else {
    config = DriftConfigSchema.parse({});
    plan = neutralPlan(agentCase);
  }

  options.onProgress?.('  controller checks and pre-upgrade baseline');
  const { verifier, checks, baselineMs } = await (options.seams?.verifier ?? productVerifier(options.env))(workspace, agentCase);

  let record: ControllerRecord | null = null;
  if (options.condition === 'generic-orchestrated') {
    await verifier?.markInstalled();
    pending = { kind: 'open', unitId: null, round: 0 };
    const prompt = renderGenericOrchestratedTask(agentCase);
    const result = await session(prompt);
    if (result && !infrastructure) await settleOpenSession(workspace.repo, agentCase.dependency.name, sessions.at(-1)!);
  }

  if (!infrastructure && !budgetExhausted) {
    record = await runRemediationController({
      root: workspace.repo,
      plan,
      config,
      agent,
      verifier,
      logger,
      commits,
      signal: abort.signal,
      onSessionStart: (start) => {
        pending = { kind: start.origin === 'plan' ? 'unit' : 'repair', unitId: start.unitId, round: start.round };
      },
    });
  }

  // Controller records carry what happened to each session's edits; attach them by order.
  const controllerSessions = record?.sessions ?? [];
  const outcomes = new Map<number, (typeof controllerSessions)[number]>();
  let offset = sessions.findIndex((s) => s.kind !== 'open');
  if (offset < 0) offset = sessions.length;
  controllerSessions.forEach((entry, i) => outcomes.set(offset + i, entry));

  if (record) {
    units.sentToAgent = record.units.filter((unit) => unit.resolution === 'agent').length;
    units.skippedProtected = record.units.filter((unit) => unit.resolution === 'skipped-protected').length;
    units.merged = record.units.filter((unit) => unit.resolution === 'merged').length;
    units.requiringRepair = new Set(record.sessions.filter((s) => s.origin === 'repair' && s.unitId !== 'residual').map((s) => s.unitId.replace(/-repair$/, ''))).size;
  }

  const orchestration: OrchestrationRecord = {
    kind: options.condition === 'drift-orchestrated' ? 'drift' : 'generic',
    sessions: sessions.map((captured, i) => {
      const controllerEntry = outcomes.get(i);
      const split = firstEditSplit(captured.parsed);
      return {
        index: captured.index,
        kind: captured.kind,
        unitId: captured.unitId,
        round: captured.round,
        allowedFiles: controllerEntry ? controllerEntry.allowedFiles : null,
        changedFiles: controllerEntry ? controllerEntry.changedFiles : (captured as CapturedSession & { changed?: string[] }).changed ?? [],
        outcome: controllerEntry ? controllerEntry.status : ((captured as CapturedSession & { outcome?: string }).outcome ?? captured.result.status),
        reasons: controllerEntry ? controllerEntry.reasons.slice(0, 10) : ((captured as CapturedSession & { reasons?: string[] }).reasons ?? []),
        scopeRequests: controllerEntry ? controllerEntry.scopeRequests.map((request) => request.path) : [],
        agentStatus: captured.result.status,
        promptChars: captured.prompt.length,
        promptHash: sha256(captured.prompt),
        durationMs: captured.result.durationMs,
        usage: captured.result.usage,
        toolCalls: captured.result.tools.toolCalls,
        tokensBeforeFirstEdit: split.before,
        tokensAfterFirstEdit: split.after,
        agentVerification: agentVerificationCommands(captured.parsed),
        verificationGuard: guarded.has(captured.index),
        research: researchSignals(captured.parsed, agentCase.dependency.name),
        environmentFingerprint: captured.result.session.environment?.fingerprint ?? null,
      };
    }),
    controller: {
      termination: record?.termination ?? (infrastructure ? 'infrastructure' : budgetExhausted ? 'budget-exhausted' : 'not-run'),
      terminationDetail: record?.terminationDetail ?? '',
      repairRounds: record?.repairRounds ?? 0,
      outOfScopeRejections: record?.outOfScopeRejections ?? 0,
      workaroundRejections: record?.workaroundRejections ?? 0,
      grantedFiles: record?.grantedFiles ?? [],
      deniedScopeRequests: (record?.deniedScopeRequests ?? []).map((request) => request.path),
      needsHuman: record?.needsHuman ?? [],
      verifications: (record?.verifications ?? []).map((v) => ({
        round: v.round,
        fresh: v.fresh,
        passed: v.passed,
        fingerprint: v.fingerprint,
        durationMs: v.durationMs,
        installed: v.installed,
        failures: v.failures,
        preexisting: v.preexisting,
        checks: v.checks,
        sideEffectsReverted: v.sideEffectsReverted,
      })),
    },
    checks,
    units,
    analysis,
    timing: {
      analysisMs,
      deterministicMs,
      baselineMeasurementMs: baselineMs,
      agentMs: sessions.reduce((sum, s) => sum + s.result.durationMs, 0),
      controllerVerificationMs: record?.verificationMs ?? 0,
      endToEndMs: Date.now() - started,
    },
    agentBudgetMs: budgetMs,
    budgetExhausted,
  };

  const streamLines = sessions.flatMap((captured) => [
    JSON.stringify({ type: SESSION_MARKER_TYPE, index: captured.index, kind: captured.kind, unitId: captured.unitId, round: captured.round }),
    ...captured.lines,
  ]);

  return {
    agent: aggregateAgentResult(sessions, { budgetExhausted, record, infrastructure }),
    streamLines,
    prompts: sessions.map((s) => s.prompt),
    orchestration,
    driftPlan,
    driftStatus,
    driftFailure,
    analysisMs,
    infrastructure,
    sessions,
  };
}

/**
 * The generic condition's open session is unscoped, so it cannot go through
 * unit scope validation. It gets the same generic safety rules the controller
 * applies to every edit: a workaround or a change to the upgraded dependency
 * rejects the session's edits; an edit to a protected path (a CI workflow) is
 * restored on its own. What remains is committed so the controller starts
 * from it.
 */
async function settleOpenSession(repo: string, dependency: string, captured: CapturedSession): Promise<void> {
  const record = captured as CapturedSession & { changed?: string[]; outcome?: string; reasons?: string[] };
  const git = async (...args: string[]) => (await execFileAsync('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024 })).stdout;
  const status = (await git('status', '--porcelain=v1', '-z', '--untracked-files=all')).split('\0').filter(Boolean);
  const changed = status.map((entry) => ({ path: entry.slice(3), status: entry.startsWith('??') ? 'untracked' : entry[1] === 'D' || entry[0] === 'D' ? 'deleted' : 'modified' }));
  record.changed = changed.map((c) => c.path);
  if (changed.length === 0) {
    record.outcome = 'no-change';
    return;
  }
  await git('add', '-A');
  const patch = await git('diff', '--cached', '--find-renames');
  const reasons = [...workaroundFindings(patch, changed as never), ...upgradedDependencyFindings(patch, [dependency])];
  if (reasons.length > 0) {
    await git('reset', '--hard', 'HEAD');
    await git('clean', '-fd');
    record.outcome = 'rejected';
    record.reasons = reasons;
    return;
  }
  const protectedPaths = changed.map((c) => c.path).filter((path) => isProtectedPath(path));
  if (protectedPaths.length > 0) {
    await git('reset', '-q', 'HEAD', '--', ...protectedPaths);
    await git('checkout', '--', ...protectedPaths.filter((path) => changed.find((c) => c.path === path)?.status !== 'untracked')).catch(() => '');
    record.reasons = [`restored protected path(s): ${protectedPaths.join(', ')}`];
  }
  const staged = (await git('diff', '--cached', '--name-only')).trim();
  if (staged) {
    await git('-c', 'user.email=bench@drift.invalid', '-c', 'user.name=Drift Benchmark', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'open session edits');
    record.outcome = 'accepted';
  } else {
    record.outcome = 'no-change';
  }
}

/** A plan with the dependency change and nothing Drift inferred about it. */
export function neutralPlan(agentCase: AgentCase): RemediationPlan {
  return {
    id: 'generic',
    branchName: 'generic',
    baseBranch: 'main',
    changes: [{ name: agentCase.dependency.name, from: agentCase.dependency.fromVersion, to: agentCase.dependency.toVersion, ecosystem: agentCase.ecosystem }],
    breakingChanges: [],
    impactSites: [],
    evidence: [],
    commits: [],
    blockers: [],
  } as unknown as RemediationPlan;
}

function productAnalysis(options: OrchestratedOptions) {
  return async (workspace: Workspace) => {
    try {
      const { config, result } = await analyzeWorkspace(workspace, { verify: options.driftVerify, githubToken: options.githubToken });
      return { config, plan: result.plan ?? null, failure: result.plan ? null : result.summary };
    } catch (err) {
      return { config: DriftConfigSchema.parse({}), plan: null, failure: `failed: ${(err as Error).message}` };
    }
  };
}

/** The product's verifier, run in the same project environment the agent sessions and validation use. */
const productVerifier = (env: NodeJS.ProcessEnv) => async (workspace: Workspace, agentCase: AgentCase) => {
  const started = Date.now();
  const checks = await detectRemediationChecks(workspace.repo, agentCase.workspaceDir);
  if (checks.length === 0) return { verifier: null, checks: [], baselineMs: 0 };
  const baseline = await measureBaseline({ root: workspace.repo, ref: workspace.baseCommit, dir: agentCase.workspaceDir, checks, env });
  const verifier = createProjectVerifier({ root: workspace.repo, dir: agentCase.workspaceDir, checks, baseline: baseline.outcomes, coverageBaseline: baseline.coverage, env });
  return { verifier, checks: checks.map((check) => check.label), baselineMs: Date.now() - started };
};

export function sumUsage(usages: readonly Usage[]): Usage {
  const total: Usage = {
    grossInputTokens: 0,
    uncachedInputTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    modelCalls: 0,
    byModel: {},
    source: usages.every((u) => u.source === 'result-model-usage') && usages.length > 0 ? 'result-model-usage' : 'event-ledger',
    ledgerGrossInputTokens: 0,
    ledgerAgreesWithResult: usages.some((u) => u.ledgerAgreesWithResult === false) ? false : usages.length > 0 && usages.every((u) => u.ledgerAgreesWithResult === true) ? true : null,
    costUsd: usages.length > 0 && usages.every((u) => u.costUsd !== null) ? usages.reduce((sum, u) => sum + (u.costUsd ?? 0), 0) : null,
  };
  for (const usage of usages) {
    total.grossInputTokens += usage.grossInputTokens;
    total.uncachedInputTokens += usage.uncachedInputTokens;
    total.inputTokens += usage.inputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheCreationTokens += usage.cacheCreationTokens;
    total.outputTokens += usage.outputTokens;
    total.modelCalls += usage.modelCalls;
    total.ledgerGrossInputTokens += usage.ledgerGrossInputTokens;
    for (const [model, bucket] of Object.entries(usage.byModel)) {
      const into = (total.byModel[model] ??= { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 });
      into.inputTokens += bucket.inputTokens;
      into.cacheReadTokens += bucket.cacheReadTokens;
      into.cacheCreationTokens += bucket.cacheCreationTokens;
      into.outputTokens += bucket.outputTokens;
    }
  }
  return total;
}

/**
 * One `AgentRunResult` for the whole trial, so validation, validity and every
 * existing report treat an orchestrated trial like any other.
 *
 * Status: an infrastructure failure in any session is that failure; an
 * exhausted agent-time budget is `timeout` (a valid failure, as for the
 * baseline); otherwise `completed` — a single session that errored is a
 * controller event the loop already handled, not the trial's outcome.
 */
export function aggregateAgentResult(
  sessions: readonly CapturedSession[],
  state: { budgetExhausted: boolean; record: ControllerRecord | null; infrastructure: OrchestratedResult['infrastructure'] },
): AgentRunResult {
  const infra = sessions.find((s) => s.result.status === 'provider-error' || s.result.status === 'launch-failure');
  const status: AgentRunResult['status'] = infra ? infra.result.status : state.budgetExhausted ? 'timeout' : 'completed';
  const first = sessions[0]?.result;
  const last = sessions.at(-1)?.result;
  const allLines = sessions.flatMap((s) => s.lines);
  const fingerprints = new Set(sessions.map((s) => s.result.session.environment?.fingerprint ?? 'none'));
  return {
    status,
    exitCode: last?.exitCode ?? 0,
    terminalReason: state.record ? `controller:${state.record.termination}` : (last?.terminalReason ?? null),
    resultSubtype: last?.resultSubtype ?? null,
    apiErrorStatus: infra?.result.apiErrorStatus ?? null,
    numTurns: sessions.reduce((sum, s) => sum + (s.result.numTurns ?? 0), 0),
    durationMs: sessions.reduce((sum, s) => sum + s.result.durationMs, 0),
    apiDurationMs: sessions.reduce((sum, s) => sum + (s.result.apiDurationMs ?? 0), 0),
    finalMessage: [state.record ? `Controller: ${state.record.termination} — ${state.record.terminationDetail}` : '', last?.finalMessage ?? ''].filter(Boolean).join('\n\n').slice(0, 4000),
    permissionDenials: sessions.reduce((sum, s) => sum + s.result.permissionDenials, 0),
    usage: sumUsage(sessions.map((s) => s.result.usage)),
    tools: toolMetricsFromStream(parseClaudeStream(allLines)),
    session: first
      ? {
          ...first.session,
          // Every session must have loaded the same environment; a difference is surfaced as a mismatch.
          environment: fingerprints.size > 1 && first.session.environment ? { ...first.session.environment, fingerprint: `mixed:${[...fingerprints].sort().join('+')}` } : first.session.environment,
        }
      : {
          agentCliVersion: 'unavailable',
          confirmedModel: 'unavailable',
          permissionMode: 'unavailable',
          tools: [],
          mcpServers: [],
          environment: null,
          argv: [],
          disallowedTools: [],
          cleanEnvironment: 'unavailable',
        },
    assistantMessages: sessions.reduce((sum, s) => sum + s.result.assistantMessages, 0),
    stderr: last?.stderr ?? '',
  };
}
