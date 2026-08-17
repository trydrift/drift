import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommitFixPlan, fixPlanAssessmentOf } from '../src/fix.js';
import type { CommitUnit } from '../../src/types.js';

/**
 * `applyCommitFixPlan` is the fix-plan-tier counterpart to
 * `applyCommitCodemod` (see `codemod-fix.test.ts`) — the boundary between "a
 * validated plan was accepted" and the rest of the fix flow.
 *
 * It replaces `applyCommitRecipe`, which used to run a community recipe here.
 * Nothing third-party executes at this point any more: a recipe, when one was
 * involved at all, ran during analysis in a throwaway worktree and
 * contributed only the operations Drift could re-derive from what it did. By
 * the time the editor applies anything, every operation is Drift's own.
 */

const FIX_PLAN: NonNullable<CommitUnit['fixPlan']> = {
  plan: {
    schemaVersion: 2,
    id: 'fp_1',
    breakingChangeId: 'bc_2',
    dependency: 'acme-sdk',
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    changeKind: 'renamed-export',
    migration: '`gone` became `arrived`.',
    rationale: 'The changelog states the rename.',
    ops: [{ kind: 'rename-identifier', from: 'gone', to: 'arrived' }],
    citations: ['ev_1'],
    provenance: { author: 'model', model: 'claude-opus-5', authoredAt: '2026-01-01T00:00:00Z' },
  },
  assurance: 'proven',
  files: ['src/app.ts'],
  anchors: [{ file: 'src/app.ts', line: 'gone();', lineNumber: 1, column: 0, matchedText: 'gone(' }],
  covered: 1,
  residual: 0,
  residualSites: [],
};

function commit(fixPlan?: CommitUnit['fixPlan']): CommitUnit {
  return {
    id: 'unit_1',
    order: 1,
    message: 'fix(acme-sdk): migrate away from gone',
    body: '',
    breakingChangeIds: ['bc_2'],
    files: ['src/app.ts'],
    allowedFiles: ['src/app.ts'],
    instructions: '',
    dependsOn: [],
    dependencyReasons: [],
    executionLayer: 0,
    expectedChecks: [],
    invalidationTriggers: [],
    ...(fixPlan ? { fixPlan } : {}),
  };
}

describe('applyCommitFixPlan', () => {
  test('reports no-changes when the commit carries no plan', () => {
    const outcome = applyCommitFixPlan(commit(undefined), [{ path: 'src/app.ts', content: 'gone();\n' }]);
    assert.equal(outcome.status, 'no-changes');
  });

  test('applies the plan’s operations to the anchored line only', () => {
    const outcome = applyCommitFixPlan(commit(FIX_PLAN), [
      { path: 'src/app.ts', content: 'gone();\ngone();\n' },
    ]);

    assert.equal(outcome.status, 'applied');
    // The second `gone()` was never localized, so it was never anchored.
    assert.equal(outcome.edits?.[0]!.content, 'arrived();\ngone();\n');
    assert.match(outcome.message, /fp_1/);
  });

  test('re-derives against live content, so a shifted file still resolves', () => {
    const outcome = applyCommitFixPlan(commit(FIX_PLAN), [
      { path: 'src/app.ts', content: '// header added since analysis\ngone();\n' },
    ]);

    assert.equal(outcome.status, 'applied');
    assert.equal(outcome.edits?.[0]!.content, '// header added since analysis\narrived();\n');
  });

  test('is idempotent — a second application changes nothing', () => {
    const once = applyCommitFixPlan(commit(FIX_PLAN), [{ path: 'src/app.ts', content: 'gone();\n' }]);
    const twice = applyCommitFixPlan(commit(FIX_PLAN), [
      { path: 'src/app.ts', content: once.edits![0]!.content },
    ]);

    assert.equal(twice.status, 'no-changes');
  });

  test('says how much work an agent is still left when coverage is partial', () => {
    const partial = {
      ...FIX_PLAN,
      covered: 1,
      residual: 2,
      residualSites: [
        { file: 'src/b.ts', line: 3, reason: 'no rule matched' },
        { file: 'src/c.ts', line: 9, reason: 'no rule matched' },
      ],
    };

    const outcome = applyCommitFixPlan(commit(partial), [{ path: 'src/app.ts', content: 'gone();\n' }]);
    assert.equal(outcome.status, 'applied');
    assert.match(outcome.message, /2 call sites still need an agent/);
  });
});

describe('fixPlanAssessmentOf', () => {
  test('reconstructs the shape the shared renderer and policy read', () => {
    const assessment = fixPlanAssessmentOf(commit(FIX_PLAN));
    assert.equal(assessment.verdict, 'accepted');
    assert.equal(assessment.assurance, 'proven');
    assert.equal(assessment.plan.id, 'fp_1');
  });

  test('a plan leaving residual sites is partial, not accepted', () => {
    const assessment = fixPlanAssessmentOf(
      commit({ ...FIX_PLAN, residual: 1, residualSites: [{ file: 'src/b.ts', line: 3, reason: 'no rule matched' }] }),
    );
    assert.equal(assessment.verdict, 'partial');
    assert.equal(assessment.sites[0]!.status, 'residual');
  });
});
