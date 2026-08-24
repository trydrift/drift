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
 * The Python per-version single-flight cache in `python.ts` keys its promise
 * by `{analyzer, package, version}`, so two scans (or two upgrade rows in the
 * same scan) asking about the identical version join one computation instead
 * of running the parser twice. Before this fix, the shared computation's
 * deadline was whichever caller happened to arrive *first* -- a late joiner
 * with a large remaining budget of its own silently inherited the first
 * caller's smaller one. Concretely: caller A starts with a tiny budget,
 * caller B joins moments later with a much larger one; if A's original
 * budget were still what gated the shared computation, it would report
 * "ran out of time" well before B's own deadline, and B would incorrectly
 * inherit that failure.
 *
 * `DeadlineRef` (see `python.ts`) fixes this by folding every joiner's
 * deadline into the *shared* computation's deadline, keeping whichever is
 * latest. This test proves it: A's own budget alone is far too small for the
 * archive download below to finish, but B joins early with a much larger
 * one, so the shared computation must survive well past A's original
 * deadline and both callers must see a successful result.
 *
 * Determinism: the archive download is gated by a barrier (like the
 * existing single-flight tests' parser barrier), so the test knows for a
 * fact that A has become the in-flight owner before B starts, and that B has
 * had a chance to join and extend the shared deadline before the archive
 * download is allowed to complete. The only real-time wait is bounded and
 * deliberate: enough for A's tiny original deadline to have genuinely
 * elapsed, so a pass here cannot be explained by the check simply not having
 * run yet.
 */

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

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'drift-python-deadline-'));
  configureHttpDiskCache(cacheDir);
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  clearHttpCache();
  configureHttpDiskCache(null);
  await rm(cacheDir, { recursive: true, force: true });
});

function immediateExec(): SurfaceRequest['exec'] {
  return async (command, args) => {
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
}

function makeRequest(name: string, from: string, to: string, timeoutMs: number, workdir: string): SurfaceRequest {
  return { name, from, to, exec: immediateExec(), workdir, logger: createLogger('error'), timeoutMs };
}

describe('Python single-flight late joiners are not shortchanged by the first caller\'s deadline', () => {
  test('a late joiner with a large budget rescues a computation past the first caller\'s tiny one', async () => {
    const name = 'demo-deadline';
    let archiveRequested = false;
    let resolveArchiveDispatched: (() => void) | undefined;
    const archiveDispatched = new Promise<void>((resolve) => {
      // Resolved from inside the stub itself, the moment the archive
      // request is actually made -- see below.
      resolveArchiveDispatched = resolve;
    });

    let releaseArchive: (() => void) | undefined;
    const archiveGateOpen = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });

    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input);
      if (url === `https://pypi.org/pypi/${name}/json`) {
        return Promise.resolve(new Response(JSON.stringify(pypiJson(name, ['1.0.0', '2.0.0'])), { status: 200 }));
      }
      if (url.startsWith('https://files.pythonhosted.org/')) {
        archiveRequested = true;
        resolveArchiveDispatched?.();
        return archiveGateOpen.then(
          () => new Response(sdistBytes(name.replace(/-/g, '_')), { status: 200 }),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;

    const wA = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
    const wB = await mkdtemp(join(tmpdir(), 'drift-python-work-'));

    // A: a tiny budget that cannot possibly survive the archive download
    // being held open below.
    const runA = pythonSurface.compute(makeRequest(name, '1.0.0', '2.0.0', 60, wA));

    // Wait until A has genuinely become the in-flight owner and dispatched
    // the archive request -- not a fixed tick count.
    await archiveDispatched;
    assert.ok(archiveRequested, 'A should have reached the archive download');

    // B: a much larger budget, joining the same in-flight computation
    // (same package, same from/to) while the archive download is still
    // held open.
    const runB = pythonSurface.compute(makeRequest(name, '1.0.0', '2.0.0', 20_000, wB));

    // Give B's own setup (isAvailable check, mkdir, script write, interpreter
    // version probe) time to actually reach `surfaceOf` and fold its deadline
    // into the shared one, and let real time genuinely pass A's 60ms budget
    // before letting the archive respond. This is the one deliberate,
    // bounded real-time wait in this test.
    await new Promise((resolve) => setTimeout(resolve, 200));

    releaseArchive?.();

    const [resultA, resultB] = await Promise.all([runA, runB]);
    await Promise.all([wA, wB].map((d) => rm(d, { recursive: true, force: true })));

    assert.equal(
      resultA.available,
      true,
      `A should not inherit its own tiny deadline once B extended the shared computation's budget, got: ${JSON.stringify(resultA)}`,
    );
    assert.equal(
      resultB.available,
      true,
      `B, with a large budget of its own, must not be shortchanged by A's tiny one, got: ${JSON.stringify(resultB)}`,
    );
  });
});
