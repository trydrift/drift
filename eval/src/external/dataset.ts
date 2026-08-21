import { z } from 'zod';

/**
 * What an external corpus is, and — the part that actually decides what may be
 * reported from it — what its ground truth is *like*.
 *
 * Five datasets are described here and they are not five instances of one
 * thing. Two of them label what changed in an upstream library; three of them
 * label a downstream project that a dependency upgrade broke. Those answer
 * different questions about Drift, and pooling them into one "accuracy" figure
 * would produce a number that describes nothing. So the class is a field, the
 * evaluation question is a sentence stored beside it, and every report is
 * grouped by class before anything is averaged.
 *
 * The `groundTruth` block is load-bearing in a stricter way. A benchmark made
 * of known-breaking upgrades has no negatives in it: every case is known to
 * break, so a tool that answered "breaking" to everything would score a
 * perfect recall and there is no population from which a false-positive rate
 * could be computed. Reporting precision from such a corpus is not a
 * presentation choice, it is arithmetic applied to data that cannot support
 * it. `exhaustive: false` therefore makes `metrics.ts` *refuse* to compute
 * precision or F1 — not omit them from a template, refuse.
 */

export const datasetClassSchema = z.enum([
  /** Labels what changed in an upstream library. Answers "did Drift read the change correctly?". */
  'upstream-bc-detection',
  /** Labels a downstream project a dependency upgrade broke. Answers "did Drift see that this repository is affected, and could it repair it?". */
  'consumer-impact',
]);
export type DatasetClass = z.infer<typeof datasetClassSchema>;

export const groundTruthSchema = z.object({
  /**
   * The level at which the dataset actually states truth. A metric may only be
   * computed at a granularity the annotation supports: a commit-level label
   * cannot adjudicate a symbol-level prediction, and scoring one against the
   * other manufactures both false positives and false negatives.
   */
  granularity: z.enum(['commit', 'api-symbol', 'category', 'project-build']),
  /**
   * Whether the annotation covers *everything* a prediction could name at that
   * granularity.
   *
   * `true` means an unannotated prediction is genuinely wrong, so precision,
   * F1 and a false-positive rate are all defined. `false` means the corpus
   * records positives only (or a sample), so an unannotated prediction may
   * simply be something nobody looked at — and precision computed over it
   * would be a fabrication with a decimal point.
   */
  exhaustive: z.boolean(),
  /** Why the two fields above are what they are, in the dataset's own terms. Printed in every report. */
  basis: z.string().min(1),
  /** Metrics this dataset's annotation can support. Nothing outside this list is ever computed from it. */
  supports: z.array(z.enum(['recall', 'precision', 'f1', 'category-accuracy', 'repair-success', 'false-safe-count'])),
});
export type GroundTruth = z.infer<typeof groundTruthSchema>;

export const datasetSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  /** Where the data actually came from — a DOI, a repository URL, or both. Never a paper citation standing in for a source. */
  source: z.object({
    kind: z.enum(['zenodo', 'git', 'local']),
    url: z.string().min(1),
    /** DOI for a Zenodo record, commit SHA for a repository. The thing that pins the version. */
    version: z.string().min(1),
    /** Concept DOI, when the record has one — the identifier that survives a new version. */
    conceptVersion: z.string().optional(),
  }),
  licence: z.string().min(1),
  /** How the dataset's authors ask to be cited. Reproduced in the report, not paraphrased. */
  citation: z.string().min(1),
  ecosystem: z.string().min(1),
  datasetClass: datasetClassSchema,
  /** One sentence: what running Drift against this corpus is asking. */
  evaluationQuestion: z.string().min(1),
  /** One sentence: what a good result here would *not* establish. Required, because this is the sentence readers need most. */
  doesNotEstablish: z.string().min(1),
  groundTruth: groundTruthSchema,
  /** Path under `benchmarks/` where the corpus is expected. Relative; the CLI resolves it. */
  localPath: z.string().min(1),
});
export type Dataset = z.infer<typeof datasetSchema>;

/**
 * The dataset registry.
 *
 * Version strings are what an actual fetch confirmed, not what a paper says.
 * Where a local copy's own metadata disagrees with the record it was expected
 * to come from, the adapter records what the local copy says — silently
 * rewriting a dataset's provenance to the version you meant to download is
 * exactly the failure this whole file exists to prevent.
 */
export const DATASETS: Record<string, Dataset> = {
  kong: {
    id: 'kong',
    title: 'Towards Better Comprehension of Breaking Changes in the NPM Ecosystem',
    source: {
      kind: 'zenodo',
      url: 'https://zenodo.org/records/13857646',
      version: '10.5281/zenodo.13857646',
      conceptVersion: '10.5281/zenodo.13219136',
    },
    licence: 'CC-BY-4.0',
    citation: 'Dezhen Kong et al., "Towards Better Comprehension of Breaking Changes in the NPM Ecosystem", replication package, Zenodo, DOI 10.5281/zenodo.13857646.',
    ecosystem: 'npm',
    datasetClass: 'upstream-bc-detection',
    evaluationQuestion:
      'Given the real prose an upstream JavaScript maintainer wrote about a commit, does Drift read a breaking change out of it, and does it read the right kind of breaking change?',
    doesNotEstablish:
      'Nothing about whether Drift finds these changes in a consumer repository, nothing about repair, and nothing about the published-artefact API diff — this corpus supplies prose, so only the prose interpreter is under test.',
    groundTruth: {
      granularity: 'commit',
      exhaustive: true,
      basis:
        "RQ1's detected_bc_are_documented.csv labels every sampled commit yes/no for whether developers documented a breaking change, so the negatives are real and precision is defined. RQ2's analyzed_breaking_changes.csv annotates a category per breaking change on commits already known to be breaking, which supports category accuracy and nothing else.",
      supports: ['recall', 'precision', 'f1', 'category-accuracy'],
    },
    /**
     * The extracted, byte-verified Zenodo package — not a local re-export.
     *
     * A copy of this dataset was already present on the machine this was
     * developed on, under a slightly different name. It differs from record
     * 13857646 in four of eight files: one column is renamed (`reason` vs
     * `motivation`), and the CSVs are re-encoded such that some multi-line
     * commit messages split differently. Which Zenodo version it came from
     * cannot be established — the newest version under the concept DOI
     * publishes no files — so rather than silently rewriting its provenance to
     * a record it may not be from, runs evaluate the published package, whose
     * md5 matches what Zenodo reports.
     */
    localPath: 'kong-zenodo-13857646',
  },

  'swe-bump': {
    id: 'swe-bump',
    title: 'swe-bump-bench',
    source: { kind: 'git', url: 'https://github.com/xeol-io/swe-bump-bench', version: 'unresolved' },
    licence: 'see the repository',
    citation: 'xeol-io, swe-bump-bench, https://github.com/xeol-io/swe-bump-bench',
    ecosystem: 'npm',
    datasetClass: 'consumer-impact',
    evaluationQuestion:
      'Given a real TypeScript project at a real commit and a dependency upgrade known to break its build, does Drift detect the update, decide the repository is affected, localize the code, and avoid telling the developer it is safe?',
    doesNotEstablish:
      'No precision and no false-positive rate. Every task in this corpus is a known-breaking upgrade, so there is no negative population to compute one over; a tool that answered "affected" unconditionally would score identically on the questions this corpus can answer.',
    groundTruth: {
      granularity: 'project-build',
      exhaustive: false,
      basis:
        'Each task is a known-breaking dependency bump whose build oracle fails. Positives only: there are no non-breaking control upgrades, and no symbol-level annotation of what changed.',
      supports: ['recall', 'repair-success', 'false-safe-count'],
    },
    localPath: 'swe-bump-bench',
  },

  timemachine: {
    id: 'timemachine',
    title: 'TimeMachine-bench (human-verified subset)',
    source: { kind: 'git', url: 'https://github.com/tohoku-nlp/timemachine-bench', version: 'unresolved' },
    licence: 'see the repository',
    citation: 'Tohoku NLP, TimeMachine-bench, https://github.com/tohoku-nlp/timemachine-bench',
    ecosystem: 'pypi',
    datasetClass: 'consumer-impact',
    evaluationQuestion:
      'Given a real Python repository whose historical dependency state no longer resolves or runs, does Drift detect the dependency change and identify the repository as affected?',
    doesNotEstablish:
      'No precision and no false-positive rate, for the same reason as swe-bump-bench: the corpus is migration failures, so every case is a positive.',
    groundTruth: {
      granularity: 'project-build',
      exhaustive: false,
      basis: 'Human-verified migration failures. Positives only; no non-failing control migrations.',
      supports: ['recall', 'repair-success', 'false-safe-count'],
    },
    localPath: 'timemachine-bench',
  },

  roseau: {
    id: 'roseau',
    title: 'Roseau accuracy dataset (replication kit)',
    source: { kind: 'zenodo', url: 'https://zenodo.org/records/15536418', version: '10.5281/zenodo.15536418' },
    licence: 'see the replication kit',
    citation: 'Roseau replication kit, Zenodo, DOI 10.5281/zenodo.15536418; tool at https://github.com/alien-tools/roseau',
    ecosystem: 'maven',
    datasetClass: 'upstream-bc-detection',
    evaluationQuestion:
      'On hand-built Java library version pairs with exhaustively enumerated API breaking changes, does Drift produce the same set?',
    doesNotEstablish:
      'Nothing about Drift on real-world Java projects: this dataset is constructed to enumerate API change kinds exhaustively, which is what makes precision meaningful and also what makes it unrepresentative of an actual upgrade.',
    groundTruth: {
      granularity: 'api-symbol',
      exhaustive: true,
      basis: 'Constructed library pairs with every API breaking change enumerated at symbol level, which is what supports precision and F1.',
      supports: ['recall', 'precision', 'f1', 'category-accuracy'],
    },
    localPath: 'roseau',
  },

  bump: {
    id: 'bump',
    title: 'BUMP — reproducible breaking dependency updates in Java',
    source: { kind: 'git', url: 'https://github.com/chains-project/bump', version: 'unresolved' },
    licence: 'see the repository',
    citation:
      'Frank Reyes et al., "BUMP: A Benchmark of Reproducible Breaking Dependency Updates", arXiv:2401.09906; data at https://github.com/chains-project/bump, archive at DOI 10.5281/zenodo.10041883.',
    ecosystem: 'maven',
    datasetClass: 'consumer-impact',
    evaluationQuestion:
      'Given a real Java project at the commit where a dependency update broke its Maven build, does Drift detect the update and identify the project as affected?',
    doesNotEstablish:
      'No precision and no false-positive rate. Every record is a reproduced breaking update; there are no non-breaking control updates in the corpus.',
    groundTruth: {
      granularity: 'project-build',
      exhaustive: false,
      basis:
        'Each record is one reproduced breaking dependency update with a recorded failure category. Positives only, and no annotation of which consumer source lines the break lands on.',
      supports: ['recall', 'repair-success', 'false-safe-count'],
    },
    localPath: 'bump',
  },
};

export function datasetOrThrow(id: string): Dataset {
  const dataset = DATASETS[id];
  if (!dataset) {
    throw new Error(`Unknown dataset "${id}". Known: ${Object.keys(DATASETS).sort().join(', ')}.`);
  }
  return dataset;
}
