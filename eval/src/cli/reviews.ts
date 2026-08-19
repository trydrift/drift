import { checkStaleness, loadAdjudication, loadReviews, type Review } from '../review.ts';

export interface ReviewsSummary {
  fixtureId: string;
  reviews: {
    id: string;
    reviewerType: string;
    reviewerName: string;
    provider: string;
    model: string;
    status: string;
    createdAt: string;
    stale: boolean;
    reviewOf: string[];
  }[];
  adjudication: {
    status: string;
    acceptedReviewIds: string[];
    decidedBy: { type: string; name: string };
    decidedAt: string;
  } | null;
  disagreements: {
    field: 'upstreamFindings' | 'impactSites' | 'taxonomy' | 'gaps' | 'expectedAction' | 'expectedChangedFiles';
    reviewIds: string[];
    values: unknown[];
  }[];
}

export async function summarizeReviews(fixtureId: string, root?: string): Promise<ReviewsSummary> {
  const reviews = await loadReviews(fixtureId, root);
  const adjudication = await loadAdjudication(fixtureId, root);

  const staleness = await Promise.all(reviews.map((r) => checkStaleness(r, fixtureId, root)));

  const disagreements = fieldsToCompare().flatMap((field) => {
    const distinctValues = new Map<string, { review: Review; value: unknown }[]>();
    for (const review of reviews) {
      const value = fieldValue(review, field);
      const key = JSON.stringify(value);
      const list = distinctValues.get(key) ?? [];
      list.push({ review, value });
      distinctValues.set(key, list);
    }
    if (distinctValues.size <= 1) return [];
    return [
      {
        field,
        reviewIds: reviews.map((r) => r.id),
        values: [...distinctValues.values()].map((list) => list[0]!.value),
      },
    ];
  });

  return {
    fixtureId,
    reviews: reviews.map((r, i) => ({
      id: r.id,
      reviewerType: r.reviewer.type,
      reviewerName: r.reviewer.name,
      provider: r.reviewer.provider,
      model: r.reviewer.model,
      status: r.status,
      createdAt: r.createdAt,
      stale: staleness[i]!.stale,
      reviewOf: r.reviewOf,
    })),
    adjudication: adjudication
      ? {
          status: adjudication.status,
          acceptedReviewIds: adjudication.acceptedReviewIds,
          decidedBy: adjudication.decidedBy,
          decidedAt: adjudication.decidedAt,
        }
      : null,
    disagreements,
  };
}

function fieldsToCompare(): ReviewsSummary['disagreements'][number]['field'][] {
  return ['upstreamFindings', 'impactSites', 'taxonomy', 'gaps', 'expectedAction', 'expectedChangedFiles'];
}

function fieldValue(review: Review, field: ReviewsSummary['disagreements'][number]['field']): unknown {
  switch (field) {
    case 'upstreamFindings':
      return [...review.conclusion.upstreamFindings].sort();
    case 'impactSites':
      return [...review.conclusion.impactSites].sort();
    case 'taxonomy':
      return review.conclusion.taxonomy ?? null;
    case 'gaps':
      return [...review.conclusion.gaps].sort();
    case 'expectedAction':
      return review.conclusion.repair.expectedAction;
    case 'expectedChangedFiles':
      return [...review.conclusion.repair.expectedChangedFiles].sort();
  }
}

export async function runReviewsCli(argv = process.argv.slice(2)): Promise<number> {
  const fixtureId = argv.find((a) => !a.startsWith('--'));
  if (!fixtureId) {
    console.error('usage: npm run eval:reviews -- <fixture-id> [--json]');
    return 1;
  }
  const summary = await summarizeReviews(fixtureId);

  if (argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  console.log(`Reviews for ${fixtureId}:`);
  for (const r of summary.reviews) {
    console.log(
      `  ${r.id} — ${r.reviewerType}:${r.reviewerName} (${r.provider}/${r.model}) — ${r.status}${r.stale ? ' [STALE]' : ''}${r.reviewOf.length ? ` (supersedes ${r.reviewOf.join(', ')})` : ''}`,
    );
  }
  console.log(
    summary.adjudication
      ? `Adjudication: ${summary.adjudication.status}, accepts [${summary.adjudication.acceptedReviewIds.join(', ')}], decided by ${summary.adjudication.decidedBy.type}:${summary.adjudication.decidedBy.name}`
      : 'Adjudication: none',
  );
  if (summary.disagreements.length === 0) {
    console.log('No disagreements across reviews.');
  } else {
    console.log('Disagreements:');
    for (const d of summary.disagreements) console.log(`  ${d.field}: ${d.values.map((v) => JSON.stringify(v)).join(' vs. ')}`);
  }

  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runReviewsCli();
}
