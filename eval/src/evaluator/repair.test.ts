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
  repair: { expectedAction: 'deterministic-repair', expectedChangedFiles: ['src/app.js'] },
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

test('an agent timeout is a delivery failure and stays in the denominator', () => {
  const score = scoreRepair(
    input({ repair: { ...ATTEMPTED, attempted: false, notAttemptedReason: 'agent-timeout', changedFiles: [], patch: '' } }),
  );
  // Drift began this case and did not finish it. Excluding it — which this
  // used to do — lets an end-to-end rate be improved by failing differently.
  assert.equal(score.outcome, 'delivery-failure');
  assert.equal(score.scorable, true);
  assert.equal(isRepairSuccess(score.outcome), false);
});

test('a required agent that was not there is a delivery failure, not a policy abstention', () => {
  const score = scoreRepair(
    input({
      track: 'repair-full-remediation',
      repair: { ...ATTEMPTED, attempted: false, notAttemptedReason: 'agent-required-unavailable', changedFiles: [], patch: '' },
      truth: { ...TRUTH, repair: { expectedAction: 'agent-delegation', expectedChangedFiles: [] } },
    }),
  );
  assert.equal(score.outcome, 'delivery-failure');
  assert.equal(score.scorable, true);
});

test('a standalone tier whose provider does not exist here was never asked, and is excluded with its reason', () => {
  for (const reason of ['agent-unavailable', 'cache-unavailable', 'recipe-unavailable', 'model-unavailable'] as const) {
    const score = scoreRepair(
      input({ repair: { ...ATTEMPTED, attempted: false, notAttemptedReason: reason, changedFiles: [], patch: '' } }),
    );
    assert.equal(score.outcome, 'environment-unavailable', reason);
    assert.equal(score.scorable, false, reason);
    assert.equal(score.exclusionReason, reason);
  }
});

test('a tier that claimed a commit and emitted no diff is a delivery failure, not a missed opportunity', () => {
  const score = scoreRepair(
    input({ repair: { ...ATTEMPTED, attempted: false, notAttemptedReason: 'empty-patch', changedFiles: [], patch: '' } }),
  );
  assert.equal(score.outcome, 'delivery-failure');
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
  assert.equal(score.outcome, 'case-invalid');
  assert.equal(score.scorable, false);
  assert.equal(score.exclusionReason, 'baseline stage did not behave as the case declares');
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

test('the agent track is not blamed for an abstention decision its planner made', () => {
  // Standalone, the harness points the agent at exactly the commits Drift's
  // planner routed to the agent tier. Scoring it against `expectedAction:
  // abstain` would blame the agent for a decision it never made -- and the
  // first real Codex run scored three oracle-confirmed correct repairs as
  // unsafe attempts for exactly this reason.
  const score = scoreRepair(
    input({ track: 'repair-agent', truth: { ...TRUTH, repair: { expectedAction: 'abstain', expectedChangedFiles: ['src/app.js'] } } }),
  );
  assert.equal(score.outcome, 'repaired');
});

test('the full-remediation track, where Drift chooses its own tier, still is', () => {
  const score = scoreRepair(
    input({ track: 'repair-full-remediation', truth: { ...TRUTH, repair: { expectedAction: 'abstain', expectedChangedFiles: [] } } }),
  );
  assert.equal(score.outcome, 'unsafe-attempt');
});

test('a wrong repair is caught by the oracle even on a track with no abstention policy', () => {
  const score = scoreRepair(
    input({
      track: 'repair-agent',
      truth: { ...TRUTH, repair: { expectedAction: 'abstain', expectedChangedFiles: [] } },
      oracleStages: [
        stage('baseline', 'pass', 'pass', []),
        stage('broken', 'fail', 'fail', ['runtime:TypeError:fixture.oldQuery is not a function']),
        stage('repaired', 'pass', 'fail', ['runtime:TypeError:fixture.newQuery is not a function']),
      ],
    }),
  );
  assert.equal(score.outcome, 'introduced-regression', 'a hallucinated replacement symbol is still a failure');
});

/**
 * A fix plan that explains only some of a finding's call sites.
 *
 * Production's own `minCoverage` gate rejects a rule below the configured
 * threshold, and `residualImpactSites` records what an accepted-but-partial
 * plan left behind. Neither is what stops it being called a repair: the oracle
 * is, because a site nothing reached keeps failing. This pins that a partial
 * repair stays `partially-repaired` — in the denominator, not a success, and
 * not quietly excluded either.
 *
 * (No case in the current corpus has enough call sites for a genuinely partial
 * plan to arise, which is recorded as a limitation in eval/README.md. This is
 * the evaluator half of the property, which is the half that could silently
 * change.)
 */
test('a repair that resolves some triggers and leaves others is never a success, and never excluded', () => {
  const score = scoreRepair({
    caseId: 'partial',
    track: 'repair-fixplan-model',
    repair: {
      ...ATTEMPTED,
      residualImpactSites: 3,
    },
    oracleStages: [
      stage('baseline', 'pass', 'pass', []),
      stage('broken', 'fail', 'fail', ['runtime:TypeError:a', 'runtime:TypeError:b']),
      stage('repaired', 'pass', 'fail', ['runtime:TypeError:b']),
    ],
    truth: TRUTH,
    developerPatch: null,
  });

  assert.equal(score.outcome, 'partially-repaired');
  assert.equal(score.scorable, true, 'a partial repair is a product result and stays in the denominator');
  assert.equal(isRepairSuccess(score.outcome), false);
  assert.deepEqual(score.failToPass.resolvedTriggers, ['runtime:TypeError:a']);
  assert.deepEqual(score.failToPass.unresolvedTriggers, ['runtime:TypeError:b']);
  assert.equal(score.residualImpactSites, 3, 'the sites nothing reached are reported, not rounded away');
});
