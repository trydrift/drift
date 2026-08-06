import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DriftConfigSchema } from '../dist/config/schema.js';
import {
  literalArgsFromExcerpt,
  runBehaviouralDifferential,
  runBehaviouralVerification,
  selectBehaviouralCandidates,
} from '../dist/verification/behavioural.js';
import { localPackageEnvironment } from '../dist/verification/environment.js';

const config = DriftConfigSchema.parse({
  verification: {
    behavioural: {
      enabled: true,
      maxSymbols: 10,
      maxCasesPerSymbol: 20,
      timeoutSeconds: 5,
      network: false,
      memoryMb: 128,
      cpuLimit: 1,
      retainArtifacts: false,
    },
  },
}).verification.behavioural;

async function runPair(
  oldCode: string,
  newCode: string,
  args: unknown[] = [],
  overrides: Partial<typeof config> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'drift-behavioural-fixture-'));
  try {
    const oldRoot = join(root, 'old');
    const newRoot = join(root, 'new');
    mkdirSync(oldRoot);
    mkdirSync(newRoot);
    writeFileSync(join(oldRoot, 'index.mjs'), oldCode);
    writeFileSync(join(newRoot, 'index.mjs'), newCode);

    const result = await runBehaviouralDifferential({
      config: { ...config, ...overrides },
      oldEnvironment: { label: 'old', packageRoot: oldRoot, modulePath: join(oldRoot, 'index.mjs') },
      newEnvironment: { label: 'new', packageRoot: newRoot, modulePath: join(newRoot, 'index.mjs') },
      probes: [
        {
          dependency: 'fixture',
          symbol: 'subject',
          modulePath: '',
          exportName: 'subject',
          cases: [{ id: 'case-1', args, contracts: ['return-shape', 'thrown-error', 'argument-mutation', 'promise-state'] }],
        },
      ],
    });

    return result.observations[0]!;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('bounded behavioural differential probes', () => {
  test('records a changed return value without claiming universal compatibility', async () => {
    const observation = await runPair(
      'export function subject() { return { answer: 1 }; }',
      'export function subject() { return { answer: 2 }; }',
    );

    assert.equal(observation.observedDifference, 'returned value changed');
    assert.ok(observation.limitations.some((line) => /not proof of behavioural compatibility/i.test(line)));
  });

  test('records a new exception by type and message category', async () => {
    const observation = await runPair(
      'export function subject() { return "ok"; }',
      'export function subject() { throw new TypeError("missing required mode"); }',
    );

    assert.equal(observation.observedDifference, 'status changed from returned to threw');
    assert.deepEqual(observation.newResult.error, {
      name: 'TypeError',
      messageCategory: 'validation',
    });
  });

  test('records changed configured defaults', async () => {
    const observation = await runPair(
      'export function subject(name = "old") { return name; }',
      'export function subject(name = "new") { return name; }',
    );

    assert.equal(observation.observedDifference, 'returned value changed');
  });

  test('records argument mutation differences', async () => {
    const observation = await runPair(
      'export function subject(input) { input.count = 1; return input.count; }',
      'export function subject(input) { input.count = 2; return input.count; }',
      [{ count: 0 }],
    );

    assert.equal(observation.observedDifference, 'returned value changed');
    assert.notDeepEqual(observation.oldResult.mutations, observation.newResult.mutations);
  });

  test('records an async rejection as a status change', async () => {
    const observation = await runPair(
      'export async function subject() { return "ok"; }',
      'export async function subject() { throw new Error("invalid async state"); }',
    );

    assert.equal(observation.observedDifference, 'status changed from returned to threw');
  });

  test('treats nondeterministic output as inconclusive', async () => {
    const observation = await runPair(
      'export function subject() { return Math.random(); }',
      'export function subject() { return Math.random(); }',
    );

    assert.equal(observation.nondeterministic, true);
    assert.match(observation.observedDifference, /nondeterministic/);
  });

  test('bounds wall-clock timeouts', async () => {
    const observation = await runPair(
      'export function subject() { return "ok"; }',
      'export function subject() { while (true) {} }',
      [],
      { timeoutSeconds: 1 },
    );

    assert.equal(observation.newResult.status, 'timed-out');
  });

  test('blocks attempted network access by default', async () => {
    const observation = await runPair(
      'export async function subject() { return "ok"; }',
      'export async function subject() { await fetch("http://127.0.0.1:9"); }',
    );

    assert.equal(observation.newResult.status, 'blocked');
    assert.deepEqual(observation.newResult.error, {
      name: 'Error',
      messageCategory: 'network',
    });
  });

  test('blocks attempted out-of-sandbox writes', async () => {
    const observation = await runPair(
      'export function subject() { return "ok"; }',
      'import { writeFileSync } from "node:fs"; export function subject() { writeFileSync("/tmp/drift-forbidden-write", "x"); }',
    );

    assert.equal(observation.newResult.status, 'blocked');
  });
});

describe('literal argument extraction from a matched call site', () => {
  test('parses a simple object literal without evaluating anything', () => {
    assert.deepEqual(literalArgsFromExcerpt("formatUser({ name: 'Ada' })", 'formatUser'), [{ name: 'Ada' }]);
  });

  test('parses multiple literal arguments', () => {
    assert.deepEqual(literalArgsFromExcerpt('subject(1, "two", true)', 'subject'), [1, 'two', true]);
  });

  test('yields null for a call whose arguments are not literals', () => {
    assert.equal(literalArgsFromExcerpt('formatUser(someVariable)', 'formatUser'), null);
  });

  test('yields null when the symbol is not called on this line', () => {
    assert.equal(literalArgsFromExcerpt('const x = formatUser;', 'formatUser'), null);
  });
});

describe('selecting behavioural candidates', () => {
  const config = DriftConfigSchema.parse({ verification: { behavioural: { enabled: true } } });

  const change = {
    id: 'bc_1',
    dependency: 'fixture-lib',
    kind: 'behaviour-change',
    summary: 'formatUser may have changed.',
    remediation: 'Check call sites.',
    symbols: ['formatUser'],
    confidence: 'low',
    citations: [],
  };

  test('reuses a real call site argument, alongside the no-argument case', () => {
    const impactSites = [
      {
        breakingChangeId: 'bc_1',
        file: 'src/app.ts',
        line: 3,
        excerpt: "formatUser({ name: 'Ada' })",
        matchedSymbol: 'formatUser',
        confidence: 'high',
      },
    ];

    const probes = selectBehaviouralCandidates({ breakingChanges: [change], impactSites }, config);

    assert.equal(probes.length, 1);
    assert.deepEqual(
      probes[0].cases.map((c) => c.args),
      [[], [{ name: 'Ada' }]],
    );
  });

  test('produces nothing when a change has no impact site at all', () => {
    const probes = selectBehaviouralCandidates({ breakingChanges: [change], impactSites: [] }, config);
    assert.deepEqual(probes, []);
  });

  test('produces nothing when probing is disabled', () => {
    const disabled = DriftConfigSchema.parse({});
    const impactSites = [
      { breakingChangeId: 'bc_1', file: 'src/app.ts', line: 3, excerpt: 'formatUser()', matchedSymbol: 'formatUser', confidence: 'high' },
    ];
    assert.deepEqual(selectBehaviouralCandidates({ breakingChanges: [change], impactSites }, disabled), []);
  });
});

describe('running behavioural verification end to end', () => {
  test('cites new evidence on the breaking change it observed a difference for', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-behavioural-verify-'));
    try {
      const oldRoot = join(root, 'old');
      const newRoot = join(root, 'new');
      mkdirSync(oldRoot);
      mkdirSync(newRoot);
      writeFileSync(join(oldRoot, 'index.js'), 'export function formatUser(u) { return u.name.toUpperCase(); }');
      writeFileSync(join(oldRoot, 'package.json'), JSON.stringify({ main: 'index.js' }));
      writeFileSync(join(newRoot, 'index.js'), 'export function formatUser(u) { return { label: u.name.toUpperCase() }; }');
      writeFileSync(join(newRoot, 'package.json'), JSON.stringify({ main: 'index.js' }));

      const config = DriftConfigSchema.parse({ verification: { behavioural: { enabled: true, network: false } } });
      const change = {
        id: 'bc_1',
        dependency: 'fixture-lib',
        kind: 'behaviour-change',
        summary: 'formatUser may have changed.',
        remediation: 'Check call sites.',
        symbols: ['formatUser'],
        confidence: 'low',
        citations: [],
      };
      const dependencyChange = {
        name: 'fixture-lib',
        ecosystem: 'npm',
        from: '1.0.0',
        to: '2.0.0',
        kind: 'runtime',
        bump: 'major',
        manifestPath: 'package.json',
      };
      const impactSites = [
        { breakingChangeId: 'bc_1', file: 'src/app.ts', line: 1, excerpt: "formatUser({ name: 'Ada' })", matchedSymbol: 'formatUser', confidence: 'high' },
      ];

      const result = await runBehaviouralVerification({
        config,
        breakingChanges: [change],
        dependencyChanges: [dependencyChange],
        impactSites,
        resolveEnvironments: async () => {
          const oldEnvironment = await localPackageEnvironment('old', oldRoot);
          const newEnvironment = await localPackageEnvironment('new', newRoot);
          return oldEnvironment && newEnvironment ? { oldEnvironment, newEnvironment } : null;
        },
      });

      assert.ok(result.evidence.length > 0);
      assert.ok(result.evidence.every((e) => e.source === 'behavioural-diff'));
      assert.deepEqual(result.citationsByChangeId.get('bc_1'), result.evidence.map((e) => e.id));
      assert.deepEqual(result.gaps, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reports a gap instead of throwing when a version cannot be resolved', async () => {
    const config = DriftConfigSchema.parse({ verification: { behavioural: { enabled: true } } });
    const change = {
      id: 'bc_1',
      dependency: 'fixture-lib',
      kind: 'behaviour-change',
      summary: 's',
      remediation: 'r',
      symbols: ['formatUser'],
      confidence: 'low',
      citations: [],
    };
    const dependencyChange = {
      name: 'fixture-lib',
      ecosystem: 'npm',
      from: '1.0.0',
      to: '2.0.0',
      kind: 'runtime',
      bump: 'major',
      manifestPath: 'package.json',
    };
    const impactSites = [
      { breakingChangeId: 'bc_1', file: 'src/app.ts', line: 1, excerpt: 'formatUser()', matchedSymbol: 'formatUser', confidence: 'high' },
    ];

    const result = await runBehaviouralVerification({
      config,
      breakingChanges: [change],
      dependencyChanges: [dependencyChange],
      impactSites,
      resolveEnvironments: async () => null,
    });

    assert.deepEqual(result.evidence, []);
    assert.equal(result.gaps.length, 1);
    assert.match(result.gaps[0], /could not resolve/);
  });
});
