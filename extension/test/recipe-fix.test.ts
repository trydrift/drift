import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommitRecipe } from '../src/fix.js';
import type { CommitUnit } from '../../src/types.js';

/**
 * `applyCommitRecipe` is the recipe-tier counterpart to `applyCommitCodemod`
 * (see `codemod-fix.test.ts`) — the boundary between "a community recipe was
 * offered and chosen" and the rest of the fix flow. It never decides *whether*
 * to run a recipe (the ask-gate in `runFixOnBranch` does that, once, before
 * anything is written); it only runs what it is given and reports the
 * outcome truthfully, including "failed" rather than silently swallowing an
 * error.
 */

const RECIPE = {
  provider: 'codemod.com' as const,
  name: '@acme/upgrade-sdk',
  version: '1.2.3',
  publisher: 'Codemod.com',
  source: 'https://codemod.com/registry/@acme/upgrade-sdk',
  migration: 'Migrates `gone` usages to the v2 API.',
  official: true,
};

function commit(recipe: CommitUnit['recipe']): CommitUnit {
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
    ...(recipe ? { recipe } : {}),
  };
}

describe('applyCommitRecipe', () => {
  test('reports no-changes when the commit was never actually offered a recipe', async () => {
    const outcome = await applyCommitRecipe(commit(undefined), '/tmp/worktree');
    assert.equal(outcome.status, 'no-changes');
  });

  test('applies via the injected runner and reports its message', async () => {
    const outcome = await applyCommitRecipe(commit([RECIPE]), '/tmp/worktree', async (candidate, root) => {
      assert.equal(candidate, RECIPE);
      assert.equal(root, '/tmp/worktree');
      return { status: 'applied', changedFiles: ['src/app.ts'], message: 'Applied it.' };
    });
    assert.equal(outcome.status, 'applied');
    assert.equal(outcome.message, 'Applied it.');
  });

  test('surfaces a failure rather than reporting success', async () => {
    const outcome = await applyCommitRecipe(commit([RECIPE]), '/tmp/worktree', async () => ({
      status: 'failed',
      changedFiles: [],
      message: 'recipe blew up',
    }));
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.message, 'recipe blew up');
  });

  test('deduplicates identical recipe entries across multiple breaking changes in one commit', async () => {
    let calls = 0;
    const outcome = await applyCommitRecipe(commit([RECIPE, RECIPE]), '/tmp/worktree', async () => {
      calls += 1;
      return { status: 'applied', changedFiles: ['src/app.ts'], message: 'ok' };
    });
    assert.equal(calls, 1);
    assert.equal(outcome.status, 'applied');
  });
});
