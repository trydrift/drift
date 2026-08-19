import type { EvalFixture } from './load.ts';
import { sameTaxonomy, type Adjudication } from './review.ts';
import type { OracleStageResult } from './oracle.ts';

/**
 * v3 replaces the fake `repairOutOfScopeFiles` (always `[]`) and hard-coded
 * `repairGoldPatchExact: false` with real, computed signals, and splits one
 * conflated "out of scope" concept into two distinct ones:
 * `repairScopeEscapeFiles` (Drift edited a file outside its own plan's
 * allowed scope — a hard safety failure) vs. a ground-truth "unexpected
 * changed file" (Drift stayed in its own allowed scope but touched a file
 * the accepted benchmark truth did not expect — a benchmark-quality signal).
 * `outOfScopeEditCount` is gone; `productionScopeEscapeCount` and
 * `unexpectedChangedFileCount` replace it as two separately-reported counts.
 * Not a bug-fix-only bump: the JSON schema's field names changed.
 *
 * v4 renames the `drift-full-pipeline` adapter to
 * `drift-known-bump-analysis`, because it never was the full pipeline: it
 * constructs its own `DependencyChange` and starts at `gatherEvidence`,
 * skipping manifest detection, workspace labelling and triage. Detection and
 * repair results are byte-identical to v3 -- only the label changed -- but a
 * label that misdescribes what ran is exactly the kind of thing a scoring
 * version exists to make traceable, so it gets a bump rather than a silent
 * edit. The adapter that genuinely starts from the manifests is
 * `drift-end-to-end` in the case-based harness.
 */
export const SCORING_VERSION = 'eval-score-v4';

/**
 * Verdict strings a benchmark cares about, collapsed from production's two
 * real enums (`FindingVerdict` from `src/report/confidence.ts`, used by the
 * `drift-known-bump-analysis` adapter's per-finding result; `UpgradeSeverity` from
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
  /** Files changed outside the union of the repairable commits' own `allowedFiles`. Computed from real repair behaviour — never hard-coded. */
  repairScopeEscapeFiles: string[];
  /**
   * `'not-applicable'` when no repair was attempted or the adjudicated
   * ground truth has no gold patch to compare against — never `false` for
   * "we did not compare". Only `true`/`false` when an actual normalized-diff
   * comparison ran.
   */
  repairGoldPatchExact: boolean | 'not-applicable';
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
  /** Hard safety failure count: files changed outside Drift's own declared repair scope. CI-blocking. */
  productionScopeEscapeCount: number;
  /** Benchmark-quality signal: files changed within Drift's allowed scope but not expected by adjudicated ground truth. Never CI-blocking on its own. */
  unexpectedChangedFileCount: number;
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
    ? prediction.taxonomy !== undefined && sameTaxonomy(adjudication.decision.taxonomy, prediction.taxonomy)
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
   * attempted this automatically?" — and only `drift-known-bump-analysis` makes
   * that judgement. A component adapter like
   * `drift-component-localize-repair` is *handed* a known finding and always
   * attempts repair by design, because its entire purpose is testing whether
   * repair application succeeds given a known finding, not whether Drift
   * should have acted. Scoring it against the same expectedAction would
   * mislabel a successful component test as an "unsafe repair attempt".
   */
  const policyScoped = prediction.adapter === 'drift-known-bump-analysis';
  // This legacy adapter is deterministic and cannot delegate, so
  // `agent-delegation` truth — "no deterministic rule is derivable here" — says
  // exactly what `abstain` says to it: do not act.
  const mustNotAct = expectedAction === 'abstain' || expectedAction === 'agent-delegation';
  const correctAbstention = policyScoped && mustNotAct && !attempted;
  const incorrectRepairAttempt = policyScoped && mustNotAct && attempted;
  const missedRepairOpportunity = policyScoped && expectedAction === 'deterministic-repair' && !attempted;
  const successfulRepair =
    (policyScoped ? expectedAction === 'deterministic-repair' : true) &&
    attempted &&
    prediction.repairOutcome === 'passed' &&
    (baselineStage === undefined || baselineStage.matchesExpectation) &&
    (brokenStage === undefined || brokenStage.matchesExpectation) &&
    repairedStage?.matchesExpectation === true &&
    prediction.repairScopeEscapeFiles.length === 0;

  let regressionReason: FixtureScore['regressionReason'] = 'none';
  if (attempted && prediction.repairOutcome !== 'passed' && (!policyScoped || expectedAction === 'deterministic-repair')) {
    if (repairedStage?.observed === 'unable-to-run') regressionReason = 'oracle-unavailable';
    else if (brokenStage && !brokenStage.matchesExpectation) regressionReason = 'repair-introduced-regression';
    else regressionReason = 'repair-failed-to-fix';
  }

  // Ground truth for changed-file scoring is always the adjudicated
  // `expectedChangedFiles` — never `allowedFiles` (Drift's own production
  // safety boundary, which can legitimately be broader than what any one
  // fixture's ground truth expects to change; see eval/README.md).
  const expectedChangedFiles = new Set(adjudication.decision.repair.expectedChangedFiles.map(ns));
  const actualChangedFiles = new Set(prediction.repairChangedFiles.map(ns));
  const changedFiles = confusion([...expectedChangedFiles], [...actualChangedFiles]);

  // Prediction reports its own not-applicable state honestly (no repair
  // attempted, or adjudication has no gold patch) — scoring trusts it rather
  // than re-deriving applicability from policy, so an adapter that could not
  // actually run the comparison never gets silently overridden into `false`.
  const goldPatchExact = prediction.repairGoldPatchExact;

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
    productionScopeEscapeCount: prediction.repairScopeEscapeFiles.length,
    unexpectedChangedFileCount: changedFiles.fp,
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
  /** Hard safety failures: files a repair changed outside Drift's own declared scope. CI-blocking whenever > 0. */
  productionScopeEscapeCount: number;
  productionScopeEscapeRate: number;
  /** Benchmark-quality signal: files changed in-scope but not expected by adjudicated ground truth. Reported, never CI-blocking on its own. */
  unexpectedChangedFileCount: number;
  changedFilePrecision: number;
  changedFileRecall: number;
  changedFileF1: number;
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
    productionScopeEscapeCount: sum(scores.map((s) => s.productionScopeEscapeCount)),
    productionScopeEscapeRate: scores.length === 0 ? 0 : round(scores.filter((s) => s.productionScopeEscapeCount > 0).length / scores.length),
    unexpectedChangedFileCount: sum(scores.map((s) => s.unexpectedChangedFileCount)),
    changedFilePrecision: changedFiles.micro.precision,
    changedFileRecall: changedFiles.micro.recall,
    changedFileF1: changedFiles.micro.f1,
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
