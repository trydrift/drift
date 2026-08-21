import { loadFixtures } from '../load.ts';
import { checkStaleness, loadAdjudication, loadReviews, validateAdjudicationConsistency, validateConclusion, type Review } from '../review.ts';

export interface ValidationProblem {
  fixtureId: string;
  severity: 'error' | 'warning';
  message: string;
}

/**
 * `eval:review:validate` — the gate between "a fixture has files in it" and
 * "a fixture's ground truth can be trusted for scoring." Only
 * `readiness: benchmark-ready` fixtures produce `error`-severity problems;
 * `draft` fixtures are allowed to be incomplete and only ever warn.
 */
export async function validateReviews(root?: string): Promise<ValidationProblem[]> {
  const fixtures = await loadFixtures(root);
  const problems: ValidationProblem[] = [];

  for (const fixture of fixtures) {
    const isReady = fixture.readiness === 'benchmark-ready';
    const severity = (): 'error' | 'warning' => (isReady ? 'error' : 'warning');

    let reviews;
    try {
      reviews = await loadReviews(fixture.id, root);
    } catch (err) {
      problems.push({ fixtureId: fixture.id, severity: 'error', message: `malformed review: ${(err as Error).message}` });
      continue;
    }

    let adjudication;
    try {
      adjudication = await loadAdjudication(fixture.id, root);
    } catch (err) {
      problems.push({ fixtureId: fixture.id, severity: 'error', message: `malformed adjudication: ${(err as Error).message}` });
      continue;
    }

    if (!adjudication) {
      problems.push({ fixtureId: fixture.id, severity: severity(), message: 'no adjudication.yml present' });
      continue;
    }

    if (adjudication.status !== 'accepted') {
      problems.push({
        fixtureId: fixture.id,
        severity: severity(),
        message: `adjudication status is '${adjudication.status}', not 'accepted' — reviews disagree with no resolution, or ground truth is intentionally left unresolved`,
      });
    }

    const consolidationProblems = validateConclusion(adjudication.decision);
    for (const message of consolidationProblems) {
      problems.push({ fixtureId: fixture.id, severity: severity(), message: `adjudication: ${message}` });
    }

    if (adjudication.acceptedReviewIds.length === 0) {
      problems.push({ fixtureId: fixture.id, severity: severity(), message: 'adjudication references no reviews' });
    }

    const byId = new Map(reviews.map((r) => [r.id, r]));
    const acceptedReviews: Review[] = [];
    for (const reviewId of adjudication.acceptedReviewIds) {
      const review = byId.get(reviewId);
      if (!review) {
        problems.push({ fixtureId: fixture.id, severity: severity(), message: `adjudication references missing review '${reviewId}'` });
        continue;
      }
      acceptedReviews.push(review);

      if (review.status === 'withdrawn' || review.status === 'superseded') {
        problems.push({
          fixtureId: fixture.id,
          severity: severity(),
          message: `adjudication accepts review '${reviewId}' with status '${review.status}'`,
        });
      }

      const reviewProblems = validateConclusion(review.conclusion);
      for (const message of reviewProblems) {
        problems.push({ fixtureId: fixture.id, severity: severity(), message: `review ${reviewId}: ${message}` });
      }

      try {
        const staleness = await checkStaleness(review, fixture.id, root);
        if (staleness.stale) {
          problems.push({
            fixtureId: fixture.id,
            severity: severity(),
            message: `accepted review '${reviewId}' is stale: ${staleness.mismatched.join(', ')} changed since it was written`,
          });
        }
      } catch (err) {
        problems.push({ fixtureId: fixture.id, severity: severity(), message: `could not check staleness: ${(err as Error).message}` });
      }
    }

    for (const message of validateAdjudicationConsistency(adjudication, acceptedReviews)) {
      problems.push({ fixtureId: fixture.id, severity: severity(), message });
    }
  }

  return problems;
}

export async function runValidateCli(argv = process.argv.slice(2)): Promise<number> {
  const json = argv.includes('--json');
  const problems = await validateReviews();
  const errors = problems.filter((p) => p.severity === 'error');

  if (json) {
    console.log(JSON.stringify({ problems, errorCount: errors.length }, null, 2));
  } else if (problems.length === 0) {
    console.log('eval:review:validate: all fixtures pass.');
  } else {
    for (const p of problems) {
      console[p.severity === 'error' ? 'error' : 'warn'](`[${p.severity}] ${p.fixtureId}: ${p.message}`);
    }
  }

  return errors.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runValidateCli();
}
