import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dispositionFor } from '../dist/fixplan/policy.js';
import { renderFixPlanDocument, summarizeFixPlan, describeOp } from '../dist/fixplan/document.js';
import { memoryFixPlanCache, migrationKey, asRestored } from '../dist/fixplan/cache.js';
import { resolveFixPlans } from '../dist/fixplan/resolve.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { FIX_PLAN_SCHEMA_VERSION } from '../dist/fixplan/schema.js';

const config = (overrides: Record<string, unknown> = {}) => DriftConfigSchema.parse(overrides);

const plan = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: FIX_PLAN_SCHEMA_VERSION,
  id: 'fp_1',
  breakingChangeId: 'bc_1',
  dependency: 'acme-sdk',
  fromVersion: '1.0.0',
  toVersion: '2.0.0',
  changeKind: 'renamed-export' as const,
  migration: '`connect` became `createConnection`.',
  rationale: 'The changelog states the rename.',
  ops: [{ kind: 'rename-identifier' as const, from: 'connect', to: 'createConnection' }],
  citations: ['ev_1'],
  provenance: { author: 'model' as const, model: 'claude-opus-5', authoredAt: '2026-01-01T00:00:00Z' },
  ...overrides,
});

const assessment = (overrides: Record<string, unknown> = {}) => ({
  plan: plan(),
  verdict: 'accepted' as const,
  assurance: 'proven' as const,
  sites: [],
  covered: 4,
  residual: 0,
  rejections: [] as string[],
  anchors: [{ file: 'src/app.ts', line: 'connect();', lineNumber: 1 }],
  ...overrides,
});

describe('dispositionFor: the one auto-apply decision', () => {
  test('approve mode reviews everything, whatever autoApply says', () => {
    const result = dispositionFor(
      assessment(),
      config({ mode: 'approve', remediation: { fixPlans: { autoApply: 'verified' } } }),
      { verificationPassed: true },
    );
    assert.equal(result.action, 'review');
    assert.match(result.reason, /approve mode/);
  });

  test('a rejected plan is skipped and says why', () => {
    const result = dispositionFor(
      assessment({ verdict: 'rejected', rejections: ['The replacement was not attested.'] }),
      config({ mode: 'auto' }),
    );
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'The replacement was not attested.');
  });

  test('coverage below the configured minimum is skipped', () => {
    const result = dispositionFor(
      assessment({ covered: 1, residual: 9 }),
      config({ mode: 'auto', remediation: { fixPlans: { autoApply: 'proven', minCoverage: 0.5 } } }),
    );
    assert.equal(result.action, 'skip');
    assert.match(result.reason, /below the configured minimum/);
  });

  test('a proven plan applies under `proven`', () => {
    const result = dispositionFor(
      assessment(),
      config({ mode: 'auto', remediation: { fixPlans: { autoApply: 'proven' } } }),
    );
    assert.equal(result.action, 'apply');
  });

  test('a checked plan never applies under `proven`, however confident', () => {
    const result = dispositionFor(
      assessment({ assurance: 'checked' }),
      config({ mode: 'auto', remediation: { fixPlans: { autoApply: 'proven' } } }),
      { verificationPassed: true },
    );
    assert.equal(result.action, 'review');
  });

  test('a checked plan applies under `verified` only when checks actually passed', () => {
    const settings = config({ mode: 'auto', remediation: { fixPlans: { autoApply: 'verified' } } });

    assert.equal(
      dispositionFor(assessment({ assurance: 'checked' }), settings, { verificationPassed: true }).action,
      'apply',
    );
    // Verification switched off is not verification that passed. This is the
    // rule that does not bend at any setting.
    assert.equal(
      dispositionFor(assessment({ assurance: 'checked' }), settings, { verificationPassed: false }).action,
      'review',
    );
    assert.equal(dispositionFor(assessment({ assurance: 'checked' }), settings, {}).action, 'review');
  });

  test('the default configuration reviews rather than applies', () => {
    assert.equal(dispositionFor(assessment(), config({ mode: 'auto' })).action, 'review');
  });
});

describe('the fix plan document', () => {
  test('states the rule, the checks Drift ran, and the provenance', () => {
    const document = renderFixPlanDocument(assessment());

    assert.match(document, /Rename the identifier `connect` to `createConnection`/);
    assert.match(document, /Attestation/);
    assert.match(document, /Convergence/);
    assert.match(document, /claude-opus-5/);
    assert.match(document, /All 4 call sites are resolved deterministically/);
  });

  test('a partial plan says what it did not cover, and that the plan survives it', () => {
    const document = renderFixPlanDocument(
      assessment({
        verdict: 'partial',
        covered: 9,
        residual: 1,
        sites: [
          { file: 'src/a.ts', line: 1, before: 'connect();', after: 'createConnection();', status: 'covered', op: 'rename-identifier' },
          { file: 'src/b.ts', line: 4, before: 'x.connect();', status: 'residual', reason: 'shaped differently' },
        ],
      }),
    );

    assert.match(document, /9 of 10 call sites/);
    assert.match(document, /not abandoned because of them/);
    assert.match(document, /shaped differently/);
  });

  test('a rejected plan reads as a refusal, not as a fix', () => {
    const document = renderFixPlanDocument(
      assessment({ verdict: 'rejected', rejections: ['Nothing in the cited evidence mentions `openSocket`.'] }),
    );

    assert.match(document, /Drift rejected this plan/);
    assert.match(document, /openSocket/);
    assert.doesNotMatch(document, /What it does/);
  });

  test('a recipe-derived plan credits the recipe and says its output was not used', () => {
    const document = renderFixPlanDocument(
      assessment({
        plan: plan({
          provenance: {
            author: 'recipe',
            recipe: {
              name: '@acme/upgrade',
              version: '1.2.3',
              publisher: 'Codemod.com',
              source: 'https://example.invalid/r',
            },
            authoredAt: '2026-01-01T00:00:00Z',
          },
        }),
      }),
    );

    assert.match(document, /@acme\/upgrade@1\.2\.3/);
    assert.match(document, /recipe’s own output was not used/);
  });

  test('a restored plan says it was re-validated locally', () => {
    const document = renderFixPlanDocument(
      assessment({ plan: plan({ provenance: { author: 'cache', sourceId: 'fp_other', authoredAt: 'x' } }) }),
    );
    assert.match(document, /re-validated against this repository’s own call sites/);
  });

  test('every op describes itself in reviewer language', () => {
    assert.match(describeOp({ kind: 'rename-member', from: 'a', to: 'b' }), /member access only/);
    assert.match(describeOp({ kind: 'replace-import-path', from: 'a', to: 'b' }), /import path/);
    assert.match(describeOp({ kind: 'wrap-call', callee: 'f', wrapper: 'await' }), /Prefix every `f\(…\)`/);
    assert.match(
      describeOp({ kind: 'insert-argument', callee: 'f', index: 1, text: '{}' }),
      /as argument 2 of every `f\(…\)`/,
    );
  });

  test('the one-line summary carries the coverage and the assurance', () => {
    assert.equal(
      summarizeFixPlan(assessment({ covered: 9, residual: 1 })),
      '1 deterministic rule covering 9/10 call sites (proven)',
    );
  });
});

describe('the fix plan cache: keyed on the migration, not the repository', () => {
  const change = {
    id: 'bc_1',
    dependency: 'acme-sdk',
    kind: 'renamed-export' as const,
    summary: 's',
    remediation: 'r',
    symbols: ['connect'],
    confidence: 'high' as const,
    citations: ['ev_1'],
  };
  const dependencyChange = {
    name: 'acme-sdk',
    ecosystem: 'npm' as const,
    from: '1.0.0',
    to: '2.0.0',
    kind: 'runtime' as const,
    bump: 'major' as const,
    manifestPath: 'package.json',
  };

  test('two repositories hitting the same upstream break compute the same key', () => {
    const a = migrationKey(change, dependencyChange);
    const b = migrationKey({ ...change, id: 'bc_different', workspace: 'packages/api' }, dependencyChange);
    assert.equal(a, b);
  });

  test('a different version range is a different migration', () => {
    assert.notEqual(
      migrationKey(change, dependencyChange),
      migrationKey(change, { ...dependencyChange, to: '3.0.0' }),
    );
  });

  test('symbol order does not change the key', () => {
    assert.equal(
      migrationKey({ ...change, symbols: ['a', 'b'] }, dependencyChange),
      migrationKey({ ...change, symbols: ['b', 'a'] }, dependencyChange),
    );
  });

  test('a restored plan records where it came from without losing its author', () => {
    const restored = asRestored(plan());
    assert.equal(restored.provenance.author, 'cache');
    assert.equal(restored.provenance.sourceId, 'fp_1');
    assert.equal(restored.provenance.model, 'claude-opus-5');
  });
});

describe('resolveFixPlans: many proposal sources, one gate', () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;

  const change = {
    id: 'bc_1',
    dependency: 'acme-sdk',
    kind: 'renamed-export' as const,
    summary: '`connect` was renamed to `createConnection`.',
    remediation: 'Replace `connect` with `createConnection`.',
    symbols: ['connect'],
    replacementSymbols: ['createConnection'],
    confidence: 'high' as const,
    citations: ['ev_1'],
  };
  const evidence = [
    {
      id: 'ev_1',
      source: 'changelog' as const,
      dependency: 'acme-sdk',
      title: 'CHANGELOG',
      content: '`connect` is now `createConnection`.',
      weight: 1,
    },
  ];
  const sites = [
    { breakingChangeId: 'bc_1', file: 'src/app.ts', line: 1, excerpt: '', matchedSymbol: 'connect', confidence: 'high' as const },
  ];
  const fileContents = new Map([['src/app.ts', 'connect(url);\n']]);
  const dependencyChanges = [
    {
      name: 'acme-sdk',
      ecosystem: 'npm' as const,
      from: '1.0.0',
      to: '2.0.0',
      kind: 'runtime' as const,
      bump: 'major' as const,
      manifestPath: 'package.json',
    },
  ];

  const base = {
    changes: [change],
    sites,
    evidence,
    dependencyChanges,
    fileContents,
    logger,
  } as never;

  test('a recipe-derived plan is validated, not trusted', async () => {
    const result = await resolveFixPlans({
      ...(base as object),
      config: config(),
      cache: memoryFixPlanCache(),
      // A recipe claiming a replacement no evidence attests. Under the old
      // design its diff would have been scope-checked and committed.
      proposeFromRecipe: async () =>
        plan({
          ops: [{ kind: 'rename-identifier', from: 'connect', to: 'openSocket' }],
          citations: [],
          provenance: {
            author: 'recipe',
            recipe: { name: '@x/y', version: '1.0.0', publisher: 'p', source: 's' },
            authoredAt: 'x',
          },
        }),
    } as never);

    assert.equal(result.accepted.size, 0);
    assert.equal(result.rejected.size, 1);
    assert.match(result.rejected.get('bc_1')!.rejections.join(' '), /openSocket/);
  });

  test('a cache hit is used, and re-validated against this repository', async () => {
    const key = migrationKey(change as never, dependencyChanges[0] as never);
    const result = await resolveFixPlans({
      ...(base as object),
      config: config(),
      cache: memoryFixPlanCache([[key, plan() as never]]),
    } as never);

    assert.equal(result.accepted.size, 1);
    assert.equal(result.accepted.get('bc_1')!.plan.provenance.author, 'cache');
    assert.equal(result.accepted.get('bc_1')!.covered, 1);
  });

  test('a plan below minCoverage is discarded once, here, not per surface', async () => {
    const manySites = [
      ...sites,
      { breakingChangeId: 'bc_1', file: 'src/app.ts', line: 2, excerpt: '', matchedSymbol: 'connect', confidence: 'high' as const },
      { breakingChangeId: 'bc_1', file: 'src/app.ts', line: 3, excerpt: '', matchedSymbol: 'connect', confidence: 'high' as const },
    ];

    const result = await resolveFixPlans({
      ...(base as object),
      sites: manySites,
      // Only line 1 is a bare call; the other two are member accesses the
      // rename-identifier op refuses to touch.
      fileContents: new Map([['src/app.ts', 'connect(url);\nx.connect();\ny.connect();\n']]),
      config: config({ remediation: { fixPlans: { minCoverage: 0.9 } } }),
      cache: memoryFixPlanCache(),
      proposeFromRecipe: async () => plan() as never,
    } as never);

    assert.equal(result.accepted.size, 0);
    assert.match(result.rejected.get('bc_1')!.rejections.join(' '), /below the configured minimum/);
  });

  test('a rejected proposal does not stop the next source proposing', async () => {
    let authored = false;
    const result = await resolveFixPlans({
      ...(base as object),
      config: config(),
      cache: memoryFixPlanCache(),
      proposeFromRecipe: async () =>
        plan({
          ops: [{ kind: 'rename-identifier', from: 'connect', to: 'invented' }],
          provenance: { author: 'recipe', recipe: { name: 'r', version: '1', publisher: 'p', source: 's' }, authoredAt: 'x' },
        }),
      client: {
        messages: {
          async create() {
            authored = true;
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    applicable: true,
                    migration: '`connect` became `createConnection`.',
                    rationale: 'stated in the changelog',
                    citations: ['ev_1'],
                    ops: [{ kind: 'rename-identifier', from: 'connect', to: 'createConnection' }],
                  }),
                },
              ],
            };
          },
        },
      },
    } as never);

    assert.ok(authored, 'the model should still get a turn after the recipe was rejected');
    assert.equal(result.accepted.size, 1);
    assert.equal(result.accepted.get('bc_1')!.plan.provenance.author, 'model');
  });

  test('an accepted plan is written to the cache; a rejected one is not', async () => {
    const cache = memoryFixPlanCache();
    await resolveFixPlans({
      ...(base as object),
      config: config(),
      cache,
      proposeFromRecipe: async () =>
        plan({
          ops: [{ kind: 'rename-identifier', from: 'connect', to: 'invented' }],
          provenance: { author: 'recipe', recipe: { name: 'r', version: '1', publisher: 'p', source: 's' }, authoredAt: 'x' },
        }),
    } as never);

    assert.equal((await cache.all()).length, 0);
  });
});
