import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { hashFixtureRevision, type FixtureHashes } from './hash.ts';
import type { EvalFixture } from './load.ts';

/**
 * Review and adjudication records.
 *
 * A FIXTURE is scenario/evidence. A REVIEW is one reviewer's opinion of that
 * evidence, persisted and never overwritten. An ADJUDICATION is the currently
 * accepted benchmark truth, which references the review(s) it accepts.
 * Scoring reads only adjudications; it never reads a review directly and
 * never reads a fixture's own metadata as ground truth.
 */

const taxonomySchema = z.object({
  nature: z.string(),
  detectability: z.array(z.string()),
  scope: z.string(),
  visibility: z.array(z.string()),
});

/**
 * What a reviewer says Drift is entitled to do about this case.
 *
 * Four values rather than three, because `repair | abstain | no-repair-needed`
 * cannot express the most common honest answer to a real migration: "a
 * deterministic rule cannot be derived from this evidence, but handing it to a
 * coding agent behind human review is the right product behaviour". Scored
 * under the old enum, that case punished Drift twice — the codemod tier was
 * charged a `missed-opportunity` for not guessing, and the full hierarchy was
 * charged an `unsafe-attempt` for doing exactly what the product is designed
 * to do. Neither charge described a defect.
 *
 * - `deterministic-repair` — the evidence supports a mechanical, model-free
 *   fix, and a tier that declines has missed something it should have caught.
 * - `agent-delegation` — no deterministic rule is derivable, and delegating to
 *   an agent under approval is correct. A deterministic tier that declines is
 *   right; a deterministic tier that acts anyway is not.
 * - `abstain` — nothing automated should touch this, agent included.
 * - `no-repair-needed` — nothing is broken.
 */
const expectedActionSchema = z.enum(['deterministic-repair', 'agent-delegation', 'abstain', 'no-repair-needed']);
export type ExpectedAction = z.infer<typeof expectedActionSchema>;

const repairConclusionSchema = z.object({
  expectedAction: expectedActionSchema,
  expectedChangedFiles: z.array(z.string()).default([]),
  goldPatch: z.string().optional(),
});

export const conclusionSchema = z.object({
  /**
   * D0 — the dependency updates a reviewer says a manifest diff should find,
   * as `ecosystem:name[@workspace]:from->to`.
   *
   * Optional, and absent means "no reviewer ruled on this level", which the
   * evaluator reports as `not-adjudicated` and scores in nothing. It is
   * deliberately not defaulted to `[]`: an empty array is itself a claim —
   * "there is no dependency update here" — and is how a control case
   * correctly punishes a false positive. Conflating the two would score every
   * unreviewed level as a perfect prediction of nothing.
   */
  dependencyChanges: z.array(z.string()).optional(),
  /**
   * D1 — upstream facts as the evidence layer states them, as
   * `dependency:code:symbol` using the provider's own rule code.
   *
   * Distinct from `upstreamFindings` below, which despite its name records an
   * *interpretation* (`dependency:symbol:kind`, naming a `BreakingChangeKind`)
   * and therefore scores D2. The two are separated because "Drift never
   * fetched the evidence" and "Drift fetched it and classified it wrongly" are
   * different defects in different modules.
   */
  evidenceFindings: z.array(z.string()).optional(),
  upstreamFindings: z.array(z.string()),
  impactSites: z.array(z.string()),
  taxonomy: taxonomySchema.optional(),
  gaps: z.array(z.string()),
  /**
   * The reviewer's explicit judgement of whether accepted truth is safe.
   * Never derived silently from impact-site counts: a reviewer states it, and
   * `validateAdjudication` below checks it isn't self-contradictory.
   */
  groundTruthSafety: z.enum(['safe', 'unsafe', 'uncertain']),
  repair: repairConclusionSchema,
});
export type Conclusion = z.infer<typeof conclusionSchema>;

const reviewerSchema = z.object({
  type: z.enum(['human', 'ai']),
  name: z.string(),
  /** Unavailable metadata is the literal string "unavailable", never omitted. */
  provider: z.string(),
  model: z.string(),
  modelVersion: z.string(),
  toolVersion: z.string(),
});

const reviewedRevisionSchema = z.object({
  fixtureMetadata: z.string(),
  upstreamOld: z.string(),
  upstreamNew: z.string(),
  consumer: z.string(),
  oracles: z.string(),
  goldPatch: z.string(),
  /** The benchmark-added hidden behavioural checks this reviewer saw. `sha256('')` when the fixture had none. */
  hiddenChecks: z.string(),
});

export const reviewSchema = z.object({
  id: z.string(),
  fixtureId: z.string(),
  createdAt: z.string(),
  reviewer: reviewerSchema,
  reviewedRevision: reviewedRevisionSchema,
  evidence: z.object({
    files: z.array(z.string()),
    commands: z.array(z.string()),
    artifacts: z.array(z.string()),
    notes: z.string(),
  }),
  conclusion: conclusionSchema,
  rationale: z.object({
    summary: z.string(),
    findingNotes: z.array(z.string()),
    uncertainty: z.string(),
  }),
  status: z.enum(['reviewed', 'disputed', 'superseded', 'withdrawn']),
  reviewOf: z.array(z.string()).default([]),
  promptVersion: z.string(),
  promptHash: z.string(),
});
export type Review = z.infer<typeof reviewSchema>;

/**
 * Records that adjudication deliberately diverges from its accepted review(s)
 * — see `diffConclusions`/`validateAdjudicationConsistency` below. Machine
 * checked: `changedFields` must exactly match the fields that actually
 * differ, no more (an unexplained delta) and no less (a stale/inaccurate
 * justification).
 */
const overrideSchema = z.object({
  enabled: z.literal(true),
  reason: z.string().min(1),
  changedFields: z.array(z.string()).min(1),
});

const synthesisSchema = z.object({
  reason: z.string().min(1),
  changedFields: z.array(z.string()),
});

export const adjudicationSchema = z.object({
  fixtureId: z.string(),
  acceptedReviewIds: z.array(z.string()).min(1),
  decision: conclusionSchema,
  status: z.enum(['accepted', 'unresolved']),
  decidedAt: z.string(),
  decidedBy: z.object({ type: z.enum(['human', 'ai']), name: z.string() }),
  notes: z.string(),
  /** Required when `decision` differs from a single accepted review's conclusion. */
  override: overrideSchema.optional(),
  /** Required when `decision` differs from any of multiple accepted reviews' conclusions. */
  synthesis: synthesisSchema.optional(),
});
export type Adjudication = z.infer<typeof adjudicationSchema>;
export type AdjudicationOverride = z.infer<typeof overrideSchema>;
export type AdjudicationSynthesis = z.infer<typeof synthesisSchema>;

export function fixtureDir(fixtureId: string, root = join(process.cwd(), 'eval', 'fixtures')): string {
  return join(root, fixtureId);
}

export async function loadReviews(fixtureId: string, root?: string): Promise<Review[]> {
  const dir = join(fixtureDir(fixtureId, root), 'reviews');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const reviews: Review[] = [];
  for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith('.yml')).sort((a, b) => a.name.localeCompare(b.name))) {
    const body = await readFile(join(dir, entry.name), 'utf8');
    const parsed = reviewSchema.parse(YAML.parse(body));
    if (parsed.fixtureId !== fixtureId) {
      throw new Error(`Review ${entry.name} declares fixtureId ${parsed.fixtureId}, expected ${fixtureId}.`);
    }
    reviews.push(parsed);
  }
  return reviews;
}

export async function saveReview(review: Review, root?: string): Promise<string> {
  const dir = join(fixtureDir(review.fixtureId, root), 'reviews');
  const path = join(dir, `${review.id}.yml`);
  if (await fileExists(path)) {
    throw new Error(`Review ${review.id} already exists at ${path}; reviews are append-only, never overwritten.`);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(path, YAML.stringify(reviewSchema.parse(review)), 'utf8');
  return path;
}

export async function loadAdjudication(fixtureId: string, root?: string): Promise<Adjudication | null> {
  const path = join(fixtureDir(fixtureId, root), 'adjudication.yml');
  try {
    const body = await readFile(path, 'utf8');
    return adjudicationSchema.parse(YAML.parse(body));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveAdjudication(adjudication: Adjudication, root?: string): Promise<string> {
  const path = join(fixtureDir(adjudication.fixtureId, root), 'adjudication.yml');
  await writeFile(path, YAML.stringify(adjudicationSchema.parse(adjudication)), 'utf8');
  return path;
}

export interface StalenessResult {
  stale: boolean;
  current: FixtureHashes;
  mismatched: (keyof FixtureHashes)[];
}

/** A review only applies to the exact fixture revision it inspected. */
export async function checkStaleness(review: Pick<Review, 'reviewedRevision'>, fixtureId: string, root?: string): Promise<StalenessResult> {
  const dir = fixtureDir(fixtureId, root);
  const body = await readFile(join(dir, 'fixture.yml'), 'utf8');
  const current = await hashFixtureRevision(dir, body);
  const mismatched = (Object.keys(current) as (keyof FixtureHashes)[]).filter(
    (key) => current[key] !== review.reviewedRevision[key],
  );
  return { stale: mismatched.length > 0, current, mismatched };
}

/**
 * Structural consistency invariants for a decision (review conclusion or
 * adjudication decision), independent of the fixture it's about. Catches a
 * self-contradictory ground-truth call before it ever reaches scoring.
 */
export function validateConclusion(conclusion: Conclusion): string[] {
  const problems: string[] = [];

  if (conclusion.groundTruthSafety === 'unsafe') {
    const supported =
      conclusion.impactSites.length > 0 ||
      conclusion.gaps.length > 0 ||
      conclusion.repair.expectedAction !== 'no-repair-needed';
    if (!supported) {
      problems.push(
        "groundTruthSafety is 'unsafe' but nothing supports it: impactSites is empty, gaps is empty, and repair.expectedAction is 'no-repair-needed'.",
      );
    }
  }

  if (conclusion.groundTruthSafety === 'safe' && conclusion.impactSites.length > 0) {
    problems.push("groundTruthSafety is 'safe' but impactSites is non-empty.");
  }

  return problems;
}

/** The `Conclusion` fields `diffConclusions`/adjudication-consistency checking can name. */
export type ConclusionField =
  | 'dependencyChanges'
  | 'evidenceFindings'
  | 'upstreamFindings'
  | 'impactSites'
  | 'taxonomy'
  | 'gaps'
  | 'groundTruthSafety'
  | 'repair.expectedAction'
  | 'repair.expectedChangedFiles'
  | 'repair.goldPatch';

/** Set equality that keeps "unstated" and "stated as empty" distinct. */
function sameOptionalSet(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return sameSet(a, b);
}

/** Order-insensitive equality for a field that is semantically a set. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const as = [...new Set(a)].sort();
  const bs = [...new Set(b)].sort();
  return as.length === bs.length && as.every((value, i) => value === bs[i]);
}

/**
 * Canonical taxonomy equality: `detectability`/`visibility` are sets
 * (ordering never matters), `nature`/`scope` compare exactly. Shared by
 * scoring (a prediction's taxonomy vs. adjudicated truth) and adjudication
 * consistency (adjudication's taxonomy vs. an accepted review's).
 */
export function sameTaxonomy(
  a: Conclusion['taxonomy'] | undefined,
  b: Conclusion['taxonomy'] | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.nature === b.nature && a.scope === b.scope && sameSet(a.detectability, b.detectability) && sameSet(a.visibility, b.visibility);
}

/**
 * The `Conclusion` fields that differ between two conclusions, after
 * canonical (order-insensitive, set-based where appropriate) normalization.
 * `repair.expectedAction` and `repair.goldPatch` compare exactly — a policy
 * decision or a gold-patch path is never a set.
 */
export function diffConclusions(a: Conclusion, b: Conclusion): ConclusionField[] {
  const changed: ConclusionField[] = [];
  // `undefined` vs `[]` is a real difference at these two levels — see the
  // schema comment — so they are compared as optionals rather than coerced.
  if (!sameOptionalSet(a.dependencyChanges, b.dependencyChanges)) changed.push('dependencyChanges');
  if (!sameOptionalSet(a.evidenceFindings, b.evidenceFindings)) changed.push('evidenceFindings');
  if (!sameSet(a.upstreamFindings, b.upstreamFindings)) changed.push('upstreamFindings');
  if (!sameSet(a.impactSites, b.impactSites)) changed.push('impactSites');
  if (!sameTaxonomy(a.taxonomy, b.taxonomy)) changed.push('taxonomy');
  if (!sameSet(a.gaps, b.gaps)) changed.push('gaps');
  if (a.groundTruthSafety !== b.groundTruthSafety) changed.push('groundTruthSafety');
  if (a.repair.expectedAction !== b.repair.expectedAction) changed.push('repair.expectedAction');
  if (!sameSet(a.repair.expectedChangedFiles, b.repair.expectedChangedFiles)) changed.push('repair.expectedChangedFiles');
  if ((a.repair.goldPatch ?? null) !== (b.repair.goldPatch ?? null)) changed.push('repair.goldPatch');
  return changed;
}

/**
 * Provenance gate: an adjudication cannot silently contradict the review(s)
 * it claims to accept.
 *
 * One accepted review — adjudication must equal it exactly, unless an
 * `override` is recorded whose `changedFields` exactly matches the fields
 * that actually differ (no missing field, no field that doesn't actually
 * differ).
 *
 * Multiple accepted reviews — adjudication may synthesize between them, but
 * any field where adjudication differs from *any* accepted review must be
 * named in `synthesis.changedFields`, exactly.
 */
export function validateAdjudicationConsistency(adjudication: Adjudication, acceptedReviews: readonly Review[]): string[] {
  const problems: string[] = [];
  if (acceptedReviews.length === 0) return problems;

  if (acceptedReviews.length === 1) {
    const review = acceptedReviews[0]!;
    const changed = diffConclusions(review.conclusion, adjudication.decision);

    if (changed.length === 0) {
      if (adjudication.override) {
        problems.push(
          `adjudication declares an override, but its decision does not differ from the single accepted review '${review.id}' in any field.`,
        );
      }
      return problems;
    }

    if (!adjudication.override) {
      problems.push(
        `adjudication decision differs from its single accepted review '${review.id}' in [${changed.join(', ')}] with no override metadata recorded.`,
      );
      return problems;
    }

    const declared = new Set(adjudication.override.changedFields);
    const actual = new Set(changed);
    const missing = changed.filter((field) => !declared.has(field));
    const extra = [...declared].filter((field) => !actual.has(field as ConclusionField));
    if (missing.length > 0) {
      problems.push(`adjudication override.changedFields is missing actually-differing field(s): ${missing.join(', ')}`);
    }
    if (extra.length > 0) {
      problems.push(
        `adjudication override.changedFields lists field(s) that do not actually differ from review '${review.id}': ${extra.join(', ')}`,
      );
    }
    return problems;
  }

  // Multiple accepted reviews: adjudication may legitimately differ from any
  // one of them (that's the whole point of synthesis), but every field where
  // it differs from at least one accepted review must be named.
  const unionChanged = new Set<string>();
  for (const review of acceptedReviews) {
    for (const field of diffConclusions(review.conclusion, adjudication.decision)) unionChanged.add(field);
  }

  if (unionChanged.size === 0) {
    if (adjudication.synthesis) {
      problems.push('adjudication declares synthesis metadata, but its decision does not differ from any accepted review in any field.');
    }
    return problems;
  }

  if (!adjudication.synthesis) {
    problems.push(
      `adjudication decision differs from at least one accepted review in [${[...unionChanged].sort().join(', ')}] with no synthesis metadata recorded.`,
    );
    return problems;
  }

  const declared = new Set(adjudication.synthesis.changedFields);
  const missing = [...unionChanged].filter((field) => !declared.has(field));
  const extra = [...declared].filter((field) => !unionChanged.has(field));
  if (missing.length > 0) {
    problems.push(`adjudication synthesis.changedFields is missing actually-differing field(s): ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    problems.push(`adjudication synthesis.changedFields lists field(s) that do not actually differ from any accepted review: ${extra.join(', ')}`);
  }
  return problems;
}

export function stableReviewId(reviewerName: string, dateIso: string, suffix: string): string {
  const slug = reviewerName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const date = dateIso.slice(0, 10);
  return `${slug}-${date}-${suffix}`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export type { EvalFixture };
