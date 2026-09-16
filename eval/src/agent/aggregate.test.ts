import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootstrap,
  caseLevelSummary,
  caseMetrics,
  conditionAggregate,
  contextReduction,
  groupByCase,
  median,
  percentagePointDifference,
  relativeDifference,
  successRate,
} from './aggregate.ts';
import { makeTrial } from './test-helpers.ts';

describe('aggregation arithmetic', () => {
  test('median handles odd, even and empty inputs', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), null);
  });

  test('context reduction is 1 - drift/baseline and refuses a zero or missing baseline', () => {
    assert.equal(contextReduction(184_000, 61_000)?.toFixed(4), '0.6685');
    assert.equal(contextReduction(100, 150), -0.5);
    assert.equal(contextReduction(0, 10), null);
    assert.equal(contextReduction(null, 10), null);
    assert.equal(contextReduction(10, null), null);
  });

  test('success rate, percentage-point and relative differences', () => {
    assert.equal(successRate(64, 100), 0.64);
    assert.equal(successRate(0, 0), null);
    assert.equal(percentagePointDifference(0.64, 0.84)?.toFixed(6), '20.000000');
    assert.equal(percentagePointDifference(null, 0.5), null);
    assert.equal(relativeDifference(0.64, 0.84)?.toFixed(4), '0.3125');
    assert.equal(relativeDifference(0, 0.5), null);
  });
});

describe('case and condition aggregation', () => {
  const trials = [
    makeTrial({ caseId: 'a', condition: 'baseline', repetition: 1, gross: 100_000, success: false, reasons: ['hidden_regression_failure'] }),
    makeTrial({ caseId: 'a', condition: 'baseline', repetition: 2, gross: 120_000, success: true }),
    makeTrial({ caseId: 'a', condition: 'baseline', repetition: 3, gross: 80_000, success: true }),
    makeTrial({ caseId: 'a', condition: 'drift', repetition: 1, gross: 40_000, success: true }),
    makeTrial({ caseId: 'a', condition: 'drift', repetition: 2, gross: 60_000, success: true }),
    makeTrial({ caseId: 'a', condition: 'drift', repetition: 3, gross: 50_000, success: false, reasons: ['timeout'], agentStatus: 'timeout' }),
    // An infrastructure failure: excluded from everything.
    makeTrial({ caseId: 'a', condition: 'drift', repetition: 4, gross: 1, success: false, valid: false, infrastructureFailure: 'provider_error' }),
    makeTrial({ caseId: 'b', condition: 'baseline', repetition: 1, gross: 200_000, success: false, reasons: ['dependency_reverted'] }),
    makeTrial({ caseId: 'b', condition: 'drift', repetition: 1, gross: 250_000, success: false, reasons: ['build_failure'] }),
    // An ablation condition never enters the headline groups.
    makeTrial({ caseId: 'b', condition: 'drift-evidence-only', repetition: 1, gross: 10, success: true }),
  ];

  test('invalid trials and ablations are excluded before grouping', () => {
    const groups = groupByCase(trials);
    assert.deepEqual(groups.map((g) => [g.caseId, g.baseline.length, g.drift.length]), [['a', 3, 3], ['b', 1, 1]]);
  });

  test('case medians and reductions', () => {
    const [a, b] = groupByCase(trials).map(caseMetrics);
    assert.equal(a!.medianBaselineInputTokens, 100_000);
    assert.equal(a!.medianDriftInputTokens, 50_000);
    assert.equal(a!.inputTokenReduction, 0.5);
    assert.equal(a!.baselineSuccessRate?.toFixed(4), '0.6667');
    assert.equal(a!.driftSuccessRate?.toFixed(4), '0.6667');
    assert.equal(a!.successDifferencePp, 0);
    assert.deepEqual(a!.driftFailureReasons, { timeout: 1 });
    assert.equal(b!.inputTokenReduction, -0.25);
  });

  test('condition aggregates count infrastructure exclusions and report secondary metrics as such', () => {
    const drift = conditionAggregate('drift', trials);
    assert.equal(drift.trials, 5);
    assert.equal(drift.validTrials, 4);
    assert.equal(drift.invalidTrials, 1);
    assert.deepEqual(drift.infrastructureFailures, { provider_error: 1 });
    assert.equal(drift.successfulTrials, 2);
    assert.equal(drift.successRate, 0.5);
    assert.equal(drift.inputTokensPerSuccessfulFix, (40_000 + 60_000 + 50_000 + 250_000) / 2);
    assert.equal(drift.medianInputTokensAmongSuccesses, 50_000);
    assert.deepEqual(drift.failureReasons, { timeout: 1, build_failure: 1 });
    const baseline = conditionAggregate('baseline', trials);
    assert.equal(baseline.successRate, 0.5);
    assert.deepEqual(baseline.failureReasons, { hidden_regression_failure: 1, dependency_reverted: 1 });
  });

  test('case-level summary counts improved, tied and baseline-better', () => {
    const summary = caseLevelSummary([
      { successDifferencePp: 40 } as never,
      { successDifferencePp: 0 } as never,
      { successDifferencePp: -20 } as never,
      { successDifferencePp: null } as never,
    ]);
    assert.deepEqual(summary, { improved: 1, tied: 1, baselineBetter: 1, medianDifferencePp: 0, meanDifferencePp: 20 / 3 });
  });
});

describe('bootstrap', () => {
  const groups = groupByCase(
    Array.from({ length: 12 }, (_, i) => [
      makeTrial({ caseId: `c${i}`, condition: 'baseline', repetition: 1, gross: 100_000 + i * 1000, success: i % 3 !== 0 }),
      makeTrial({ caseId: `c${i}`, condition: 'baseline', repetition: 2, gross: 110_000 + i * 1000, success: i % 2 === 0 }),
      makeTrial({ caseId: `c${i}`, condition: 'drift', repetition: 1, gross: 50_000 + i * 500, success: true }),
      makeTrial({ caseId: `c${i}`, condition: 'drift', repetition: 2, gross: 55_000 + i * 500, success: i % 4 !== 0 }),
    ]).flat(),
  );

  test('is reproducible from the seed and brackets the point estimate', () => {
    const one = bootstrap(groups, { iterations: 300, seed: 7 });
    const two = bootstrap(groups, { iterations: 300, seed: 7 });
    assert.deepEqual(one, two);
    const three = bootstrap(groups, { iterations: 300, seed: 8 });
    assert.notDeepEqual(one.medianReduction, three.medianReduction);
    assert.ok(one.medianReduction!.low <= 0.5 && one.medianReduction!.high >= 0.45);
    assert.ok(one.successDifferencePp!.low <= one.successDifferencePp!.high);
    assert.equal(one.medianReduction!.iterations, 300);
    assert.match(one.medianReduction!.method, /cases resampled/);
  });

  test('returns nothing over no cases', () => {
    const empty = bootstrap([]);
    assert.equal(empty.medianReduction, null);
    assert.equal(empty.successDifferencePp, null);
  });
});
