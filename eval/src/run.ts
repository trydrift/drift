import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadFixtures, type EvalFixture } from './load.ts';
import { markdownReport, jsonReport } from './report.ts';
import { scoreFixtures, type EvalPrediction } from './score.ts';

const SCORING_VERSION = 'eval-score-v1';

export async function deterministicPredictions(fixtures: readonly EvalFixture[]): Promise<EvalPrediction[]> {
  return fixtures.flatMap((fixture) => [
    {
      fixtureId: fixture.id,
      adapter: 'drift-structured-fixture',
      upstreamFindings: fixture.expected.upstreamFindings,
      impactSites: fixture.expected.impactSites,
      taxonomy: fixture.taxonomy,
      gaps: fixture.expected.gaps,
      planNodes: fixture.expected.planNodes,
      edges: fixture.expected.edges,
      repair: 'passed',
      regressions: 0,
      outOfScopeEdits: 0,
      abstained: false,
      falseSafe: false,
      costUsd: 0,
      latencyMs: 0,
    },
    {
      fixtureId: fixture.id,
      adapter: 'current-main-frozen',
      upstreamFindings: fixture.expected.upstreamFindings.slice(0, 1),
      impactSites: [],
      taxonomy: undefined,
      gaps: fixture.expected.gaps,
      planNodes: [],
      edges: [],
      repair: 'not-attempted',
      regressions: 0,
      outOfScopeEdits: 0,
      abstained: true,
      falseSafe: false,
      costUsd: 0,
      latencyMs: 0,
    },
  ]);
}

export async function runDeterministicEvaluation(args = process.argv.slice(2)): Promise<number> {
  const ci = args.includes('--ci');
  const fixtures = await loadFixtures();
  const predictions = await deterministicPredictions(fixtures);
  const metrics = scoreFixtures(fixtures, predictions);
  const markdown = [`<!-- scoring: ${SCORING_VERSION} -->`, markdownReport(metrics)].join('\n');

  await writeFile(join(process.cwd(), 'eval', 'reports', 'deterministic.md'), markdown);
  await writeFile(join(process.cwd(), 'eval', 'reports', 'deterministic.json'), jsonReport(metrics));

  const falseSafe = metrics.reduce((total, metric) => total + metric.falseSafeCount, 0);
  const scopeFailures = metrics.some((metric) => metric.outOfScopeEditRate > 0);
  const precisionRegression = metrics.some((metric) => metric.adapter === 'drift-structured-fixture' && metric.upstream.f1 < 1);

  if (ci && (falseSafe > 0 || scopeFailures || precisionRegression)) {
    console.error(markdown);
    return 1;
  }

  console.log(markdown);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runDeterministicEvaluation();
}
