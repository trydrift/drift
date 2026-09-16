import { AGENT_TRIAL_SCHEMA_VERSION, trialSchema, type Condition, type FailureReason, type InfrastructureFailure, type TrialArtifact } from './schema.ts';

/** A schema-valid trial artifact with the fields a test cares about overridden. */
export function makeTrial(input: {
  caseId: string;
  condition: Condition;
  repetition: number;
  gross: number;
  success: boolean;
  reasons?: FailureReason[];
  valid?: boolean;
  infrastructureFailure?: InfrastructureFailure;
  agentStatus?: TrialArtifact['agent']['status'];
  uncached?: number;
  durationMs?: number;
  filesRead?: number;
  toolCalls?: number;
  model?: string;
  taskHash?: string;
  caseHash?: string;
  driftStatus?: TrialArtifact['context']['driftStatus'];
  driftIdentifiedBreakingChange?: boolean | null;
  driftIdentifiedLocalCode?: boolean | null;
  runId?: string;
}): TrialArtifact {
  const valid = input.valid ?? true;
  const uncached = Math.min(input.gross, input.uncached ?? Math.round(input.gross / 4));
  const artifact: TrialArtifact = {
    schemaVersion: AGENT_TRIAL_SCHEMA_VERSION,
    trialId: `${input.runId ?? 'run-1'}/${input.caseId}/${input.condition}/${input.repetition}`,
    runId: input.runId ?? 'run-1',
    suite: 'test-suite',
    caseId: input.caseId,
    caseHash: input.caseHash ?? 'hash-' + input.caseId,
    condition: input.condition,
    repetition: input.repetition,
    scheduleIndex: input.repetition,
    metadata: {
      repository: 'https://example.invalid/repo.git',
      baseCommit: 'a'.repeat(40),
      startCommit: 'b'.repeat(40),
      startTreeHash: 'c'.repeat(40),
      driftCommit: 'd'.repeat(40),
      driftTreeDirty: false,
      driftVersion: '0.1.11',
      dependency: { name: 'dep', fromVersion: '1.0.0', toVersion: '2.0.0' },
      provider: 'claude-code',
      agentCliVersion: '2.1.267 (Claude Code)',
      requestedModel: 'claude-sonnet-5',
      confirmedModel: input.model ?? 'claude-sonnet-5',
      requestedEffort: 'high',
      os: 'darwin 25 arm64',
      node: 'v24.0.0',
      networkPolicy: 'registry-and-provider; web tools disabled',
      agentConfiguration: {
        permissionMode: 'bypassPermissions',
        disallowedTools: ['WebFetch', 'WebSearch'],
        cleanEnvironment: 'safe-mode',
        tools: ['Bash', 'Read'],
        mcpServers: [],
        argv: ['claude', '-p'],
      },
      startedAt: '2026-09-16T00:00:00.000Z',
      endedAt: '2026-09-16T00:10:00.000Z',
      timeoutSeconds: 1800,
      budget: { maxBudgetUsd: null, maxTurns: null },
      taskHash: input.taskHash ?? 'task-' + input.caseId,
      promptHash: 'prompt-' + input.condition,
      promptChars: 500,
    },
    context: {
      kind: input.condition === 'baseline' ? 'none' : 'drift',
      preamble: input.condition === 'baseline' ? '' : 'report',
      preambleHash: 'p',
      driftAnalysisMs: input.condition === 'baseline' ? null : 30_000,
      driftCommand: input.condition === 'baseline' ? null : 'drift analyze --before a --after b --markdown --verify',
      driftStatus: input.condition === 'baseline' ? 'not-applicable' : (input.driftStatus ?? 'completed'),
      driftFailure: null,
      driftPlan: input.condition === 'baseline' ? null : { breakingChanges: 2, impactSites: 3, impactFiles: ['src/a.ts'], symbols: ['sync'], verdict: 'affected', verificationStatus: null, evidenceSources: 2 },
    },
    agent: {
      status: input.agentStatus ?? 'completed',
      exitCode: 0,
      terminalReason: 'completed',
      resultSubtype: 'success',
      apiErrorStatus: null,
      numTurns: 10,
      durationMs: input.durationMs ?? 300_000,
      apiDurationMs: 250_000,
      finalMessage: 'done',
      permissionDenials: 0,
    },
    usage: {
      grossInputTokens: input.gross,
      uncachedInputTokens: uncached,
      inputTokens: Math.min(100, uncached),
      cacheReadTokens: input.gross - uncached,
      cacheCreationTokens: uncached - Math.min(100, uncached),
      outputTokens: 2000,
      modelCalls: 10,
      byModel: {},
      source: 'result-model-usage',
      ledgerGrossInputTokens: input.gross,
      ledgerAgreesWithResult: true,
      costUsd: 0.5,
    },
    tools: {
      toolCalls: input.toolCalls ?? 20,
      byTool: { Read: 5 },
      fileReads: 5,
      uniqueFilesRead: input.filesRead ?? 4,
      searches: 3,
      shellCommands: 6,
      edits: 2,
      webRequests: 0,
      subagentCalls: 0,
      counting: 'tool_use blocks',
    },
    patch: {
      files: input.success ? 1 : 0,
      sourceFiles: input.success ? 1 : 0,
      testFiles: 0,
      configFiles: 0,
      dependencyFiles: 0,
      otherFiles: 0,
      linesAdded: 3,
      linesDeleted: 3,
      changedFiles: input.success ? ['src/a.ts'] : [],
      deletedFiles: [],
      diff: '',
      diffTruncated: false,
      diffHash: 'e'.repeat(64),
    },
    validation: {
      dependencyIntegrity: { passed: true, declaredSpecifier: '2.0.0', installedVersion: '2.0.0', installSucceeded: true, details: [] },
      checks: [{ name: 'test', kind: 'test', passed: true, exitCode: 0, spawnFailed: false, timedOut: false, durationMs: 1000, outputExcerpt: '' }],
      hiddenTests: [{ name: 'h', id: 'h', description: 'd', passed: input.success, exitCode: input.success ? 0 : 1, spawnFailed: false, timedOut: false, durationMs: 100, outputExcerpt: '' }],
      forbidden: [],
      success: valid && input.success,
      failureReasons: input.success ? [] : (input.reasons ?? ['hidden_regression_failure']),
    },
    validity: { valid, infrastructureFailure: valid ? null : (input.infrastructureFailure ?? 'runner_error'), detail: valid ? null : 'boom' },
    diagnostics: {
      driftIdentifiedBreakingChange: input.condition === 'baseline' ? null : (input.driftIdentifiedBreakingChange ?? true),
      driftIdentifiedLocalCode: input.condition === 'baseline' ? null : (input.driftIdentifiedLocalCode ?? true),
      referencePatchFileOverlap: 1,
      referencePatchFiles: 1,
    },
    timing: { materializeMs: 1000, installMs: 5000, contextMs: 0, agentMs: input.durationMs ?? 300_000, validationMs: 2000, totalMs: 310_000 },
  };
  return trialSchema.parse(artifact);
}
