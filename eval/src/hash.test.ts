import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFixtureRevision, hashFixtureMetadata, hashTree } from './hash.ts';

async function withTempFixture(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'drift-eval-hash-test-'));
  try {
    await mkdir(join(dir, 'upstream', 'old'), { recursive: true });
    await mkdir(join(dir, 'upstream', 'new'), { recursive: true });
    await mkdir(join(dir, 'consumer'), { recursive: true });
    await writeFile(join(dir, 'upstream', 'old', 'index.js'), 'export const a = 1;\n');
    await writeFile(join(dir, 'upstream', 'new', 'index.js'), 'export const a = 2;\n');
    await writeFile(join(dir, 'consumer', 'app.js'), 'console.log(1);\n');
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('hashFixtureRevision is deterministic across repeated calls', async () => {
  await withTempFixture(async (dir) => {
    const body = 'id: x\noracles:\n  baseline:\n    command: npm test\n';
    const a = await hashFixtureRevision(dir, body);
    const b = await hashFixtureRevision(dir, body);
    assert.deepEqual(a, b);
  });
});

test('changing upstream/old changes upstreamOld hash but not upstreamNew or consumer', async () => {
  await withTempFixture(async (dir) => {
    const body = 'id: x\n';
    const before = await hashFixtureRevision(dir, body);
    await writeFile(join(dir, 'upstream', 'old', 'index.js'), 'export const a = 999;\n');
    const after = await hashFixtureRevision(dir, body);
    assert.notEqual(before.upstreamOld, after.upstreamOld);
    assert.equal(before.upstreamNew, after.upstreamNew);
    assert.equal(before.consumer, after.consumer);
  });
});

test('changing consumer changes consumer hash only', async () => {
  await withTempFixture(async (dir) => {
    const body = 'id: x\n';
    const before = await hashFixtureRevision(dir, body);
    await writeFile(join(dir, 'consumer', 'app.js'), 'console.log(2);\n');
    const after = await hashFixtureRevision(dir, body);
    assert.notEqual(before.consumer, after.consumer);
    assert.equal(before.upstreamOld, after.upstreamOld);
  });
});

test('fixture metadata hash ignores the readiness field', () => {
  const a = 'id: x\nreadiness: draft\nfoo: bar\n';
  const b = 'id: x\nreadiness: benchmark-ready\nfoo: bar\n';
  assert.equal(hashFixtureMetadata(a), hashFixtureMetadata(b));
});

test('fixture metadata hash changes for any other field', () => {
  const a = 'id: x\nfoo: bar\n';
  const b = 'id: x\nfoo: baz\n';
  assert.notEqual(hashFixtureMetadata(a), hashFixtureMetadata(b));
});

test('hashTree is stable regardless of directory listing order dependence', async () => {
  await withTempFixture(async (dir) => {
    const h1 = await hashTree(join(dir, 'consumer'));
    const h2 = await hashTree(join(dir, 'consumer'));
    assert.equal(h1, h2);
  });
});

test('hashTree of a missing directory does not throw', async () => {
  const h = await hashTree(join(tmpdir(), 'drift-eval-hash-test-does-not-exist-xyz'));
  assert.equal(typeof h, 'string');
});
