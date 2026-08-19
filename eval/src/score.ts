import type { EvalFixture } from './load.ts';
import type { Adjudication } from './review.ts';
import type { OracleStageResult } from './oracle.ts';

export const SCORING_VERSION = 'eval-score-v2';

/**
 * Verdict strings a benchmark cares about, collapsed from production's two
 * real enums (`FindingVerdict` from `src/report/confidence.ts`, used by the
 * `drift-full-pipeline` adapter's per-finding result; `UpgradeSeverity` from
 * `src/upgrade/severity.ts`, used where a component adapter reports a
 * scan-level verdict instead). Only the safe-equivalent members are treated
 * as "Drift told the user this is safe" — everything else, including every
 * unverified/inconclusive/skipped shape, is deliberately never safe-equivalent.
 */
export type DriftVerdict =
  | 'no-incompatible-change-in-checked-surfaces'
  | 'detected-not-locally-reachable'
  | 'locally-affected'
  | 'insufficient-evidence'
  | 'verification-incomplete'
  | 'clean'
  | 'affected'
  | 'verification-failed'
  | 'upstream-only'
  | 'unchecked'
  | 'error'
  | 'pending';

const SAFE_EQUIVALENT_VERDICTS = new Set<DriftVerdict>(['no-incompatible-change-in-checked-surfaces', 'clean']);

export function isUserFacingSafeVerdict(verdict: DriftVerdict): boolean {
  return SAFE_EQUIVALENT_VERDICTS.has(verdict);
}

export type RepairAction = 'repair-attempted' | 'abstained';

export interface EvalPrediction {
  fixtureId: string;
  adapter: string;
  upstreamFindings: string[];
  impactSites: string[];
  taxonomy?: { nature: string; detectability: string[]; scope: string; visibility: string[] };
  gaps: string[];
  planNodes: string[];
  verdict: DriftVerdict;
  repairAction: RepairAction;
  repairOutcome: 'passed' | 'failed' | 'not-attempted';
  repairChangedFiles: string[];
  repairOutOfScopeFiles: string[];
  repairGoldPatchExact: boolean;
  oracleStages: OracleStageResult[];
  costUsd: number;
  latencyMs: number;
}

export interface Prf {
  precision: number;
  recall: number;
  f1: number;
}

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
}

export interface FixtureScore {
  fixtureId: string;
  adapter: string;
  upstream: Confusion & { applicable: boolean };
  impact: Confusion & { applicable: boolean };
  taxonomyCorrect: boolean | 'not-applicable';
  gapRecall: number | 'not-applicable';
  falseSafe: boolean;
  unsupportedSafe: boolean;
  correctAbstention: boolean;
  incorrectRepairAttempt: boolean;
  missedRepairOpportunity: boolean;
  successfulRepair: boolean;
  repairAttempted: boolean;
  regressionReason: 'none' | 'repair-failed-to-fix' | 'repair-introduced-regression' | 'oracle-unavailable';
  outOfScopeEditCount: number;
  changedFiles: Confusion;
  goldPatchExact: boolean | 'not-applicable';
  verdict: DriftVerdict;
  oracleStages: OracleStageResult[];
}

export function scoreFixture(fixture: EvalFixture, adjudication: Adjudication, prediction: EvalPrediction): FixtureScore {
  const ns = (id: string): string => `${fixture.id}::${id}`;
  const upstream = confusion(
    adjudication.decision.upstreamFindings.map(ns),
    prediction.upstreamFindings.map(ns),
  );
  const impact = confusion(adjudication.decision.impactSites.map(ns), prediction.impactSites.map(ns));

  const taxonomyCorrect = adjudication.decision.taxonomy
    ? prediction.taxonomy !== undefined && taxonomyEqual(adjudication.decision.taxonomy, prediction.taxonomy)
    : ('not-applicable' as const);

  const gapRecall =
    adjudication.decision.gaps.length === 0
      ? ('not-applicable' as const)
      : recall(adjudication.decision.gaps, prediction.gaps);

  const groundTruthSafety = adjudication.decision.groundTruthSafety;
  const driftSaysSafe = isUserFacingSafeVerdict(prediction.verdict);
  const falseSafe = groundTruthSafety === 'unsafe' && driftSaysSafe;
  const unsupportedSafe = groundTruthSafety === 'uncertain' && driftSaysSafe;

  const expectedAction = adjudication.decision.repair.expectedAction;
  const attempted = prediction.repairAction === 'repair-attempted';
  const repairedStage = prediction.oracleStages.find((s) => s.stage === 'repaired');
  const brokenStage = prediction.oracleStages.find((s) => s.stage === 'broken');
  const baselineStage = prediction.oracleStages.find((s) => s.stage === 'baseline');

  /**
   * Abstention correctness is a policy judgement — "should Drift have
   * attempted this automatically?" — and only `drift-full-pipeline` makes
   * that judgement. A component adapter like
   * `drift-component-localize-repair` is *handed* a known finding and always
   * attempts repair by design, because its entire purpose is testing whether
   * repair application succeeds given a known finding, not whether Drift
   * should have acted. Scoring it against the same expectedAction would
   * mislabel a successful component test as an "unsafe repair attempt".
   */
  const policyScoped = prediction.adapter === 'drift-full-pipeline';
  const correctAbstention = policyScoped && expectedAction === 'abstain' && !attempted;
  const incorrectRepairAttempt = policyScoped && expectedAction === 'abstain' && attempted;
  const missedRepairOpportunity = policyScoped && expectedAction === 'repair' && !attempted;
  const successfulRepair =
    (policyScoped ? expectedAction === 'repair' : true) &&
    attempted &&
    prediction.repairOutcome === 'passed' &&
    (baselineStage === undefined || baselineStage.matchesExpectation) &&
    (brokenStage === undefined || brokenStage.matchesExpectation) &&
    repairedStage?.matchesExpectation === true &&
    prediction.repairOutOfScopeFiles.length === 0;

  let regressionReason: FixtureScore['regressionReason'] = 'none';
  if (attempted && prediction.repairOutcome !== 'passed' && (!policyScoped || expectedAction === 'repair')) {
    if (repairedStage?.observed === 'unable-to-run') regressionReason = 'oracle-unavailable';
    else if (brokenStage && !brokenStage.matchesExpectation) regressionReason = 'repair-introduced-regression';
    else regressionReason = 'repair-failed-to-fix';
  }

  const expectedChangedFiles = new Set(adjudication.decision.repair.expectedChangedFiles.map(ns));
  const actualChangedFiles = new Set(prediction.repairChangedFiles.map(ns));
  const changedFiles = confusion([...expectedChangedFiles], [...actualChangedFiles]);

  const goldPatchApplicable = policyScoped ? expectedAction === 'repair' : attempted;
  const goldPatchExact = goldPatchApplicable ? prediction.repairGoldPatchExact : ('not-applicable' as const);

  return {
    fixtureId: fixture.id,
    adapter: prediction.adapter,
    upstream: { ...upstream, applicable: adjudication.decision.upstreamFindings.length > 0 || prediction.upstreamFindings.length > 0 },
    impact: { ...impact, applicable: adjudication.decision.impactSites.length > 0 || prediction.impactSites.length > 0 },
    taxonomyCorrect,
    gapRecall,
    falseSafe,
    unsupportedSafe,
    correctAbstention,
    incorrectRepairAttempt,
    missedRepairOpportunity,
    successfulRepair,
    repairAttempted: attempted,
    regressionReason,
    outOfScopeEditCount: prediction.repairOutOfScopeFiles.length,
    changedFiles,
    goldPatchExact,
    verdict: prediction.verdict,
    oracleStages: prediction.oracleStages,
  };
}

function confusion(expected: readonly string[], actual: readonly string[]): Confusion {
  const wanted = new Set(expected);
  const got = new Set(actual);
  const tp = [...got].filter((id) => wanted.has(id)).length;
  const fp = [...got].filter((id) => !wanted.has(id)).length;
  const fn = [...wanted].filter((id) => !got.has(id)).length;
  return { tp, fp, fn };
}

export function prfFromConfusion(c: Confusion): Prf {
  const precision = c.tp + c.fp === 0 ? (c.tp + c.fn === 0 ? 1 : 0) : c.tp / (c.tp + c.fp);
  const recallValue = c.tp + c.fn === 0 ? 1 : c.tp / (c.tp + c.fn);
  const f1 = precision + recallValue === 0 ? 0 : (2 * precision * recallValue) / (precision + recallValue);
  return { precision: round(precision), recall: round(recallValue), f1: round(f1) };
}

function recall(expected: readonly string[], actual: readonly string[]): number {
  if (expected.length === 0) return 1;
  const got = new Set(actual);
  return expected.filter((item) => got.has(item)).length / expected.length;
}

function taxonomyEqual(
  expected: NonNullable<Adjudication['decision']['taxonomy']>,
  actual: NonNullable<EvalPrediction['taxonomy']>,
): boolean {
  return JSON.stringify(sortTaxonomy(expected)) === JSON.stringify(sortTaxonomy(actual));
}

function sortTaxonomy<T extends { detectability: string[]; visibility: string[] }>(taxonomy: T): T {
  return { ...taxonomy, detectability: [...taxonomy.detectability].sort(), visibility: [...taxonomy.visibility].sort() };
}

export interface MicroMacro {
  micro: Prf;
  macro: Prf | 'not-applicable';
  counts: Confusion;
  /** Fixtures excluded from the macro mean because both expected and actual were empty. See eval/README.md's "empty-positive fixtures" policy. */
  excludedFromMacro: number;
}

/**
 * Micro sums raw confusion counts across every fixture, then computes one
 * P/R/F1 — the standard corpus-level aggregation, and immune to the
 * empty-set-inflation problem because a 0/0/0 fixture contributes nothing to
 * either the numerator or the denominator.
 *
 * Macro averages each fixture's own P/R/F1 — but excludes a fixture whose
 * expected AND actual sets were both empty ("nothing expected, nothing
 * predicted"): including it would silently count a fixture that made no
 * claim as a perfect positive detection, which is exactly the inflation this
 * benchmark must not produce. A fixture with an empty expected set and a
 * non-empty actual set (a false positive on a negative/control fixture) is
 * never excluded — it correctly drags macro precision toward 0.
 */
export function aggregateDetection(entries: readonly (Confusion & { applicable: boolean })[]): MicroMacro {
  const counts = entries.reduce(
    (total, e) => ({ tp: total.tp + e.tp, fp: total.fp + e.fp, fn: total.fn + e.fn }),
    { tp: 0, fp: 0, fn: 0 },
  );
  const micro = prfFromConfusion(counts);

  const applicable = entries.filter((e) => e.applicable);
  const macro =
    applicable.length === 0
      ? ('not-applicable' as const)
      : (() => {
          const prfs = applicable.map(prfFromConfusion);
          return {
            precision: round(mean(prfs.map((p) => p.precision))),
            recall: round(mean(prfs.map((p) => p.recall))),
            f1: round(mean(prfs.map((p) => p.f1))),
          };
        })();

  return { micro, macro, counts, excludedFromMacro: entries.length - applicable.length };
}

export interface AdapterMetrics {
  adapter: string;
  fixtures: number;
  upstream: MicroMacro;
  impact: MicroMacro;
  changedFiles: MicroMacro;
  taxonomyAccuracy: number | 'not-applicable';
  gapRecall: number | 'not-applicable';
  falseSafeCount: number;
  unsupportedSafeCount: number;
  repairOpportunities: number;
  repairAttempts: number;
  expectedAbstentions: number;
  correctAbstentions: number;
  incorrectAbstentions: number;
  missedRepairOpportunities: number;
  successfulRepairs: number;
  failedRepairs: number;
  repairedOraclePassRate: number | 'not-applicable';
  regressionCounts: Record<'repair-failed-to-fix' | 'repair-introduced-regression' | 'oracle-unavailable', number>;
  outOfScopeEditCount: number;
  outOfScopeEditRate: number;
  goldPatchExactRate: number | 'not-applicable';
}

export function aggregateAdapter(adapter: string, scores: readonly FixtureScore[]): AdapterMetrics {
  const upstream = aggregateDetection(scores.map((s) => s.upstream));
  const impact = aggregateDetection(scores.map((s) => s.impact));
  const changedFiles = aggregateDetection(scores.map((s) => ({ ...s.changedFiles, applicable: true })));

  const taxonomyApplicable = scores.filter((s) => s.taxonomyCorrect !== 'not-applicable');
  const taxonomyAccuracy =
    taxonomyApplicable.length === 0
      ? ('not-applicable' as const)
      : round(taxonomyApplicable.filter((s) => s.taxonomyCorrect === true).length / taxonomyApplicable.length);

  const gapApplicable = scores.filter((s) => s.gapRecall !== 'not-applicable') as (FixtureScore & { gapRecall: number })[];
  const gapRecallValue =
    gapApplicable.length === 0 ? ('not-applicable' as const) : round(mean(gapApplicable.map((s) => s.gapRecall)));

  const repairOpportunities = scores.filter((s) => s.missedRepairOpportunity || s.successfulRepair || (s.repairAttempted && !s.correctAbstention)).length;
  const expectedAbstentions = scores.filter((s) => s.correctAbstention || s.incorrectRepairAttempt).length;
  const successfulRepairs = scores.filter((s) => s.successfulRepair).length;
  const attempts = scores.filter((s) => s.repairAttempted);
  const failedRepairs = attempts.filter((s) => !s.successfulRepair).length;
  const repairedApplicable = attempts.length;

  const goldApplicable = scores.filter((s) => s.goldPatchExact !== 'not-applicable') as (FixtureScore & { goldPatchExact: boolean })[];

  return {
    adapter,
    fixtures: scores.length,
    upstream,
    impact,
    changedFiles,
    taxonomyAccuracy,
    gapRecall: gapRecallValue,
    falseSafeCount: scores.filter((s) => s.falseSafe).length,
    unsupportedSafeCount: scores.filter((s) => s.unsupportedSafe).length,
    repairOpportunities,
    repairAttempts: attempts.length,
    expectedAbstentions,
    correctAbstentions: scores.filter((s) => s.correctAbstention).length,
    incorrectAbstentions: scores.filter((s) => s.incorrectRepairAttempt).length,
    missedRepairOpportunities: scores.filter((s) => s.missedRepairOpportunity).length,
    successfulRepairs,
    failedRepairs,
    repairedOraclePassRate: repairedApplicable === 0 ? 'not-applicable' : round(successfulRepairs / repairedApplicable),
    regressionCounts: {
      'repair-failed-to-fix': scores.filter((s) => s.regressionReason === 'repair-failed-to-fix').length,
      'repair-introduced-regression': scores.filter((s) => s.regressionReason === 'repair-introduced-regression').length,
      'oracle-unavailable': scores.filter((s) => s.regressionReason === 'oracle-unavailable').length,
    },
    outOfScopeEditCount: sum(scores.map((s) => s.outOfScopeEditCount)),
    outOfScopeEditRate: scores.length === 0 ? 0 : round(scores.filter((s) => s.outOfScopeEditCount > 0).length / scores.length),
    goldPatchExactRate: goldApplicable.length === 0 ? 'not-applicable' : round(goldApplicable.filter((s) => s.goldPatchExact).length / goldApplicable.length),
  };
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
