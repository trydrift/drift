import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  bootstrap,
  caseLevelSummary,
  caseMetrics,
  conditionAggregate,
  groupByCase,
  mean,
  median,
  percentagePointDifference,
  quantile,
  relativeDifference,
  type CaseMetrics,
  type ConditionAggregate,
  type Interval,
} from './aggregate.ts';
import { loadCase, loadSuite } from './cases.ts';
import { AGENT_SUMMARY_SCHEMA_VERSION, type RunManifest, type TrialArtifact } from './schema.ts';
import { readRunManifest, readTrials, resultsRoot } from './store.ts';

/**
 * The one canonical, machine-readable result: `eval/results/agent/latest.json`.
 *
 * The website, the README block, the report and the verification command all
 * read this file. Every previous summary is kept under `history/`, keyed by
 * generation time, suite and model, so a result from one Drift version can be
 * compared with the next on the same suite and the same model — and never
 * across models, which the summary records precisely so that nobody does.
 */

export interface PublicationGate {
  name: string;
  passed: boolean;
  detail: string;
}

export interface PublicationGates {
  eligible: boolean;
  gates: PublicationGate[];
  thresholds: typeof DEFAULT_GATES;
}

export const DEFAULT_GATES = {
  minimumCases: 10,
  minimumPairedCases: 10,
  minimumRunsPerCondition: 3,
  minimumValidTrialsPerCondition: 30,
  maximumAgeDays: 180,
  /** A public result must be over a frozen suite. */
  requireFrozenSuite: true,
  /** A public result must be over cases whose provenance is historical. */
  requireHistoricalCases: true,
  /** Trials excluded as infrastructure failures may not exceed this fraction. */
  maximumInfrastructureExclusionRate: 0.2,
};

export interface AgentBenchmarkSummary {
  schemaVersion: number;
  suite: string;
  suiteStatus: string;
  suiteDescription: string;
  generatedAt: string;
  runIds: string[];
  driftCommit: string;
  driftTreeDirty: boolean;
  driftVersion: string;
  provider: string;
  agentCliVersion: string;
  requestedModel: string;
  /** Every model the sessions actually reported, with how many trials reported each. */
  confirmedModels: Record<string, number>;
  requestedEffort: string;
  runsPerCondition: number;
  caseCount: number;
  caseProvenance: Record<string, number>;
  caseRoles: Record<string, number>;
  ecosystems: Record<string, number>;
  task: { taskHashes: string[]; identicalAcrossConditions: boolean };
  configuration: {
    networkPolicies: string[];
    permissionModes: string[];
    cleanEnvironments: string[];
    disallowedTools: string[];
    timeoutSeconds: number[];
    driftVerify: boolean | null;
  };
  efficiency: {
    metric: string;
    pairedCaseCount: number;
    medianInputTokenReductionPct: number | null;
    meanInputTokenReductionPct: number | null;
    reductionIqrPct: { q1: number; q3: number } | null;
    reductionDistributionPct: number[];
    medianBaselineInputTokens: number | null;
    medianDriftInputTokens: number | null;
    medianBaselineUncachedInputTokens: number | null;
    medianDriftUncachedInputTokens: number | null;
    medianUncachedReductionPct: number | null;
    medianWallClockChangePct: number | null;
    medianFilesReadChangePct: number | null;
    medianToolCallChangePct: number | null;
    medianDriftAnalysisMs: number | null;
    confidenceInterval95: { medianReduction: Interval | null; meanReduction: Interval | null };
  };
  effectiveness: {
    metric: string;
    validBaselineTrials: number;
    successfulBaselineTrials: number;
    baselineSuccessRate: number | null;
    validDriftTrials: number;
    successfulDriftTrials: number;
    driftSuccessRate: number | null;
    differencePercentagePoints: number | null;
    relativeDifference: number | null;
    caseLevel: ReturnType<typeof caseLevelSummary>;
    confidenceInterval95: {
      differencePercentagePoints: Interval | null;
      baselineSuccessRate: Interval | null;
      driftSuccessRate: Interval | null;
    };
  };
  secondary: {
    baselineInputTokensPerSuccessfulFix: number | null;
    driftInputTokensPerSuccessfulFix: number | null;
    baselineMedianInputTokensAmongSuccesses: number | null;
    driftMedianInputTokensAmongSuccesses: number | null;
    note: string;
  };
  conditions: ConditionAggregate[];
  cases: CaseMetrics[];
  exclusions: { trialId: string; caseId: string; condition: string; reason: string; detail: string }[];
  pipelineDiagnostics: {
    driftAnalysisStatuses: Record<string, number>;
    driftIdentifiedBreakingChangeRate: number | null;
    driftIdentifiedLocalCodeRate: number | null;
  };
  publication: PublicationGates;
  methodology: {
    inputTokenDefinition: string;
    successDefinition: string;
    bootstrap: string;
    toolCounting: string;
    isolation: string;
  };
}

export const INPUT_TOKEN_DEFINITION =
  'Gross agent input tokens: for one agent session, the sum over every model the session used of the provider-reported ' +
  'input_tokens + cache_read_input_tokens + cache_creation_input_tokens, read from the coding agent CLI\'s own cumulative ' +
  'per-model usage record at the end of the session (Claude Code: the `modelUsage` block of the `result` event in ' +
  '`--output-format stream-json`). Every model turn in the session is included, not only the first prompt. Cache reads ' +
  'are counted at their full token size. "Uncached input tokens" (input_tokens + cache_creation_input_tokens) is reported ' +
  'as a secondary metric.';

export const SUCCESS_DEFINITION =
  'A trial succeeds only if, after the agent exits: the dependency is still declared at the upgraded version and a fresh ' +
  'install resolves and installs it at that version; every one of the project\'s own declared checks passes; every hidden ' +
  'regression test — staged into the workspace only after the agent exited — passes; and no case-specific prohibited-workaround ' +
  'rule fires. A session that timed out or errored fails. No partial credit.';

export const ISOLATION_STATEMENT =
  'Each trial runs in a fresh temporary git repository built from the case source with exactly two commits (before and after ' +
  'the bump), no remote and no later history, audited to contain no hidden material. Hidden tests, the reference patch and ' +
  'case metadata live outside that directory and are copied in only after the agent process has exited. This is a workspace ' +
  'audit, not an OS sandbox: the private files remain readable elsewhere on the host by a process the agent starts. Package ' +
  'manager caches are shared across trials and conditions.';

export function evaluateGates(summary: Omit<AgentBenchmarkSummary, 'publication'>, thresholds = DEFAULT_GATES, now = new Date()): PublicationGates {
  const gates: PublicationGate[] = [];
  const push = (name: string, passed: boolean, detail: string) => gates.push({ name, passed, detail });

  push('minimum-cases', summary.caseCount >= thresholds.minimumCases, `${summary.caseCount} case(s), minimum ${thresholds.minimumCases}`);
  push('minimum-paired-cases', summary.efficiency.pairedCaseCount >= thresholds.minimumPairedCases, `${summary.efficiency.pairedCaseCount} paired case(s), minimum ${thresholds.minimumPairedCases}`);
  push('minimum-runs-per-condition', summary.runsPerCondition >= thresholds.minimumRunsPerCondition, `${summary.runsPerCondition} run(s) per condition, minimum ${thresholds.minimumRunsPerCondition}`);
  const minValid = Math.min(summary.effectiveness.validBaselineTrials, summary.effectiveness.validDriftTrials);
  push('minimum-valid-trials', minValid >= thresholds.minimumValidTrialsPerCondition, `${minValid} valid trial(s) in the smaller condition, minimum ${thresholds.minimumValidTrialsPerCondition}`);
  push('frozen-suite', !thresholds.requireFrozenSuite || summary.suiteStatus === 'frozen', `suite status ${summary.suiteStatus}`);
  const synthetic = summary.caseProvenance['synthetic'] ?? 0;
  push('historical-cases-only', !thresholds.requireHistoricalCases || synthetic === 0, synthetic === 0 ? 'no synthetic cases' : `${synthetic} synthetic case(s) in the result`);
  const ageDays = (now.getTime() - new Date(summary.generatedAt).getTime()) / 86_400_000;
  push('freshness', ageDays <= thresholds.maximumAgeDays, `${ageDays.toFixed(0)} day(s) old, maximum ${thresholds.maximumAgeDays}`);
  const total = summary.conditions.reduce((sum, c) => sum + c.trials, 0);
  const invalid = summary.conditions.reduce((sum, c) => sum + c.invalidTrials, 0);
  const exclusionRate = total === 0 ? 1 : invalid / total;
  push('infrastructure-exclusions', exclusionRate <= thresholds.maximumInfrastructureExclusionRate, `${invalid}/${total} trial(s) excluded as infrastructure failures`);
  push('hidden-validation-complete', summary.cases.length > 0 && summary.exclusions.every((e) => e.reason !== 'validation_unavailable'), summary.exclusions.some((e) => e.reason === 'validation_unavailable') ? 'some trials could not run validation' : 'every valid trial ran hidden validation');
  push('same-task', summary.task.identicalAcrossConditions, summary.task.identicalAcrossConditions ? 'one task hash per case across conditions' : 'task text differed between conditions');
  push('one-model', Object.keys(summary.confirmedModels).filter((m) => m !== 'unavailable').length === 1, `confirmed models: ${Object.keys(summary.confirmedModels).join(', ') || 'none'}`);
  push('success-rate-integrity', summary.effectiveness.baselineSuccessRate !== null && summary.effectiveness.driftSuccessRate !== null, 'both success rates are defined');
  push('clean-drift-tree', !summary.driftTreeDirty, summary.driftTreeDirty ? 'Drift source tree had uncommitted changes' : 'Drift built from a clean tree');
  push('required-metadata', summary.driftCommit !== 'unavailable' && summary.agentCliVersion !== 'unavailable' && summary.requestedModel.length > 0, 'commit, agent version and model recorded');

  return { eligible: gates.every((gate) => gate.passed), gates, thresholds };
}

export interface BuildSummaryOptions {
  runIds: string[];
  root?: string;
  thresholds?: typeof DEFAULT_GATES;
  now?: Date;
}

export async function buildSummary(options: BuildSummaryOptions): Promise<AgentBenchmarkSummary> {
  const root = options.root ?? process.cwd();
  const manifests: RunManifest[] = [];
  const trials: TrialArtifact[] = [];
  for (const runId of options.runIds) {
    manifests.push(await readRunManifest(runId, root));
    trials.push(...(await readTrials(runId, root)));
  }
  if (manifests.length === 0) throw new Error('No runs to aggregate.');
  const suites = new Set(manifests.map((m) => m.suite));
  if (suites.size > 1) throw new Error(`Runs span several suites (${[...suites].join(', ')}); aggregate one suite at a time.`);
  const models = new Set(manifests.map((m) => m.requestedModel));
  if (models.size > 1) throw new Error(`Runs span several requested models (${[...models].join(', ')}); never pool across models.`);
  const first = manifests[0]!;
  const suite = await loadSuite(first.suite, root);

  // A frozen suite's hash must match what every trial recorded.
  const caseHashes = new Map(suite.cases.map((c) => [c.id, c.caseHash]));
  const stale = trials.filter((t) => caseHashes.get(t.caseId) !== t.caseHash);
  if (suite.status === 'frozen' && stale.length > 0) {
    throw new Error(`${stale.length} trial(s) were recorded against a case hash the frozen suite does not contain: ${[...new Set(stale.map((t) => t.caseId))].join(', ')}`);
  }

  const groups = groupByCase(trials);
  const cases = groups.map(caseMetrics);
  const paired = cases.filter((c) => c.inputTokenReduction !== null);
  const reductions = paired.map((c) => c.inputTokenReduction!);
  const baseline = conditionAggregate('baseline', trials);
  const drift = conditionAggregate('drift', trials);
  const boot = bootstrap(groups);

  const pct = (value: number | null): number | null => (value === null ? null : value * 100);
  const changePct = (b: number | null, d: number | null): number | null => (b === null || d === null || b === 0 ? null : ((d - b) / b) * 100);
  const medianChange = (pick: (c: CaseMetrics) => [number | null, number | null]): number | null =>
    median(paired.map((c) => changePct(...pick(c))).filter((v): v is number => v !== null));

  const provenance: Record<string, number> = {};
  const roles: Record<string, number> = {};
  const ecosystems: Record<string, number> = {};
  for (const group of groups) {
    const agentCase = await loadCase(group.caseId, root);
    provenance[agentCase.provenance] = (provenance[agentCase.provenance] ?? 0) + 1;
    roles[agentCase.role] = (roles[agentCase.role] ?? 0) + 1;
    ecosystems[agentCase.ecosystem] = (ecosystems[agentCase.ecosystem] ?? 0) + 1;
  }

  const confirmedModels: Record<string, number> = {};
  for (const t of trials) if (t.validity.valid) confirmedModels[t.metadata.confirmedModel] = (confirmedModels[t.metadata.confirmedModel] ?? 0) + 1;

  const taskHashesByCase = new Map<string, Set<string>>();
  for (const t of trials) {
    const set = taskHashesByCase.get(t.caseId) ?? new Set();
    set.add(t.metadata.taskHash);
    taskHashesByCase.set(t.caseId, set);
  }

  const driftStatuses: Record<string, number> = {};
  const identifiedBc: (boolean | null)[] = [];
  const identifiedLocal: (boolean | null)[] = [];
  for (const t of trials.filter((t) => t.condition === 'drift' && t.validity.valid)) {
    driftStatuses[t.context.driftStatus] = (driftStatuses[t.context.driftStatus] ?? 0) + 1;
    identifiedBc.push(t.diagnostics.driftIdentifiedBreakingChange);
    identifiedLocal.push(t.diagnostics.driftIdentifiedLocalCode);
  }
  const rate = (values: (boolean | null)[]): number | null => {
    const known = values.filter((v): v is boolean => v !== null);
    return known.length === 0 ? null : known.filter(Boolean).length / known.length;
  };

  const withoutGates: Omit<AgentBenchmarkSummary, 'publication'> = {
    schemaVersion: AGENT_SUMMARY_SCHEMA_VERSION,
    suite: suite.suite,
    suiteStatus: suite.status,
    suiteDescription: suite.description,
    generatedAt: (options.now ?? new Date()).toISOString(),
    runIds: options.runIds,
    driftCommit: first.driftCommit,
    driftTreeDirty: manifests.some((m) => m.driftTreeDirty),
    driftVersion: trials[0]?.metadata.driftVersion ?? 'unknown',
    provider: first.provider,
    agentCliVersion: first.agentCliVersion,
    requestedModel: first.requestedModel,
    confirmedModels,
    requestedEffort: first.requestedEffort,
    runsPerCondition: Math.min(...manifests.map((m) => m.runsPerCondition)),
    caseCount: groups.length,
    caseProvenance: provenance,
    caseRoles: roles,
    ecosystems,
    task: {
      taskHashes: [...new Set(trials.map((t) => t.metadata.taskHash))].sort(),
      identicalAcrossConditions: [...taskHashesByCase.values()].every((set) => set.size === 1),
    },
    configuration: {
      networkPolicies: [...new Set(trials.map((t) => t.metadata.networkPolicy))].sort(),
      permissionModes: [...new Set(trials.filter((t) => t.validity.valid).map((t) => t.metadata.agentConfiguration.permissionMode))].sort(),
      cleanEnvironments: [...new Set(trials.filter((t) => t.validity.valid).map((t) => t.metadata.agentConfiguration.cleanEnvironment))].sort(),
      disallowedTools: [...new Set(trials.flatMap((t) => t.metadata.agentConfiguration.disallowedTools))].sort(),
      timeoutSeconds: [...new Set(trials.map((t) => t.metadata.timeoutSeconds))].sort((a, b) => a - b),
      driftVerify: trials.some((t) => t.context.driftCommand?.includes('--verify')) ? true : trials.some((t) => t.context.driftCommand) ? false : null,
    },
    efficiency: {
      metric: 'median of case-level reductions in gross agent input tokens (1 - driftMedian / baselineMedian per case)',
      pairedCaseCount: paired.length,
      medianInputTokenReductionPct: pct(median(reductions)),
      meanInputTokenReductionPct: pct(mean(reductions)),
      reductionIqrPct: reductions.length > 0 ? { q1: quantile(reductions, 0.25)! * 100, q3: quantile(reductions, 0.75)! * 100 } : null,
      reductionDistributionPct: reductions.map((r) => r * 100).sort((a, b) => a - b),
      medianBaselineInputTokens: baseline.medianInputTokens,
      medianDriftInputTokens: drift.medianInputTokens,
      medianBaselineUncachedInputTokens: baseline.medianUncachedInputTokens,
      medianDriftUncachedInputTokens: drift.medianUncachedInputTokens,
      medianUncachedReductionPct: pct(
        median(
          paired
            .map((c) => (c.medianBaselineUncachedInputTokens && c.medianDriftUncachedInputTokens !== null ? 1 - c.medianDriftUncachedInputTokens / c.medianBaselineUncachedInputTokens : null))
            .filter((v): v is number => v !== null),
        ),
      ),
      medianWallClockChangePct: medianChange((c) => [c.medianBaselineWallClockMs, c.medianDriftWallClockMs]),
      medianFilesReadChangePct: medianChange((c) => [c.medianBaselineFilesRead, c.medianDriftFilesRead]),
      medianToolCallChangePct: medianChange((c) => [c.medianBaselineToolCalls, c.medianDriftToolCalls]),
      medianDriftAnalysisMs: median(cases.map((c) => c.medianDriftAnalysisMs).filter((v): v is number => v !== null)),
      confidenceInterval95: { medianReduction: boot.medianReduction, meanReduction: boot.meanReduction },
    },
    effectiveness: {
      metric: 'successful dependency remediations / valid trials, per condition; difference in percentage points',
      validBaselineTrials: baseline.validTrials,
      successfulBaselineTrials: baseline.successfulTrials,
      baselineSuccessRate: baseline.successRate,
      validDriftTrials: drift.validTrials,
      successfulDriftTrials: drift.successfulTrials,
      driftSuccessRate: drift.successRate,
      differencePercentagePoints: percentagePointDifference(baseline.successRate, drift.successRate),
      relativeDifference: relativeDifference(baseline.successRate, drift.successRate),
      caseLevel: caseLevelSummary(cases),
      confidenceInterval95: {
        differencePercentagePoints: boot.successDifferencePp,
        baselineSuccessRate: boot.baselineSuccessRate,
        driftSuccessRate: boot.driftSuccessRate,
      },
    },
    secondary: {
      baselineInputTokensPerSuccessfulFix: baseline.inputTokensPerSuccessfulFix,
      driftInputTokensPerSuccessfulFix: drift.inputTokensPerSuccessfulFix,
      baselineMedianInputTokensAmongSuccesses: baseline.medianInputTokensAmongSuccesses,
      driftMedianInputTokensAmongSuccesses: drift.medianInputTokensAmongSuccesses,
      note: 'Secondary. Conditioning on success selects for the runs that went well and is not a substitute for the two primary metrics.',
    },
    conditions: [baseline, drift],
    cases,
    exclusions: trials
      .filter((t) => !t.validity.valid)
      .map((t) => ({ trialId: t.trialId, caseId: t.caseId, condition: t.condition, reason: t.validity.infrastructureFailure ?? 'unknown', detail: (t.validity.detail ?? '').slice(0, 300) })),
    pipelineDiagnostics: {
      driftAnalysisStatuses: driftStatuses,
      driftIdentifiedBreakingChangeRate: rate(identifiedBc),
      driftIdentifiedLocalCodeRate: rate(identifiedLocal),
    },
    methodology: {
      inputTokenDefinition: INPUT_TOKEN_DEFINITION,
      successDefinition: SUCCESS_DEFINITION,
      bootstrap: boot.medianReduction?.method ?? boot.successDifferencePp?.method ?? 'not computed (no valid trials)',
      toolCounting: trials.find((t) => t.tools.counting !== 'no session ran')?.tools.counting ?? 'no session ran',
      isolation: ISOLATION_STATEMENT,
    },
  };

  return { ...withoutGates, publication: evaluateGates(withoutGates, options.thresholds, options.now) };
}

export function latestSummaryPath(root = process.cwd()): string {
  return join(resultsRoot(root), 'latest.json');
}

export async function writeSummary(summary: AgentBenchmarkSummary, root = process.cwd()): Promise<{ latest: string; history: string }> {
  const latest = latestSummaryPath(root);
  const historyDir = join(resultsRoot(root), 'history');
  await mkdir(historyDir, { recursive: true });
  const stamp = summary.generatedAt.replace(/[:.]/g, '-');
  const history = join(historyDir, `${stamp}__${summary.suite}__${summary.requestedModel.replace(/[^a-z0-9.-]+/gi, '-')}.json`);
  const body = `${JSON.stringify(summary, null, 2)}\n`;
  await writeFile(latest, body, 'utf8');
  await writeFile(history, body, 'utf8');
  return { latest, history };
}

export async function readLatestSummary(root = process.cwd()): Promise<AgentBenchmarkSummary | null> {
  try {
    return JSON.parse(await readFile(latestSummaryPath(root), 'utf8')) as AgentBenchmarkSummary;
  } catch {
    return null;
  }
}
