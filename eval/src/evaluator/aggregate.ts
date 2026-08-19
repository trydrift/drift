import type { Confusion, LevelScore } from './detection.ts';
import { isCorrectDecision, isRepairSuccess, type RepairScore } from './repair.ts';

/**
 * Aggregation, and the statistical honesty that has to come with it.
 *
 * Two failure modes are being guarded against here, and both are easy to fall
 * into without noticing.
 *
 * The first is the empty-set trap. A case with nothing expected and nothing
 * predicted has perfect precision and perfect recall by definition, and
 * averaging that in rewards a tool for making no claim. It is excluded from
 * macro means and left in micro, where it contributes 0/0/0 and moves nothing.
 * A case with an empty expected set and a *non-empty* actual set — a false
 * positive on a control case — is never excluded; it correctly drags precision
 * down, which is the entire point of having control cases.
 *
 * The second is repository dominance. A historical corpus mined from real
 * repositories is never balanced: one active monorepo can contribute a dozen
 * cases and one obscure library one. Instance-micro then reports that
 * repository's characteristics as the tool's. So every rate is reported at
 * four levels — instance-micro, case-macro, repository-macro and
 * dependency-macro — and a large gap between them is itself the finding.
 */

export interface Prf {
  precision: number;
  recall: number;
  f1: number;
}

export function prf(confusion: Confusion): Prf {
  const precision = confusion.tp + confusion.fp === 0 ? 0 : confusion.tp / (confusion.tp + confusion.fp);
  const recall = confusion.tp + confusion.fn === 0 ? 0 : confusion.tp / (confusion.tp + confusion.fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

export interface LevelAggregate {
  /** Cases whose adjudication actually ruled on this level. Everything below is out of this many. */
  scoredCases: number;
  notAdjudicatedCases: number;
  micro: Confusion & Prf;
  /** Mean of per-case P/R/F1, excluding vacuous (empty-expected, empty-actual) cases. */
  macro: Prf & { cases: number };
  vacuousExcluded: number;
}

export function aggregateLevel(scores: readonly LevelScore[]): LevelAggregate {
  const scored = scores.filter((score) => score.status === 'scored');
  const micro = scored.reduce<Confusion>(
    (total, score) => ({
      tp: total.tp + score.confusion.tp,
      fp: total.fp + score.confusion.fp,
      fn: total.fn + score.confusion.fn,
    }),
    { tp: 0, fp: 0, fn: 0 },
  );

  const macroInputs = scored.filter((score) => !score.vacuous);
  const macro = macroInputs.length === 0
    ? { precision: 0, recall: 0, f1: 0, cases: 0 }
    : {
        ...mean(macroInputs.map((score) => prf(score.confusion))),
        cases: macroInputs.length,
      };

  return {
    scoredCases: scored.length,
    notAdjudicatedCases: scores.length - scored.length,
    micro: { ...micro, ...prf(micro) },
    macro,
    vacuousExcluded: scored.length - macroInputs.length,
  };
}

function mean(values: readonly Prf[]): Prf {
  const sum = values.reduce(
    (total, value) => ({
      precision: total.precision + value.precision,
      recall: total.recall + value.recall,
      f1: total.f1 + value.f1,
    }),
    { precision: 0, recall: 0, f1: 0 },
  );
  return { precision: sum.precision / values.length, recall: sum.recall / values.length, f1: sum.f1 / values.length };
}

export interface Rate {
  numerator: number;
  denominator: number;
  /** `null` when the denominator is zero. A rate over nothing is not 0% — it is undefined, and printing 0% would be a claim. */
  value: number | null;
}

export function rate(numerator: number, denominator: number): Rate {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

export interface RepairAggregate {
  track: string;
  /** Every outcome, counted. The exclusion table is derived from this, so no case can vanish. */
  outcomes: Record<string, number>;
  /** Trials this track produced, before anything is excluded. `scorable + excluded`. */
  attempted: number;
  /** Outcomes eligible for a rate. Product outcomes only — see the three exclusion kinds below. */
  scorable: number;
  excluded: number;
  /**
   * Why each excluded trial left the denominator, counted.
   *
   * Printed beside every rate rather than folded into a single "excluded"
   * number, because the two kinds call for opposite reactions: a large
   * `environment-unavailable` count means the run could not measure the
   * product here, and a large `case-invalid` count means the corpus is not
   * reproducing on this machine. Neither is a result about Drift, and both
   * have to be visible before the rate above them is read.
   */
  exclusionReasons: Record<string, number>;
  /**
   * The end-to-end delivery breakdown, stated as three counts that sum to the
   * denominator, so a reader never has to reconstruct it from a percentage.
   *
   * `unsuccessful` includes `delivery-failure` — a case Drift began and could
   * not finish. Those used to be excluded outright, which let the headline
   * describe only the attempts that survived long enough to be judged.
   */
  delivery: {
    successful: number;
    unsuccessful: number;
    deliveryFailures: number;
    denominator: number;
  };
  repairSuccess: Rate;
  correctDecision: Rate;
  productionScopeEscapes: number;
  unexpectedChangedFiles: number;
  goldPatchExactOf: Rate;
  /** Which mechanism actually did the work, for the full-remediation track. */
  resolvedByTier: Record<string, number>;
}

export function aggregateRepair(track: string, scores: readonly RepairScore[]): RepairAggregate {
  const outcomes: Record<string, number> = {};
  const exclusionReasons: Record<string, number> = {};
  const resolvedByTier: Record<string, number> = {};
  for (const score of scores) {
    outcomes[score.outcome] = (outcomes[score.outcome] ?? 0) + 1;
    if (!score.scorable) {
      const reason = score.exclusionReason ?? score.outcome;
      exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1;
    }
    for (const entry of score.resolvedByTier) resolvedByTier[entry.tier] = (resolvedByTier[entry.tier] ?? 0) + 1;
  }

  const scorable = scores.filter((score) => score.scorable);
  const compared = scores.filter((score) => score.goldPatchExact !== 'not-applicable');
  const successful = scorable.filter((score) => isRepairSuccess(score.outcome)).length;
  const deliveryFailures = scorable.filter((score) => score.outcome === 'delivery-failure').length;

  return {
    track,
    outcomes,
    attempted: scores.length,
    scorable: scorable.length,
    excluded: scores.length - scorable.length,
    exclusionReasons,
    delivery: {
      successful,
      unsuccessful: scorable.length - successful,
      deliveryFailures,
      denominator: scorable.length,
    },
    repairSuccess: rate(successful, scorable.length),
    correctDecision: rate(scorable.filter((score) => isCorrectDecision(score.outcome)).length, scorable.length),
    productionScopeEscapes: scores.reduce((total, score) => total + score.productionScopeEscapes.length, 0),
    unexpectedChangedFiles: scores.reduce((total, score) => total + score.unexpectedChangedFiles.length, 0),
    goldPatchExactOf: rate(compared.filter((score) => score.goldPatchExact === true).length, compared.length),
    resolvedByTier,
  };
}

/**
 * Per-case reliability across independent trials.
 *
 * A live agent is nondeterministic, and "succeeded once in three" and
 * "succeeded three times in three" are different products even though pass@3
 * scores them identically. The headline is first-attempt success; this reports
 * the rest of the distribution beside it rather than instead of it, and
 * deliberately does not compute a best-of-k number, which belongs in a
 * separately labelled experiment if it is ever wanted at all.
 */
export interface TrialReliability {
  caseId: string;
  trials: number;
  successes: number;
  firstAttemptSuccess: boolean;
  allTrialsSucceeded: boolean;
}

export function trialReliability(scores: readonly (RepairScore & { trial: number })[]): TrialReliability[] {
  const byCase = new Map<string, (RepairScore & { trial: number })[]>();
  for (const score of scores) {
    const bucket = byCase.get(score.caseId) ?? [];
    bucket.push(score);
    byCase.set(score.caseId, bucket);
  }

  return [...byCase.entries()]
    .map(([caseId, entries]) => {
      const sorted = [...entries].sort((a, b) => a.trial - b.trial);
      const successes = sorted.filter((entry) => isRepairSuccess(entry.outcome)).length;
      return {
        caseId,
        trials: sorted.length,
        successes,
        firstAttemptSuccess: sorted[0] !== undefined && isRepairSuccess(sorted[0].outcome),
        allTrialsSucceeded: sorted.length > 0 && successes === sorted.length,
      };
    })
    .sort((a, b) => a.caseId.localeCompare(b.caseId));
}

/**
 * A case-level bootstrap interval for a proportion.
 *
 * Resampling is over *cases*, not over trials, because cases are the
 * independent units — two trials of the same case are not two observations of
 * the population. Deterministic given a seed so a report is reproducible.
 *
 * Returns `null` below `minimumCases`. An interval computed from four cases is
 * arithmetically valid and rhetorically dishonest: it would be printed beside
 * a percentage and read as evidence of precision that a four-case corpus
 * cannot supply.
 */
export function bootstrapInterval(
  outcomes: readonly boolean[],
  options: { iterations?: number; seed?: number; confidence?: number; minimumCases?: number } = {},
): { low: number; high: number; iterations: number } | null {
  const minimumCases = options.minimumCases ?? 20;
  if (outcomes.length < minimumCases) return null;

  const iterations = options.iterations ?? 2000;
  const confidence = options.confidence ?? 0.95;
  const random = mulberry32(options.seed ?? 20260819);
  const means: number[] = [];

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let successes = 0;
    for (let draw = 0; draw < outcomes.length; draw += 1) {
      if (outcomes[Math.floor(random() * outcomes.length)]!) successes += 1;
    }
    means.push(successes / outcomes.length);
  }

  means.sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  return {
    low: means[Math.floor(tail * means.length)]!,
    high: means[Math.min(means.length - 1, Math.ceil((1 - tail) * means.length) - 1)]!,
    iterations,
  };
}

/**
 * McNemar's exact test, for comparing two tracks on the same cases.
 *
 * The right test here precisely because the two tracks are evaluated on
 * identical cases: the paired design means only the cases where they disagree
 * carry information, and an unpaired proportion test would throw that away.
 * Returns `null` when the discordant count is too small for the result to mean
 * anything, rather than returning a p-value nobody should act on.
 */
export function mcnemar(
  a: ReadonlyMap<string, boolean>,
  b: ReadonlyMap<string, boolean>,
  minimumDiscordant = 10,
): { aOnly: number; bOnly: number; pValue: number; n: number } | null {
  let aOnly = 0;
  let bOnly = 0;
  let paired = 0;

  for (const [caseId, aSuccess] of a) {
    if (!b.has(caseId)) continue;
    paired += 1;
    const bSuccess = b.get(caseId)!;
    if (aSuccess && !bSuccess) aOnly += 1;
    else if (!aSuccess && bSuccess) bOnly += 1;
  }

  const discordant = aOnly + bOnly;
  if (discordant < minimumDiscordant) return null;

  // Exact two-sided binomial test at p = 0.5 over the discordant pairs.
  const smaller = Math.min(aOnly, bOnly);
  let tail = 0;
  for (let k = 0; k <= smaller; k += 1) tail += binomial(discordant, k);
  const pValue = Math.min(1, (2 * tail) / 2 ** discordant);

  return { aOnly, bOnly, pValue, n: paired };
}

function binomial(n: number, k: number): number {
  let result = 1;
  for (let i = 0; i < k; i += 1) result = (result * (n - i)) / (i + 1);
  return result;
}

/** A small deterministic PRNG, so a bootstrap interval is reproducible from the report alone. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
