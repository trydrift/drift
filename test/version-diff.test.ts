import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchVersionDiff, unifiedDiffText } from '../dist/evidence/version-diff.js';
import { execCommand } from '../dist/util/exec.js';

/**
 * `fetchVersionDiff` is exercised against the real `tar` and `git` binaries —
 * the same trust boundary `pythonSurface` and the upgrade probe already run
 * on this machine — with only the network fetch faked, so a `.crate`
 * built for the test stands in for crates.io.
 */

describe('a real diff between two published versions', () => {
  const realFetch = globalThis.fetch;
  const tempDirs: string[] = [];

  after(async () => {
    globalThis.fetch = realFetch;
    tempDirs.push(join(tmpdir(), 'drift-version-diff'));
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function crateArchive(files: Record<string, string>, name: string, version: string): Promise<Buffer> {
    const staging = await mkdtemp(join(tmpdir(), 'drift-version-diff-fixture-'));
    tempDirs.push(staging);
    const root = `${name}-${version}`;
    await mkdir(join(staging, root), { recursive: true });
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(staging, root, path, '..'), { recursive: true });
      await writeFile(join(staging, root, path), content);
    }

    const archivePath = join(staging, 'archive.crate');
    const result = await execCommand('tar', ['-czf', archivePath, '-C', staging, root]);
    assert.equal(result.code, 0, result.stderr);
    return readFile(archivePath);
  }

  test('reports added, removed and modified files between two crate releases', async () => {
    const name = `drift-fixture-${randomUUID().slice(0, 8)}`;
    const before = await crateArchive(
      { 'src/lib.rs': 'pub fn old() {}\n', 'src/removed.rs': 'pub fn gone() {}\n' },
      name,
      '1.0.0',
    );
    const after = await crateArchive(
      { 'src/lib.rs': 'pub fn old() {}\npub fn newly_added() {}\n', 'src/added.rs': 'pub fn hi() {}\n' },
      name,
      '1.0.1',
    );

    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      const matched = /\/([\w.-]+)-([\w.-]+)\.crate$/.exec(url);
      const body = matched?.[2] === '1.0.0' ? before : after;
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const result = await fetchVersionDiff({
      ecosystem: 'cargo',
      name,
      from: '1.0.0',
      to: '1.0.1',
      exec: execCommand,
    });

    assert.equal(result.available, true);
    if (!result.available) return;

    const byPath = new Map(result.files.map((f) => [f.path, f.status]));
    assert.equal(byPath.get('src/lib.rs'), 'modified');
    assert.equal(byPath.get('src/removed.rs'), 'removed');
    assert.equal(byPath.get('src/added.rs'), 'added');

    const diff = await unifiedDiffText(result.beforeDir, result.afterDir, execCommand);
    assert.match(diff, /diff --git/);
    assert.match(diff, /\+pub fn newly_added/);
    assert.match(diff, /-pub fn gone/);
  });

  test('a second call reuses the cached extraction and still resolves to the package root, not its cache directory', async () => {
    // The cache hit path used to return the directory the archive was
    // unpacked *into* rather than the single subdirectory it unpacked *to*
    // (`indicatif-0.17.10/`), so a second call in the same process diffed the
    // cache housekeeping files (`.drift-extracted`, `archive.tgz`) alongside
    // the real content instead of just the real content.
    const name = `drift-fixture-${randomUUID().slice(0, 8)}`;
    const before = await crateArchive({ 'src/lib.rs': 'pub fn old() {}\n' }, name, '2.0.0');
    const after = await crateArchive({ 'src/lib.rs': 'pub fn changed() {}\n' }, name, '2.0.1');

    let calls = 0;
    globalThis.fetch = (async (input: unknown) => {
      calls += 1;
      const url = String(input);
      const matched = /-([\w.-]+)\.crate$/.exec(url);
      const body = matched?.[1] === '2.0.0' ? before : after;
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const first = await fetchVersionDiff({ ecosystem: 'cargo', name, from: '2.0.0', to: '2.0.1', exec: execCommand });
    const second = await fetchVersionDiff({ ecosystem: 'cargo', name, from: '2.0.0', to: '2.0.1', exec: execCommand });

    assert.equal(calls, 2, 'the second call must reuse the cached extraction rather than refetching');
    assert.equal(first.available, true);
    assert.equal(second.available, true);
    if (!first.available || !second.available) return;

    assert.deepEqual(
      second.files.map((f) => f.path),
      first.files.map((f) => f.path),
    );
    assert.ok(
      second.files.every((f) => f.path !== '.drift-extracted' && f.path !== 'archive.tgz'),
      'the cache-hit path must resolve to the package root, not the cache directory holding it',
    );
  });

  test('an unsupported ecosystem is refused with a stated reason rather than guessed at', async () => {
    const result = await fetchVersionDiff({
      ecosystem: 'gleam',
      name: 'whatever',
      from: '1.0.0',
      to: '2.0.0',
      exec: execCommand,
    });
    assert.equal(result.available, false);
    if (result.available) return;
    assert.match(result.reason, /gleam/);
  });
});
