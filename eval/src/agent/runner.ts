import { arch, platform, release } from 'node:os';
import { hashCase, loadCase, loadHidden, loadSuite, suiteHashMismatches } from './cases.ts';
import { agentContextDiagnostics } from './agent-context.ts';
import { buildDriftContext, type DriftContext } from './drift-context.ts';
import { parseClaudeStream } from './providers/claude-code.ts';
import type { AgentProvider, AgentRunResult } from './providers/types.ts';
import {
  AGENT_TRIAL_SCHEMA_VERSION,
  HEADLINE_CONDITIONS,
  type AgentCase,
  type Condition,
  type HiddenMaterial,
  type TrialArtifact,
  type ToolMetrics,
  type Usage,
} from './schema.ts';
import { driftRevision, driftVersion, newRunId, setAsideInfrastructureFailure, trialExists, writeRunManifest, writeTrial } from './store.ts';
import { composePrompt, contextKindFor, renderTask, sha256 } from './task.ts';
import { patchStatsFrom, validateWorkspace } from './validation.ts';
import { captureDiff, materializeWorkspace, projectEnv, runCommand, type Workspace } from './workspace.ts';

/**
 * One trial, start to finish:
 *
 *   materialize → install → (Drift analysis, Drift condition only) → agent
 *   session → capture diff → validate → write artifact
 *
 * and the schedule that runs them. Conditions alternate order on every
 * repetition — repetition 1 runs baseline then Drift for each case,
 * repetition 2 runs Drift then baseline — so neither condition is
 * systematically first when the provider is slow or the registry is warm.
 */

export const MAX_DIFF_CHARS = 2_000_000;

export interface RunOptions {
  suite: string;
  /** Restrict to these case ids. Empty means every case in the suite. */
  caseIds?: string[];
  runs: number;
  conditions?: Condition[];
  provider: AgentProvider;
  model: string;
  effort: string;
  webTools?: 'allowed' | 'disabled';
  maxBudgetUsd?: number | null;
  maxTurns?: number | null;
  driftVerify?: boolean;
  githubToken?: string;
  runId?: string;
  notes?: string;
  root?: string;
  /**
   * Attempt again the slots whose recorded trial was excluded for an
   * infrastructure failure (a provider outage, a rate limit, a check that
   * could not start). Valid trials are never retried, whatever their outcome.
   */
  retryInfrastructure?: boolean;
  onProgress?: (message: string) => void;
}

export interface RunOutcome {
  runId: string;
  written: number;
  skipped: number;
  trials: TrialArtifact[];
}

export async function runBenchmark(options: RunOptions): Promise<RunOutcome> {
  const root = options.root ?? process.cwd();
  const manifest = await loadSuite(options.suite, root);
  const mismatches = await suiteHashMismatches(manifest, root);
  if (mismatches.length > 0) {
    if (manifest.status === 'frozen') {
      throw new Error(`Suite ${manifest.suite} is frozen and its cases changed on disk:\n  - ${mismatches.join('\n  - ')}`);
    }
    options.onProgress?.(`warning: draft suite ${manifest.suite} has ${mismatches.length} case(s) whose hash differs from the manifest`);
  }

  const wanted = options.caseIds?.length ? options.caseIds : manifest.cases.map((entry) => entry.id);
  const unknown = wanted.filter((id) => !manifest.cases.some((entry) => entry.id === id));
  if (unknown.length > 0) throw new Error(`Not in suite ${manifest.suite}: ${unknown.join(', ')}`);

  const conditions = options.conditions ?? [...HEADLINE_CONDITIONS];
  const detected = await options.provider.detect();
  if (!detected.available) throw new Error(`${options.provider.label} is not available: ${detected.detail}`);
  const revision = await driftRevision(root);
  const version = await driftVersion(root);
  const runId = options.runId ?? newRunId(manifest.suite, options.model);

  await writeRunManifest(
    {
      version: 'drift-agent-run-v1',
      runId,
      suite: manifest.suite,
      suiteStatus: manifest.status,
      createdAt: new Date().toISOString(),
      command: process.argv.join(' '),
      driftCommit: revision.commit,
      driftTreeDirty: revision.dirty,
      provider: options.provider.id,
      requestedModel: options.model,
      requestedEffort: options.effort,
      agentCliVersion: detected.version,
      runsPerCondition: options.runs,
      conditions,
      caseIds: wanted,
      node: process.version,
      platform: platform(),
      arch: arch(),
      notes: options.notes ?? '',
    },
    root,
  );

  const trials: TrialArtifact[] = [];
  let written = 0;
  let skipped = 0;
  let scheduleIndex = 0;

  for (let repetition = 1; repetition <= options.runs; repetition += 1) {
    const order = repetition % 2 === 1 ? conditions : [...conditions].reverse();
    for (const caseId of wanted) {
      const agentCase = await loadCase(caseId, root);
      const caseHash = await hashCase(caseId, root);
      const hidden = await loadHidden(caseId, root);
      for (const condition of order) {
        scheduleIndex += 1;
        if (await trialExists(runId, caseId, condition, repetition, root)) {
          const retry = options.retryInfrastructure ? await setAsideInfrastructureFailure(runId, caseId, condition, repetition, root) : { setAside: false, reason: 'artifact exists' };
          if (!retry.setAside) {
            skipped += 1;
            options.onProgress?.(`skip ${caseId} ${condition} rep ${repetition}: ${retry.reason}`);
            continue;
          }
          options.onProgress?.(`retry ${caseId} ${condition} rep ${repetition}: ${retry.reason}`);
        }
        options.onProgress?.(`trial ${caseId} ${condition} rep ${repetition} (${scheduleIndex})`);
        const { artifact, diff, streamLines } = await runTrial({
          agentCase,
          caseHash,
          hidden,
          condition,
          repetition,
          scheduleIndex,
          runId,
          suite: manifest.suite,
          provider: options.provider,
          agentCliVersion: detected.version,
          model: options.model,
          effort: options.effort,
          webTools: options.webTools ?? 'disabled',
          maxBudgetUsd: options.maxBudgetUsd ?? null,
          maxTurns: options.maxTurns ?? null,
          driftVerify: options.driftVerify ?? true,
          githubToken: options.githubToken,
          driftCommit: revision.commit,
          driftTreeDirty: revision.dirty,
          driftVersion: version,
          root,
          onProgress: options.onProgress,
        });
        await writeTrial(artifact, { diff, streamLines }, root);
        trials.push(artifact);
        written += 1;
        options.onProgress?.(
          artifact.validity.valid
            ? `  → ${artifact.validation.success ? 'SUCCESS' : 'failed'} [${artifact.validation.failureReasons.join(', ') || 'no reasons'}] ` +
                `gross input ${artifact.usage.grossInputTokens.toLocaleString('en-US')} tokens, ${Math.round(artifact.agent.durationMs / 1000)}s`
            : `  → EXCLUDED (${artifact.validity.infrastructureFailure}: ${(artifact.validity.detail ?? '').split('\n')[0]?.slice(0, 120)})`,
        );
      }
    }
  }

  return { runId, written, skipped, trials };
}

export interface TrialOptions {
  agentCase: AgentCase;
  caseHash: string;
  hidden: HiddenMaterial;
  condition: Condition;
  repetition: number;
  scheduleIndex: number;
  runId: string;
  suite: string;
  provider: AgentProvider;
  agentCliVersion: string;
  model: string;
  effort: string;
  webTools: 'allowed' | 'disabled';
  maxBudgetUsd: number | null;
  maxTurns: number | null;
  driftVerify: boolean;
  githubToken?: string;
  driftCommit: string;
  driftTreeDirty: boolean;
  driftVersion: string;
  root: string;
  onProgress?: (message: string) => void;
  /** Seam for tests: replaces the production Drift analysis. */
  driftContext?: (condition: Condition, workspace: Workspace) => Promise<DriftContext>;
}

const EMPTY_USAGE: Usage = {
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
  costUsd: null,
};

const EMPTY_TOOLS: ToolMetrics = {
  toolCalls: 0,
  byTool: {},
  fileReads: 0,
  uniqueFilesRead: 0,
  searches: 0,
  shellCommands: 0,
  edits: 0,
  webRequests: 0,
  subagentCalls: 0,
  counting: 'no session ran',
};

export async function runTrial(options: TrialOptions): Promise<{ artifact: TrialArtifact; diff: string; streamLines: string[] }> {
  const { agentCase, hidden, condition } = options;
  const startedAt = new Date();
  const timing = { materializeMs: 0, installMs: 0, contextMs: 0, agentMs: 0, validationMs: 0, totalMs: 0 };
  const task = renderTask(agentCase);
  const streamLines: string[] = [];
  let workspace: Workspace | null = null;
  let infrastructureFailure: TrialArtifact['validity']['infrastructureFailure'] = null;
  let infrastructureDetail: string | null = null;

  const base = (): Omit<TrialArtifact, 'context' | 'agent' | 'usage' | 'tools' | 'patch' | 'validation' | 'validity' | 'diagnostics' | 'timing' | 'metadata'> => ({
    schemaVersion: AGENT_TRIAL_SCHEMA_VERSION,
    trialId: `${options.runId}/${agentCase.id}/${condition}/${options.repetition}`,
    runId: options.runId,
    suite: options.suite,
    caseId: agentCase.id,
    caseHash: options.caseHash,
    condition,
    repetition: options.repetition,
    scheduleIndex: options.scheduleIndex,
  });

  const metadata = (agent: AgentRunResult | null, promptText: string, endedAt: Date, ws: Workspace | null): TrialArtifact['metadata'] => ({
    repository: agentCase.source.kind === 'git' ? agentCase.source.repository : `fixture:${agentCase.source.path}`,
    baseCommit: agentCase.source.kind === 'git' ? agentCase.source.baseCommit : (ws?.baseCommit ?? 'unavailable'),
    startCommit: agentCase.source.kind === 'git' && agentCase.source.startCommit ? agentCase.source.startCommit : (ws?.startCommit ?? 'unavailable'),
    startTreeHash: ws?.startTreeHash ?? 'unavailable',
    driftCommit: options.driftCommit,
    driftTreeDirty: options.driftTreeDirty,
    driftVersion: options.driftVersion,
    dependency: { ...agentCase.dependency },
    provider: options.provider.id,
    agentCliVersion: agent?.session.agentCliVersion && agent.session.agentCliVersion !== 'unavailable' ? agent.session.agentCliVersion : options.agentCliVersion,
    requestedModel: options.model,
    confirmedModel: agent?.session.confirmedModel ?? 'unavailable',
    requestedEffort: options.effort,
    os: `${platform()} ${release()} ${arch()}`,
    node: process.version,
    networkPolicy: `${agentCase.networkPolicy}; web tools ${options.webTools}`,
    agentConfiguration: {
      permissionMode: agent?.session.permissionMode ?? 'unavailable',
      disallowedTools: agent?.session.disallowedTools ?? [],
      cleanEnvironment: agent?.session.cleanEnvironment ?? 'unavailable',
      tools: agent?.session.tools ?? [],
      mcpServers: agent?.session.mcpServers ?? [],
      argv: agent?.session.argv ?? [],
    },
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    timeoutSeconds: agentCase.agent.timeoutSeconds,
    budget: { maxBudgetUsd: options.maxBudgetUsd, maxTurns: options.maxTurns },
    taskHash: sha256(task),
    promptHash: sha256(promptText),
    promptChars: promptText.length,
  });

  const emptyContext: TrialArtifact['context'] = {
    kind: contextKindFor(condition),
    preamble: '',
    preambleHash: sha256(''),
    driftAnalysisMs: null,
    driftCommand: null,
    driftStatus: 'not-applicable',
    driftFailure: null,
    driftPlan: null,
  };

  const emptyValidation: TrialArtifact['validation'] = {
    dependencyIntegrity: { passed: false, declaredSpecifier: null, installedVersion: null, installSucceeded: false, details: ['not validated'] },
    checks: [],
    hiddenTests: [],
    forbidden: [],
    success: false,
    failureReasons: [],
  };

  const emptyPatch: TrialArtifact['patch'] = {
    files: 0,
    sourceFiles: 0,
    testFiles: 0,
    configFiles: 0,
    dependencyFiles: 0,
    otherFiles: 0,
    linesAdded: 0,
    linesDeleted: 0,
    changedFiles: [],
    deletedFiles: [],
    diff: '',
    diffTruncated: false,
    diffHash: sha256(''),
  };

  const emptyAgent: TrialArtifact['agent'] = {
    status: 'launch-failure',
    exitCode: null,
    terminalReason: null,
    resultSubtype: null,
    apiErrorStatus: null,
    numTurns: null,
    durationMs: 0,
    apiDurationMs: null,
    finalMessage: '',
    permissionDenials: 0,
  };

  const emptyDiagnostics: TrialArtifact['diagnostics'] = {
    driftIdentifiedBreakingChange: null,
    driftIdentifiedLocalCode: null,
    referencePatchFileOverlap: null,
    referencePatchFiles: null,
  };

  const setupFailure = (detail: string): { artifact: TrialArtifact; diff: string; streamLines: string[] } => {
    const endedAt = new Date();
    timing.totalMs = endedAt.getTime() - startedAt.getTime();
    return {
      artifact: {
        ...base(),
        metadata: metadata(null, task, endedAt, workspace),
        context: emptyContext,
        agent: emptyAgent,
        usage: EMPTY_USAGE,
        tools: EMPTY_TOOLS,
        patch: emptyPatch,
        validation: emptyValidation,
        validity: { valid: false, infrastructureFailure: 'setup_failure', detail },
        diagnostics: emptyDiagnostics,
        timing,
      },
      diff: '',
      streamLines: [],
    };
  };

  try {
    // 1. Materialize.
    const t0 = Date.now();
    try {
      workspace = await materializeWorkspace(agentCase, options.root);
    } catch (err) {
      return setupFailure(`materialize: ${(err as Error).message}`);
    }
    timing.materializeMs = Date.now() - t0;

    // 2. Install, so both conditions start from an installed tree.
    const t1 = Date.now();
    options.onProgress?.('  install');
    const install = await runCommand(agentCase.commands.install, {
      cwd: workspace.project,
      timeoutMs: agentCase.commands.installTimeoutSeconds * 1000,
      env: projectEnv(agentCase),
    });
    timing.installMs = Date.now() - t1;
    if (install.spawnFailed || install.timedOut || install.code !== 0) {
      return setupFailure(`install: exit ${install.code} ${install.timedOut ? '(timed out)' : ''}\n${install.output.slice(-2000)}`);
    }

    // 3. Condition-specific context.
    const t2 = Date.now();
    let context: TrialArtifact['context'] = emptyContext;
    let driftContext: DriftContext | null = null;
    if (contextKindFor(condition) === 'drift') {
      options.onProgress?.('  drift analysis');
      driftContext = options.driftContext
        ? await options.driftContext(condition, workspace)
        : await buildDriftContext(condition, workspace, { verify: options.driftVerify, githubToken: options.githubToken });
      context = {
        kind: 'drift',
        preamble: driftContext.preamble,
        preambleHash: sha256(driftContext.preamble),
        driftAnalysisMs: driftContext.analysisMs,
        driftCommand: driftContext.command,
        driftStatus: driftContext.status,
        driftFailure: driftContext.failure,
        driftPlan: driftContext.plan,
      };
    }
    timing.contextMs = Date.now() - t2;

    // 4. The agent.
    const prompt = composePrompt(task, context.preamble);
    const t3 = Date.now();
    options.onProgress?.('  agent session');
    const agent = await options.provider.run({
      prompt,
      cwd: workspace.repo,
      model: options.model,
      effort: options.effort,
      timeoutMs: agentCase.agent.timeoutSeconds * 1000,
      webTools: options.webTools,
      maxBudgetUsd: options.maxBudgetUsd,
      maxTurns: options.maxTurns,
      env: projectEnv(agentCase, { DRIFT: '1' }),
      mcpServers: driftContext?.mcpServers ?? {},
      onEventLine: (line) => streamLines.push(line),
      onProgress: (message) => options.onProgress?.(`    ${message}`),
    });
    timing.agentMs = Date.now() - t3;

    if (agent.status === 'launch-failure') {
      infrastructureFailure = 'agent_launch_failure';
      infrastructureDetail = agent.stderr.trim() || 'the agent produced no model response';
    } else if (agent.status === 'provider-error') {
      infrastructureFailure = 'provider_error';
      infrastructureDetail = `api error status ${agent.apiErrorStatus}: ${agent.finalMessage.slice(0, 500)}`;
    }

    // 5. The diff.
    const captured = await captureDiff(workspace.repo, workspace.startCommit);
    const stats = patchStatsFrom(captured.nameStatus, captured.numstat);
    const truncated = captured.diff.length > MAX_DIFF_CHARS;
    const patch: TrialArtifact['patch'] = {
      ...stats,
      diff: truncated ? captured.diff.slice(0, MAX_DIFF_CHARS) : captured.diff,
      diffTruncated: truncated,
      diffHash: sha256(captured.diff),
    };

    // 6. Validation, hidden tests staged only now.
    const t4 = Date.now();
    const { result: validation, unableToRun } = await validateWorkspace({
      agentCase,
      workspace,
      hidden,
      agentStatus: agent.status,
      diff: captured.diff,
      patch: stats,
      onProgress: (message) => options.onProgress?.(`  ${message}`),
    });
    timing.validationMs = Date.now() - t4;
    if (unableToRun.length > 0 && infrastructureFailure === null) {
      infrastructureFailure = 'validation_unavailable';
      infrastructureDetail = unableToRun.join('\n');
    }

    // 7. Diagnostics.
    const referenceFiles = filesOfPatch(hidden.referencePatch);
    const referenceSource = referenceFiles.filter((file) => !/(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(file));
    const diagnostics: TrialArtifact['diagnostics'] = {
      driftIdentifiedBreakingChange:
        driftContext?.plan && hidden.expectedSymbols.length > 0
          ? driftContext.plan.symbols.some((symbol) => hidden.expectedSymbols.some((expected) => symbolMatches(symbol, expected)))
          : null,
      driftIdentifiedLocalCode:
        driftContext?.plan && referenceSource.length > 0 ? driftContext.plan.impactFiles.some((file) => referenceSource.includes(file)) : null,
      referencePatchFileOverlap: stats.changedFiles.filter((file) => referenceFiles.includes(file)).length,
      referencePatchFiles: referenceFiles.length,
    };

    // What Drift put into the context and what the agent pulled from it.
    const agentContext = agentContextDiagnostics({
      condition,
      parsed: parseClaudeStream(streamLines),
      preamble: context.preamble,
      brief: driftContext?.brief ?? null,
      findingsInPlan: driftContext?.plan?.breakingChanges ?? null,
      dependency: agentCase.dependency.name,
    });

    const endedAt = new Date();
    timing.totalMs = endedAt.getTime() - startedAt.getTime();
    const valid = infrastructureFailure === null;

    return {
      artifact: {
        ...base(),
        metadata: metadata(agent, prompt, endedAt, workspace),
        context,
        agent: {
          status: agent.status,
          exitCode: agent.exitCode,
          terminalReason: agent.terminalReason,
          resultSubtype: agent.resultSubtype,
          apiErrorStatus: agent.apiErrorStatus,
          numTurns: agent.numTurns,
          durationMs: agent.durationMs,
          apiDurationMs: agent.apiDurationMs,
          finalMessage: agent.finalMessage,
          permissionDenials: agent.permissionDenials,
        },
        usage: agent.usage,
        tools: agent.tools,
        patch,
        validation: valid ? validation : { ...validation, success: false },
        validity: { valid, infrastructureFailure, detail: infrastructureDetail },
        diagnostics,
        agentContext,
        timing,
      },
      diff: captured.diff,
      streamLines,
    };
  } catch (err) {
    const endedAt = new Date();
    timing.totalMs = endedAt.getTime() - startedAt.getTime();
    return {
      artifact: {
        ...base(),
        metadata: metadata(null, task, endedAt, workspace),
        context: emptyContext,
        agent: emptyAgent,
        usage: EMPTY_USAGE,
        tools: EMPTY_TOOLS,
        patch: emptyPatch,
        validation: emptyValidation,
        validity: { valid: false, infrastructureFailure: 'runner_error', detail: (err as Error).stack ?? (err as Error).message },
        diagnostics: emptyDiagnostics,
        timing,
      },
      diff: '',
      streamLines,
    };
  } finally {
    if (workspace) await workspace.teardown().catch(() => undefined);
  }
}

export function filesOfPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split('\n')) {
    const match = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (match && match[1] !== '/dev/null') files.add(match[1]!.trim());
  }
  return [...files].sort();
}

function symbolMatches(driftSymbol: string, expected: string): boolean {
  const a = driftSymbol.toLowerCase();
  const b = expected.toLowerCase();
  return a === b || a.endsWith(`.${b}`) || a.endsWith(`#${b}`) || a.endsWith(`:${b}`) || a.endsWith(`/${b}`);
}
