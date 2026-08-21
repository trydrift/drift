import data from "@/data/benchmarks/results.json";

/**
 * The benchmark results, as the page reads them.
 *
 * Every field here originates in an `eval/results/<run-id>/metrics.json` that a
 * real run wrote, copied into `src/data/benchmarks.json` by
 * `scripts/sync-benchmarks.mjs` at build time. Nothing on the page is typed by
 * hand, and this module deliberately offers no way to construct a
 * `BenchmarkDataset` from anything else.
 */

export interface Rate {
  numerator: number;
  denominator: number;
  value: number | null;
}

export interface GroundTruth {
  granularity: string;
  exhaustive: boolean;
  basis: string;
  supports: string[];
}

export interface Confusion {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

export interface BenchmarkDataset {
  runId: string;
  headline: boolean;
  why: string;

  title: string;
  ecosystem: string;
  datasetClass: string;
  sourceUrl: string;
  datasetVersion: string;
  licence: string;
  citation: string;
  evaluationQuestion: string;
  doesNotEstablish: string;
  groundTruth: GroundTruth | null;

  driftCommit: string;
  driftTreeDirty: boolean;
  runDate: string;
  /** When the metrics were last recomputed from the same observations, or `null`. */
  rescoredAt: string | null;
  rescoredAtCommit: string | null;
  command: string;
  platform: string;
  notes: string;

  available: number;
  selected: number;
  /** Records the run reached. Below `selected` only when the run was interrupted. */
  attempted: number;
  notRun: number;
  scored: number;
  excluded: Record<string, number>;
  missingRequirements: Record<string, number>;
  negativeControls: number;
  selectionMode: string;
  selectionSeed: number;
  selectionLimit: number | null;

  rates: Record<string, Rate>;
  confusion: Confusion | null;
  classification: { precision: Rate; recall: Rate; f1: number | null } | null;
  baseline: { name: string; description: string; confusion: Confusion; precision: Rate; recall: Rate } | null;
  refusals: { metric: string; reason: string }[];
  mappingCoverage: Record<string, number>;
  breakdown: Record<string, Record<string, Rate>>;
  /** Case-level bootstrap intervals, present only for rates with at least twenty cases behind them. */
  intervals: Record<string, { low: number; high: number; iterations: number }>;

  tools: { tool: string; available: boolean; version: string; neededFor: string }[];
}

export interface Benchmarks {
  generatedAt: string;
  datasets: BenchmarkDataset[];
}

export function loadBenchmarks(): Benchmarks {
  return data as unknown as Benchmarks;
}

/**
 * A published dataset by its `runId`, or a loud failure.
 *
 * Every quantitative claim on the site traces back to one of these calls. A
 * silent fallback here — an empty dataset, a zeroed rate — would let a run
 * that was renamed or dropped from `published.json` keep being cited by copy
 * that no longer has anything backing it. Better a broken build than a
 * confident number nobody can find the evidence for.
 */
export function requireDataset(datasets: readonly BenchmarkDataset[], runId: string): BenchmarkDataset {
  const dataset = datasets.find((d) => d.runId === runId);
  if (!dataset) {
    throw new Error(
      `requireDataset: no published run "${runId}" in results.json. ` +
        `Available: ${datasets.map((d) => d.runId).join(", ") || "(none)"}.`,
    );
  }
  return dataset;
}

/** A named rate off a dataset, or a loud failure — same reasoning as {@link requireDataset}. */
export function requireRate(dataset: BenchmarkDataset, label: string): Rate {
  const rate = dataset.rates[label];
  if (!rate) {
    throw new Error(
      `requireRate: dataset "${dataset.runId}" has no rate "${label}". ` +
        `Available: ${Object.keys(dataset.rates).join(", ") || "(none)"}.`,
    );
  }
  return rate;
}

/** The precision/recall/F1 block, or a loud failure when a dataset has no negative controls. */
export function requireClassification(
  dataset: BenchmarkDataset,
): { precision: Rate; recall: Rate; f1: number | null } {
  if (!dataset.classification) {
    throw new Error(
      `requireClassification: dataset "${dataset.runId}" has no classification block ` +
        `(it likely has no negative controls, so precision/recall are not defined).`,
    );
  }
  return dataset.classification;
}

/** The confusion matrix, or a loud failure — see {@link requireClassification}. */
export function requireConfusion(dataset: BenchmarkDataset): Confusion {
  if (!dataset.confusion) {
    throw new Error(`requireConfusion: dataset "${dataset.runId}" has no confusion matrix.`);
  }
  return dataset.confusion;
}

/** The "false-safe verdicts" rate every consumer-impact dataset publishes. */
export function falseSafeRate(dataset: BenchmarkDataset): Rate {
  return requireRate(dataset, "false-safe verdicts");
}

/** Whether a dataset's confusion matrix reflects real negative controls (as opposed to positives-only). */
export function hasRealNegatives(dataset: BenchmarkDataset): boolean {
  return dataset.confusion !== null && dataset.negativeControls > 0;
}

/** A rate from one slice of a dataset's own `breakdown`, or a loud failure. */
export function requireBreakdownRate(dataset: BenchmarkDataset, slice: string, label: string): Rate {
  const row = dataset.breakdown[slice];
  const rate = row?.[label];
  if (!rate) {
    throw new Error(
      `requireBreakdownRate: dataset "${dataset.runId}" has no "${label}" under breakdown slice "${slice}". ` +
        `Available slices: ${Object.keys(dataset.breakdown).join(", ") || "(none)"}.`,
    );
  }
  return rate;
}

/**
 * `13/17 (76.5%)`, or `n/a (0/0)`.
 *
 * The only way a rate is ever rendered on this site. A bare percentage invites
 * a reader to supply their own denominator, and on a benchmark whose
 * denominators move — cases excluded because a runtime was missing, cases whose
 * label would not map — the denominator is most of the information.
 */
export function formatRate(rate: Rate): string {
  if (rate.value === null) return `n/a (0/${rate.denominator})`;
  return `${rate.numerator}/${rate.denominator} (${(rate.value * 100).toFixed(1)}%)`;
}

/** Just the fraction, for a metric card's large line. Always paired with the percentage below it. */
export function fraction(rate: Rate): string {
  return `${rate.numerator}/${rate.denominator}`;
}

export function percent(rate: Rate): string {
  return rate.value === null ? "n/a" : `${(rate.value * 100).toFixed(1)}%`;
}

/** `2026-08-19`. Times are noise on a page about datasets. */
export function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

export function shortCommit(sha: string): string {
  return sha === "unavailable" ? sha : sha.slice(0, 10);
}

const CLASS_LABEL: Record<string, string> = {
  "upstream-bc-detection": "Upstream breaking-change detection",
  "consumer-impact": "Consumer impact",
};

export function classLabel(datasetClass: string): string {
  return CLASS_LABEL[datasetClass] ?? datasetClass;
}

/**
 * The two questions the corpora answer, kept apart everywhere on the page.
 *
 * "Did Drift read the upstream change correctly?" and "did Drift see that this
 * repository is affected?" are different questions with different corpora and
 * different ground truth. Averaging across them would produce a single "Drift
 * accuracy" figure that describes neither.
 */
export function byClass(datasets: readonly BenchmarkDataset[]): { datasetClass: string; datasets: BenchmarkDataset[] }[] {
  const order = ["upstream-bc-detection", "consumer-impact"];
  return order
    .map((datasetClass) => ({ datasetClass, datasets: datasets.filter((d) => d.datasetClass === datasetClass) }))
    .filter((group) => group.datasets.length > 0);
}
