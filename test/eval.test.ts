import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtures } from '../eval/src/load.ts';
import { buildReport } from '../eval/src/run.ts';
import { validateReviews } from '../eval/src/cli/validate.ts';

describe('evaluation harness', () => {
  test('every fixture has valid, non-stale, accepted ground truth', async () => {
    const problems = await validateReviews();
    const errors = problems.filter((p) => p.severity === 'error');
    assert.deepEqual(errors, [], `eval:review:validate found errors: ${JSON.stringify(errors, null, 2)}`);
  });

  test('the deterministic report never carries a false-safe outcome on a benchmark-ready fixture', async () => {
    const fixtures = await loadFixtures();
    const report = await buildReport(fixtures);

    for (const metric of report.metrics) {
      assert.equal(metric.falseSafeCount, 0, `${metric.adapter} reported a false-safe outcome — this must never pass CI`);
    }
  });

  test('report separates known-bump detection from component-adapter results', async () => {
    const fixtures = await loadFixtures();
    const report = await buildReport(fixtures);
    const adapters = report.metrics.map((m) => m.adapter);

    assert.ok(adapters.includes('drift-known-bump-analysis'), 'headline detection adapter must be present');
    // Component adapters, if present, must never be the only adapter reported —
    // the headline number always comes from drift-known-bump-analysis.
    for (const adapter of adapters) {
      if (adapter !== 'drift-known-bump-analysis') assert.ok(adapter.startsWith('drift-component-'), `unexpected adapter name ${adapter}`);
    }
  });

  test('per-fixture rows are scored independently (no cross-fixture id collisions)', async () => {
    const fixtures = await loadFixtures();
    const report = await buildReport(fixtures);
    const scored = report.rows.filter((r) => r.score !== null);
    assert.ok(scored.length >= fixtures.length, 'expected at least one scored row per benchmark-ready fixture');
  });

  test('the negative/control fixture produces zero impact-site false positives', async () => {
    const fixtures = await loadFixtures();
    const report = await buildReport(fixtures);
    const row = report.rows.find((r) => r.fixture.id === 'npm-unused-break' && r.score?.adapter === 'drift-known-bump-analysis');
    assert.ok(row?.score, 'expected a scored drift-known-bump-analysis row for the negative/control fixture');
    assert.equal(row.score!.impact.fp, 0);
  });

  test('does not hide harness integrity failures required by CI (out-of-scope edits, false-safe)', async () => {
    const fixtures = await loadFixtures();
    const report = await buildReport(fixtures);
    for (const failure of report.integrityFailures) {
      assert.ok(
        failure.startsWith('false-safe:') || failure.startsWith('out-of-scope edit:') || failure.includes('threw on fixture'),
        `unexpected integrity failure shape: ${failure}`,
      );
    }
  });
});
