import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pythonSurface } from '../dist/evidence/surface/python.js';
import { clearHttpCache, configureHttpDiskCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';
import type { SurfaceRequest } from '../dist/evidence/surface/types.js';

/**
 * The scan-level exact-upgrade cache (see src/upgrade/scan.ts) dedupes two
 * manifest rows asking for the identical (from, to) pair, but does nothing
 * for two *different* upgrades of the same package that only share one
 * endpoint version -- pandas 2.2.2->3.0.5 and pandas 2.2.3->3.0.5 both need
 * pandas@3.0.5's surface computed exactly once. These tests cover the
 * per-version in-flight single-flight cache in python.ts that closes that
 * gap, using a barrier on the parser invocation so concurrent callers are
 * provably overlapping rather than accidentally serialized.
 */

/** A tar entry, built the way tar builds one: a 512-byte header, then bytes. */
function tarEntry(path: string, content: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);

  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  body.write(content, 0, 'utf8');
  return Buffer.concat([header, body]);
}

function pypiJson(name: string, versions: string[]): object {
  const releases: Record<string, unknown> = {};
  for (const v of versions) {
    releases[v] = [{ url: `https://files.pythonhosted.org/packages/${name}-${v}.tar.gz`, filename: `${name}-${v}.tar.gz`, packagetype: 'sdist' }];
  }
  return { info: { project_urls: { Source: `https://github.com/demo-org/${name}` } }, releases };
}

const sdistBytes = (module: string) => gzipSync(tarEntry(`${module}/${module}.py`, 'def thing():\n    pass\n'));

const realFetch = globalThis.fetch;
let cacheDir: string;

function stubFetch(respond: (url: string) => Response | null): void {
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    const response = respond(url);
    return Promise.resolve(response ?? new Response('not found', { status: 404 }));
  }) as typeof fetch;
}

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'drift-python-sf-'));
  configureHttpDiskCache(cacheDir);
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  clearHttpCache();
  configureHttpDiskCache(null);
  await rm(cacheDir, { recursive: true, force: true });
});

/** A barrier-controlled parser: counts invocations and lets the test decide when each one resolves. */
function barrierExec(): { exec: SurfaceRequest['exec']; parseCalls: string[]; release: (id: string) => void; releaseAll: () => void } {
  const pending = new Map<string, () => void>();
  const parseCalls: string[] = [];
  let n = 0;
  const exec: SurfaceRequest['exec'] = async (command, args) => {
    if (command === 'python3' && args[0] === '--version') return { code: 0, stdout: 'Python 3.11.0', stderr: '' };
    if (command === 'python3') {
      const id = `parse-${n++}`;
      parseCalls.push(id);
      await new Promise<void>((resolve) => pending.set(id, resolve));
      return {
        code: 0,
        stdout: JSON.stringify([{ name: 'thing', kind: 'function', signature: 'def thing()' }]),
        stderr: '',
      };
    }
    return { code: 1, stdout: '', stderr: 'unexpected command' };
  };
  return {
    exec,
    parseCalls,
    release: (id: string) => pending.get(id)?.(),
    releaseAll: () => { for (const resolve of pending.values()) resolve(); },
  };
}

function makeRequest(name: string, from: string, to: string, exec: SurfaceRequest['exec'], workdir: string): SurfaceRequest {
  return { name, from, to, exec, workdir, logger: createLogger('error'), timeoutMs: 20_000 };
}

/** Polls until `array.length >= count`, rather than assuming a fixed number of event-loop ticks. */
async function waitForCount(array: unknown[], count: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (array.length < count) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} calls, only saw ${array.length}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('Python per-version surface single-flight', () => {
  test('A: 3 concurrent identical upgrades, uncached -> exactly 2 parser executions', { timeout: 15000 }, async () => {
    const name = 'demo-sf-a';
    stubFetch((url) => {
      if (url === `https://pypi.org/pypi/${name}/json`) return new Response(JSON.stringify(pypiJson(name, ['1.0.0', '2.0.0'])), { status: 200 });
      if (url.startsWith('https://files.pythonhosted.org/')) return new Response(sdistBytes(name.replace(/-/g, '_')), { status: 200 });
      return null;
    });

    const { exec, parseCalls, releaseAll } = barrierExec();
    const workdirs = await Promise.all([0, 1, 2].map(() => mkdtemp(join(tmpdir(), 'drift-python-work-'))));

    const runs = workdirs.map((workdir) => pythonSurface.compute(makeRequest(name, '1.0.0', '2.0.0', exec, workdir)));

    // Wait until every unique version has actually reached the parser
    // (not a fixed number of ticks -- real disk I/O precedes it) before
    // releasing any of them.
    await waitForCount(parseCalls, 2);
    releaseAll();

    const results = await Promise.all(runs);
    await Promise.all(workdirs.map((d) => rm(d, { recursive: true, force: true })));

    for (const r of results) assert.equal(r.available, true);
    assert.equal(parseCalls.length, 2, `expected exactly 2 parser executions, got ${parseCalls.length}`);
  });

  test('B: two upgrades sharing one endpoint version -> exactly 3 unique version computations', { timeout: 15000 }, async () => {
    const name = 'demo-sf-b';
    stubFetch((url) => {
      if (url === `https://pypi.org/pypi/${name}/json`) return new Response(JSON.stringify(pypiJson(name, ['1.0.0', '2.0.0', '3.0.0'])), { status: 200 });
      if (url.startsWith('https://files.pythonhosted.org/')) return new Response(sdistBytes(name.replace(/-/g, '_')), { status: 200 });
      return null;
    });

    const { exec, parseCalls, releaseAll } = barrierExec();
    const [w1, w2] = await Promise.all([mkdtemp(join(tmpdir(), 'drift-python-work-')), mkdtemp(join(tmpdir(), 'drift-python-work-'))]);

    // X 1.0->3.0 and X 2.0->3.0: X@1.0, X@2.0, X@3.0 -> 3 unique versions, not 4.
    const run1 = pythonSurface.compute(makeRequest(name, '1.0.0', '3.0.0', exec, w1));
    const run2 = pythonSurface.compute(makeRequest(name, '2.0.0', '3.0.0', exec, w2));

    await waitForCount(parseCalls, 3);
    releaseAll();

    const [r1, r2] = await Promise.all([run1, run2]);
    await Promise.all([w1, w2].map((d) => rm(d, { recursive: true, force: true })));

    assert.equal(r1.available, true);
    assert.equal(r2.available, true);
    assert.equal(parseCalls.length, 3, `expected exactly 3 unique version computations, got ${parseCalls.length}`);
  });

  test('C: canonical PyPI success remains persistently cached across independent calls', async () => {
    const name = 'demo-sf-c';
    let archiveCalls = 0;
    stubFetch((url) => {
      if (url === `https://pypi.org/pypi/${name}/json`) return new Response(JSON.stringify(pypiJson(name, ['1.0.0', '2.0.0'])), { status: 200 });
      if (url.startsWith('https://files.pythonhosted.org/')) {
        archiveCalls += 1;
        return new Response(sdistBytes(name.replace(/-/g, '_')), { status: 200 });
      }
      return null;
    });

    const { exec: exec1 } = barrierExecImmediate();
    const w1 = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
    const first = await pythonSurface.compute(makeRequest(name, '1.0.0', '2.0.0', exec1, w1));
    await rm(w1, { recursive: true, force: true });
    assert.equal(first.available, true);
    const callsAfterFirst = archiveCalls;
    assert.ok(callsAfterFirst > 0);

    clearHttpCache();

    const { exec: exec2 } = barrierExecImmediate();
    const w2 = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
    const second = await pythonSurface.compute(makeRequest(name, '1.0.0', '2.0.0', exec2, w2));
    await rm(w2, { recursive: true, force: true });
    assert.equal(second.available, true);
    // Persistent cache hit: no new archive downloads, no new parse needed.
    assert.equal(archiveCalls, callsAfterFirst);
  });

  test('D: GitHub fallback is shared only while in-flight, and does not poison a later canonical attempt', { timeout: 15000 }, async () => {
    const name = 'demo-sf-d';
    let archiveCalls = 0;
    stubFetch((url) => {
      if (url === `https://pypi.org/pypi/${name}/json`) return new Response(JSON.stringify(pypiJson(name, ['1.0.0', '2.0.0'])), { status: 200 });
      if (url.startsWith('https://files.pythonhosted.org/')) {
        archiveCalls += 1;
        return new Response('unavailable', { status: 500 });
      }
      if (url.startsWith('https://api.github.com/repos/demo-org/'))
        return new Response(JSON.stringify([{ name: 'v1.0.0' }, { name: 'v2.0.0' }]), { status: 200 });
      if (url.startsWith('https://codeload.github.com/')) return new Response(sdistBytes(name.replace(/-/g, '_')), { status: 200 });
      return null;
    });

    const { exec, parseCalls, releaseAll } = barrierExec();
    const [w1, w2] = await Promise.all([mkdtemp(join(tmpdir(), 'drift-python-work-')), mkdtemp(join(tmpdir(), 'drift-python-work-'))]);

    // Two concurrent callers for the identical (from, to): both should share
    // the one fallback computation for each endpoint version.
    const run1 = pythonSurface.compute(makeRequest(name, '1.0.0', '2.0.0', exec, w1));
    const run2 = pythonSurface.compute(makeRequest(name, '1.0.0', '2.0.0', exec, w2));

    await waitForCount(parseCalls, 2);
    releaseAll();

    const [r1, r2] = await Promise.all([run1, run2]);
    await Promise.all([w1, w2].map((d) => rm(d, { recursive: true, force: true })));

    assert.equal(r1.available, true);
    assert.equal(r2.available, true);
    assert.equal(parseCalls.length, 2, 'both concurrent callers should have shared one fallback computation per version');

    const archiveCallsAfterFallback = archiveCalls;

    // A later, independent call must retry PyPI rather than inherit the
    // fallback result -- the in-flight fallback entry must not have become a
    // permanent cache entry.
    const { exec: exec3 } = barrierExecImmediate();
    const w3 = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
    const third = await pythonSurface.compute(makeRequest(name, '1.0.0', '2.0.0', exec3, w3));
    await rm(w3, { recursive: true, force: true });

    assert.equal(third.available, true);
    assert.ok(archiveCalls > archiveCallsAfterFallback, 'a later call must retry PyPI rather than reuse the cached fallback');
  });

  test('E: a failure is not permanently cached and can be retried', async () => {
    const name = 'demo-sf-e';
    let allowSuccess = false;
    stubFetch((url) => {
      if (url === `https://pypi.org/pypi/${name}/json`) {
        // First round: PyPI metadata itself is unreachable, on every attempt
        // (including internal retries). Second round (after `allowSuccess`
        // is flipped, once the in-flight entry has cleared) succeeds.
        if (!allowSuccess) return new Response('error', { status: 500 });
        return new Response(JSON.stringify(pypiJson(name, ['1.0.0', '2.0.0'])), { status: 200 });
      }
      if (url.startsWith('https://files.pythonhosted.org/')) return new Response(sdistBytes(name.replace(/-/g, '_')), { status: 200 });
      return null;
    });

    const { exec } = barrierExecImmediate();
    const w1 = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
    const first = await pythonSurface.compute(makeRequest(name, '1.0.0', '2.0.0', exec, w1));
    await rm(w1, { recursive: true, force: true });
    assert.equal(first.available, false);

    clearHttpCache();
    allowSuccess = true;

    const w2 = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
    const second = await pythonSurface.compute(makeRequest(name, '1.0.0', '2.0.0', exec, w2));
    await rm(w2, { recursive: true, force: true });
    assert.equal(second.available, true, 'a later independent call must be able to retry after a failure, not inherit it');
  });
});

/** A parser stub that resolves immediately -- for sequential (non-overlapping) test steps. */
function barrierExecImmediate(): { exec: SurfaceRequest['exec'] } {
  const exec: SurfaceRequest['exec'] = async (command, args) => {
    if (command === 'python3' && args[0] === '--version') return { code: 0, stdout: 'Python 3.11.0', stderr: '' };
    if (command === 'python3') {
      return {
        code: 0,
        stdout: JSON.stringify([{ name: 'thing', kind: 'function', signature: 'def thing()' }]),
        stderr: '',
      };
    }
    return { code: 1, stdout: '', stderr: 'unexpected command' };
  };
  return { exec };
}
