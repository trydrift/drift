import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../dist/dispatch/index.js';
import { attemptCodemod } from '../dist/codemod/index.js';
import { buildPlan } from '../dist/plan/index.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { createLogger } from '../dist/util/logger.js';

/**
 * `dispatch()` is the one place a plan turns into an actual write. These
 * tests are about the shared remediation priority it now enforces: Drift's
 * own codemod, then (only when explicitly enabled) a community recipe, then
 * an agent — and never an agent for a commit already resolved.
 */

const repo = {
  owner: 'acme',
  repo: 'app',
  baseBranch: 'main',
  beforeSha: 'a'.repeat(40),
  afterSha: 'b'.repeat(40),
};

const logger = createLogger('error');

const evidence = [
  {
    id: 'ev_1',
    source: 'type-surface-diff' as const,
    dependency: 'acme-sdk',
    url: 'https://example.com/diff',
    title: 'API surface diff',
    content: 'change detail',
    weight: 1,
  },
];

const renameBreaking = () => ({
  id: 'bc_1',
  dependency: 'acme-sdk',
  kind: 'renamed-export' as const,
  summary: '`oldName` was renamed to `newName`.',
  remediation: 'Replace every usage of `oldName` with `newName`.',
  symbols: ['oldName'],
  replacementSymbols: ['newName'],
  confidence: 'high' as const,
  citations: ['ev_1'],
});

const removedBreaking = () => ({
  id: 'bc_2',
  dependency: 'acme-sdk',
  kind: 'removed-export' as const,
  summary: '`gone` was removed.',
  remediation: 'Remove every usage of `gone`.',
  symbols: ['gone'],
  confidence: 'high' as const,
  citations: ['ev_1'],
});

const site = (breakingChangeId: string, file: string, symbol: string) => ({
  breakingChangeId,
  file,
  line: 1,
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

function fakeGithub() {
  const calls: string[] = [];
  return {
    calls,
    async createBranch() {
      calls.push('createBranch');
      return true;
    },
    async commitFiles(_r: unknown, _b: string, files: { path: string }[]) {
      calls.push(`commitFiles:${files.map((f) => f.path).join(',')}`);
      return { sha: 'c'.repeat(40) };
    },
    async createCheckRun() {
      calls.push('createCheckRun');
    },
    async createPullRequest() {
      calls.push('createPullRequest');
      return { number: 1, url: 'https://github.com/acme/app/pull/1', existing: false };
    },
    async findPullRequestForBranch() {
      return null;
    },
    async getDefaultBranch() {
      return 'main';
    },
    async createIssue() {
      calls.push('createIssue');
      return { number: 2, url: 'https://github.com/acme/app/issues/2' };
    },
    async findOpenPlanIssue() {
      return null;
    },
  };
}

async function withWorkspace<T>(content: string, fn: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), 'drift-dispatch-'));
  try {
    await writeFile(join(workspace, 'app.ts'), content, 'utf8');
    return await fn(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe('dispatch: deterministic remediation before an agent', () => {
  test('a fully codemod-resolvable plan is committed directly and never needs a Copilot token', async () => {
    await withWorkspace('oldName();\n', async (workspace) => {
      const codemodResult = attemptCodemod(
        renameBreaking() as never,
        [site('bc_1', 'app.ts', 'oldName')],
        new Map([['app.ts', 'oldName();\n']]),
      );
      assert.ok(codemodResult);

      const config = DriftConfigSchema.parse({ mode: 'auto' });
      const plan = buildPlan({
        repo: { ...repo, workspace },
        config,
        changes: [],
        evidence,
        breakingChanges: [renameBreaking()] as never,
        impactSites: [site('bc_1', 'app.ts', 'oldName')] as never,
        codemods: new Map([['bc_1', codemodResult!]]) as never,
      });
      assert.equal(plan.commits.length, 1);
      assert.ok(plan.commits[0]!.codemod);

      const github = fakeGithub();
      const result = await dispatch({
        repo: { ...repo, workspace },
        plan,
        config,
        github: github as never,
        logger,
        // No copilotToken at all — proves an agent was never needed.
      });

      assert.equal(result.status, 'dispatched');
      assert.equal(result.taskId, undefined);
      assert.ok(github.calls.some((c) => c.startsWith('commitFiles:app.ts')));
      assert.ok(github.calls.includes('createPullRequest'));
      assert.match(result.message, /deterministically/);
    });
  });

  test('a community recipe is never used unless remediation.communityRecipes is true, even with no agent available', async () => {
    await withWorkspace('gone();\n', async (workspace) => {
      const config = DriftConfigSchema.parse({ mode: 'auto', remediation: { communityRecipes: false } });
      const plan = buildPlan({
        repo: { ...repo, workspace },
        config,
        changes: [],
        evidence,
        breakingChanges: [removedBreaking()] as never,
        impactSites: [site('bc_2', 'app.ts', 'gone')] as never,
        recipes: new Map([['bc_2', RECIPE]]) as never,
      });
      assert.equal(plan.commits.length, 1);
      assert.deepEqual(plan.commits[0]!.recipe, [RECIPE]);

      const github = fakeGithub();
      const result = await dispatch({
        repo: { ...repo, workspace },
        plan,
        config,
        github: github as never,
        logger,
        // No copilotToken: with the recipe disabled, this commit needs an
        // agent and none is available, so it must fall back to approval —
        // never fall through to using the recipe anyway.
      });

      assert.equal(result.status, 'blocked');
      assert.ok(github.calls.includes('createIssue'));
      assert.ok(!github.calls.some((c) => c.startsWith('commitFiles')));
    });
  });

  test('recipe failure falls back to approval safely rather than guessing', async () => {
    await withWorkspace('gone();\n', async (workspace) => {
      const config = DriftConfigSchema.parse({ mode: 'auto', remediation: { communityRecipes: true } });
      const plan = buildPlan({
        repo: { ...repo, workspace },
        config,
        changes: [],
        evidence,
        breakingChanges: [removedBreaking()] as never,
        impactSites: [site('bc_2', 'app.ts', 'gone')] as never,
        recipes: new Map([['bc_2', RECIPE]]) as never,
      });

      const github = fakeGithub();
      // A fake `exec` makes the recipe runner itself fail, quickly and
      // deterministically — never actually shelling out to `npx` — so the
      // commit is expected to remain unresolved and fall back to approval.
      const exec = async () => ({ code: 1, stdout: '', stderr: 'recipe exploded', failure: 'error' as const });
      const result = await dispatch({
        repo: { ...repo, workspace },
        plan,
        config,
        github: github as never,
        logger,
        exec: exec as never,
      });

      assert.equal(result.status, 'blocked');
      assert.ok(!github.calls.some((c) => c.startsWith('commitFiles')));
    });
  });
});
