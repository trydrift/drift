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

const repairConclusionSchema = z.object({
  expectedAction: z.enum(['repair', 'abstain', 'no-repair-needed']),
  expectedChangedFiles: z.array(z.string()).default([]),
  goldPatch: z.string().optional(),
});

export const conclusionSchema = z.object({
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

export const adjudicationSchema = z.object({
  fixtureId: z.string(),
  acceptedReviewIds: z.array(z.string()).min(1),
  decision: conclusionSchema,
  status: z.enum(['accepted', 'unresolved']),
  decidedAt: z.string(),
  decidedBy: z.object({ type: z.enum(['human', 'ai']), name: z.string() }),
  notes: z.string(),
});
export type Adjudication = z.infer<typeof adjudicationSchema>;

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
