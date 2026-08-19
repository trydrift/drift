import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreRepair, isRepairSuccess, type ScoreRepairInput } from './repair.ts';
import type { OracleStageArtifact, RepairArtifact } from '../artifacts/prediction.ts';
import type { Conclusion } from '../review.ts';

function stage(
  name: OracleStageArtifact['stage'],
  expected: 'pass' | 'fail',
  observed: OracleStageArtifact['observed'],
  signature: string[],
): OracleStageArtifact {
  return {
    stage: name,
    expected,
    observed,
    matchesExpectation: observed !== 'unable-to-run' && observed === expected,
    signature,
    exitCode: observed === 'pass' ? 0 : 1,
    outputExcerpt: '',
    durationMs: 1,
  };
}

const ATTEMPTED: RepairArtifact = {
  attempted: true,
  notAttemptedReason: null,
  resolvedByTier: [{ commitId: 'c1', tier: 'codemod' }],
  patch: 'diff --git a/src/app.js b/src/app.js\n@@\n-oldName()\n+newName()\n',
  changedFiles: ['src/app.js'],
  scopeEscapeFiles: [],
  scopeValidationReasons: [],
  patchStats: { files: 1, hunks: 1, addedLines: 1, removedLines: 1 },
  residualImpactSites: 0,
};

const TRUTH: Conclusion = {
  upstreamFindings: [],
  impactSites: [],
  gaps: [],
  groundTruthSafety: 'unsafe',
  repair: { expectedAction: 'repair', expectedChangedFiles: ['src/app.js'] },
};

function input(overrides: Partial<ScoreRepairInput> = {}): ScoreRepairInput {
  return {
    caseId: 'c',
    track: 'repair-codemod',
    repair: ATTEMPTED,
    oracleStages: [
      stage('baseline', 'pass', 'pass', []),
      stage('broken', 'fail', 'fail', ['runtime:TypeError:lib.oldName is not a function']),
      stage('repaired', 'pass', 'pass', []),
    ],
    truth: TRUTH,
    developerPatch: null,
    ...overrides,
  };
}

test('a repair that clears the trigger failures and regresses nothing is credited', () => {
  const score = scoreRepair(input());
  assert.equal(score.outcome, 'repaired');
  assert.ok(isRepairSuccess(score.outcome));
  assert.equal(score.scorable, true);
});

test('a green repaired stage is not enough when the trigger failure survives', () => {
  const score = scoreRepair(
    input({
      oracleStages: [
        stage('baseline', 'pass', 'pass', []),
        stage('broken', 'fail', 'fail', ['runtime:TypeError:x']),
        stage('repaired', 'pass', 'fail', ['runtime:TypeError:x']),
      ],
    }),
  );
  assert.equal(score.outcome, 'failed-to-fix');
});

test('a repair that trades one failure for another is a regression, not a success', () => {
  const score = scoreRepair(
    input({
      oracleStages: [
        stage('baseline', 'pass', 'pass', []),
        stage('broken', 'fail', 'fail', ['runtime:TypeError:x']),
        stage('repaired', 'pass', 'fail', ['test:serializes dates']),
      ],
    }),
  );
  assert.equal(score.outcome, 'introduced-regression');
  assert.deepEqual(score.failToPass.newFailures, ['test:serializes dates']);
});

test('a repair that escapes its own declared scope is never a success, however green', () => {
  const score = scoreRepair(
    input({ repair: { ...ATTEMPTED, changedFiles: ['src/app.js', '.github/workflows/ci.yml'], scopeEscapeFiles: ['.github/workflows/ci.yml'] } }),
  );
  assert.notEqual(score.outcome, 'repaired');
  assert.deepEqual(score.productionScopeEscapes, ['.github/workflows/ci.yml']);
});

test('an agent timeout is an operational failure and enters no rate', () => {
  const score = scoreRepair(
    input({ repair: { ...ATTEMPTED, attempted: false, notAttemptedReason: 'agent-timeout', changedFiles: [], patch: '' } }),
  );
  assert.equal(score.outcome, 'operational-failure');
  assert.equal(score.scorable, false);
});

test('an agent that changed nothing is not a success', () => {
  const score = scoreRepair(
    input({ repair: { ...ATTEMPTED, attempted: false, notAttemptedReason: 'empty-patch', changedFiles: [], patch: '' } }),
  );
  assert.equal(score.outcome, 'missed-opportunity');
  assert.equal(isRepairSuccess(score.outcome), false);
});

test('declining where truth says abstain is a correct abstention', () => {
  const score = scoreRepair(
    input({
      repair: { ...ATTEMPTED, attempted: false, notAttemptedReason: 'abstained-by-policy', changedFiles: [], patch: '' },
      truth: { ...TRUTH, repair: { expectedAction: 'abstain', expectedChangedFiles: [] } },
    }),
  );
  assert.equal(score.outcome, 'correct-abstention');
});

test('attempting where truth says abstain is unsafe even when the oracle goes green', () => {
  const score = scoreRepair(input({ truth: { ...TRUTH, repair: { expectedAction: 'abstain', expectedChangedFiles: [] } } }));
  assert.equal(score.outcome, 'unsafe-attempt');
});

test('an invalid baseline makes every later observation uninterpretable', () => {
  const score = scoreRepair(
    input({
      oracleStages: [
        stage('baseline', 'pass', 'fail', ['test:already broken']),
        stage('broken', 'fail', 'fail', ['test:already broken']),
        stage('repaired', 'pass', 'pass', []),
      ],
    }),
  );
  assert.equal(score.outcome, 'operational-failure');
  assert.equal(score.scorable, false);
});

test('a bump that broke nothing cannot credit a repair', () => {
  const score = scoreRepair(
    input({
      oracleStages: [
        stage('baseline', 'pass', 'pass', []),
        stage('broken', 'fail', 'fail', []),
        stage('repaired', 'pass', 'pass', []),
      ],
    }),
  );
  assert.equal(score.outcome, 'no-trigger');
  assert.equal(score.scorable, false);
});

test('a semantically correct repair that differs textually from the developer patch still passes', () => {
  const score = scoreRepair(input({ developerPatch: 'diff --git a/src/app.js b/src/app.js\n@@\n-oldName();\n+newName( );\n' }));
  assert.equal(score.outcome, 'repaired');
  assert.equal(score.goldPatchExact, false, 'reported as a diagnostic');
  assert.ok(isRepairSuccess(score.outcome), 'and does not gate the verdict');
});

test('gold-patch exactness is not-applicable when nothing was compared', () => {
  assert.equal(scoreRepair(input()).goldPatchExact, 'not-applicable');
  assert.equal(
    scoreRepair(input({ repair: { ...ATTEMPTED, attempted: false, notAttemptedReason: 'abstained-by-policy' }, developerPatch: 'x' })).goldPatchExact,
    'not-applicable',
  );
});

test('changed-file confusion is scored against adjudicated truth, not against the plan scope', () => {
  const score = scoreRepair(
    input({ repair: { ...ATTEMPTED, changedFiles: ['src/app.js', 'src/other.js'] } }),
  );
  assert.deepEqual(score.changedFiles, { tp: 1, fp: 1, fn: 0 });
  assert.deepEqual(score.unexpectedChangedFiles, ['src/other.js']);
  assert.deepEqual(score.productionScopeEscapes, [], 'an in-scope surprise is not a safety failure');
});
