import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readComputed, writeComputed } from '../dist/util/artifact-cache.js';
import { configureHttpDiskCache } from '../dist/util/http.js';

/**
 * The HTTP cache remembers responses; this remembers conclusions. For the
 * surface providers that is where most of the cost is — downloading an archive
 * is half the work, and parsing every file in it is the other half.
 *
 * The whole thing is only sound while the key covers everything that could
 * change the answer, so most of what is worth testing here is what must *miss*.
 */

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'drift-artifact-'));
  configureHttpDiskCache(cacheDir);
});

afterEach(async () => {
  configureHttpDiskCache(null);
  await rm(cacheDir, { recursive: true, force: true });
});

describe('remembering a conclusion about an immutable input', () => {
  test('what goes in comes back out', async () => {
    await writeComputed('pkg@1.0.0', [['Client', { name: 'Client', kind: 'class', members: ['send'] }]]);
    assert.deepEqual(await readComputed('pkg@1.0.0'), [
      ['Client', { name: 'Client', kind: 'class', members: ['send'] }],
    ]);
  });

  test('a key that was never written is a miss, not an error', async () => {
    assert.equal(await readComputed('never-computed'), null);
  });

  test('a different analyzer fingerprint is a different key', async () => {
    // The property the whole design rests on: fixing the parser must invalidate
    // every answer it could have got wrong, with no TTL and no window in which
    // the old one is still served.
    await writeComputed('python-surface:abc123/Python-3.13:pkg@1.0.0', ['old parser said this']);
    assert.equal(await readComputed('python-surface:def456/Python-3.13:pkg@1.0.0'), null);
    assert.equal(await readComputed('python-surface:abc123/Python-3.9:pkg@1.0.0'), null);
  });

  test('an entry whose stored key does not match is ignored', async () => {
    await writeComputed('mine', ['mine']);
    const [file] = await readdir(cacheDir);
    const stored = JSON.parse(await readFile(join(cacheDir, file!), 'utf8'));
    stored.key = 'somebody else';
    await writeFile(join(cacheDir, file!), JSON.stringify(stored), 'utf8');

    assert.equal(await readComputed('mine'), null);
  });

  test('an entry in an older format is ignored rather than misread', async () => {
    await writeComputed('shape', ['current']);
    const [file] = await readdir(cacheDir);
    const stored = JSON.parse(await readFile(join(cacheDir, file!), 'utf8'));
    stored.format = 0;
    await writeFile(join(cacheDir, file!), JSON.stringify(stored), 'utf8');

    assert.equal(await readComputed('shape'), null);
  });

  test('a truncated entry is a miss, not a crash', async () => {
    await writeComputed('partial', ['whole']);
    const [file] = await readdir(cacheDir);
    await writeFile(join(cacheDir, file!), '{"format":1,"key":"partial","val', 'utf8');

    assert.equal(await readComputed('partial'), null);
  });

  test('with no cache directory configured, nothing is written and nothing is read', async () => {
    configureHttpDiskCache(null);
    await writeComputed('nowhere', ['value']);
    assert.equal(await readComputed('nowhere'), null);
    assert.deepEqual(await readdir(cacheDir), []);
  });
});
