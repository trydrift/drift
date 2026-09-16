import data from "@/data/benchmarks/agent.json";

/**
 * The paired coding-agent benchmark result, as the site reads it.
 *
 * `src/data/benchmarks/agent.json` is a verbatim copy of
 * `eval/results/agent/latest.json`, written by `scripts/sync-benchmarks.mjs`,
 * or `{ "status": "no-result" }` when no result has been aggregated. Nothing
 * on the page is typed by hand: every figure is a field of this object, and
 * the quantitative sections render only when the result's own publication
 * gates — computed by the benchmark, not by the site — all pass.
 */

export interface Interval {
  low: number;
  high: number;
  iterations: number;
  seed: number;
  method: string;
}

export interface AgentCaseRow {
  caseId: string;
  validBaselineTrials: number;
  validDriftTrials: number;
  baselineSuccesses: number;
  driftSuccesses: number;
  baselineSuccessRate: number | null;
  driftSuccessRate: number | null;
  successDifferencePp: number | null;
  medianBaselineInputTokens: number | null;
  medianDriftInputTokens: number | null;
  inputTokenReduction: number | null;
  medianBaselineFilesRead: number | null;
  medianDriftFilesRead: number | null;
}

export interface AgentConditionRow {
  condition: string;
  trials: number;
  validTrials: number;
  invalidTrials: number;
  successfulTrials: number;
  successRate: number | null;
  medianInputTokens: number | null;
  medianUncachedInputTokens: number | null;
  medianWallClockMs: number | null;
  medianFilesRead: number | null;
  medianToolCalls: number | null;
  failureReasons: Record<string, number>;
}

export interface AgentBenchmarkResult {
  schemaVersion: number;
  suite: string;
  suiteStatus: string;
  generatedAt: string;
  runIds: string[];
  driftCommit: string;
  driftVersion: string;
  provider: string;
  agentCliVersion: string;
  requestedModel: string;
  confirmedModels: Record<string, number>;
  requestedEffort: string;
  runsPerCondition: number;
  caseCount: number;
  caseProvenance: Record<string, number>;
  caseRoles: Record<string, number>;
  ecosystems: Record<string, number>;
  configuration: {
    networkPolicies: string[];
    permissionModes: string[];
    cleanEnvironments: string[];
    disallowedTools: string[];
    timeoutSeconds: number[];
    driftVerify: boolean | null;
  };
  efficiency: {
    pairedCaseCount: number;
    medianInputTokenReductionPct: number | null;
    meanInputTokenReductionPct: number | null;
    reductionIqrPct: { q1: number; q3: number } | null;
    medianBaselineInputTokens: number | null;
    medianDriftInputTokens: number | null;
    medianBaselineUncachedInputTokens: number | null;
    medianDriftUncachedInputTokens: number | null;
    medianUncachedReductionPct: number | null;
    medianWallClockChangePct: number | null;
    medianFilesReadChangePct: number | null;
    medianToolCallChangePct: number | null;
    confidenceInterval95: { medianReduction: Interval | null; meanReduction: Interval | null };
  };
  effectiveness: {
    validBaselineTrials: number;
    successfulBaselineTrials: number;
    baselineSuccessRate: number | null;
    validDriftTrials: number;
    successfulDriftTrials: number;
    driftSuccessRate: number | null;
    differencePercentagePoints: number | null;
    relativeDifference: number | null;
    caseLevel: { improved: number; tied: number; baselineBetter: number; medianDifferencePp: number | null; meanDifferencePp: number | null };
    confidenceInterval95: { differencePercentagePoints: Interval | null; baselineSuccessRate: Interval | null; driftSuccessRate: Interval | null };
  };
  conditions: AgentConditionRow[];
  cases: AgentCaseRow[];
  exclusions: { trialId: string; caseId: string; condition: string; reason: string; detail: string }[];
  publication: { eligible: boolean; gates: { name: string; passed: boolean; detail: string }[]; thresholds: Record<string, number | boolean> };
  methodology: { inputTokenDefinition: string; successDefinition: string; bootstrap: string; toolCounting: string; isolation: string };
}

export type AgentBenchmark = { status: "no-result" } | ({ status?: undefined } & AgentBenchmarkResult);

export function loadAgentBenchmark(): AgentBenchmark {
  return data as unknown as AgentBenchmark;
}

/** The result, only when one exists. */
export function agentResult(benchmark: AgentBenchmark): AgentBenchmarkResult | null {
  return "status" in benchmark && benchmark.status === "no-result" ? null : (benchmark as AgentBenchmarkResult);
}

/** Whether the quantitative sections may render at all. Decided by the benchmark's own gates, never here. */
export function publishable(benchmark: AgentBenchmark): AgentBenchmarkResult | null {
  const result = agentResult(benchmark);
  return result && result.publication.eligible ? result : null;
}

export function pct(value: number | null, digits = 1): string {
  return value === null ? "n/a" : `${value.toFixed(digits)}%`;
}

export function ratePct(value: number | null, digits = 1): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(digits)}%`;
}

export function pp(value: number | null): string {
  return value === null ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(1)} pp`;
}

export function int(value: number | null): string {
  return value === null ? "n/a" : Math.round(value).toLocaleString("en-US");
}

export function fraction(numerator: number, denominator: number): string {
  return `${numerator}/${denominator}`;
}

export function intervalText(interval: Interval | null, scale: number, unit: string): string {
  return interval === null ? "n/a" : `${(interval.low * scale).toFixed(1)}${unit} to ${(interval.high * scale).toFixed(1)}${unit}`;
}

/**
 * `95% CI -71.2% to -48.0%`. The confidence level is part of the string so
 * `check-benchmark-copy` never sees a hand-typed percentage in JSX text.
 */
export function ci95(interval: Interval | null, scale: number, unit: string): string {
  return `95% CI ${intervalText(interval, scale, unit)}`;
}

/** `-61.2%` for a reduction, `+12.0%` for an increase; the sign is the reader's first question. */
export function tokenDelta(reduction: number | null): string {
  if (reduction === null) return "n/a";
  const change = -reduction * 100;
  return `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
}

export function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

export function shortCommit(sha: string): string {
  return sha === "unavailable" ? sha : sha.slice(0, 10);
}
