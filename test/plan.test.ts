import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk, buildPlan, isAutoDispatchable, isTestPath } from '../dist/plan/index.js';
import { buildTaskPrompt } from '../dist/dispatch/copilot.js';
import { renderPullRequestBody } from '../dist/report/markdown.js';
import { DEFAULT_CONFIG, DriftConfigSchema } from '../dist/config/schema.js';
import { parseConfig } from '../dist/config/load.js';

const repo = {
  owner: 'acme',
  repo: 'app',
  baseBranch: 'main',
  beforeSha: 'a'.repeat(40),
  afterSha: 'b'.repeat(40),
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

const evidence = [
  {
    id: 'ev_1',
    source: 'type-surface-diff' as const,
    dependency: 'acme-sdk',
    url: 'https://example.com/diff',
    title: 'API surface diff',
    content: '`createClient` removed',
    weight: 1,
  },
];

const breaking = (overrides: Record<string, unknown> = {}) => ({
  id: 'bc_1',
  dependency: 'acme-sdk',
  kind: 'removed-export' as const,
  summary: '`createClient` was removed.',
  remediation: 'Replace every usage of `createClient`.',
  symbols: ['createClient'],
  confidence: 'high' as const,
  citations: ['ev_1'],
  ...overrides,
});

const site = (file: string, line = 1, breakingChangeId = 'bc_1') => ({
  breakingChangeId,
  file,
  line,
  excerpt: 'createClient()',
  matchedSymbol: 'createClient',
  confidence: 'high' as const,
});

describe('config', () => {
  test('defaults to approval-required', () => {
    assert.equal(DEFAULT_CONFIG.mode, 'approve');
    assert.equal(DEFAULT_CONFIG.guardrails.requireEvidence, true);
    assert.equal(DEFAULT_CONFIG.triggerOn.patch, false);
  });

  test('falls back to safe defaults on malformed YAML', () => {
    const result = parseConfig('mode: [this is not valid');
    assert.equal(result.config.mode, 'approve');
    assert.ok(result.problems.length > 0, 'the problem is reported, not swallowed');
  });

  test('falls back to safe defaults on schema violations', () => {
    const result = parseConfig('mode: chaos\n');
    assert.equal(result.config.mode, 'approve');
    assert.ok(result.problems.some((p) => p.includes('mode')));
  });

  test('accepts a valid config', () => {
    const result = parseConfig('mode: auto\nmaxAutoRisk: low\nignore:\n  - "@types/*"\n');
    assert.equal(result.problems.length, 0);
    assert.equal(result.config.mode, 'auto');
    assert.equal(result.config.maxAutoRisk, 'low');
  });
});

describe('risk assessment', () => {
  test('is none when nothing is affected', () => {
    assert.equal(assessRisk([dependencyChange], [], []), 'none');
  });

  test('escalates behaviour changes to high', () => {
    const risk = assessRisk(
      [dependencyChange],
      [breaking({ kind: 'behaviour-change' })],
      [site('src/a.ts')],
    );
    assert.equal(risk, 'high', 'behaviour changes compile either way, so nothing else catches them');
  });

  test('escalates on breadth', () => {
    const sites = Array.from({ length: 30 }, (_, i) => site(`src/f${i}.ts`));
    assert.equal(assessRisk([dependencyChange], [breaking()], sites), 'high');
  });

  test('escalates a downgrade to high', () => {
    const downgrade = { ...dependencyChange, from: '2.0.0', to: '1.0.0' };
    assert.equal(assessRisk([downgrade], [breaking()], [site('src/a.ts')]), 'high');
  });
});

describe('test path detection', () => {
  test('recognises conventions across ecosystems', () => {
    for (const path of [
      'src/__tests__/a.ts',
      'src/a.test.ts',
      'spec/models/user_spec.rb',
      'tests/test_app.py',
      'internal/handler_test.go',
      'src/test/java/AppTest.java',
    ]) {
      assert.ok(isTestPath(path), `${path} should be a test path`);
    }
  });

  test('does not misclassify production code', () => {
    assert.ok(!isTestPath('src/latest.ts'));
    assert.ok(!isTestPath('src/contest/index.ts'));
  });
});

describe('commit planning', () => {
  test('produces one commit per breaking change by default', () => {
    const changes = [
      breaking({ id: 'bc_1', symbols: ['a'] }),
      breaking({ id: 'bc_2', symbols: ['b'], summary: '`b` was removed.' }),
    ];
    const sites = [site('src/a.ts', 1, 'bc_1'), site('src/b.ts', 1, 'bc_2')];

    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: changes,
      impactSites: sites,
    });

    assert.equal(plan.commits.length, 2);
    assert.deepEqual(
      plan.commits.map((c) => c.order),
      [1, 2],
    );
  });

  test('orders build-enabling changes before semantic ones', () => {
    const changes = [
      breaking({ id: 'bc_behaviour', kind: 'behaviour-change', symbols: ['x'] }),
      breaking({ id: 'bc_runtime', kind: 'runtime-requirement', symbols: ['y'] }),
    ];
    const sites = [site('src/a.ts', 1, 'bc_behaviour'), site('src/b.ts', 1, 'bc_runtime')];

    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: changes,
      impactSites: sites,
    });

    assert.ok(
      plan.commits[0]!.breakingChangeIds.includes('bc_runtime'),
      'the toolchain must match before later tests can pass',
    );
  });

  test('plans no commit for a change with no impact site', () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [breaking()],
      impactSites: [],
    });

    assert.equal(plan.commits.length, 0);
    assert.ok(
      plan.warnings.some((w) => w.includes('no usage was found')),
      'the finding is still reported for awareness',
    );
  });

  test('scopes each commit to its own files', () => {
    const changes = [
      breaking({ id: 'bc_1', symbols: ['a'] }),
      breaking({ id: 'bc_2', symbols: ['b'] }),
    ];
    const sites = [site('src/a.ts', 1, 'bc_1'), site('src/b.ts', 1, 'bc_2')];

    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: changes,
      impactSites: sites,
    });

    assert.deepEqual(plan.commits[0]!.files, ['src/a.ts']);
    assert.deepEqual(plan.commits[1]!.files, ['src/b.ts']);
  });

  test('honours single-commit granularity', () => {
    const config = DriftConfigSchema.parse({ remediation: { commitGranularity: 'single' } });
    const changes = [breaking({ id: 'bc_1' }), breaking({ id: 'bc_2' })];
    const sites = [site('src/a.ts', 1, 'bc_1'), site('src/b.ts', 1, 'bc_2')];

    const plan = buildPlan({
      repo,
      config,
      changes: [dependencyChange],
      evidence,
      breakingChanges: changes,
      impactSites: sites,
    });

    assert.equal(plan.commits.length, 1);
  });
});

describe('guardrails', () => {
  const planWith = (config = DEFAULT_CONFIG, sites = [site('src/a.ts')]) =>
    buildPlan({
      repo,
      config,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [breaking()],
      impactSites: sites,
    });

  test('approve mode is never auto-dispatchable', () => {
    const plan = planWith();
    assert.equal(isAutoDispatchable(plan, DEFAULT_CONFIG), false);
  });

  test('auto mode dispatches a clean low-risk plan', () => {
    const config = DriftConfigSchema.parse({ mode: 'auto' });
    const plan = planWith(config);

    assert.equal(plan.blockers.length, 0, `unexpected blockers: ${plan.blockers.join('; ')}`);
    assert.equal(isAutoDispatchable(plan, config), true);
  });

  test('blocks when impact sites fall in protected paths', () => {
    const config = DriftConfigSchema.parse({ mode: 'auto' });
    const plan = planWith(config, [site('.github/workflows/ci.yml')]);

    assert.ok(plan.blockers.some((b) => b.includes('protected')));
    assert.equal(isAutoDispatchable(plan, config), false);
  });

  test('blocks when the plan is too wide', () => {
    const config = DriftConfigSchema.parse({ mode: 'auto', guardrails: { maxFilesChanged: 2 } });
    const sites = Array.from({ length: 5 }, (_, i) => site(`src/f${i}.ts`));
    const plan = planWith(config, sites);

    assert.ok(plan.blockers.some((b) => b.includes('maxFilesChanged')));
  });

  test('blocks when only semver evidence exists', () => {
    const config = DriftConfigSchema.parse({ mode: 'auto' });
    const plan = buildPlan({
      repo,
      config,
      changes: [dependencyChange],
      evidence: [
        {
          id: 'ev_semver',
          source: 'semver-heuristic' as const,
          dependency: 'acme-sdk',
          title: 'major bump',
          content: 'major',
          weight: 0.25,
        },
      ],
      breakingChanges: [breaking()],
      impactSites: [site('src/a.ts')],
    });

    assert.ok(plan.blockers.some((b) => b.includes('version number alone')));
  });

  test('blocks when risk exceeds maxAutoRisk', () => {
    const config = DriftConfigSchema.parse({ mode: 'auto', maxAutoRisk: 'low' });
    const plan = buildPlan({
      repo,
      config,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [breaking({ kind: 'behaviour-change' })],
      impactSites: [site('src/a.ts')],
    });

    assert.ok(plan.blockers.some((b) => b.includes('maxAutoRisk')));
  });

  test('warns rather than blocks when tests are affected', () => {
    const config = DriftConfigSchema.parse({ mode: 'auto' });
    const plan = planWith(config, [site('src/a.test.ts')]);
    assert.ok(plan.warnings.some((w) => w.includes('test file')));
  });

  test('respects alwaysApprove', () => {
    const config = DriftConfigSchema.parse({ mode: 'auto', alwaysApprove: ['acme-*'] });
    const plan = planWith(config);
    assert.ok(plan.blockers.some((b) => b.includes('alwaysApprove')));
  });
});

describe('determinism', () => {
  test('the same input yields the same plan id and branch', () => {
    const input = {
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [breaking()],
      impactSites: [site('src/a.ts')],
    };

    const a = buildPlan(input);
    const b = buildPlan(input);

    assert.equal(a.id, b.id, 'content-derived ids make the approval flow stateless');
    assert.equal(a.branchName, b.branchName);
  });
});

describe('rendered output', () => {
  const plan = buildPlan({
    repo,
    config: DEFAULT_CONFIG,
    changes: [dependencyChange],
    evidence,
    breakingChanges: [breaking()],
    impactSites: [site('src/a.ts')],
  });

  test('the report cites its evidence', () => {
    const body = renderPullRequestBody(plan, DEFAULT_CONFIG);
    assert.ok(body.includes('https://example.com/diff'), 'every claim links to its source');
    assert.ok(body.includes('createClient'));
    assert.ok(body.includes('Review checklist'));
  });

  test('the report embeds the commit marker the approval flow reads back', () => {
    const body = renderPullRequestBody(plan, DEFAULT_CONFIG);
    assert.ok(body.includes(`drift-commit: ${repo.afterSha}`));
  });

  test('the agent prompt forbids the predictable failure modes', () => {
    const prompt = buildTaskPrompt(plan, DEFAULT_CONFIG);

    assert.match(prompt, /do not weaken, skip, or delete tests/i);
    assert.match(prompt, /do not modify dependency versions/i);
    assert.match(prompt, /do not squash them/i);
    assert.match(prompt, /TODO\(drift\)/);
    assert.match(prompt, /do not merge/i);
  });

  test('the agent prompt carries the evidence, not just conclusions', () => {
    const prompt = buildTaskPrompt(plan, DEFAULT_CONFIG);
    assert.ok(prompt.includes('createClient'));
    assert.ok(prompt.includes('src/a.ts:1'), 'the agent gets exact locations');
  });
});
