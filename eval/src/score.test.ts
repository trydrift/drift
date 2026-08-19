import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreFixture, aggregateDetection, isUserFacingSafeVerdict, type EvalPrediction } from './score.ts';
import type { EvalFixture } from './load.ts';
import type { Adjudication } from './review.ts';

function fixture(id: string): EvalFixture {
  return {
    id,
    ecosystem: 'npm',
    dependency: 'fixture-lib',
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    scenarioLabel: 'renamed-export',
    source: { repository: 'fixture-local', licence: 'MIT' },
    exposure: 'direct',
    oracles: {
      baseline: { command: 'npm test', expect: 'pass' },
      broken: { command: 'npm test', expect: 'fail' },
      repaired: { command: 'npm test', expect: 'pass' },
    },
    complexity: 'small',
    network: 'disabled',
    readiness: 'benchmark-ready',
    provenance: { kind: 'synthetic', createdAt: '2026-08-19', author: 'test' },
  };
}

function adjudication(overrides: Partial<Adjudication['decision']> = {}): Adjudication {
  return {
    fixtureId: 'x',
    acceptedReviewIds: ['r1'],
    decision: {
      upstreamFindings: [],
      impactSites: [],
      gaps: [],
      groundTruthSafety: 'safe',
      repair: { expectedAction: 'no-repair-needed', expectedChangedFiles: [] },
      ...overrides,
    },
    status: 'accepted',
    decidedAt: '2026-08-19',
    decidedBy: { type: 'ai', name: 'test' },
    notes: '',
  };
}

function prediction(overrides: Partial<EvalPrediction> = {}): EvalPrediction {
  return {
    fixtureId: 'x',
    adapter: 'drift-known-bump-analysis',
    upstreamFindings: [],
    impactSites: [],
    gaps: [],
    planNodes: [],
    verdict: 'insufficient-evidence',
    repairAction: 'abstained',
    repairOutcome: 'not-attempted',
    repairChangedFiles: [],
    repairScopeEscapeFiles: [],
    repairGoldPatchExact: 'not-applicable',
    oracleStages: [],
    costUsd: 0,
    latencyMs: 0,
    ...overrides,
  };
}

test('identical finding ids in two different fixtures do not cross-contaminate scoring', () => {
  const fixtureA = fixture('fixture-a');
  const fixtureB = fixture('fixture-b');
  const adjA = adjudication({ upstreamFindings: ['fixture-lib:foo:renamed-export'] });
  const adjB = adjudication({ upstreamFindings: [] });
  // fixture B's prediction claims the exact same raw finding id fixture A expects.
  const predB = prediction({ upstreamFindings: ['fixture-lib:foo:renamed-export'] });

  const scoreA = scoreFixture(fixtureA, adjA, prediction());
  const scoreB = scoreFixture(fixtureB, adjB, predB);

  // Fixture A's expected finding must not be satisfied by fixture B's prediction.
  assert.equal(scoreA.upstream.fn, 1, 'fixture A should show its expected finding as unmet');
  // Fixture B's prediction, matched against fixture B's own (empty) expectations, is a false positive.
  assert.equal(scoreB.upstream.fp, 1, "fixture B's identically-named finding must count as its own FP, not satisfy fixture A");
});

test('false-safe requires groundTruthSafety unsafe AND a safe-equivalent verdict', () => {
  const f = fixture('x');
  const unsafeAdj = adjudication({ groundTruthSafety: 'unsafe', impactSites: ['a'] });
  const safeVerdictPrediction = prediction({ verdict: 'no-incompatible-change-in-checked-surfaces' });
  const score = scoreFixture(f, unsafeAdj, safeVerdictPrediction);
  assert.equal(score.falseSafe, true);
  assert.equal(score.unsupportedSafe, false);
});

test('unsupportedSafe fires on uncertain ground truth + safe verdict, and is never counted as falseSafe', () => {
  const f = fixture('x');
  const uncertainAdj = adjudication({ groundTruthSafety: 'uncertain', gaps: ['could not verify'] });
  const safeVerdictPrediction = prediction({ verdict: 'no-incompatible-change-in-checked-surfaces' });
  const score = scoreFixture(f, uncertainAdj, safeVerdictPrediction);
  assert.equal(score.falseSafe, false);
  assert.equal(score.unsupportedSafe, true);
});

test('a genuinely safe fixture with a safe verdict is neither falseSafe nor unsupportedSafe', () => {
  const f = fixture('x');
  const safeAdj = adjudication({ groundTruthSafety: 'safe' });
  const safeVerdictPrediction = prediction({ verdict: 'no-incompatible-change-in-checked-surfaces' });
  const score = scoreFixture(f, safeAdj, safeVerdictPrediction);
  assert.equal(score.falseSafe, false);
  assert.equal(score.unsupportedSafe, false);
});

test('unverified/inconclusive verdicts never count as safe-equivalent', () => {
  for (const v of ['insufficient-evidence', 'verification-incomplete', 'detected-not-locally-reachable', 'unchecked', 'verification-failed'] as const) {
    assert.equal(isUserFacingSafeVerdict(v), false, `${v} must never be treated as safe-equivalent`);
  }
  assert.equal(isUserFacingSafeVerdict('no-incompatible-change-in-checked-surfaces'), true);
  assert.equal(isUserFacingSafeVerdict('clean'), true);
});

test('unsafe ground truth + unverified Drift verdict is not a false-safe (Drift did not claim safe)', () => {
  const f = fixture('x');
  const unsafeAdj = adjudication({ groundTruthSafety: 'unsafe', impactSites: ['a'] });
  const inconclusive = prediction({ verdict: 'insufficient-evidence' });
  const score = scoreFixture(f, unsafeAdj, inconclusive);
  assert.equal(score.falseSafe, false);
});

test('abstention correctness is only scored for drift-known-bump-analysis', () => {
  const f = fixture('x');
  const abstainAdj = adjudication({ repair: { expectedAction: 'abstain', expectedChangedFiles: [] } });
  const componentPrediction = prediction({ adapter: 'drift-component-localize-repair', repairAction: 'repair-attempted', repairOutcome: 'passed' });
  const score = scoreFixture(f, abstainAdj, componentPrediction);
  assert.equal(score.incorrectRepairAttempt, false, 'component adapters do not participate in abstention policy scoring');
});

test('aggregateDetection excludes empty/empty fixtures from macro but not from micro', () => {
  const agg = aggregateDetection([
    { tp: 0, fp: 0, fn: 0, applicable: false }, // nothing expected, nothing predicted
    { tp: 1, fp: 0, fn: 0, applicable: true },
  ]);
  assert.equal(agg.excludedFromMacro, 1);
  assert.equal(agg.micro.precision, 1);
  assert.equal(agg.macro !== 'not-applicable' && agg.macro.precision, 1);
});

test('a false positive on a negative fixture (empty expected, non-empty actual) is never excluded from macro', () => {
  const agg = aggregateDetection([{ tp: 0, fp: 1, fn: 0, applicable: true }]);
  assert.equal(agg.excludedFromMacro, 0);
  assert.equal(agg.macro !== 'not-applicable' && agg.macro.precision, 0);
});

// --- Production scope escape vs. ground-truth unexpected changed file (see full-pipeline.ts's RepairCapture) ---

test('production scope escape: a repair that changes a file outside its own allowedFiles fails successfulRepair and is counted', () => {
  const f = fixture('x');
  const adj = adjudication({ repair: { expectedAction: 'deterministic-repair', expectedChangedFiles: ['src/a.ts'] } });
  const pred = prediction({
    repairAction: 'repair-attempted',
    repairOutcome: 'passed',
    repairChangedFiles: ['src/a.ts', 'src/b.ts'],
    repairScopeEscapeFiles: ['src/b.ts'],
    oracleStages: [
      { stage: 'baseline', expected: 'pass', observed: 'pass', matchesExpectation: true },
      { stage: 'broken', expected: 'fail', observed: 'fail', matchesExpectation: true },
      { stage: 'repaired', expected: 'pass', observed: 'pass', matchesExpectation: true },
    ],
  });
  const score = scoreFixture(f, adj, pred);
  assert.equal(score.productionScopeEscapeCount, 1, 'src/b.ts is a real production-scope escape');
  assert.equal(score.successfulRepair, false, 'a scope escape must never count as a successful repair');
});

test('ground-truth unexpected edit only: an in-scope file the fixture did not expect is FP/FN, not a scope escape', () => {
  const f = fixture('x');
  // allowedFiles would have been ['src/a.ts', 'src/b.ts'] in production; expected ground truth only wants src/a.ts changed.
  const adj = adjudication({ repair: { expectedAction: 'deterministic-repair', expectedChangedFiles: ['src/a.ts'] } });
  const pred = prediction({
    repairAction: 'repair-attempted',
    repairOutcome: 'passed',
    repairChangedFiles: ['src/b.ts'], // in Drift's own allowed scope, but not what ground truth expected
    repairScopeEscapeFiles: [], // no production-scope escape: src/b.ts was in allowedFiles
    oracleStages: [
      { stage: 'baseline', expected: 'pass', observed: 'pass', matchesExpectation: true },
      { stage: 'broken', expected: 'fail', observed: 'fail', matchesExpectation: true },
      { stage: 'repaired', expected: 'pass', observed: 'pass', matchesExpectation: true },
    ],
  });
  const score = scoreFixture(f, adj, pred);
  assert.equal(score.productionScopeEscapeCount, 0, 'no CI-blocking safety failure here');
  assert.equal(score.changedFiles.fp, 1, 'src/b.ts is an unexpected changed file');
  assert.equal(score.changedFiles.fn, 1, 'src/a.ts was expected but never changed');
  assert.equal(score.unexpectedChangedFileCount, 1);
});

test('clean repair: actual changed files exactly match expected and stay in allowed scope', () => {
  const f = fixture('x');
  const adj = adjudication({ repair: { expectedAction: 'deterministic-repair', expectedChangedFiles: ['src/a.ts'] } });
  const pred = prediction({
    repairAction: 'repair-attempted',
    repairOutcome: 'passed',
    repairChangedFiles: ['src/a.ts'],
    repairScopeEscapeFiles: [],
    oracleStages: [
      { stage: 'baseline', expected: 'pass', observed: 'pass', matchesExpectation: true },
      { stage: 'broken', expected: 'fail', observed: 'fail', matchesExpectation: true },
      { stage: 'repaired', expected: 'pass', observed: 'pass', matchesExpectation: true },
    ],
  });
  const score = scoreFixture(f, adj, pred);
  assert.equal(score.productionScopeEscapeCount, 0);
  assert.equal(score.unexpectedChangedFileCount, 0);
  assert.equal(score.changedFiles.tp, 1);
  assert.equal(score.successfulRepair, true);
});

// --- Gold-patch exactness is secondary and honestly tri-state (see full-pipeline.ts's computeGoldPatchExact) ---

test('gold-patch exact false does not make an otherwise-successful repair unsuccessful', () => {
  const f = fixture('x');
  const adj = adjudication({ repair: { expectedAction: 'deterministic-repair', expectedChangedFiles: ['src/a.ts'], goldPatch: 'expected/gold.patch' } });
  const pred = prediction({
    repairAction: 'repair-attempted',
    repairOutcome: 'passed',
    repairChangedFiles: ['src/a.ts'],
    repairScopeEscapeFiles: [],
    repairGoldPatchExact: false,
    oracleStages: [
      { stage: 'baseline', expected: 'pass', observed: 'pass', matchesExpectation: true },
      { stage: 'broken', expected: 'fail', observed: 'fail', matchesExpectation: true },
      { stage: 'repaired', expected: 'pass', observed: 'pass', matchesExpectation: true },
    ],
  });
  const score = scoreFixture(f, adj, pred);
  assert.equal(score.goldPatchExact, false);
  assert.equal(score.successfulRepair, true, 'a semantically correct, non-exact patch must still count as a successful repair');
});

test('gold patch not-applicable when no repair was attempted, and scoring preserves that rather than reporting false', () => {
  const f = fixture('x');
  const adj = adjudication({ repair: { expectedAction: 'abstain', expectedChangedFiles: [] } });
  const pred = prediction({ repairAction: 'abstained', repairOutcome: 'not-attempted', repairGoldPatchExact: 'not-applicable' });
  const score = scoreFixture(f, adj, pred);
  assert.equal(score.goldPatchExact, 'not-applicable');
});
