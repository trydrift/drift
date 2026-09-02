import { bootstrapInterval } from '../evaluator/aggregate.ts';
import type { Dataset } from './dataset.ts';
import type { ExternalCaseResult } from './record.ts';

/**
 * Metrics, and the refusals that make them worth reading.
 *
 * Every number here is a numerator over a denominator and is printed as one.
 * A percentage on its own invites a reader to supply their own denominator,
 * and on a benchmark whose denominators move — cases excluded because a
 * runtime was missing, cases whose label would not map — the denominator is
 * most of the information.
 *
 * Three refusals are enforced rather than documented:
 *
 *   1. **Precision from a positive-only corpus.** A dataset of known-breaking
 *      upgrades contains no negatives, so "how often was Drift wrong to say
 *      breaking" has no population to be measured over. `rateOf` will not
 *      compute it, and `refusals` records why so the report can print the
 *      sentence instead of the number.
 *   2. **A rate over an empty denominator.** `null`, never `0`. Zero is a
 *      measurement; nothing is not.
 *   3. **A metric the dataset's own `groundTruth.supports` list does not
 *      include.** The list is a property of the annotation, so a caller
 *      asking for something outside it is asking for a fabrication.
 */

export interface Rate {
  numerator: number;
  denominator: number;
  value: number | null;
}

export function rate(numerator: number, denominator: number): Rate {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

/** `3/7 (42.9%)`, or `n/a (0/0)`. The only way a rate is ever rendered. */
export function formatRate(value: Rate): string {
  if (value.value === null) return `n/a (0/${value.denominator})`;
  return `${value.numerator}/${value.denominator} (${(value.value * 100).toFixed(1)}%)`;
}

export interface Refusal {
  metric: string;
  reason: string;
}

export interface DatasetMetrics {
  datasetId: string;
  datasetClass: Dataset['datasetClass'];
  /** Records the dataset contains, before this run selected anything. */
  available: number;
  /** Records the run's selection named. Not the same as how many it got through — see `attempted`. */
  selected: number;
  /**
   * Records this run actually produced a result for.
   *
   * Distinct from `selected` because a run can be interrupted, and an
   * interrupted run's artifacts are publishable. Collapsing the two would make
   * a sweep killed at case 37 of 63 report itself as a complete 37-case run —
   * quietly shrinking the denominator to whatever it managed instead of saying
   * what it set out to do.
   */
  attempted: number;
  /** Selected records this run never reached. Zero for a completed run. */
  notRun: number;
  /** Records that produced a scored outcome. */
  scored: number;
  /** Records excluded, and why — one entry per reason, summing to `selected - scored`. */
  excluded: Record<string, number>;
  /** The exact requirement each `environment-unavailable` exclusion was missing. */
  missingRequirements: Record<string, number>;
  rates: Record<string, Rate>;
  /** Per-question coverage where adapters explicitly recorded unadjudicated cases. */
  adjudication: Record<string, { adjudicated: number; notAdjudicated: number; reasons: Record<string, number> }>;
  /** Metrics deliberately not computed, with the reason a reader needs. */
  refusals: Refusal[];
  /** Cases the dataset labels as negatives/controls. Zero means precision is undefined here, whatever the ground-truth flags say. */
  negativeControls: number;
  /**
   * The confusion matrix, present only when the corpus is exhaustively
   * labelled *and* actually contributed negatives to this run. Both conditions
   * are checked against the data rather than read off a flag: a dataset can
   * declare itself exhaustive and still supply a run with no negatives in it,
   * and precision over that is as undefined as precision over a positive-only
   * corpus.
   */
  confusion: { tp: number; fp: number; tn: number; fn: number } | null;
  /** Precision/recall/F1, present exactly when `confusion` is. */
  classification: { precision: Rate; recall: Rate; f1: number | null } | null;
  /**
   * A trivially computable baseline on the same cases, when the adapter
   * supplies one.
   *
   * Published beside Drift's number rather than omitted. A task whose labels a
   * regular expression recovers is a task on which a good score means very
   * little, and the only convincing way to say so is to show what the regular
   * expression scores.
   */
  baseline: { name: string; description: string; confusion: { tp: number; fp: number; tn: number; fn: number }; precision: Rate; recall: Rate } | null;
  /**
   * Case-level bootstrap intervals, for the rates that have enough cases to
   * support one.
   *
   * The same policy the case-based harness uses, from the same function:
   * resample over cases rather than trials, and return nothing below twenty
   * cases. An interval from four cases is arithmetically valid and
   * rhetorically dishonest — it gets printed beside a percentage and read as
   * evidence of a precision the sample cannot supply. A rate with no entry
   * here has too few cases, which is itself worth knowing.
   */
  intervals: Record<string, { low: number; high: number; iterations: number }>;
  /**
   * Every rate again, broken down by the dataset's own label and by whatever
   * strata the adapter recorded.
   *
   * Present so that a headline can never be the only number available. A single
   * pooled figure hides both directions of the interesting result — that Drift
   * reads removals far better than renames, say — and a reader who can only see
   * the pooled figure has to take the author's word for which parts of the
   * corpus it came from.
   */
  breakdown: Record<string, Record<string, Rate>>;
  /**
   * How much of the corpus the label mapping can actually adjudicate.
   *
   * Reported for the same reason the refusals are: a category metric computed
   * over a tenth of a corpus is a different claim from one computed over all of
   * it, and the difference is invisible unless the coverage is printed beside
   * the rate.
   */
  mappingCoverage: Record<string, number>;
}

/**
 * The metric names this module knows how to compute, and which question each
 * one answers. Keeping them named rather than derived from whatever keys the
 * outcomes happen to carry means a typo produces nothing rather than a new
 * metric nobody defined.
 */
const OUTCOME_METRICS = {
  detectedBreaking: 'breaking-change detection recall',
  categoryCorrect: 'category classification accuracy',
  detectedUpdate: 'dependency-update detection rate',
  identifiedAffected: 'affected-repository identification rate',
  localized: 'consumer localization rate',
  repaired: 'repair success rate',
} as const;

export interface BaselineSpec {
  name: string;
  description: string;
  /** Reads the baseline's own prediction off a case. Never off Drift's. */
  predict: (result: ExternalCaseResult) => boolean;
}

export function computeMetrics(input: {
  dataset: Dataset;
  available: number;
  results: readonly ExternalCaseResult[];
  baseline?: BaselineSpec;
  /** How many records the run's selection named. Defaults to the number of results, which is right for a completed run. */
  selected?: number;
}): DatasetMetrics {
  const { dataset, results } = input;

  const excluded: Record<string, number> = {};
  const missingRequirements: Record<string, number> = {};
  for (const result of results) {
    if (!result.excluded) continue;
    excluded[result.excluded.kind] = (excluded[result.excluded.kind] ?? 0) + 1;
    if (result.excluded.missingRequirement) {
      missingRequirements[result.excluded.missingRequirement] =
        (missingRequirements[result.excluded.missingRequirement] ?? 0) + 1;
    }
  }

  const scored = results.filter((result) => result.excluded === null);
  const negativeControls = scored.filter((result) => result.truth.polarity === 'negative').length;

  const rates: Record<string, Rate> = {};
  const refusals: Refusal[] = [];
  const adjudication: DatasetMetrics['adjudication'] = {};

  for (const [key, label] of Object.entries({ ...OUTCOME_METRICS, falseSafe: 'false-safe verdicts' })) {
    const asked = scored.filter((result) => result.outcomes[key as keyof typeof result.outcomes] !== undefined);
    const withheld = scored.filter((result) => result.notAdjudicated?.[key as keyof NonNullable<ExternalCaseResult['notAdjudicated']>] !== undefined);
    if (asked.length > 0 || withheld.length > 0) {
      adjudication[label] = {
        adjudicated: asked.length,
        notAdjudicated: withheld.length,
        reasons: withheld.reduce<Record<string, number>>((counts, result) => {
          const reason = result.notAdjudicated?.[key as keyof NonNullable<ExternalCaseResult['notAdjudicated']>];
          if (reason) counts[reason] = (counts[reason] ?? 0) + 1;
          return counts;
        }, {}),
      };
    }
    if (key === 'falseSafe' || asked.length === 0) continue;
    const hits = asked.filter((result) => result.outcomes[key as keyof typeof result.outcomes] === true).length;
    rates[label] = rate(hits, asked.length);
  }

  // A false-safe is a count, never a rate. "Drift told 3 broken repositories
  // they were fine" is the sentence a reader needs; dividing it by anything
  // makes it look smaller than it is.
  const safetyAsked = scored.filter((result) => result.outcomes.falseSafe !== undefined);
  if (safetyAsked.length > 0) {
    // Gated like every other metric. It was not, which meant an adapter could
    // report a safety number from a dataset whose ground truth never claimed
    // to support one — and the safety number is the last one that should
    // escape the check.
    if (dataset.groundTruth.supports.includes('false-safe-count')) {
      rates['false-safe verdicts'] = rate(
        safetyAsked.filter((result) => result.outcomes.falseSafe === true).length,
        safetyAsked.length,
      );
    } else {
      refusals.push({
        metric: 'false-safe verdicts',
        reason: `${dataset.title}'s ground truth does not state whether a case is genuinely broken in a way that makes a safe verdict wrong, so a false-safe count from it would not mean what it says.`,
      });
    }
  }

  /*
   * The confusion matrix, computed only where it is defined.
   *
   * Both conditions are data-driven. A dataset may declare itself exhaustive
   * and still hand this particular run no negatives — a selection that
   * happened to draw only positives, a filter that removed them — and
   * precision over that is exactly as undefined as precision over a
   * positive-only corpus. Reading the flag alone would let the second case
   * through.
   */
  const classifiable = scored.filter((result) => result.predictedPositive !== undefined);
  const hasNegatives = classifiable.some((result) => result.truth.polarity === 'negative');
  const confusion =
    dataset.groundTruth.exhaustive && hasNegatives ? confuse(classifiable, (r) => r.predictedPositive === true) : null;

  const classification = confusion
    ? {
        precision: rate(confusion.tp, confusion.tp + confusion.fp),
        recall: rate(confusion.tp, confusion.tp + confusion.fn),
        f1: f1Of(confusion),
      }
    : null;

  const baseline =
    confusion && input.baseline
      ? (() => {
          const matrix = confuse(classifiable, input.baseline!.predict);
          return {
            name: input.baseline!.name,
            description: input.baseline!.description,
            confusion: matrix,
            precision: rate(matrix.tp, matrix.tp + matrix.fp),
            recall: rate(matrix.tp, matrix.tp + matrix.fn),
          };
        })()
      : null;

  /*
   * The refusals. Each one replaces a number a reader would otherwise expect
   * to see, so each one carries the sentence that belongs in its place.
   */
  if (!dataset.groundTruth.exhaustive || !hasNegatives) {
    const why = !dataset.groundTruth.exhaustive
      ? `${dataset.title}'s annotation is not exhaustive at the granularity Drift predicts at (${dataset.groundTruth.granularity}): ${dataset.groundTruth.basis}`
      : `${dataset.title} contributed no negative/control cases to this run, so there is no population a false positive could be measured against.`;
    refusals.push(
      { metric: 'precision', reason: why },
      { metric: 'F1', reason: 'F1 is a harmonic mean of precision and recall, and precision is not defined here.' },
      { metric: 'false-positive rate', reason: why },
    );
  }

  for (const [key, label] of Object.entries(OUTCOME_METRICS)) {
    if (!(label in rates)) continue;
    const supported = supportsMetric(dataset, key);
    if (supported) continue;
    delete rates[label];
    refusals.push({
      metric: label,
      reason: `${dataset.title}'s ground truth does not support this metric — it states ${dataset.groundTruth.supports.join(', ') || 'nothing scorable'} and nothing else.`,
    });
  }

  return {
    datasetId: dataset.id,
    datasetClass: dataset.datasetClass,
    available: input.available,
    selected: input.selected ?? results.length,
    attempted: results.length,
    notRun: Math.max(0, (input.selected ?? results.length) - results.length),
    scored: scored.length,
    excluded,
    missingRequirements,
    rates,
    adjudication,
    refusals,
    negativeControls,
    confusion,
    classification,
    baseline,
    breakdown: breakdownOf(dataset, scored),
    intervals: intervalsFor(scored),
    mappingCoverage: results.reduce<Record<string, number>>((counts, result) => {
      counts[result.truth.mappingStatus] = (counts[result.truth.mappingStatus] ?? 0) + 1;
      return counts;
    }, {}),
  };
}

/**
 * Per-label and per-stratum rates.
 *
 * The strata come from whatever the adapter put in `provenance.extra` with a
 * boolean-looking value, rather than from a fixed list here, so an adapter that
 * records a new dimension gets it reported without this file having to learn
 * about it.
 */
function breakdownOf(dataset: Dataset, scored: readonly ExternalCaseResult[]): Record<string, Record<string, Rate>> {
  const dimensions = new Map<string, Map<string, ExternalCaseResult[]>>();

  const put = (dimension: string, bucket: string, result: ExternalCaseResult): void => {
    const byBucket = dimensions.get(dimension) ?? new Map<string, ExternalCaseResult[]>();
    const entries = byBucket.get(bucket) ?? [];
    entries.push(result);
    byBucket.set(bucket, entries);
    dimensions.set(dimension, byBucket);
  };

  for (const result of scored) {
    put('label', result.truth.label || '(unlabelled)', result);
    for (const [key, value] of Object.entries(result.provenance.extra)) {
      if (value === 'true' || value === 'false') put(key, value, result);
    }
  }

  const out: Record<string, Record<string, Rate>> = {};
  for (const [dimension, byBucket] of dimensions) {
    for (const [bucket, entries] of byBucket) {
      for (const [key, label] of Object.entries(OUTCOME_METRICS)) {
        if (!supportsMetric(dataset, key)) continue;
        const asked = entries.filter((entry) => entry.outcomes[key as keyof typeof entry.outcomes] !== undefined);
        if (asked.length === 0) continue;
        const hits = asked.filter((entry) => entry.outcomes[key as keyof typeof entry.outcomes] === true).length;
        (out[`${dimension}: ${bucket}`] ??= {})[label] = rate(hits, asked.length);
      }
    }
  }
  return out;
}

/**
 * One interval per outcome, over the cases that outcome was actually asked of.
 *
 * Deliberately not computed over `scored` as a whole: an outcome asked of 30
 * of 100 cases has 30 independent observations, and resampling 100 would
 * report a tighter interval than the data supports.
 */
function intervalsFor(scored: readonly ExternalCaseResult[]): Record<string, { low: number; high: number; iterations: number }> {
  const out: Record<string, { low: number; high: number; iterations: number }> = {};
  // The false-safe rate is included here even though it is not in
  // `OUTCOME_METRICS`, which is not cosmetic: without it the report printed
  // "not reported (under 20 cases)" beside a rate over 39 cases. A false
  // explanation in a report whose subject is honesty is worse than no
  // interval, and the safety number is the one a reader scrutinises hardest.
  for (const [key, label] of Object.entries({ ...OUTCOME_METRICS, falseSafe: 'false-safe verdicts' })) {
    const asked = scored
      .map((result) => result.outcomes[key as keyof typeof result.outcomes])
      .filter((value): value is boolean => value !== undefined);
    const interval = bootstrapInterval(asked, { seed: 20260819 });
    if (interval) out[label] = interval;
  }
  return out;
}

function confuse(
  results: readonly ExternalCaseResult[],
  predict: (result: ExternalCaseResult) => boolean,
): { tp: number; fp: number; tn: number; fn: number } {
  const matrix = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const result of results) {
    const positive = result.truth.polarity === 'positive';
    const predicted = predict(result);
    if (positive && predicted) matrix.tp += 1;
    else if (positive) matrix.fn += 1;
    else if (predicted) matrix.fp += 1;
    else matrix.tn += 1;
  }
  return matrix;
}

function f1Of(confusion: { tp: number; fp: number; fn: number }): number | null {
  const precision = confusion.tp + confusion.fp === 0 ? null : confusion.tp / (confusion.tp + confusion.fp);
  const recall = confusion.tp + confusion.fn === 0 ? null : confusion.tp / (confusion.tp + confusion.fn);
  if (precision === null || recall === null || precision + recall === 0) return null;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Whether the dataset's declared annotation can support a given outcome.
 *
 * A detection or impact question is a recall question, an accuracy question is
 * a category question, and a repair question needs an executable oracle. The
 * mapping is spelled out rather than inferred so that adding an outcome
 * without deciding what kind of claim it is fails here instead of silently
 * appearing in a report.
 */
function supportsMetric(dataset: Dataset, outcomeKey: string): boolean {
  const supports = new Set(dataset.groundTruth.supports);
  switch (outcomeKey) {
    case 'detectedBreaking':
    case 'detectedUpdate':
    case 'identifiedAffected':
    case 'localized':
      return supports.has('recall');
    case 'categoryCorrect':
      return supports.has('category-accuracy');
    case 'repaired':
      return supports.has('repair-success');
    default:
      return false;
  }
}

/**
 * Precision, recall and F1 over an exhaustively annotated corpus — the only
 * shape where all three are defined.
 *
 * Kept separate from `computeMetrics` rather than folded into it, so that
 * calling it is a decision someone made rather than a default that happened.
 * It throws on a non-exhaustive dataset instead of returning a placeholder: a
 * function that quietly returns nothing gets its result rendered as `0.0`
 * somewhere downstream eventually.
 */
export function exhaustivePrf(
  dataset: Dataset,
  confusion: { tp: number; fp: number; fn: number },
): { precision: Rate; recall: Rate; f1: number | null } {
  if (!dataset.groundTruth.exhaustive) {
    throw new Error(
      `Refusing to compute precision for ${dataset.id}: its annotation is not exhaustive (${dataset.groundTruth.basis}).`,
    );
  }
  const precision = rate(confusion.tp, confusion.tp + confusion.fp);
  const recall = rate(confusion.tp, confusion.tp + confusion.fn);
  const f1 =
    precision.value === null || recall.value === null || precision.value + recall.value === 0
      ? null
      : (2 * precision.value * recall.value) / (precision.value + recall.value);
  return { precision, recall, f1 };
}
