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
    assert.equal(DEFAULT_CONFIG.verification.behavioural.enabled, false);
    assert.equal(DEFAULT_CONFIG.verification.behavioural.sandbox, 'required');
    assert.equal(DEFAULT_CONFIG.verification.behavioural.network, false);
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
    assert.deepEqual(plan.commits[0]!.allowedFiles, ['src/a.ts']);
    assert.match(plan.commits[0]!.id, /^unit_/);
  });

  test('independent commits share an execution layer', () => {
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

    assert.deepEqual(
      plan.commits.map((commit) => commit.executionLayer),
      [0, 0],
    );
    assert.deepEqual(plan.commits.flatMap((commit) => commit.dependsOn), []);
    assert.deepEqual(plan.planEdges, []);
  });

  test('conflicting file scopes are serialized with an explicit edge', () => {
    const changes = [
      breaking({ id: 'bc_1', symbols: ['a'] }),
      breaking({ id: 'bc_2', symbols: ['b'], summary: '`b` was removed.' }),
    ];
    const sites = [site('src/shared.ts', 1, 'bc_1'), site('src/shared.ts', 2, 'bc_2')];

    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: changes,
      impactSites: sites,
    });

    assert.equal(plan.planEdges.length, 1);
    assert.equal(plan.planEdges[0]!.reason, 'same-file-conflict');
    assert.deepEqual(
      plan.commits.map((commit) => commit.executionLayer),
      [0, 1],
    );
    assert.deepEqual(plan.commits[1]!.dependsOn, [plan.commits[0]!.id]);
  });

  test('runtime prerequisite units precede source fixes without a linear chain', () => {
    const changes = [
      breaking({ id: 'bc_runtime', kind: 'runtime-requirement', symbols: ['node'] }),
      breaking({ id: 'bc_removed', kind: 'removed-export', symbols: ['createClient'] }),
      breaking({ id: 'bc_other', kind: 'removed-export', dependency: 'other-sdk', symbols: ['makeOther'] }),
    ];
    const sites = [
      site('package.json', 1, 'bc_runtime'),
      site('src/a.ts', 1, 'bc_removed'),
      site('src/other.ts', 1, 'bc_other'),
    ];

    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: changes,
      impactSites: sites,
    });

    const runtime = plan.commits.find((commit) => commit.breakingChangeIds.includes('bc_runtime'))!;
    const removed = plan.commits.find((commit) => commit.breakingChangeIds.includes('bc_removed'))!;
    const other = plan.commits.find((commit) => commit.breakingChangeIds.includes('bc_other'))!;

    assert.equal(runtime.executionLayer, 0);
    assert.equal(removed.executionLayer, 1);
    assert.equal(other.executionLayer, 1);
    assert.ok(removed.dependsOn.includes(runtime.id));
    assert.ok(other.dependsOn.includes(runtime.id));
    assert.ok(
      plan.planEdges.some((edge) => edge.from === runtime.id && edge.to === removed.id && edge.reason === 'runtime-prerequisite'),
    );
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

describe('deterministic codemods on the plan', () => {
  const renameChange = (overrides: Record<string, unknown> = {}) => ({
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

  test('a commit fully covered by a codemod carries it, and says so in the commit body', () => {
    const changeSites = [site('src/a.ts', 1, 'bc_1')];
    const codemods = new Map([
      [
        'bc_1',
        {
          transform: { ruleId: 'rename-identifier' as const, from: 'oldName', to: 'newName' },
          sitesResolved: 1,
          edits: [{ file: 'src/a.ts', before: 'oldName();\n', after: 'newName();\n' }],
        },
      ],
    ]);

    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [renameChange()],
      impactSites: changeSites,
      codemods,
    });

    assert.equal(plan.commits.length, 1);
    assert.deepEqual(plan.commits[0]!.codemod, [
      { ruleId: 'rename-identifier', from: 'oldName', to: 'newName', files: ['src/a.ts'] },
    ]);
    assert.match(plan.commits[0]!.body, /Resolved deterministically/);
  });

  test('a commit only partially covered by a codemod falls back to the agent for the whole unit', () => {
    const changeSites = [site('src/a.ts', 1, 'bc_1'), site('src/b.ts', 2, 'bc_1')];
    // Only one of the two sites was actually resolved.
    const codemods = new Map([
      [
        'bc_1',
        {
          transform: { ruleId: 'rename-identifier' as const, from: 'oldName', to: 'newName' },
          sitesResolved: 1,
          edits: [{ file: 'src/a.ts', before: 'oldName();\n', after: 'newName();\n' }],
        },
      ],
    ]);

    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [renameChange()],
      impactSites: changeSites,
      codemods,
    });

    assert.equal(plan.commits[0]!.codemod, undefined);
    assert.doesNotMatch(plan.commits[0]!.body, /Resolved deterministically/);
  });

  test('two changes in one commit that touch the same file fall back to the agent entirely', () => {
    const config = DriftConfigSchema.parse({ remediation: { commitGranularity: 'single' } });
    const changes = [
      renameChange({ id: 'bc_1', symbols: ['oldA'], replacementSymbols: ['newA'] }),
      renameChange({ id: 'bc_2', symbols: ['oldB'], replacementSymbols: ['newB'] }),
    ];
    const sites = [site('src/a.ts', 1, 'bc_1'), site('src/a.ts', 2, 'bc_2')];
    const codemods = new Map([
      [
        'bc_1',
        {
          transform: { ruleId: 'rename-identifier' as const, from: 'oldA', to: 'newA' },
          sitesResolved: 1,
          edits: [{ file: 'src/a.ts', before: 'x', after: 'y' }],
        },
      ],
      [
        'bc_2',
        {
          transform: { ruleId: 'rename-identifier' as const, from: 'oldB', to: 'newB' },
          sitesResolved: 1,
          edits: [{ file: 'src/a.ts', before: 'x', after: 'z' }],
        },
      ],
    ]);

    const plan = buildPlan({
      repo,
      config,
      changes: [dependencyChange],
      evidence,
      breakingChanges: changes,
      impactSites: sites,
      codemods,
    });

    assert.equal(plan.commits.length, 1);
    assert.equal(plan.commits[0]!.codemod, undefined);
  });

  test('no codemods supplied leaves commits exactly as before', () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [renameChange()],
      impactSites: [site('src/a.ts', 1, 'bc_1')],
    });

    assert.equal(plan.commits[0]!.codemod, undefined);
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

  test('the branch names the package, original version, target version, and date', () => {
    const plan = buildPlan({
      repo: { ...repo, afterSha: '77d0485'.padEnd(40, '0') },
      config: DEFAULT_CONFIG,
      changes: [{ ...dependencyChange, name: 'typescript', from: '5.9.3', to: '7.0.2' }],
      evidence,
      breakingChanges: [breaking({ dependency: 'typescript' })],
      impactSites: [site('src/a.ts')],
    });

    // The `upgrade-` segment is what the extension has always produced. The
    // Action used to name the same upgrade differently, so a team saw two
    // branch shapes depending on where the run started; both now go through
    // `plan/pull-request.ts` and agree.
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(plan.branchName, `drift/upgrade-typescript-5.9.3-to-7.0.2-${today}`);
  });

  test('the branch template is configurable, and the default is the shared one', () => {
    const plan = buildPlan({
      repo,
      config: {
        ...DEFAULT_CONFIG,
        pullRequest: { ...DEFAULT_CONFIG.pullRequest, branchTemplate: '{prefix}bump/{name}-{to}' },
      },
      changes: [{ ...dependencyChange, name: 'typescript', from: '5.9.3', to: '7.0.2' }],
      evidence,
      breakingChanges: [breaking({ dependency: 'typescript' })],
      impactSites: [site('src/a.ts')],
    });

    assert.equal(plan.branchName, 'drift/bump-typescript-7.0.2');
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
    assert.match(body, /https:\/\/example\.com\/diff/, 'every claim links to its source');
    assert.ok(body.includes('createClient'));
    assert.ok(body.includes('Review checklist'));
  });

  test('the report embeds the commit marker the approval flow reads back', () => {
    const body = renderPullRequestBody(plan, DEFAULT_CONFIG);
    assert.ok(body.includes(`drift-commit: ${repo.afterSha}`));
  });

  test('the report surfaces which commits were resolved without a model call', () => {
    const codemods = new Map([
      [
        'bc_1',
        {
          transform: { ruleId: 'rename-identifier' as const, from: 'oldName', to: 'newName' },
          sitesResolved: 1,
          edits: [{ file: 'src/a.ts', before: 'oldName();\n', after: 'newName();\n' }],
        },
      ],
    ]);
    const codemodPlan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [
        {
          id: 'bc_1',
          dependency: 'acme-sdk',
          kind: 'renamed-export' as const,
          summary: '`oldName` was renamed to `newName`.',
          remediation: 'Replace every usage of `oldName` with `newName`.',
          symbols: ['oldName'],
          replacementSymbols: ['newName'],
          confidence: 'high' as const,
          citations: ['ev_1'],
        },
      ],
      impactSites: [site('src/a.ts', 1, 'bc_1')],
      codemods,
    });

    const body = renderPullRequestBody(codemodPlan, DEFAULT_CONFIG);
    assert.match(body, /Resolved deterministically/);
    assert.match(body, /no model call was needed/);
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
