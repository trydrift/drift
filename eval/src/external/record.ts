import { z } from 'zod';

/**
 * One external case, and everything needed to answer "where did this code and
 * this expected answer come from?".
 *
 * Deliberately *not* the npm `PublicCase` shape. That schema describes a
 * frozen consumer with two frozen upstream package trees and a `file:`
 * repointing step, which is exactly right for a synthetic npm capsule and
 * exactly wrong for a Maven project reproduced from a Docker image or a Python
 * repository resolved against a date-filtered index. Forcing five corpora
 * through one case type would mean either inventing the fields they do not
 * have or quietly dropping the ones they do — and a dropped field is a lost
 * provenance chain.
 *
 * So this is the provenance record, and how a case is *executed* is the
 * adapter's business. What every adapter must supply is the same: enough to
 * find the original source again at the exact revision that was evaluated.
 */

export const EXTERNAL_RECORD_VERSION = 'drift-external-case-v1';

/**
 * How confidently an external label maps onto Drift's own vocabulary.
 *
 * A benchmark's taxonomy and a tool's taxonomy are never the same taxonomy,
 * and the temptation is to squeeze one into the other so that more cases score.
 * Every category that gets squeezed makes the resulting number describe the
 * squeeze rather than the tool. So a mapping states its own confidence, only
 * `exact` and `compatible` are scored, and `ambiguous`/`unsupported` stay
 * visible in a table with the count next to them.
 */
export const mappingStatusSchema = z.enum([
  /** The two labels mean the same thing. Scored. */
  'exact',
  /** Different words, same observable change, and the difference cannot flip a verdict. Scored, and listed as compatible. */
  'compatible',
  /** The external label spans several Drift kinds, or vice versa, so a match cannot be adjudicated. Never scored. */
  'ambiguous',
  /** Drift has no representation of this at all. Never scored. */
  'unsupported',
]);
export type MappingStatus = z.infer<typeof mappingStatusSchema>;

export const externalProvenanceSchema = z.object({
  dataset: z.string(),
  /** DOI, Zenodo record, or repository commit — whatever pins the dataset version this record came from. */
  datasetVersion: z.string(),
  /** The dataset's own identifier for this record. Never renumbered by us. */
  recordId: z.string(),
  /** The original project this is about, as a URL where one exists. */
  repository: z.string(),
  /** The exact revision evaluated. Never a branch, never HEAD. */
  commit: z.string(),
  /** A second revision where the case is a pair (the pre-update state, the upstream `from` tag). */
  baseCommit: z.string().nullable(),
  dependency: z.string().nullable(),
  fromVersion: z.string().nullable(),
  toVersion: z.string().nullable(),
  packageManager: z.string().nullable(),
  /** Runtime the dataset says this case needs — a Node major, a JDK version, a Python version. */
  requiredRuntime: z.string().nullable(),
  /** The command the dataset's own oracle runs, when it states one. */
  oracleCommand: z.string().nullable(),
  /** Container image the dataset publishes for this case, when it publishes one. */
  containerImage: z.string().nullable(),
  /** Content hash of whatever source text this record was actually evaluated against. */
  sourceHash: z.string(),
  /** Free-form extra fields the source dataset carries and we must not lose. */
  extra: z.record(z.string(), z.string()).default({}),
});
export type ExternalProvenance = z.infer<typeof externalProvenanceSchema>;

export const externalTruthSchema = z.object({
  /** The dataset's own label, verbatim. Never normalised in place. */
  label: z.string(),
  /** What that label maps to in Drift's vocabulary, and how confidently. */
  mappedTo: z.string().nullable(),
  mappingStatus: mappingStatusSchema,
  /** Why the mapping has the status it has. Required for anything but `exact`. */
  mappingNote: z.string().default(''),
  /**
   * Whether this case is a positive (something really is broken/breaking) or a
   * negative control. A corpus with no `negative` records cannot support
   * precision, and `metrics.ts` checks this rather than trusting a flag.
   */
  polarity: z.enum(['positive', 'negative']),
});
export type ExternalTruth = z.infer<typeof externalTruthSchema>;

/** Why a case produced no scored result. Every excluded case carries one. */
export const exclusionKindSchema = z.enum([
  /** A tool, runtime or container the case needs is not present on this machine. Never a product result. */
  'environment-unavailable',
  /** The dataset's own reference to source that no longer exists. Marked, never substituted with today's HEAD. */
  'source-unavailable',
  /** The case could not be set up: install failed, checkout failed, the baseline did not behave as recorded. */
  'reproduction-failed',
  /** The dataset's label does not map onto anything Drift represents, so a comparison would not be meaningful. */
  'label-unmappable',
  /** Drift does not support this ecosystem or file type at the stage under test. A real, reportable product limit. */
  'out-of-scope-for-drift',
  /** Excluded by the run's own selection (limit/sample), not by anything about the case. */
  'not-selected',
]);
export type ExclusionKind = z.infer<typeof exclusionKindSchema>;

export const externalCaseResultSchema = z.object({
  schemaVersion: z.literal(EXTERNAL_RECORD_VERSION),
  caseId: z.string(),
  provenance: externalProvenanceSchema,
  truth: externalTruthSchema,
  /**
   * What Drift actually produced. Shapeless on purpose: an upstream-detection
   * dataset records breaking-change kinds, a consumer-impact dataset records a
   * verdict and impact sites, and inventing a union that covers both would
   * make every adapter fill in fields it has no answer for.
   */
  prediction: z.record(z.string(), z.unknown()),
  /**
   * Scored outcome per question. Absent keys mean the question was not asked of
   * this dataset — never that Drift got it wrong.
   */
  outcomes: z.object({
    /** Upstream BC detection: did Drift read a breaking change out of the evidence at all? */
    detectedBreaking: z.boolean().optional(),
    /** Upstream BC detection: was the kind right, under the declared mapping? */
    categoryCorrect: z.boolean().optional(),
    /** Consumer impact: did Drift see the dependency update? */
    detectedUpdate: z.boolean().optional(),
    /** Consumer impact: did Drift say this repository is affected? */
    identifiedAffected: z.boolean().optional(),
    /** Consumer impact: did Drift point at any consumer code? */
    localized: z.boolean().optional(),
    /** Consumer impact: did Drift tell a broken consumer it was safe? The one that matters most. */
    falseSafe: z.boolean().optional(),
    /** Repair: did a repair pass the dataset's own oracle? */
    repaired: z.boolean().optional(),
  }),
  /**
   * The raw binary prediction, for a dataset that has real negatives.
   *
   * Kept separate from `outcomes`, which record *correctness*. A confusion
   * matrix needs the prediction and the label as independent facts, and
   * deriving one from the other is how a correct rejection ends up counted as
   * a detection. Absent for datasets with no negative population, where a
   * confusion matrix would be undefined anyway.
   */
  predictedPositive: z.boolean().optional(),
  excluded: z
    .object({ kind: exclusionKindSchema, reason: z.string().min(1), missingRequirement: z.string().nullable() })
    .nullable(),
  durationMs: z.number(),
});
export type ExternalCaseResult = z.infer<typeof externalCaseResultSchema>;
