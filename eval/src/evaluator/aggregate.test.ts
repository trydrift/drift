import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateLevel, aggregateRepair, bootstrapInterval, mcnemar, prf, rate, trialReliability } from './aggregate.ts';
import type { LevelScore } from './detection.ts';
import type { RepairScore } from './repair.ts';

function level(tp: number, fp: number, fn: number, vacuous = false): LevelScore {
  return { status: 'scored', confusion: { tp, fp, fn }, truePositives: [], falsePositives: [], falseNegatives: [], vacuous };
}

const NOT_ADJUDICATED: LevelScore = {
  status: 'not-adjudicated',
  confusion: { tp: 0, fp: 0, fn: 0 },
  truePositives: [],
  falsePositives: [],
  falseNegatives: [],
  vacuous: false,
};

test('an empty-expected empty-actual case is excluded from macro and harmless in micro', () => {
  const aggregate = aggregateLevel([level(1, 0, 0), level(0, 0, 0, true)]);
  assert.equal(aggregate.macro.cases, 1);
  assert.equal(aggregate.vacuousExcluded, 1);
  assert.equal(aggregate.micro.tp, 1);
  assert.equal(aggregate.macro.f1, 1);
});

test('a false positive on a control case is never excluded and drags precision down', () => {
  const aggregate = aggregateLevel([level(1, 0, 0), level(0, 2, 0)]);
  assert.equal(aggregate.vacuousExcluded, 0);
  assert.equal(aggregate.macro.cases, 2);
  assert.ok(aggregate.micro.precision < 1);
  assert.equal(aggregate.macro.precision, 0.5);
});

test('a level no adjudication ruled on is counted apart, never scored as a perfect empty prediction', () => {
  const aggregate = aggregateLevel([NOT_ADJUDICATED, NOT_ADJUDICATED]);
  assert.equal(aggregate.scoredCases, 0);
  assert.equal(aggregate.notAdjudicatedCases, 2);
  assert.equal(aggregate.micro.f1, 0);
  assert.equal(aggregate.macro.cases, 0);
});

test('a rate over nothing is undefined, not zero', () => {
  assert.equal(rate(0, 0).value, null);
  assert.equal(rate(0, 4).value, 0);
});

test('precision and recall of an all-empty confusion are zero, not NaN', () => {
  assert.deepEqual(prf({ tp: 0, fp: 0, fn: 0 }), { precision: 0, recall: 0, f1: 0 });
});

function repairScore(caseId: string, outcome: RepairScore['outcome'], scorable: boolean, trial = 1): RepairScore & { trial: number } {
  return {
    caseId,
    track: 'repair-agent',
    outcome,
    scorable,
    trial,
    failToPass: { triggerFailures: [], resolvedTriggers: [], unresolvedTriggers: [], newFailures: [], regressedChecks: [], verdict: 'resolved' },
    attempted: true,
    notAttemptedReason: null,
    productionScopeEscapes: [],
    unexpectedChangedFiles: [],
    changedFiles: { tp: 0, fp: 0, fn: 0 },
    goldPatchExact: 'not-applicable',
    patchStats: { files: 0, hunks: 0, addedLines: 0, removedLines: 0 },
    residualImpactSites: 0,
    resolvedByTier: [],
  };
}

test('operational failures leave both the numerator and the denominator', () => {
  const aggregate = aggregateRepair('repair-agent', [
    repairScore('a', 'repaired', true),
    repairScore('b', 'failed-to-fix', true),
    repairScore('c', 'operational-failure', false),
  ]);
  assert.deepEqual(aggregate.repairSuccess, { numerator: 1, denominator: 2, value: 0.5 });
  assert.equal(aggregate.excluded, 1);
  assert.equal(aggregate.outcomes['operational-failure'], 1, 'still visible in the exclusion table');
});

test('a correct abstention counts as a correct decision but not as a repair', () => {
  const aggregate = aggregateRepair('repair-codemod', [repairScore('a', 'correct-abstention', true)]);
  assert.equal(aggregate.repairSuccess.value, 0);
  assert.equal(aggregate.correctDecision.value, 1);
});

test('reliability separates first-attempt success from succeeding once in three', () => {
  const [flaky, solid] = trialReliability([
    repairScore('flaky', 'failed-to-fix', true, 1),
    repairScore('flaky', 'repaired', true, 2),
    repairScore('flaky', 'failed-to-fix', true, 3),
    repairScore('solid', 'repaired', true, 1),
    repairScore('solid', 'repaired', true, 2),
    repairScore('solid', 'repaired', true, 3),
  ]);
  assert.equal(flaky?.firstAttemptSuccess, false);
  assert.equal(flaky?.successes, 1);
  assert.equal(flaky?.allTrialsSucceeded, false);
  assert.equal(solid?.firstAttemptSuccess, true);
  assert.equal(solid?.allTrialsSucceeded, true);
});

test('a bootstrap interval is refused on a corpus too small to support one', () => {
  assert.equal(bootstrapInterval([true, false, true, true]), null);
});

test('a bootstrap interval is deterministic given a seed', () => {
  const outcomes = Array.from({ length: 40 }, (_, index) => index % 3 !== 0);
  const first = bootstrapInterval(outcomes, { seed: 7, iterations: 500 });
  const second = bootstrapInterval(outcomes, { seed: 7, iterations: 500 });
  assert.deepEqual(first, second);
  assert.ok(first!.low <= first!.high);
});

test('McNemar refuses to report on too few discordant pairs', () => {
  const a = new Map([['x', true], ['y', false]]);
  const b = new Map([['x', false], ['y', false]]);
  assert.equal(mcnemar(a, b), null);
});

test('McNemar reports the paired disagreement when there is enough of it', () => {
  const a = new Map<string, boolean>();
  const b = new Map<string, boolean>();
  for (let index = 0; index < 14; index += 1) {
    a.set(`c${index}`, true);
    b.set(`c${index}`, false);
  }
  const result = mcnemar(a, b)!;
  assert.equal(result.aOnly, 14);
  assert.equal(result.bOnly, 0);
  assert.equal(result.n, 14);
  assert.ok(result.pValue < 0.001);
});
