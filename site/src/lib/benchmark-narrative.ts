import {
  falseSafeRate,
  formatInterval,
  formatIntervalCeiling,
  fraction,
  formatRate,
  hasRealNegatives,
  percent,
  requireBreakdownRate,
  requireClassification,
  requireConfusion,
  requireDataset,
  requireRate,
  type BenchmarkDataset,
  type Benchmarks,
} from "./benchmarks";

/**
 * Every number the homepage and `/benchmarks` prose quotes, in one place.
 *
 * The page components never read `dataset.rates[...]` or a confusion count
 * directly inside a sentence — they read a field off this object, and every
 * field here is produced by `requireRate`/`requireClassification`/etc, which
 * throw rather than return `0` or `"n/a"` when the artifact a sentence
 * depends on is missing. A benchmark run being renamed or dropped therefore
 * fails the site build instead of leaving a paragraph quietly describing a
 * number nothing backs any more.
 *
 * This module is the one place a new sentence's numbers should be added, and
 * the one place `benchmark-narrative.test.mjs` checks against `results.json`.
 */
export interface BenchmarkNarrative {
  roseau: {
    dataset: BenchmarkDataset;
    available: number;
    negativeControls: number;
    precisionFraction: string;
    precisionPercent: string;
    recallFraction: string;
    recallPercent: string;
    recallDenominator: number;
    fn: number;
    fp: number;
  };
  bumpFull: {
    dataset: BenchmarkDataset;
    selected: number;
    detectionFraction: string;
    falseSafeFraction: string;
    falseSafePercent: string;
    /** The 95% Wilson span, because these corpora differ in size by 10x. */
    falseSafeInterval: string;
    /** The ceiling the smaller positives-only corpora reach, which is what stops a false comparison. */
    peerCeilings: { npm: string; python: string };
    affectedByCategory: { slice: string; rate: string }[];
  };
  javaVsTypeScript: {
    sweBump: { affectedFraction: string; falseSafePercent: string; detectionFraction: string };
    timeMachine: { affectedFraction: string; falseSafePercent: string; detectionFraction: string };
    bump: { affectedFraction: string; falseSafePercent: string; detectionFraction: string };
  };
  kong: {
    /**
     * The binary question, and the only npm run with negative controls at
     * scale — 16k of them. That denominator is the whole reason a precision
     * means anything here, so it is a field rather than a sentence.
     */
    rq1: {
      dataset: BenchmarkDataset;
      negativeControls: string;
      precisionPercent: string;
      recallPercent: string;
    };
    rq2: {
      dataset: BenchmarkDataset;
      overallPercent: string;
      withDetailPercent: string;
      withoutDetailPercent: string;
      categoryFraction: string;
      categoryPercent: string;
    };
  };
  negativeControls: {
    /** Runs whose confusion matrix reflects real negative controls, by title. */
    withRealNegatives: { runId: string; title: string }[];
    /** Runs that are positive-only, by title. */
    positiveOnly: { runId: string; title: string }[];
  };
}

export function buildNarrative(benchmarks: Benchmarks): BenchmarkNarrative {
  const { datasets } = benchmarks;

  const roseau = requireDataset(datasets, "roseau-accuracy");
  const roseauClassification = requireClassification(roseau);
  const roseauConfusion = requireConfusion(roseau);

  const bumpFull = requireDataset(datasets, "bump-full-571");
  const bumpFalseSafe = falseSafeRate(bumpFull);
  const bumpFailureCategories = Object.keys(bumpFull.breakdown)
    .filter((slice) => slice.startsWith("label: "))
    .sort();

  const sweBump = requireDataset(datasets, "swe-bump-full");
  const timeMachine = requireDataset(datasets, "timemachine-full");
  const bump = bumpFull;

  const kongRq1 = requireDataset(datasets, "kong-rq1-documented");
  const kongRq1Classification = requireClassification(kongRq1);
  const kongRq2 = requireDataset(datasets, "kong-rq2-category");
  const kongRq2Overall = requireRate(kongRq2, "breaking-change detection recall");
  const kongRq2WithDetail = requireBreakdownRate(kongRq2, "messageStatesDetail: true", "breaking-change detection recall");
  const kongRq2WithoutDetail = requireBreakdownRate(
    kongRq2,
    "messageStatesDetail: false",
    "breaking-change detection recall",
  );
  const kongRq2Category = requireRate(kongRq2, "category classification accuracy");

  const withRealNegatives = datasets.filter(hasRealNegatives).map((d) => ({ runId: d.runId, title: d.title }));
  const positiveOnly = datasets.filter((d) => !hasRealNegatives(d)).map((d) => ({ runId: d.runId, title: d.title }));

  return {
    roseau: {
      dataset: roseau,
      available: roseau.available,
      negativeControls: roseau.negativeControls,
      precisionFraction: fraction(roseauClassification.precision),
      precisionPercent: percent(roseauClassification.precision),
      recallFraction: fraction(roseauClassification.recall),
      recallPercent: percent(roseauClassification.recall),
      recallDenominator: roseauClassification.recall.denominator,
      fn: roseauConfusion.fn,
      fp: roseauConfusion.fp,
    },
    bumpFull: {
      dataset: bumpFull,
      selected: bumpFull.selected,
      detectionFraction: fraction(requireRate(bumpFull, "dependency-update detection rate")),
      falseSafeFraction: fraction(bumpFalseSafe),
      falseSafePercent: percent(bumpFalseSafe),
      falseSafeInterval: formatInterval(bumpFalseSafe) ?? "n/a",
      peerCeilings: {
        npm: formatIntervalCeiling(falseSafeRate(sweBump)) ?? "n/a",
        python: formatIntervalCeiling(falseSafeRate(timeMachine)) ?? "n/a",
      },
      affectedByCategory: bumpFailureCategories.map((slice) => ({
        slice,
        rate: formatRate(requireBreakdownRate(bumpFull, slice, "affected-repository identification rate")),
      })),
    },
    javaVsTypeScript: {
      sweBump: {
        affectedFraction: fraction(requireRate(sweBump, "affected-repository identification rate")),
        falseSafePercent: percent(falseSafeRate(sweBump)),
        detectionFraction: fraction(requireRate(sweBump, "dependency-update detection rate")),
      },
      timeMachine: {
        affectedFraction: fraction(requireRate(timeMachine, "affected-repository identification rate")),
        falseSafePercent: percent(falseSafeRate(timeMachine)),
        detectionFraction: fraction(requireRate(timeMachine, "dependency-update detection rate")),
      },
      bump: {
        affectedFraction: fraction(requireRate(bump, "affected-repository identification rate")),
        falseSafePercent: percent(falseSafeRate(bump)),
        detectionFraction: fraction(requireRate(bump, "dependency-update detection rate")),
      },
    },
    kong: {
      rq1: {
        dataset: kongRq1,
        negativeControls: kongRq1.negativeControls.toLocaleString("en-US"),
        precisionPercent: percent(kongRq1Classification.precision),
        recallPercent: percent(kongRq1Classification.recall),
      },
      rq2: {
        dataset: kongRq2,
        overallPercent: percent(kongRq2Overall),
        withDetailPercent: percent(kongRq2WithDetail),
        withoutDetailPercent: percent(kongRq2WithoutDetail),
        categoryFraction: fraction(kongRq2Category),
        categoryPercent: percent(kongRq2Category),
      },
    },
    negativeControls: { withRealNegatives, positiveOnly },
  };
}
