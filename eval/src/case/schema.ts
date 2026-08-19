import { z } from 'zod';

/**
 * The benchmark case schema — the immutable, reproducible description of one
 * dependency update, split into a PUBLIC half and a PRIVATE half.
 *
 * The split is the load-bearing part, and it is a correction of the previous
 * design rather than an addition to it. Previously `fullPipelinePrediction`
 * received the `Adjudication` object directly, and a fixture's `expected/`
 * directory sat inside the same tree an adapter walked. Neither was exploited,
 * but both are the wrong boundary: the moment a coding agent with shell access
 * runs inside that tree — which is exactly what the R3 track does — "the
 * adapter didn't happen to read it" stops being a property of the benchmark
 * and becomes a property of a model's behaviour.
 *
 * So: a prediction adapter is handed a `PublicCase` and a materialized
 * workspace that provably contains no private material. `PrivateTruth` — the
 * adjudicated findings, the developer's own migration patch, benchmark-added
 * oracles, expected changed files — is loaded only by the evaluator, from a
 * sibling directory that is never mounted into a prediction workspace.
 *
 * Field selection follows BUMP (arXiv:2401.09906) for reproduction metadata
 * and Defects4J for revision/environment pinning, adapted to npm: BUMP freezes
 * a Docker image pair per update, which is the right idea and the wrong
 * artifact for a Node corpus, where the equivalent frozen state is
 * {consumer commit, lockfile, resolved graph, package tarball digests,
 * toolchain versions}. See docs/research/evaluation.md.
 */

export const CASE_SCHEMA_VERSION = 'drift-bench-case-v1';

/**
 * Every terminal state a case can be in. `benchmark-ready` is the only one
 * that contributes to headline metrics; every other value is reported in the
 * exclusion table with its count. Nothing is ever silently dropped — that is
 * the whole reason this is an enum rather than a boolean.
 */
export const caseStatusSchema = z.enum([
  /** Mined, nothing verified yet. */
  'candidate',
  /** Reproduction checks are running or incomplete. */
  'reproducibility-check',
  /** Fully verified, reviewed, adjudicated, non-stale. Scored. */
  'benchmark-ready',
  /** Reviewers disagree on a field and adjudication could not resolve it. */
  'disputed',
  /** Reproduction outcomes differed across repetitions. */
  'flaky',
  /** The pre-update state does not satisfy its own baseline oracle. */
  'invalid-baseline',
  /** The failure is not attributable to the dependency update. */
  'non-causal',
  /** No oracle can distinguish repaired from broken for this case. */
  'oracle-insufficient',
  /** A toolchain/registry/container the case needs was unavailable here. */
  'environment-unavailable',
  /** Public evidence changed after the accepted review inspected it. */
  'excluded-stale',
]);
export type CaseStatus = z.infer<typeof caseStatusSchema>;

/**
 * How a case's failure manifests. Taken from BUMP's failure categories,
 * dropped where Maven-specific (enforcer) and extended where npm needs it
 * (`type-check-failure` is distinct from `compile-failure` because a
 * TypeScript consumer can typecheck-fail while its JavaScript still runs, and
 * a benchmark that conflates them cannot tell a `tsc`-only tool from Drift).
 */
export const failureCategorySchema = z.enum([
  'dependency-resolution-failure',
  'install-failure',
  'type-check-failure',
  'compile-failure',
  'test-failure',
  'runtime-failure',
  'lockfile-failure',
  /** A negative/control case: nothing fails, and nothing should. */
  'none',
]);
export type FailureCategory = z.infer<typeof failureCategorySchema>;

/**
 * A benchmark-only stratification dimension, orthogonal to Drift's own
 * production taxonomy, adapted from DepBench's migration categories
 * (arXiv:2607.17957). It exists to stratify results — "Drift repairs
 * mechanical renames well and paradigm shifts not at all" is a far more useful
 * sentence than one pooled percentage — and never to drive product behaviour.
 */
export const migrationComplexitySchema = z.enum([
  /** One symbol for another, no restructuring. */
  'direct',
  /** The symbol survives but moves: entry point, subpath, ESM/CJS, default vs named. */
  'import-migration',
  /** Several coordinated edits that are only correct together. */
  'compound',
  /** The consumer's own control flow or architecture must change. */
  'paradigm-shift',
  /** No migration is required (negative/control case). */
  'none',
]);
export type MigrationComplexity = z.infer<typeof migrationComplexitySchema>;

const oracleCommandSchema = z.object({
  command: z.string().min(1),
  expect: z.enum(['pass', 'fail']),
  /**
   * `project-native` — the consumer's own check, the only kind that can
   * support a claim about real-world behaviour. `benchmark-added` — an oracle
   * this benchmark wrote because the project's own tests were too weak to
   * expose a real behavioural break. The distinction is mandatory and is
   * surfaced in every report: a benchmark-added oracle is an assertion *this
   * project* made about correctness, and must be independently reviewed
   * before it can gate anything.
   */
  provenance: z.enum(['project-native', 'benchmark-added']).default('project-native'),
});

const resolvedPackageSchema = z.object({
  name: z.string(),
  version: z.string(),
  /** Registry integrity string where the lockfile records one. Never invented. */
  integrity: z.string().optional(),
});

/**
 * A one-line manifest bump is not a one-package change. BUMP found a median of
 * 2 effective dependency changes per breaking update, with transitive ripple
 * in 316 of 571 cases; a benchmark that records only the direct bump cannot
 * later tell whether Drift missed the direct break or was defeated by a
 * transitive one it never saw.
 */
const dependencyGraphSchema = z.object({
  before: z.array(resolvedPackageSchema),
  after: z.array(resolvedPackageSchema),
  /** Packages whose resolved version differs, direct bump included. Derived, then stored, so a report never has to recompute it. */
  effectiveChanges: z.array(
    z.object({ name: z.string(), from: z.string().nullable(), to: z.string().nullable() }),
  ),
});

const environmentSchema = z.object({
  /** e.g. `v22.16.0`. Preserved from the project (`.nvmrc`, `engines`) where it states one. */
  runtimeVersion: z.string(),
  packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun', 'maven', 'cargo', 'pip', 'other']),
  packageManagerVersion: z.string(),
  /** Container digest when one is used. `unavailable` when the case runs on the host toolchain. */
  containerDigest: z.string(),
  platform: z.string(),
  arch: z.string(),
  /** Locale/timezone pinning, because both change test outcomes and neither is obvious when they do. */
  timezone: z.string(),
  locale: z.string(),
});

export const publicCaseSchema = z
  .object({
    schemaVersion: z.literal(CASE_SCHEMA_VERSION),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    provenanceKind: z.enum(['synthetic', 'historical']),
    ecosystem: z.string(),
    status: caseStatusSchema,
    /** Present iff `status` is not `benchmark-ready`. Machine-checked in `validateCase`. */
    statusReason: z.string().optional(),

    consumer: z.object({
      repository: z.string(),
      licence: z.string(),
      /** The revision immediately before the migration. Immutable. */
      baseCommit: z.string(),
      /** The real migration commit, when the case is historical and one exists. */
      migrationCommit: z.string().nullable(),
      manifestPaths: z.array(z.string()).min(1),
      lockfilePaths: z.array(z.string()),
      /** Workspace member directory this update lands in, `''` for a single-package repo. */
      workspaceDir: z.string().default(''),
    }),

    dependency: z.object({
      name: z.string(),
      /** Exact resolved versions, never a range: a range makes the case non-reproducible the day the registry moves. */
      fromVersion: z.string(),
      toVersion: z.string(),
      updateClass: z.enum(['major', 'minor', 'patch', 'other']),
      section: z.enum(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']),
      exposure: z.enum(['direct', 'transitive']),
      /** Upstream repo/tag provenance where discoverable. `unavailable`, never guessed. */
      upstreamRepository: z.string(),
      upstreamFromRef: z.string(),
      upstreamToRef: z.string(),
    }),

    graph: dependencyGraphSchema,
    environment: environmentSchema,

    oracles: z.object({
      install: z.string(),
      baseline: oracleCommandSchema,
      broken: oracleCommandSchema,
      repaired: oracleCommandSchema,
      /** The project's own CI workflow, when it can be reproduced. Stronger and slower; opt-in per run. */
      fullCi: oracleCommandSchema.optional(),
    }),

    /**
     * What the prediction workspace is allowed to reach. `disabled` means the
     * capsule must satisfy every install offline; `agent-service-only` is the
     * strongest policy a live coding-agent trial can honestly claim, since the
     * agent must reach its own provider.
     */
    networkPolicy: z.enum(['disabled', 'agent-service-only', 'allowed']),

    discovery: z.object({
      source: z.enum(['synthetic', 'migration-pr', 'ncu-sweep', 'imported-corpus']),
      /** The PR/commit this case was derived from, when historical. */
      reference: z.string(),
      minedAt: z.string(),
      minerVersion: z.string(),
      /** Corpus this case was imported from, e.g. `swe-bump-bench`. `''` when mined here. */
      importedFrom: z.string().default(''),
    }),

    failureCategory: failureCategorySchema,
    migrationComplexity: migrationComplexitySchema,

    /**
     * Content hashes of every frozen public artifact. A change to any of these
     * stales the case's reviews (see `eval/src/hash.ts`'s existing staleness
     * discipline, which this extends rather than replaces).
     */
    artifactHashes: z.object({
      consumerTree: z.string(),
      upstreamOld: z.string(),
      upstreamNew: z.string(),
      lockfileBefore: z.string(),
      lockfileAfter: z.string(),
      evidenceBundle: z.string(),
    }),
  })
  .strict();

export type PublicCase = z.infer<typeof publicCaseSchema>;

/**
 * Everything a prediction must never see.
 *
 * Note what is *not* here: the adjudicated finding set still lives in the
 * existing `reviews/` + `adjudication.yml` records, which this schema
 * references by id rather than duplicating. Two copies of ground truth is how
 * ground truth starts disagreeing with itself.
 */
export const privateTruthSchema = z
  .object({
    schemaVersion: z.literal(CASE_SCHEMA_VERSION),
    caseId: z.string(),
    /** Adjudication record id in the private tree. Scoring resolves truth through this, never through a review directly. */
    adjudicationRef: z.string(),
    /**
     * The developer's own migration diff, when the case is historical.
     * Evidence of *one* valid repair, explicitly not the definition of
     * correctness — `repairGoldPatchExact` stays a diagnostic, never a gate.
     */
    developerPatch: z.string().nullable(),
    /** Files the developer patch touched, separated from lockfile/manifest churn. */
    developerPatchFiles: z.array(z.string()).default([]),
    /** Oracle commands added by this benchmark, kept out of the public case so a repair cannot be written against them. */
    hiddenOracles: z.array(oracleCommandSchema).default([]),
    /**
     * The recorded failure signature of the bump-only state, from the
     * reproducibility gate. Used to require that a repair resolves *these*
     * failures rather than merely producing a green build.
     */
    triggerSignature: z.array(z.string()).default([]),
    baselineSignature: z.array(z.string()).default([]),
    notes: z.string().default(''),
  })
  .strict();

export type PrivateTruth = z.infer<typeof privateTruthSchema>;

/**
 * Structural invariants a schema alone cannot express. Returns reasons rather
 * than throwing so a corpus-wide validation can report every problem in one
 * pass instead of stopping at the first.
 */
export function validateCase(publicCase: PublicCase): string[] {
  const reasons: string[] = [];

  if (publicCase.status !== 'benchmark-ready' && !publicCase.statusReason) {
    reasons.push(`${publicCase.id}: status ${publicCase.status} requires a statusReason.`);
  }
  if (publicCase.status === 'benchmark-ready' && publicCase.statusReason) {
    reasons.push(`${publicCase.id}: benchmark-ready cases must not carry a statusReason.`);
  }

  for (const [label, version] of [
    ['fromVersion', publicCase.dependency.fromVersion],
    ['toVersion', publicCase.dependency.toVersion],
  ] as const) {
    if (/[\^~*x><|\s]/.test(version)) {
      reasons.push(`${publicCase.id}: dependency.${label} must be an exact resolved version, got "${version}".`);
    }
  }

  // A negative/control case is defined by its failure category, and its broken
  // oracle must agree: a case claiming `failureCategory: none` while expecting
  // its bump-only state to fail is internally contradictory, and would be
  // scored as a successful repair of nothing.
  if (publicCase.failureCategory === 'none' && publicCase.oracles.broken.expect === 'fail') {
    reasons.push(`${publicCase.id}: failureCategory "none" contradicts oracles.broken.expect "fail".`);
  }
  if (publicCase.failureCategory !== 'none' && publicCase.oracles.broken.expect === 'pass') {
    reasons.push(
      `${publicCase.id}: failureCategory "${publicCase.failureCategory}" contradicts oracles.broken.expect "pass".`,
    );
  }
  if (publicCase.failureCategory === 'none' && publicCase.migrationComplexity !== 'none') {
    reasons.push(`${publicCase.id}: a case with no failure cannot have migrationComplexity "${publicCase.migrationComplexity}".`);
  }

  if (publicCase.provenanceKind === 'historical' && publicCase.consumer.baseCommit.length < 7) {
    reasons.push(`${publicCase.id}: a historical case needs a real consumer.baseCommit.`);
  }

  const graphNames = new Set(publicCase.graph.effectiveChanges.map((c) => c.name));
  if (publicCase.graph.effectiveChanges.length > 0 && !graphNames.has(publicCase.dependency.name)) {
    reasons.push(
      `${publicCase.id}: the direct dependency ${publicCase.dependency.name} is absent from graph.effectiveChanges.`,
    );
  }

  return reasons;
}
