import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  remediationKindFor,
  partitionCommits,
  hasResidualWork,
  planForCommits,
} from '../dist/remediation/partition.js';
import { findCommunityRecipe } from '../dist/remediation/registry.js';
import { queryCodemodRegistry, queryOpenRewriteRegistry } from '../dist/remediation/live-search.js';
import { applyBuiltinCodemod } from '../dist/remediation/apply.js';
import { executeCommunityRecipe } from '../dist/remediation/execute-recipe.js';
import { attemptCodemod } from '../dist/codemod/index.js';
import { buildPlan } from '../dist/plan/index.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { clearHttpCache } from '../dist/util/http.js';

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

const dependencyChange = (name: string, ecosystem: 'npm' | 'maven' = 'npm') => ({
  name,
  ecosystem,
  from: '1.0.0',
  to: '2.0.0',
  kind: 'runtime' as const,
  bump: 'major' as const,
  manifestPath: ecosystem === 'maven' ? 'pom.xml' : 'package.json',
});

const RECIPE = {
  provider: 'codemod.com' as const,
  name: '@acme/upgrade-sdk',
  version: '1.2.3',
  publisher: 'Codemod.com',
  source: 'https://codemod.com/registry/@acme/upgrade-sdk',
  migration: 'Migrates `gone` usages to the v2 API.',
  official: true,
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

const FIX_PLAN = {
  plan: {
    schemaVersion: 2,
    id: 'fp_1',
    breakingChangeId: 'bc_1',
    dependency: 'acme-sdk',
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    changeKind: 'renamed-export' as const,
    migration: '`gone` became `arrived`.',
    rationale: '',
    ops: [{ kind: 'rename-identifier' as const, from: 'gone', to: 'arrived' }],
    citations: ['ev_1'],
    provenance: { author: 'model' as const, authoredAt: '2026-01-01T00:00:00Z' },
  },
  assurance: 'proven' as const,
  files: ['src/app.ts'],
  anchors: [{ file: 'src/app.ts', line: 'gone();', lineNumber: 1, column: 0, matchedText: 'gone(' }],
  covered: 1,
  residual: 0,
  residualSites: [],
};

describe('remediationKindFor / partitionCommits', () => {
  test('a built-in codemod always wins — it needed no model and no validation', () => {
    const commit = commitUnit({
      codemod: [{ ruleId: 'rename-identifier', from: 'oldName', to: 'newName', files: [], anchors: [] }],
      fixPlan: FIX_PLAN,
      recipe: [RECIPE],
    });
    assert.equal(remediationKindFor(commit as never), 'builtin');
  });

  test('a validated fix plan is its own tier, above AI', () => {
    assert.equal(remediationKindFor(commitUnit({ fixPlan: FIX_PLAN }) as never), 'fix-plan');
  });

  test('a matched community recipe is not, by itself, an execution path any more', () => {
    // The recipe tier is gone: a recipe proposes a fix plan (which then has to
    // pass the same gate as any other proposal) or it does nothing at all.
    // Recipe metadata with no resulting plan means nothing was re-derivable.
    assert.equal(remediationKindFor(commitUnit({ recipe: [RECIPE] }) as never), 'ai');
  });

  test('nothing deterministic falls to AI', () => {
    assert.equal(remediationKindFor(commitUnit() as never), 'ai');
  });

  test('partitionCommits splits a plan\'s commits into the three buckets in order', () => {
    const builtinCommit = commitUnit({ id: 'a', codemod: [{ ruleId: 'rename-identifier', from: 'x', to: 'y', files: [], anchors: [] }] });
    const fixPlanCommit = commitUnit({ id: 'b', fixPlan: FIX_PLAN });
    const aiCommit = commitUnit({ id: 'c', recipe: [RECIPE] });
    const plan = { commits: [builtinCommit, fixPlanCommit, aiCommit] } as never;

    const split = partitionCommits(plan);
    assert.deepEqual(split.builtin.map((c: never) => (c as { id: string }).id), ['a']);
    assert.deepEqual(split.fixPlan.map((c: never) => (c as { id: string }).id), ['b']);
    assert.deepEqual(split.ai.map((c: never) => (c as { id: string }).id), ['c']);
  });

  test('a partially covering fix plan still reports residual work', () => {
    const full = commitUnit({ id: 'full', fixPlan: FIX_PLAN });
    const partial = commitUnit({
      id: 'partial',
      fixPlan: { ...FIX_PLAN, covered: 9, residual: 1, residualSites: [{ file: 'src/b.ts', line: 4, reason: 'no rule matched' }] },
    });

    assert.equal(hasResidualWork(full as never), false);
    assert.equal(hasResidualWork(partial as never), true);
    assert.equal(hasResidualWork(commitUnit() as never), true);
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

describe('findCommunityRecipe: live discovery orchestration', () => {
  test('no registry queried is no candidate found — never a crash', async () => {
    assert.equal(await findCommunityRecipe(removedBreaking() as never, undefined, []), null);
  });

  test('an injected query can match, so this is testable without a real network call', async () => {
    const query = async (change: { dependency: string }) => (change.dependency === 'acme-sdk' ? RECIPE : null);
    assert.deepEqual(await findCommunityRecipe(removedBreaking() as never, undefined, [query as never]), RECIPE);
  });

  test('a non-matching query contributes no candidate', async () => {
    const query = async () => null;
    assert.equal(await findCommunityRecipe(removedBreaking() as never, undefined, [query as never]), null);
  });

  test('a query that throws is treated the same as a query that finds nothing — never fails the run', async () => {
    const query = async () => {
      throw new Error('registry unreachable');
    };
    assert.equal(await findCommunityRecipe(removedBreaking() as never, undefined, [query as never]), null);
  });

  test('an official match is preferred over an unofficial one, regardless of query order', async () => {
    const unofficial = { ...RECIPE, name: '@randomer/recipe', official: false };
    const official = { ...RECIPE, name: '@acme/official-recipe', official: true };

    const queries = [async () => unofficial, async () => official];
    const found = await findCommunityRecipe(removedBreaking() as never, undefined, queries as never);
    assert.equal(found!.name, '@acme/official-recipe');

    const reversed = [async () => official, async () => unofficial];
    const foundReversed = await findCommunityRecipe(removedBreaking() as never, undefined, reversed as never);
    assert.equal(foundReversed!.name, '@acme/official-recipe');
  });
});

describe('live-search: trust boundary and defensive parsing', () => {
  const originalFetch = globalThis.fetch;

  function mockFetch(handler: (url: string) => { status: number; body: string } | null) {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      const result = handler(url);
      if (!result) return new Response('not found', { status: 404 });
      return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }

  test('only the two hardcoded registry hosts are ever requested', async () => {
    const requested: string[] = [];
    mockFetch((url) => {
      requested.push(new URL(url).host);
      return { status: 200, body: JSON.stringify({ entries: [] }) };
    });
    clearHttpCache();

    await queryCodemodRegistry(removedBreaking() as never, dependencyChange('acme-sdk', 'maven'));
    await queryOpenRewriteRegistry(removedBreaking() as never, dependencyChange('acme-sdk', 'maven'));

    for (const host of requested) {
      assert.ok(
        host === 'api.codemod.com' || host === 'search.maven.org',
        `unexpected registry host queried: ${host}`,
      );
    }
    globalThis.fetch = originalFetch;
  });

  test('queryCodemodRegistry matches on the dependency name and pins the returned version', async () => {
    mockFetch((url) => {
      if (new URL(url).host !== 'api.codemod.com') return null;
      return {
        status: 200,
        body: JSON.stringify({
          entries: [
            {
              slug: '@acme/upgrade-sdk',
              version: '1.2.3',
              description: 'Migrates acme-sdk usages to the v2 API.',
              verified: true,
              owner: { name: 'Codemod.com' },
            },
            { slug: 'totally-unrelated', version: '9.9.9', description: 'Nothing to do with this.' },
          ],
        }),
      };
    });
    clearHttpCache();

    const found = await queryCodemodRegistry(removedBreaking() as never, dependencyChange('acme-sdk', 'npm'));
    assert.ok(found);
    assert.equal(found!.name, '@acme/upgrade-sdk');
    assert.equal(found!.version, '1.2.3');
    assert.equal(found!.official, true);
    globalThis.fetch = originalFetch;
  });

  test('queryCodemodRegistry never matches an unrelated entry', async () => {
    mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ entries: [{ slug: 'totally-unrelated', version: '1.0.0', description: 'other' }] }),
    }));
    clearHttpCache();

    assert.equal(await queryCodemodRegistry(removedBreaking() as never, dependencyChange('acme-sdk', 'npm')), null);
    globalThis.fetch = originalFetch;
  });

  test('queryCodemodRegistry degrades to no candidate on a malformed response, never throwing', async () => {
    mockFetch(() => ({ status: 200, body: 'not json at all' }));
    clearHttpCache();

    const found = await queryCodemodRegistry(removedBreaking() as never, dependencyChange('acme-sdk', 'npm'));
    assert.equal(found, null);
    globalThis.fetch = originalFetch;
  });

  test('queryCodemodRegistry degrades to no candidate when the registry is unreachable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ENOTFOUND api.codemod.com');
    }) as typeof fetch;
    clearHttpCache();

    const found = await queryCodemodRegistry(removedBreaking() as never, dependencyChange('acme-sdk', 'npm'));
    assert.equal(found, null);
    globalThis.fetch = originalFetch;
  });

  test('queryOpenRewriteRegistry only ever proposes org.openrewrite.recipe coordinates, and only with a named recipe id', async () => {
    mockFetch((url) => {
      if (url.includes('solrsearch')) {
        return {
          status: 200,
          body: JSON.stringify({
            response: { docs: [{ g: 'org.openrewrite.recipe', a: 'rewrite-acme-sdk', latestVersion: '4.5.6' }] },
          }),
        };
      }
      if (url.includes('remotecontent')) {
        return {
          status: 200,
          body: '<project><description>Runs org.openrewrite.acme.UpgradeAcmeSdk to migrate.</description></project>',
        };
      }
      return null;
    });
    clearHttpCache();

    const found = await queryOpenRewriteRegistry(removedBreaking() as never, dependencyChange('acme-sdk', 'maven'));
    assert.ok(found);
    assert.equal(found!.name, 'org.openrewrite.acme.UpgradeAcmeSdk');
    assert.equal(found!.version, '4.5.6');
    assert.equal(found!.official, true);
    globalThis.fetch = originalFetch;
  });

  test('queryOpenRewriteRegistry declines rather than guess when no recipe id is named in the POM', async () => {
    mockFetch((url) => {
      if (url.includes('solrsearch')) {
        return {
          status: 200,
          body: JSON.stringify({
            response: { docs: [{ g: 'org.openrewrite.recipe', a: 'rewrite-acme-sdk', latestVersion: '4.5.6' }] },
          }),
        };
      }
      if (url.includes('remotecontent')) {
        return { status: 200, body: '<project><description>A generic module with no id mentioned.</description></project>' };
      }
      return null;
    });
    clearHttpCache();

    assert.equal(
      await queryOpenRewriteRegistry(removedBreaking() as never, dependencyChange('acme-sdk', 'maven')),
      null,
    );
    globalThis.fetch = originalFetch;
  });

  test('queryOpenRewriteRegistry never queries non-maven ecosystems', async () => {
    let called = false;
    mockFetch(() => {
      called = true;
      return { status: 200, body: '{}' };
    });
    clearHttpCache();

    const found = await queryOpenRewriteRegistry(removedBreaking() as never, dependencyChange('acme-sdk', 'npm'));
    assert.equal(found, null);
    assert.equal(called, false);
    globalThis.fetch = originalFetch;
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
      codemod: [{ ruleId: 'rename-identifier', from: 'oldName', to: 'newName', files: ['src/app.ts'], anchors: [{ file: 'src/app.ts', line: 'oldName();', lineNumber: 1 }] }],
    });
    const applied = applyBuiltinCodemod(commit as never, new Map([['src/app.ts', 'newName(); // already fixed\n']]));
    assert.equal(applied.status, 'no-changes');
    assert.deepEqual(applied.edits, []);
  });

  test('does not rewrite an identical line elsewhere in the file that was never localized', () => {
    // Two lines read exactly `oldName();` — only line 1 was ever an anchored
    // impact site. Matching by text alone would rewrite both.
    const commit = commitUnit({
      codemod: [
        {
          ruleId: 'rename-identifier',
          from: 'oldName',
          to: 'newName',
          files: ['src/app.ts'],
          anchors: [{ file: 'src/app.ts', line: 'oldName();', lineNumber: 1 }],
        },
      ],
    });
    const applied = applyBuiltinCodemod(
      commit as never,
      new Map([['src/app.ts', 'oldName();\n// unrelated block below, identical text\noldName();\n']]),
    );

    assert.equal(applied.status, 'applied');
    assert.deepEqual(applied.edits, [
      { path: 'src/app.ts', content: 'newName();\n// unrelated block below, identical text\noldName();\n' },
    ]);
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

    // The commit body is what ends up in the git commit message and the PR
    // description — provider, recipe name, and exact pinned version must be
    // visible there, not just in the in-memory candidate.
    assert.match(plan.commits[0]!.body, /@acme\/upgrade-sdk@1\.2\.3/);
    assert.match(plan.commits[0]!.body, /codemod\.com/);
    assert.match(plan.commits[0]!.body, /Codemod\.com/);
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
