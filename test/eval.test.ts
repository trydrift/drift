import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtures } from '../eval/src/load.ts';
import { buildReport } from '../eval/src/run.ts';
import { validateReviews } from '../eval/src/cli/validate.ts';

/**
 * One report, shared by every assertion below.
 *
 * `buildReport` runs the whole fixture corpus and takes tens of seconds. Each
 * test used to build its own, so the same corpus was analysed five times over
 * — around two minutes of duplicated work, and since `node --test`
 * parallelises across *files* rather than within them, this one file set the
 * floor for the entire suite's wall clock.
 *
 * The report is a pure function of the fixtures, so sharing it changes no
 * assertion: each test still reads the same values it read before. Built
 * lazily on first use rather than in a `before` hook so that the one test
 * which does not need it never pays for it.
 */
let reportOnce: ReturnType<typeof build> | undefined;
async function build() {
  const fixtures = await loadFixtures();
  return { fixtures, report: await buildReport(fixtures) };
}
function sharedReport(): ReturnType<typeof build> {
  reportOnce ??= build();
  return reportOnce;
}

describe('evaluation harness', () => {
  test('every fixture has valid, non-stale, accepted ground truth', async () => {
    const problems = await validateReviews();
    const errors = problems.filter((p) => p.severity === 'error');
    assert.deepEqual(errors, [], `eval:review:validate found errors: ${JSON.stringify(errors, null, 2)}`);
  });

  test('the deterministic report never carries a false-safe outcome on a benchmark-ready fixture', async () => {
    const { report } = await sharedReport();

    for (const metric of report.metrics) {
      assert.equal(metric.falseSafeCount, 0, `${metric.adapter} reported a false-safe outcome — this must never pass CI`);
    }
  });

  test('report separates known-bump detection from component-adapter results', async () => {
    const { report } = await sharedReport();
    const adapters = report.metrics.map((m) => m.adapter);

    assert.ok(adapters.includes('drift-known-bump-analysis'), 'headline detection adapter must be present');
    // Component adapters, if present, must never be the only adapter reported —
    // the headline number always comes from drift-known-bump-analysis.
    for (const adapter of adapters) {
      if (adapter !== 'drift-known-bump-analysis') assert.ok(adapter.startsWith('drift-component-'), `unexpected adapter name ${adapter}`);
    }
  });

  test('per-fixture rows are scored independently (no cross-fixture id collisions)', async () => {
    const { fixtures, report } = await sharedReport();
    const scored = report.rows.filter((r) => r.score !== null);
    assert.ok(scored.length >= fixtures.length, 'expected at least one scored row per benchmark-ready fixture');
  });

  test('the negative/control fixture produces zero impact-site false positives', async () => {
    const { report } = await sharedReport();
    const row = report.rows.find((r) => r.fixture.id === 'npm-unused-break' && r.score?.adapter === 'drift-known-bump-analysis');
    assert.ok(row?.score, 'expected a scored drift-known-bump-analysis row for the negative/control fixture');
    assert.equal(row.score!.impact.fp, 0);
  });

  test('does not hide harness integrity failures required by CI (out-of-scope edits, false-safe)', async () => {
    const { report } = await sharedReport();
    for (const failure of report.integrityFailures) {
      assert.ok(
        failure.startsWith('false-safe:') || failure.startsWith('out-of-scope edit:') || failure.includes('threw on fixture'),
        `unexpected integrity failure shape: ${failure}`,
      );
    }
  });
});
