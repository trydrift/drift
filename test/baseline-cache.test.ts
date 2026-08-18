import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineKey, createBaselineCache, noBaselineCache } from '../dist/verification/baseline-cache.js';

/**
 * The rule this cache lives or dies by: it may only answer a question whose
 * every input it has actually looked at. Anything not folded into the key is a
 * way to serve a baseline measured against a different project. See
 * `src/verification/baseline-cache.ts`.
 */

const inputs = {
  head: 'abc123',
  dir: '',
  packageManager: 'npm' as const,
  kinds: ['typecheck', 'build'] as const,
  files: [
    { path: 'package.json', content: '{"name":"x"}' },
    { path: 'package-lock.json', content: '{"lockfileVersion":3}' },
  ],
  runtime: 'v22.6.0/darwin/arm64',
};

const passed = [
  { kind: 'typecheck' as const, label: 'npm run typecheck', compileCapable: true, status: 'passed' as const, durationMs: 10, output: '' },
];

describe('what the key covers', () => {
  test('the same inputs in a different order are the same baseline', () => {
    // Two runs that read the same manifests in a different order must agree,
    // or the cache never hits on a repository with more than one lockfile.
    const reversed = { ...inputs, files: [...inputs.files].reverse() };
    assert.equal(baselineKey(inputs), baselineKey(reversed));
    assert.equal(baselineKey({ ...inputs, kinds: ['build', 'typecheck'] }), baselineKey(inputs));
  });

  test('a moved commit is a different baseline', () => {
    assert.notEqual(baselineKey({ ...inputs, head: 'def456' }), baselineKey(inputs));
  });

  test('an uncommitted lockfile edit is a different baseline', () => {
    // The case `head` alone gets wrong, and the reason contents are hashed
    // rather than paths: the commit has not moved and the install has.
    const edited = {
      ...inputs,
      files: [inputs.files[0]!, { path: 'package-lock.json', content: '{"lockfileVersion":4}' }],
    };
    assert.notEqual(baselineKey(edited), baselineKey(inputs));
  });

  test('moving a lockfile is not mistaken for leaving it alone', () => {
    const moved = {
      ...inputs,
      files: [inputs.files[0]!, { path: 'sub/package-lock.json', content: inputs.files[1]!.content }],
    };
    assert.notEqual(baselineKey(moved), baselineKey(inputs));
  });

  test('narrowing which checks run is a different baseline, not a subset of one', () => {
    assert.notEqual(baselineKey({ ...inputs, kinds: ['typecheck'] }), baselineKey(inputs));
  });

  test('a different runtime, package manager or member directory is a different baseline', () => {
    // A typecheck that passes on one Node and fails on the next is not a hit.
    assert.notEqual(baselineKey({ ...inputs, runtime: 'v26.0.0/darwin/arm64' }), baselineKey(inputs));
    assert.notEqual(baselineKey({ ...inputs, packageManager: 'pnpm' }), baselineKey(inputs));
    assert.notEqual(baselineKey({ ...inputs, dir: 'packages/web' }), baselineKey(inputs));
  });
});

describe('a cache with nowhere to write', () => {
  test('reads nothing and writes nothing, without complaining', () => {
    // "Do not cache" is a configuration — a fresh CI container, a test — not a
    // fault, so it must not need a special case at any call site.
    const cache = noBaselineCache();
    return Promise.all([
      cache.read('anything').then((value) => assert.equal(value, null)),
      cache.write('anything', passed),
    ]);
  });
});

describe('remembering a measured baseline', () => {
  test('hands back what passed, and does not hand it to a different key', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'drift-baseline-'));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const cache = createBaselineCache(dir);
    const key = baselineKey(inputs);
    assert.equal(await cache.read(key), null);

    await cache.write(key, passed);
    const remembered = await cache.read(key);
    assert.equal(remembered?.length, 1);
    assert.equal(remembered?.[0]?.label, 'npm run typecheck');
    assert.equal(remembered?.[0]?.status, 'passed');
    assert.equal(remembered?.[0]?.compileCapable, true);

    // The whole point of the key: a lockfile edit must miss.
    assert.equal(await cache.read(baselineKey({ ...inputs, head: 'def456' })), null);
  });

  test('never remembers a baseline in which nothing passed', async (t) => {
    // Usually a transient failure — a half-finished install, a machine out of
    // memory — and caching it turns one bad afternoon into a week of skipped
    // verification.
    const dir = await mkdtemp(join(tmpdir(), 'drift-baseline-'));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const cache = createBaselineCache(dir);
    await cache.write(baselineKey(inputs), [
      { kind: 'build', label: 'npm run build', compileCapable: true, status: 'failed', durationMs: 5, output: 'boom' },
    ]);
    assert.equal(await cache.read(baselineKey(inputs)), null);
    assert.deepEqual(await readdir(dir).catch(() => []), []);
  });

  test('keeps why a check failed, so a cached unusable baseline can still explain itself', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'drift-baseline-'));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const cache = createBaselineCache(dir);
    await cache.write(baselineKey(inputs), [
      ...passed,
      { kind: 'test', label: 'npm test', compileCapable: false, status: 'failed', durationMs: 5, output: 'one test failed' },
    ]);
    const remembered = await cache.read(baselineKey(inputs));
    assert.equal(remembered?.find((check) => check.label === 'npm test')?.reason, 'one test failed');
  });

  test('a corrupt entry is a miss, never a crash', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'drift-baseline-'));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${baselineKey(inputs)}.json`), 'not json', 'utf8');
    assert.equal(await createBaselineCache(dir).read(baselineKey(inputs)), null);
  });
});
