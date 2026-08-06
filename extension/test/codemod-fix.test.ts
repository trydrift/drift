import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommitCodemod } from '../src/fix.js';
import type { CommitUnit } from '../../src/types.js';

/**
 * `applyCommitCodemod` is the boundary between "the planner already proved
 * this commit needs no model" and the rest of the fix flow — the same review,
 * scope validation, and commit machinery an agent's output goes through. What
 * makes it safe is re-deriving the edit from the rule against whatever the
 * file actually contains right now, rather than replaying a stored snapshot
 * from analysis time, which could silently clobber or miss intervening edits.
 */

function commit(codemod: CommitUnit['codemod']): CommitUnit {
  return {
    id: 'unit_1',
    order: 1,
    message: 'refactor(acme-sdk): migrate oldName to newName',
    body: '',
    breakingChangeIds: ['bc_1'],
    files: ['src/app.ts'],
    allowedFiles: ['src/app.ts'],
    instructions: '',
    dependsOn: [],
    dependencyReasons: [],
    executionLayer: 0,
    expectedChecks: [],
    invalidationTriggers: [],
    ...(codemod ? { codemod } : {}),
  };
}

describe('applyCommitCodemod', () => {
  test('applies the transform fresh against the given content', () => {
    const outcome = applyCommitCodemod(
      commit([{ ruleId: 'rename-identifier', from: 'oldName', to: 'newName', files: ['src/app.ts'] }]),
      [{ path: 'src/app.ts', content: 'oldName();\n' }],
    );

    assert.equal(outcome.status, 'applied');
    assert.deepEqual(outcome.edits, [{ path: 'src/app.ts', content: 'newName();\n' }]);
    assert.match(outcome.message, /no agent call was made/);
  });

  test('re-derives against current content rather than a stale snapshot', () => {
    // If this replayed a stored `before`/`after` pair from analysis time, it
    // would have no idea an earlier commit already touched this file, and
    // either overwrite that edit or fail to find its own match at all.
    const outcome = applyCommitCodemod(
      commit([{ ruleId: 'rename-identifier', from: 'oldName', to: 'newName', files: ['src/app.ts'] }]),
      [{ path: 'src/app.ts', content: '// already migrated elsewhere\noldName();\nconst kept = 1;\n' }],
    );

    assert.equal(outcome.status, 'applied');
    assert.equal(
      outcome.edits![0]!.content,
      '// already migrated elsewhere\nnewName();\nconst kept = 1;\n',
    );
  });

  test('reports no-changes rather than a false "applied" when the rename already landed', () => {
    const outcome = applyCommitCodemod(
      commit([{ ruleId: 'rename-identifier', from: 'oldName', to: 'newName', files: ['src/app.ts'] }]),
      [{ path: 'src/app.ts', content: 'newName();\n' }],
    );

    assert.equal(outcome.status, 'no-changes');
    assert.equal(outcome.edits, undefined);
  });

  test('only edits the files the transform names, leaving the rest of the commit scope untouched', () => {
    const outcome = applyCommitCodemod(
      commit([{ ruleId: 'rename-identifier', from: 'oldName', to: 'newName', files: ['src/app.ts'] }]),
      [
        { path: 'src/app.ts', content: 'oldName();\n' },
        { path: 'src/other.ts', content: 'oldName();\n' },
      ],
    );

    assert.equal(outcome.edits!.length, 1);
    assert.equal(outcome.edits![0]!.path, 'src/app.ts');
  });

  test('applies every transform on the commit, across their own files', () => {
    const outcome = applyCommitCodemod(
      commit([
        { ruleId: 'rename-identifier', from: 'oldA', to: 'newA', files: ['src/a.ts'] },
        { ruleId: 'rename-identifier', from: 'oldB', to: 'newB', files: ['src/b.ts'] },
      ]),
      [
        { path: 'src/a.ts', content: 'oldA();\n' },
        { path: 'src/b.ts', content: 'oldB();\n' },
      ],
    );

    assert.equal(outcome.status, 'applied');
    assert.equal(outcome.edits!.length, 2);
  });
});
