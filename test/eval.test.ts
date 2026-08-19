import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtures } from '../eval/src/load.ts';
import { deterministicPredictions } from '../eval/src/run.ts';
import { scoreFixtures } from '../eval/src/score.ts';

describe('evaluation harness', () => {
  test('loads reviewed deterministic fixtures', async () => {
    const fixtures = await loadFixtures();

    assert.ok(fixtures.length > 0);
    assert.ok(fixtures.every((fixture) => fixture.provenance.reviewStatus === 'reviewed'));
  });

  test('keeps individual metrics visible and penalizes false-safe outcomes', async () => {
    const fixtures = await loadFixtures();
    const predictions = await deterministicPredictions(fixtures);
    const metrics = scoreFixtures(fixtures, predictions);

    const drift = metrics.find((metric) => metric.adapter === 'drift-structured-fixture');
    const baseline = metrics.find((metric) => metric.adapter === 'current-main-frozen');

    assert.ok(drift);
    assert.ok(baseline);
    assert.equal(drift.falseSafeCount, 0);
    assert.equal(drift.upstream.f1, 1);
    assert.equal(drift.impactSites.f1, 1);
    assert.equal(drift.repairOraclePassRate, 1);
    assert.equal(drift.repairGoldPatchExactRate, 1);
    assert.equal(drift.repairChangedFiles.f1, 1);
    assert.equal(drift.outOfScopeEditRate, 0);
    assert.ok('taxonomyAccuracy' in drift);
    assert.ok('repairAttemptRate' in drift);
    assert.ok(baseline.costSensitiveScore < drift.costSensitiveScore);
  });

  test('scores deterministic fixes and abstentions separately', async () => {
    const fixtures = await loadFixtures();
    const predictions = await deterministicPredictions(fixtures);
    const drift = predictions.filter((prediction) => prediction.adapter === 'drift-structured-fixture');

    const fixed = drift.filter((prediction) => {
      const fixture = fixtures.find((candidate) => candidate.id === prediction.fixtureId);
      return fixture?.repair.expectation === 'fixed';
    });
    const abstained = drift.filter((prediction) => {
      const fixture = fixtures.find((candidate) => candidate.id === prediction.fixtureId);
      return fixture?.repair.expectation === 'abstained';
    });

    assert.ok(fixed.length > 0);
    assert.ok(fixed.every((prediction) => prediction.repair === 'passed'));
    assert.ok(fixed.every((prediction) => prediction.repairOraclePassed));
    assert.ok(fixed.every((prediction) => prediction.repairGoldPatchExact));
    assert.ok(abstained.length > 0);
    assert.ok(abstained.every((prediction) => prediction.repair === 'not-attempted'));
  });
});
