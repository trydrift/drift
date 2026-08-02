import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { runBehaviouralDifferential } from '../dist/verification/behavioural.js';

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
