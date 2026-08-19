import { z } from 'zod';

/**
 * The prediction artifact: everything one adapter produced for one case, in
 * one trial, stored structured and replayable.
 *
 * This is what makes a live-AI benchmark honest. A Codex trial costs money and
 * cannot be re-run identically, so the trial's *output* has to be the durable
 * record — not a number computed from it at the time. Scoring reads artifacts,
 * never a live agent, so the evaluator can be fixed and every past trial
 * re-scored without paying again, and so ordinary CI can validate the
 * evaluator with zero model calls.
 *
 * Provenance is exhaustive on purpose. A result that cannot name the exact
 * model id, prompt hash, agent version, effort setting and trial index is not
 * reproducible, and a benchmark that reports it anyway is asserting more than
 * it knows. Anything the environment does not expose is recorded as the
 * literal string `unavailable` — never guessed, never omitted.
 */

export const ARTIFACT_SCHEMA_VERSION = 'drift-bench-prediction-v1';

/** The value every provenance field takes when the environment genuinely does not expose it. */
export const UNAVAILABLE = 'unavailable';

/** Which production path produced this. Never merged in a report. */
export const trackSchema = z.enum([
  /** Detection: real `analyzeRepository()` from repository revisions. The user-facing headline. */
  'detect-end-to-end',
  /** Detection: evidence -> analyze -> localize -> verdict from a known bump. Diagnostic isolation of downstream reasoning. */
  'detect-known-bump',
  /** Repair: built-in deterministic codemod (tier 1). */
  'repair-codemod',
  /** Repair: fix plan restored from cache, revalidated through the normal gate. */
  'repair-fixplan-cache',
  /** Repair: fix plan re-derived from a community recipe in the sandbox. */
  'repair-fixplan-recipe',
  /** Repair: fix plan authored by a live model, then validated and applied deterministically. */
  'repair-fixplan-model',
  /** Repair: coding agent through Drift's own FixAgent + worktree runner. */
  'repair-agent',
  /** Repair: the complete production hierarchy, Drift choosing its own tier. The headline repair result. */
  'repair-full-remediation',
]);
export type Track = z.infer<typeof trackSchema>;

/**
 * What kind of claim a track's result supports.
 *
 * `end-to-end` — the whole chain a user actually gets, from a dependency
 * update to a verdict or a migration. Only these results may be pooled into a
 * headline number.
 *
 * `conditional` — a capability question: *given* Drift routed the work to this
 * mechanism, could the mechanism do it? A standalone mechanism track is handed
 * commits the planner already chose, so its result says nothing about whether
 * Drift would have chosen it, and pooling it with end-to-end results would
 * report a ceiling as an outcome.
 *
 * `ablation` — a diagnostic that deliberately removes part of the pipeline to
 * isolate what the rest does. Never a product claim in either direction.
 *
 * This used to be a comment describing behaviour the code did not have: `base()`
 * stamped `end-to-end` on every artifact regardless of track, and the report
 * separated capability tracks by consulting `isPolicyScoped`, a set that exists
 * to answer a different question (who made the decision to act). The field is
 * now derived from the track by `experimentModeFor`, and the evaluator and the
 * report read the field.
 */
export const experimentModeSchema = z.enum(['end-to-end', 'conditional', 'ablation']);
export type ExperimentMode = z.infer<typeof experimentModeSchema>;

const provenanceSchema = z.object({
  driftCommit: z.string(),
  driftTreeDirty: z.boolean(),
  adapterVersion: z.string(),
  /** `unavailable` for every deterministic track — deterministic CI must show zero live calls. */
  agentId: z.string(),
  agentLabel: z.string(),
  provider: z.string(),
  model: z.string(),
  modelVersion: z.string(),
  agentCliVersion: z.string(),
  promptVersion: z.string(),
  promptHash: z.string(),
  effort: z.string(),
  fastMode: z.string(),
  /**
   * What the benchmark run asked for, kept strictly apart from the four fields
   * above, which record what was *confirmed*.
   *
   * A CLI coding agent resolves its own model and reasoning effort from its own
   * configuration when the flags are absent, so a requested value written into
   * `model` would attribute a result to a model that may never have run it.
   * Defaulted rather than required so artifacts written before this split still
   * parse and can still be re-scored — they simply have nothing to say here.
   */
  requestedAgentId: z.string().default(UNAVAILABLE),
  requestedModel: z.string().default(UNAVAILABLE),
  requestedEffort: z.string().default(UNAVAILABLE),
  requestedFastMode: z.string().default(UNAVAILABLE),
  requestedTimeoutSeconds: z.string().default(UNAVAILABLE),
  /** 1-indexed. Every trial is retained; none is ever discarded for losing. */
  trial: z.number().int().min(1),
  trialsPlanned: z.number().int().min(1),
  startedAt: z.string(),
  finishedAt: z.string(),
  latencyMs: z.number(),
  costUsd: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
});

const oracleStageArtifactSchema = z.object({
  stage: z.enum(['baseline', 'broken', 'repaired', 'full-ci']),
  expected: z.enum(['pass', 'fail']),
  observed: z.enum(['pass', 'fail', 'unable-to-run']),
  matchesExpectation: z.boolean(),
  /** Sorted diagnostic identities — the input to fail-to-pass analysis. */
  signature: z.array(z.string()),
  exitCode: z.number().nullable(),
  /** Truncated. Enough to diagnose, never the whole log. */
  outputExcerpt: z.string(),
  durationMs: z.number(),
});
export type OracleStageArtifact = z.infer<typeof oracleStageArtifactSchema>;

const detectionArtifactSchema = z.object({
  /** D0. Empty for known-bump tracks, which are *given* the change. */
  dependencyChanges: z.array(
    z.object({ name: z.string(), ecosystem: z.string(), from: z.string().nullable(), to: z.string().nullable(), workspace: z.string().optional() }),
  ),
  triageSkipped: z.array(z.object({ dependency: z.string(), reason: z.string() })),
  /** D1. The evidence layer's structured facts, by rule code — never prose. */
  upstreamFindings: z.array(
    z.object({ dependency: z.string(), workspace: z.string().optional(), code: z.string(), symbol: z.string(), detail: z.string() }),
  ),
  checkedSurfaces: z.array(z.object({ name: z.string(), status: z.string() })),
  /** D2. Every breaking change, with its own taxonomy — no `breakingChanges[0]` assumption anywhere. */
  breakingChanges: z.array(
    z.object({
      dependency: z.string(),
      workspace: z.string().optional(),
      kind: z.string(),
      symbols: z.array(z.string()),
      replacementSymbols: z.array(z.string()).default([]),
      summary: z.string(),
      citations: z.array(z.string()).default([]),
      taxonomy: z
        .object({ nature: z.string(), detectability: z.array(z.string()), scope: z.string(), visibility: z.array(z.string()) })
        .optional(),
      verdict: z.string(),
    }),
  ),
  /** D3. Structured, with the anchor fields both the symbol view and the line view need. */
  impactSites: z.array(
    z.object({
      breakingChangeKind: z.string(),
      file: z.string(),
      line: z.number(),
      matchedSymbol: z.string(),
      enclosingSymbol: z.string().optional(),
      excerpt: z.string(),
    }),
  ),
  gaps: z.array(z.string()),
  verificationOutcomes: z.array(z.object({ kind: z.string(), status: z.string() })),
  /** D4. The single user-facing verdict, chosen by the same precedence production uses. */
  verdict: z.string(),
});
export type DetectionArtifact = z.infer<typeof detectionArtifactSchema>;

/**
 * Why a repair did not happen, kept as a closed enum so "Drift correctly
 * declined" can never be silently pooled with "the agent timed out". Only
 * `abstained-by-policy` is a product decision; every other member is an
 * operational fact that must not be scored as either success or failure.
 */
export const repairNonOutcomeSchema = z.enum([
  'abstained-by-policy',
  'no-repairable-commit',
  'model-unavailable',
  /** No previously validated plan cache was supplied, so the cache tier had nothing to restore. */
  'cache-unavailable',
  /** No community recipe candidate was supplied, so the recipe tier had nothing to re-derive from. */
  'recipe-unavailable',
  'agent-unavailable',
  /**
   * The remediation hierarchy actually routed work to the agent tier and found
   * no agent there to route it to.
   *
   * Deliberately distinct from `agent-unavailable`, which means a standalone
   * agent track was asked to run without the CLI it exists to measure. This
   * one is a case Drift began and did not deliver, and it used to be recorded
   * as `abstained-by-policy` — a missing binary presented to a reader as a
   * considered product decision to decline.
   */
  'agent-required-unavailable',
  'agent-error',
  'agent-timeout',
  'patch-application-failed',
  'install-failed',
  'scope-validation-rejected',
  'empty-patch',
]);

const fixPlanArtifactSchema = z.object({
  /** Whether a proposal was produced at all, before any judgement of it. */
  proposal: z.enum(['produced', 'declined-not-applicable', 'malformed', 'errored', 'not-invoked']),
  proposalSource: z.string(),
  operations: z.array(z.object({ kind: z.string(), detail: z.string() })),
  /** Drift's real `validateFixPlan` verdict. The model proposes; the gate decides. */
  validation: z.enum(['accepted', 'partial', 'rejected', 'not-run']),
  rejections: z.array(z.string()),
  coveredSites: z.number(),
  residualSites: z.number(),
  policyDisposition: z.string(),
});

const repairArtifactSchema = z.object({
  attempted: z.boolean(),
  notAttemptedReason: repairNonOutcomeSchema.nullable(),
  /** Which tier actually resolved each commit, for the full-remediation track. */
  resolvedByTier: z.array(z.object({ commitId: z.string(), tier: z.string() })),
  patch: z.string(),
  changedFiles: z.array(z.string()),
  /** Files edited outside the plan's own `allowedFiles`. A production-safety failure. */
  scopeEscapeFiles: z.array(z.string()),
  scopeValidationReasons: z.array(z.string()),
  patchStats: z.object({ files: z.number(), hunks: z.number(), addedLines: z.number(), removedLines: z.number() }),
  residualImpactSites: z.number(),
  fixPlan: fixPlanArtifactSchema.optional(),
});
export type RepairArtifact = z.infer<typeof repairArtifactSchema>;

export const predictionArtifactSchema = z
  .object({
    schemaVersion: z.literal(ARTIFACT_SCHEMA_VERSION),
    runId: z.string(),
    caseId: z.string(),
    /**
     * Content hash of the WHOLE public capsule this prediction saw — consumer
     * source, before-manifest, both frozen upstream trees, frozen evidence,
     * lockfiles, `case.yml`. A later edit to any of it invalidates replay
     * rather than silently re-scoring against evidence the trial never saw.
     * See `eval/src/runs/capsule.ts`.
     */
    publicCapsuleHash: z.string().default(UNAVAILABLE),
    /**
     * Deprecated: a hash of `case.yml` alone, which is metadata and misses
     * every file that actually changes a prediction. Retained so artifacts
     * written before the capsule hash still parse and can still be read; it is
     * never what staleness is decided on.
     */
    publicCaseHash: z.string().optional(),
    track: trackSchema,
    experimentMode: experimentModeSchema,
    provenance: provenanceSchema,
    /** Proof the workspace handed to this prediction held no private material. */
    isolation: z.object({ audited: z.boolean(), pathsAudited: z.number(), networkPolicy: z.string() }),
    detection: detectionArtifactSchema.optional(),
    repair: repairArtifactSchema.optional(),
    oracleStages: z.array(oracleStageArtifactSchema).default([]),
    /** Observable agent transcript only. Model chain-of-thought is never persisted. */
    observedCommands: z.array(z.string()).default([]),
    error: z.string().nullable().default(null),
  })
  .strict();

export type PredictionArtifact = z.infer<typeof predictionArtifactSchema>;

/** A provenance block for a deterministic, model-free track — the shape that proves no live call happened. */
export function deterministicProvenance(input: {
  driftCommit: string;
  driftTreeDirty: boolean;
  adapterVersion: string;
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
}): z.infer<typeof provenanceSchema> {
  return {
    driftCommit: input.driftCommit,
    driftTreeDirty: input.driftTreeDirty,
    adapterVersion: input.adapterVersion,
    agentId: UNAVAILABLE,
    agentLabel: UNAVAILABLE,
    provider: UNAVAILABLE,
    model: UNAVAILABLE,
    modelVersion: UNAVAILABLE,
    agentCliVersion: UNAVAILABLE,
    promptVersion: UNAVAILABLE,
    promptHash: UNAVAILABLE,
    effort: UNAVAILABLE,
    fastMode: UNAVAILABLE,
    requestedAgentId: UNAVAILABLE,
    requestedModel: UNAVAILABLE,
    requestedEffort: UNAVAILABLE,
    requestedFastMode: UNAVAILABLE,
    requestedTimeoutSeconds: UNAVAILABLE,
    trial: 1,
    trialsPlanned: 1,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    latencyMs: input.latencyMs,
    costUsd: 0,
    inputTokens: null,
    outputTokens: null,
  };
}

/**
 * The experiment mode a track's results belong to.
 *
 * Exhaustive over `Track` by construction, so adding a track is a compile
 * error here rather than a silent `end-to-end` default — which is precisely
 * how a capability number would end up in a headline.
 */
export function experimentModeFor(track: Track): ExperimentMode {
  switch (track) {
    // The user-facing chain: real `analyzeRepository()` from repository
    // revisions, and the complete remediation hierarchy with Drift choosing
    // its own tier.
    case 'detect-end-to-end':
    case 'repair-full-remediation':
      return 'end-to-end';
    // Detection with the dependency update supplied rather than discovered:
    // everything upstream of evidence gathering is removed on purpose.
    case 'detect-known-bump':
      return 'ablation';
    // Standalone mechanism tracks. Each is pointed at commits the production
    // planner already routed, so each answers "could this mechanism do it",
    // never "would Drift have used it".
    case 'repair-codemod':
    case 'repair-fixplan-cache':
    case 'repair-fixplan-recipe':
    case 'repair-fixplan-model':
    case 'repair-agent':
      return 'conditional';
  }
}

/** True when this artifact records a live model or agent call. Used to assert deterministic CI made none. */
export function isLiveTrial(artifact: PredictionArtifact): boolean {
  return artifact.provenance.model !== UNAVAILABLE || artifact.provenance.agentId !== UNAVAILABLE;
}

/** Counts files/hunks/lines from a unified diff. Pure, so patch-size reporting cannot disagree between tracks. */
export function patchStatsOf(patch: string): { files: number; hunks: number; addedLines: number; removedLines: number } {
  let files = 0;
  let hunks = 0;
  let addedLines = 0;
  let removedLines = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) files += 1;
    else if (line.startsWith('@@')) hunks += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) addedLines += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removedLines += 1;
  }
  return { files, hunks, addedLines, removedLines };
}
