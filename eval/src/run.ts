import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fullPipelinePrediction } from './adapters/full-pipeline.ts';
import { componentLocalizeRepairPrediction, supportsFixture as componentSupportsFixture } from './adapters/component-localize-repair.ts';
import { loadFixtures, type EvalFixture } from './load.ts';
import { checkStaleness, loadAdjudication, loadReviews, type Adjudication } from './review.ts';
import { computeComposition, jsonReport, markdownReport, type FixtureRow } from './report.ts';
import { aggregateAdapter, scoreFixture, SCORING_VERSION, type AdapterMetrics, type EvalPrediction, type FixtureScore } from './score.ts';

export { SCORING_VERSION };

export interface BuiltReport {
  metrics: AdapterMetrics[];
  rows: FixtureRow[];
  markdown: string;
  json: string;
  integrityFailures: string[];
}

/**
 * Only `readiness: benchmark-ready` fixtures with a valid, non-stale, accepted
 * adjudication are scored against the headline metrics. A fixture missing
 * that — draft, unresolved, or stale — is reported in the composition
 * section as excluded, never silently folded into the score.
 */
async function scorableFixtures(fixtures: readonly EvalFixture[]): Promise<{
  scorable: { fixture: EvalFixture; adjudication: Adjudication }[];
  staleExcluded: string[];
  reviewsByFixture: Map<string, Awaited<ReturnType<typeof loadReviews>>>;
}> {
  const scorable: { fixture: EvalFixture; adjudication: Adjudication }[] = [];
  const staleExcluded: string[] = [];
  const reviewsByFixture = new Map<string, Awaited<ReturnType<typeof loadReviews>>>();

  for (const fixture of fixtures) {
    const reviews = await loadReviews(fixture.id);
    reviewsByFixture.set(fixture.id, reviews);

    if (fixture.readiness !== 'benchmark-ready') continue;
    const adjudication = await loadAdjudication(fixture.id);
    if (!adjudication || adjudication.status !== 'accepted') continue;

    const staleReview = await isAnyAcceptedReviewStale(adjudication, fixture.id);
    if (staleReview) {
      staleExcluded.push(fixture.id);
      continue;
    }

    scorable.push({ fixture, adjudication });
  }

  return { scorable, staleExcluded, reviewsByFixture };
}

async function isAnyAcceptedReviewStale(adjudication: Adjudication, fixtureId: string): Promise<boolean> {
  const reviews = await loadReviews(fixtureId);
  const byId = new Map(reviews.map((r) => [r.id, r]));
  for (const reviewId of adjudication.acceptedReviewIds) {
    const review = byId.get(reviewId);
    if (!review) return true;
    const { stale } = await checkStaleness(review, fixtureId);
    if (stale) return true;
  }
  return false;
}

export async function buildReport(fixtures: readonly EvalFixture[]): Promise<BuiltReport> {
  const { scorable, staleExcluded, reviewsByFixture } = await scorableFixtures(fixtures);

  const adapters: { name: string; run: (f: EvalFixture) => Promise<EvalPrediction>; supports: (f: EvalFixture) => boolean }[] = [
    { name: 'drift-full-pipeline', run: fullPipelinePrediction, supports: () => true },
    { name: 'drift-component-localize-repair', run: componentLocalizeRepairPrediction, supports: componentSupportsFixture },
  ];

  const rows: FixtureRow[] = [];
  const scoresByAdapter = new Map<string, FixtureScore[]>();
  const integrityFailures: string[] = [];

  for (const { fixture, adjudication } of scorable) {
    for (const adapter of adapters) {
      if (!adapter.supports(fixture)) continue;
      let prediction: EvalPrediction;
      try {
        prediction = await adapter.run(fixture);
      } catch (err) {
        integrityFailures.push(`${adapter.name} threw on fixture ${fixture.id}: ${(err as Error).message}`);
        continue;
      }
      const score = scoreFixture(fixture, adjudication, prediction);
      const list = scoresByAdapter.get(adapter.name) ?? [];
      list.push(score);
      scoresByAdapter.set(adapter.name, list);

      rows.push({ fixture, adjudication, score, driftUpstreamFindings: prediction.upstreamFindings, driftImpactSites: prediction.impactSites });

      if (score.falseSafe) integrityFailures.push(`false-safe: ${adapter.name} on ${fixture.id} (accepted truth is unsafe; Drift's verdict was safe-equivalent)`);
      if (score.outOfScopeEditCount > 0) integrityFailures.push(`out-of-scope edit: ${adapter.name} on ${fixture.id} touched ${score.outOfScopeEditCount} file(s) outside the expected set`);
    }
  }

  for (const fixture of fixtures) {
    if (!scorable.some((s) => s.fixture.id === fixture.id) && fixture.readiness === 'benchmark-ready' && !staleExcluded.includes(fixture.id)) {
      rows.push({ fixture, adjudication: null, score: null, driftUpstreamFindings: [], driftImpactSites: [] });
    }
  }

  const metrics = [...scoresByAdapter.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([adapter, scores]) => aggregateAdapter(adapter, scores));

  const composition = computeComposition(fixtures, reviewsByFixture, staleExcluded);
  const markdown = markdownReport(metrics, composition, rows);
  const json = jsonReport(metrics, composition, rows);

  return { metrics, rows, markdown, json, integrityFailures };
}

export async function runDeterministicEvaluation(args = process.argv.slice(2)): Promise<number> {
  const ci = args.includes('--ci');
  const fixtures = await loadFixtures();
  const report = await buildReport(fixtures);

  await writeFile(join(process.cwd(), 'eval', 'reports', 'deterministic.md'), report.markdown);
  await writeFile(join(process.cwd(), 'eval', 'reports', 'deterministic.json'), report.json);

  if (ci && report.integrityFailures.length > 0) {
    console.error(report.markdown);
    console.error('\nHarness integrity failures (CI-blocking):');
    for (const failure of report.integrityFailures) console.error(`  - ${failure}`);
    return 1;
  }

  console.log(report.markdown);
  if (report.integrityFailures.length > 0) {
    console.log('\nIntegrity failures (not CI-blocking without --ci):');
    for (const failure of report.integrityFailures) console.log(`  - ${failure}`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runDeterministicEvaluation();
}
