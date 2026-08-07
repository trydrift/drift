import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  remediationKindFor,
  partitionCommits,
  planForCommits,
} from '../dist/remediation/partition.js';
import { findCommunityRecipe } from '../dist/remediation/registry.js';
import { applyBuiltinCodemod } from '../dist/remediation/apply.js';
import { executeCommunityRecipe } from '../dist/remediation/execute-recipe.js';
import { attemptCodemod } from '../dist/codemod/index.js';
import { buildPlan } from '../dist/plan/index.js';
import { DriftConfigSchema } from '../dist/config/schema.js';

const repo = {
  owner: 'acme',
  repo: 'app',
  baseBranch: 'main',
  beforeSha: 'a'.repeat(40),
  afterSha: 'b'.repeat(40),
};

const renameBreaking = (overrides: Record<string, unknown> = {}) => ({
  id: 'bc_1',
  dependency: 'acme-sdk',
  kind: 'renamed-export' as const,
  summary: '`oldName` was renamed to `newName`.',
  remediation: 'Replace every usage of `oldName` with `newName`.',
  symbols: ['oldName'],
  replacementSymbols: ['newName'],
  confidence: 'high' as const,
  citations: ['ev_1'],
  ...overrides,
});

const removedBreaking = (overrides: Record<string, unknown> = {}) => ({
  id: 'bc_2',
  dependency: 'acme-sdk',
  kind: 'removed-export' as const,
  summary: '`gone` was removed.',
  remediation: 'Remove every usage of `gone`.',
  symbols: ['gone'],
  confidence: 'high' as const,
  citations: ['ev_1'],
  ...overrides,
});

const site = (breakingChangeId: string, file: string, line = 1, symbol = 'oldName') => ({
  breakingChangeId,
  file,
  line,
  excerpt: `${symbol}()`,
  matchedSymbol: symbol,
  confidence: 'high' as const,
});

const RECIPE = {
  provider: 'codemod.com' as const,
  name: '@acme/upgrade-sdk',
  version: '1.2.3',
  publisher: 'Codemod.com',
  source: 'https://codemod.com/registry/@acme/upgrade-sdk',
  migration: 'Migrates `gone` usages to the v2 API.',
};

function commitUnit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'unit_1',
    order: 1,
    message: 'fix: update acme-sdk',
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
    ...overrides,
  };
}

describe('remediationKindFor / partitionCommits', () => {
  test('a built-in codemod always wins, regardless of community recipe permission', () => {
    const commit = commitUnit({ codemod: [{ ruleId: 'rename-identifier', from: 'oldName', to: 'newName', files: [], anchors: [] }], recipe: [RECIPE] });
    assert.equal(remediationKindFor(commit as never, true), 'builtin');
    assert.equal(remediationKindFor(commit as never, false), 'builtin');
  });

  test('a community recipe is only used when explicitly allowed — this is the "never silently execute" guarantee', () => {
    const commit = commitUnit({ recipe: [RECIPE] });
    assert.equal(remediationKindFor(commit as never, false), 'ai');
    assert.equal(remediationKindFor(commit as never, true), 'community-recipe');
  });

  test('nothing built-in or community falls to AI', () => {
    const commit = commitUnit();
    assert.equal(remediationKindFor(commit as never, true), 'ai');
  });

  test('partitionCommits splits a plan\'s commits into the three buckets in order', () => {
    const builtinCommit = commitUnit({ id: 'a', codemod: [{ ruleId: 'rename-identifier', from: 'x', to: 'y', files: [], anchors: [] }] });
    const recipeCommit = commitUnit({ id: 'b', recipe: [RECIPE] });
    const aiCommit = commitUnit({ id: 'c' });
    const plan = { commits: [builtinCommit, recipeCommit, aiCommit] } as never;

    const disabled = partitionCommits(plan, false);
    assert.deepEqual(disabled.builtin.map((c: never) => (c as { id: string }).id), ['a']);
    assert.deepEqual(disabled.communityRecipe, []);
    assert.deepEqual(disabled.ai.map((c: never) => (c as { id: string }).id), ['b', 'c']);

    const enabled = partitionCommits(plan, true);
    assert.deepEqual(enabled.builtin.map((c: never) => (c as { id: string }).id), ['a']);
    assert.deepEqual(enabled.communityRecipe.map((c: never) => (c as { id: string }).id), ['b']);
    assert.deepEqual(enabled.ai.map((c: never) => (c as { id: string }).id), ['c']);
  });

  test('planForCommits restricts commits and breakingChanges to the given subset', () => {
    const keep = commitUnit({ id: 'keep', breakingChangeIds: ['bc_1'] });
    const drop = commitUnit({ id: 'drop', breakingChangeIds: ['bc_2'] });
    const plan = {
      commits: [keep, drop],
      breakingChanges: [renameBreaking(), removedBreaking()],
    } as never;

    const filtered = planForCommits(plan, [keep] as never);
    assert.deepEqual(filtered.commits.map((c: never) => (c as { id: string }).id), ['keep']);
    assert.deepEqual(filtered.breakingChanges.map((b: never) => (b as { id: string }).id), ['bc_1']);
  });
});

describe('findCommunityRecipe', () => {
  test('the shipped registry is empty by default — no recipe is ever offered without a maintainer curating one', () => {
    assert.equal(findCommunityRecipe(removedBreaking() as never, undefined), null);
  });

  test('an injected source can match, so the resolution machinery is testable without a populated registry', () => {
    const source = {
      candidate: RECIPE,
      matches: (change: { dependency: string }) => change.dependency === 'acme-sdk',
    };
    assert.deepEqual(findCommunityRecipe(removedBreaking() as never, undefined, [source as never]), RECIPE);
  });

  test('a non-matching source yields no candidate', () => {
    const source = { candidate: RECIPE, matches: () => false };
    assert.equal(findCommunityRecipe(removedBreaking() as never, undefined, [source as never]), null);
  });
});

describe('applyBuiltinCodemod', () => {
  test('applies the codemod\'s anchored edits to the given file contents', () => {
    const result = attemptCodemod(
      renameBreaking() as never,
      [site('bc_1', 'src/app.ts', 1)],
      new Map([['src/app.ts', 'oldName();\n']]),
    );
    assert.ok(result);

    const commit = commitUnit({ codemod: [{ ...result!.transform, files: ['src/app.ts'] }] });
    const applied = applyBuiltinCodemod(commit as never, new Map([['src/app.ts', 'oldName();\n']]));

    assert.equal(applied.status, 'applied');
    assert.deepEqual(applied.edits, [{ path: 'src/app.ts', content: 'newName();\n' }]);
  });

  test('reports no-changes rather than an error when the anchor no longer matches', () => {
    const commit = commitUnit({
      codemod: [{ ruleId: 'rename-identifier', from: 'oldName', to: 'newName', files: ['src/app.ts'], anchors: [{ file: 'src/app.ts', line: 'oldName();' }] }],
    });
    const applied = applyBuiltinCodemod(commit as never, new Map([['src/app.ts', 'newName(); // already fixed\n']]));
    assert.equal(applied.status, 'no-changes');
    assert.deepEqual(applied.edits, []);
  });
});

describe('buildPlan: community recipe attachment', () => {
  const config = DriftConfigSchema.parse({ mode: 'auto' });

  test('a recipe is attached to a commit only when no codemod resolved it, and only with full coverage', () => {
    const plan = buildPlan({
      repo,
      config,
      changes: [],
      evidence: [],
      breakingChanges: [removedBreaking()] as never,
      impactSites: [site('bc_2', 'src/app.ts', 1, 'gone')] as never,
      recipes: new Map([['bc_2', RECIPE]]) as never,
    });

    assert.equal(plan.commits.length, 1);
    assert.deepEqual(plan.commits[0]!.recipe, [RECIPE]);
    assert.equal(plan.commits[0]!.codemod, undefined);
  });

  test('a built-in codemod on the same commit takes priority — no recipe is attached', () => {
    const result = attemptCodemod(
      renameBreaking() as never,
      [site('bc_1', 'src/app.ts', 1)],
      new Map([['src/app.ts', 'oldName();\n']]),
    );
    assert.ok(result);

    const plan = buildPlan({
      repo,
      config,
      changes: [],
      evidence: [],
      breakingChanges: [renameBreaking()] as never,
      impactSites: [site('bc_1', 'src/app.ts', 1)] as never,
      codemods: new Map([['bc_1', result!]]) as never,
      recipes: new Map([['bc_1', RECIPE]]) as never,
    });

    assert.equal(plan.commits.length, 1);
    assert.ok(plan.commits[0]!.codemod);
    assert.equal(plan.commits[0]!.recipe, undefined);
  });
});

describe('executeCommunityRecipe', () => {
  function fakeExec(script: Record<string, { code: number; stdout?: string; stderr?: string; failure?: 'not-found' }>) {
    return async (command: string, args: readonly string[]) => {
      const key = `${command} ${args.join(' ')}`;
      const match = Object.entries(script).find(([pattern]) => key.startsWith(pattern));
      if (!match) return { code: 0, stdout: '', stderr: '' };
      const [, result] = match;
      return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '', failure: result.failure };
    };
  }

  test('reports applied when the recipe changes files, sourced from git status', async () => {
    const exec = fakeExec({
      'git status --porcelain': { code: 0, stdout: '' }, // first call: before, clean
      'npx --yes codemod@latest run': { code: 0 },
    });
    let call = 0;
    const sequenced = async (command: string, args: readonly string[], opts?: unknown) => {
      call += 1;
      if (command === 'git' && call === 3) return { code: 0, stdout: ' M src/app.ts\n', stderr: '' };
      return exec(command, args, opts as never);
    };

    const result = await executeCommunityRecipe(RECIPE as never, '/tmp/worktree', { exec: sequenced as never });
    assert.equal(result.status, 'applied');
    assert.deepEqual(result.changedFiles, ['src/app.ts']);
  });

  test('reports no-changes when nothing moved', async () => {
    const exec = fakeExec({
      'git status --porcelain': { code: 0, stdout: '' },
      'npx --yes codemod@latest run': { code: 0 },
    });
    const result = await executeCommunityRecipe(RECIPE as never, '/tmp/worktree', { exec: exec as never });
    assert.equal(result.status, 'no-changes');
  });

  test('reports failed when the runner is not installed, never throwing', async () => {
    const exec = fakeExec({
      'git status --porcelain': { code: 0, stdout: '' },
      'npx --yes codemod@latest run': { code: 1, failure: 'not-found' },
    });
    const result = await executeCommunityRecipe(RECIPE as never, '/tmp/worktree', { exec: exec as never });
    assert.equal(result.status, 'failed');
    assert.match(result.message, /not installed/);
  });
});
