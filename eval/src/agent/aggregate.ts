import type { Condition, FailureReason, TrialArtifact } from './schema.ts';

/**
 * Aggregation and uncertainty.
 *
 * Efficiency is paired by case: the median gross input tokens of a case's
 * valid baseline trials against the median of its valid Drift trials, and the
 * headline is the *median of case-level reductions* — never
 * `1 - totalDrift/totalBaseline`, which a single large repository would
 * dominate.
 *
 * Effectiveness is the pooled success rate per condition over valid trials,
 * reported as a percentage-point difference, with the case-level view
 * (improved / tied / baseline better) beside it.
 *
 * Uncertainty is a two-level bootstrap that respects the design: cases are
 * resampled with replacement, and within each drawn case the trials of each
 * condition are resampled with replacement. The seed is fixed, so the
 * intervals in a report can be regenerated from the artifacts.
 */

export const BOOTSTRAP_SEED = 20260916;
export const BOOTSTRAP_ITERATIONS = 2000;

export interface CaseTrials {
  caseId: string;
  baseline: TrialArtifact[];
  drift: TrialArtifact[];
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

/** `1 - drift / baseline`, or `null` when either side is missing or the baseline is zero. */
export function contextReduction(baselineMedian: number | null, driftMedian: number | null): number | null {
  if (baselineMedian === null || driftMedian === null || baselineMedian <= 0) return null;
  return 1 - driftMedian / baselineMedian;
}

export function successRate(successes: number, valid: number): number | null {
  return valid === 0 ? null : successes / valid;
}

/** Percentage points, or `null` when either rate is undefined. */
export function percentagePointDifference(baselineRate: number | null, driftRate: number | null): number | null {
  if (baselineRate === null || driftRate === null) return null;
  return (driftRate - baselineRate) * 100;
}

export function relativeDifference(baselineRate: number | null, driftRate: number | null): number | null {
  if (baselineRate === null || driftRate === null || baselineRate === 0) return null;
  return driftRate / baselineRate - 1;
}

/** Groups valid headline-condition trials by case. Invalid trials are excluded here, and only here. */
export function groupByCase(trials: readonly TrialArtifact[]): CaseTrials[] {
  const byCase = new Map<string, CaseTrials>();
  for (const trial of trials) {
    if (!trial.validity.valid) continue;
    if (trial.condition !== 'baseline' && trial.condition !== 'drift') continue;
    const entry = byCase.get(trial.caseId) ?? { caseId: trial.caseId, baseline: [], drift: [] };
    entry[trial.condition].push(trial);
    byCase.set(trial.caseId, entry);
  }
  return [...byCase.values()].sort((a, b) => a.caseId.localeCompare(b.caseId));
}

export interface CaseMetrics {
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
  medianBaselineUncachedInputTokens: number | null;
  medianDriftUncachedInputTokens: number | null;
  medianBaselineWallClockMs: number | null;
  medianDriftWallClockMs: number | null;
  medianBaselineFilesRead: number | null;
  medianDriftFilesRead: number | null;
  medianBaselineToolCalls: number | null;
  medianDriftToolCalls: number | null;
  medianDriftAnalysisMs: number | null;
  baselineFailureReasons: Record<string, number>;
  driftFailureReasons: Record<string, number>;
  driftIdentifiedBreakingChange: number | null;
  driftIdentifiedLocalCode: number | null;
}

function countReasons(trials: readonly TrialArtifact[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const trial of trials) for (const reason of trial.validation.failureReasons) out[reason] = (out[reason] ?? 0) + 1;
  return out;
}

function fractionTrue(values: readonly (boolean | null)[]): number | null {
  const known = values.filter((v): v is boolean => v !== null);
  return known.length === 0 ? null : known.filter(Boolean).length / known.length;
}

export function caseMetrics(group: CaseTrials): CaseMetrics {
  const b = group.baseline;
  const d = group.drift;
  const bRate = successRate(b.filter((t) => t.validation.success).length, b.length);
  const dRate = successRate(d.filter((t) => t.validation.success).length, d.length);
  const bTokens = median(b.map((t) => t.usage.grossInputTokens));
  const dTokens = median(d.map((t) => t.usage.grossInputTokens));
  return {
    caseId: group.caseId,
    validBaselineTrials: b.length,
    validDriftTrials: d.length,
    baselineSuccesses: b.filter((t) => t.validation.success).length,
    driftSuccesses: d.filter((t) => t.validation.success).length,
    baselineSuccessRate: bRate,
    driftSuccessRate: dRate,
    successDifferencePp: percentagePointDifference(bRate, dRate),
    medianBaselineInputTokens: bTokens,
    medianDriftInputTokens: dTokens,
    inputTokenReduction: contextReduction(bTokens, dTokens),
    medianBaselineUncachedInputTokens: median(b.map((t) => t.usage.uncachedInputTokens)),
    medianDriftUncachedInputTokens: median(d.map((t) => t.usage.uncachedInputTokens)),
    medianBaselineWallClockMs: median(b.map((t) => t.agent.durationMs)),
    medianDriftWallClockMs: median(d.map((t) => t.agent.durationMs)),
    medianBaselineFilesRead: median(b.map((t) => t.tools.uniqueFilesRead)),
    medianDriftFilesRead: median(d.map((t) => t.tools.uniqueFilesRead)),
    medianBaselineToolCalls: median(b.map((t) => t.tools.toolCalls)),
    medianDriftToolCalls: median(d.map((t) => t.tools.toolCalls)),
    medianDriftAnalysisMs: median(d.map((t) => t.context.driftAnalysisMs).filter((v): v is number => v !== null)),
    baselineFailureReasons: countReasons(b),
    driftFailureReasons: countReasons(d),
    driftIdentifiedBreakingChange: fractionTrue(d.map((t) => t.diagnostics.driftIdentifiedBreakingChange)),
    driftIdentifiedLocalCode: fractionTrue(d.map((t) => t.diagnostics.driftIdentifiedLocalCode)),
  };
}

export interface Interval {
  low: number;
  high: number;
  iterations: number;
  seed: number;
  method: string;
}

/** A small deterministic PRNG (mulberry32), so intervals are reproducible from the artifacts alone. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapResult {
  medianReduction: Interval | null;
  meanReduction: Interval | null;
  successDifferencePp: Interval | null;
  baselineSuccessRate: Interval | null;
  driftSuccessRate: Interval | null;
}

const METHOD = 'two-level percentile bootstrap: cases resampled with replacement, then each condition\'s trials within each drawn case resampled with replacement';

/**
 * The two-level bootstrap. Efficiency statistics are over cases that have at
 * least one valid trial in both conditions; effectiveness statistics are over
 * every case with valid trials in that condition.
 */
export function bootstrap(
  groups: readonly CaseTrials[],
  options: { iterations?: number; seed?: number; confidence?: number } = {},
): BootstrapResult {
  const iterations = options.iterations ?? BOOTSTRAP_ITERATIONS;
  const seed = options.seed ?? BOOTSTRAP_SEED;
  const confidence = options.confidence ?? 0.95;
  const random = mulberry32(seed);
  const tail = (1 - confidence) / 2;

  const paired = groups.filter((g) => g.baseline.length > 0 && g.drift.length > 0);
  const anyBaseline = groups.filter((g) => g.baseline.length > 0);
  const anyDrift = groups.filter((g) => g.drift.length > 0);
  if (groups.length === 0) return { medianReduction: null, meanReduction: null, successDifferencePp: null, baselineSuccessRate: null, driftSuccessRate: null };

  const medianReductions: number[] = [];
  const meanReductions: number[] = [];
  const differences: number[] = [];
  const baselineRates: number[] = [];
  const driftRates: number[] = [];

  const draw = <T>(items: readonly T[]): T[] => {
    const out: T[] = [];
    for (let i = 0; i < items.length; i += 1) out.push(items[Math.floor(random() * items.length)]!);
    return out;
  };

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    if (paired.length > 0) {
      const reductions: number[] = [];
      for (const group of draw(paired)) {
        const b = median(draw(group.baseline).map((t) => t.usage.grossInputTokens));
        const d = median(draw(group.drift).map((t) => t.usage.grossInputTokens));
        const reduction = contextReduction(b, d);
        if (reduction !== null) reductions.push(reduction);
      }
      const m = median(reductions);
      const mn = mean(reductions);
      if (m !== null) medianReductions.push(m);
      if (mn !== null) meanReductions.push(mn);
    }

    let bSucc = 0;
    let bValid = 0;
    for (const group of draw(anyBaseline)) {
      for (const trial of draw(group.baseline)) {
        bValid += 1;
        if (trial.validation.success) bSucc += 1;
      }
    }
    let dSucc = 0;
    let dValid = 0;
    for (const group of draw(anyDrift)) {
      for (const trial of draw(group.drift)) {
        dValid += 1;
        if (trial.validation.success) dSucc += 1;
      }
    }
    const bRate = successRate(bSucc, bValid);
    const dRate = successRate(dSucc, dValid);
    if (bRate !== null) baselineRates.push(bRate);
    if (dRate !== null) driftRates.push(dRate);
    const diff = percentagePointDifference(bRate, dRate);
    if (diff !== null) differences.push(diff);
  }

  const interval = (values: number[]): Interval | null => {
    if (values.length === 0) return null;
    return { low: quantile(values, tail)!, high: quantile(values, 1 - tail)!, iterations, seed, method: METHOD };
  };

  return {
    medianReduction: interval(medianReductions),
    meanReduction: interval(meanReductions),
    successDifferencePp: interval(differences),
    baselineSuccessRate: interval(baselineRates),
    driftSuccessRate: interval(driftRates),
  };
}

export interface ConditionAggregate {
  condition: Condition;
  trials: number;
  validTrials: number;
  invalidTrials: number;
  infrastructureFailures: Record<string, number>;
  successfulTrials: number;
  successRate: number | null;
  medianInputTokens: number | null;
  medianUncachedInputTokens: number | null;
  medianOutputTokens: number | null;
  medianWallClockMs: number | null;
  medianFilesRead: number | null;
  medianToolCalls: number | null;
  medianShellCommands: number | null;
  medianFilesChanged: number | null;
  failureReasons: Record<FailureReason | string, number>;
  agentStatuses: Record<string, number>;
  /** Secondary, and labelled so: conditioning on success selects for the runs that went well. */
  inputTokensPerSuccessfulFix: number | null;
  medianInputTokensAmongSuccesses: number | null;
  totalCostUsd: number | null;
}

export function conditionAggregate(condition: Condition, trials: readonly TrialArtifact[]): ConditionAggregate {
  const all = trials.filter((t) => t.condition === condition);
  const valid = all.filter((t) => t.validity.valid);
  const successes = valid.filter((t) => t.validation.success);
  const infra: Record<string, number> = {};
  for (const t of all) if (!t.validity.valid && t.validity.infrastructureFailure) infra[t.validity.infrastructureFailure] = (infra[t.validity.infrastructureFailure] ?? 0) + 1;
  const statuses: Record<string, number> = {};
  for (const t of valid) statuses[t.agent.status] = (statuses[t.agent.status] ?? 0) + 1;
  const totalTokens = valid.reduce((sum, t) => sum + t.usage.grossInputTokens, 0);
  const costs = valid.map((t) => t.usage.costUsd).filter((c): c is number => c !== null);
  return {
    condition,
    trials: all.length,
    validTrials: valid.length,
    invalidTrials: all.length - valid.length,
    infrastructureFailures: infra,
    successfulTrials: successes.length,
    successRate: successRate(successes.length, valid.length),
    medianInputTokens: median(valid.map((t) => t.usage.grossInputTokens)),
    medianUncachedInputTokens: median(valid.map((t) => t.usage.uncachedInputTokens)),
    medianOutputTokens: median(valid.map((t) => t.usage.outputTokens)),
    medianWallClockMs: median(valid.map((t) => t.agent.durationMs)),
    medianFilesRead: median(valid.map((t) => t.tools.uniqueFilesRead)),
    medianToolCalls: median(valid.map((t) => t.tools.toolCalls)),
    medianShellCommands: median(valid.map((t) => t.tools.shellCommands)),
    medianFilesChanged: median(valid.map((t) => t.patch.files)),
    failureReasons: countReasons(valid),
    agentStatuses: statuses,
    inputTokensPerSuccessfulFix: successes.length === 0 ? null : totalTokens / successes.length,
    medianInputTokensAmongSuccesses: median(successes.map((t) => t.usage.grossInputTokens)),
    totalCostUsd: costs.length === valid.length && valid.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
  };
}

export interface CaseLevelSummary {
  improved: number;
  tied: number;
  baselineBetter: number;
  medianDifferencePp: number | null;
  meanDifferencePp: number | null;
}

export function caseLevelSummary(cases: readonly CaseMetrics[]): CaseLevelSummary {
  const diffs = cases.map((c) => c.successDifferencePp).filter((d): d is number => d !== null);
  return {
    improved: diffs.filter((d) => d > 0).length,
    tied: diffs.filter((d) => d === 0).length,
    baselineBetter: diffs.filter((d) => d < 0).length,
    medianDifferencePp: median(diffs),
    meanDifferencePp: mean(diffs),
  };
}
