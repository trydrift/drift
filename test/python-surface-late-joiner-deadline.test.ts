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
 * of running the parser twice.
 *
 * `SurfaceRequest.timeoutMs` is documented as the wall-clock budget for
 * *that* caller's own computation. A previous version of this cache violated
 * that contract with a `DeadlineRef` every joiner could `extend()`: a late
 * joiner with a large budget of its own would silently rewrite the deadline
 * driving the *owner's* already-running computation, and — symmetrically — a
 * short-budget joiner could never detach from a long-running owner without
 * retroactively shortening that owner's budget too. This file replaces the
 * test that used to (incorrectly) assert that behaviour as correct.
 *
 * The fix: each in-flight computation is bounded only by whichever caller
 * created it, fixed for that computation's whole lifetime. Every other
 * caller only ever *races* that computation's promise against its own,
 * separate deadline — it never mutates the computation it joined. If the
 * owner's shorter budget is why a joined attempt failed, a joiner with
 * budget of its own left retries independently rather than inheriting that
 * failure as authoritative.
 *
 * These tests model *real* `fetch` abort semantics, unlike the test they
 * replace (whose stub ignored `AbortSignal` entirely and could therefore
 * keep "succeeding" long after production code would already have aborted
 * the request — see `abortAwareArchiveFetch` below, which actually inspects
 * and honours `init.signal` the way the real `fetch` used by
 * `util/http.ts`'s `fetchArchive` does).
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

/**
 * A `fetch` stand-in for one archive URL that genuinely honours
 * `init.signal`, the way the real `fetch` underlying `util/http.ts`'s
 * `fetchArchive` does: it rejects with an `AbortError` the moment the
 * signal fires, rather than (as the test this file replaces did) staying
 * pending regardless of any signal and only ever resolving when the test
 * manually says so. Call `release(bytes)` to resolve it as a normal
 * successful response instead; whichever happens first wins, exactly like a
 * real in-flight HTTP request racing a timeout.
 */
function abortAwareGate(): { fetchImpl: (init?: RequestInit) => Promise<Response>; release: (bytes: Buffer) => void } {
  let settle: ((bytes: Buffer) => void) | undefined;
  // The gate resolves with raw bytes, not a `Response` -- a `Response` body
  // can only be read once, and this gate can be shared by more than one
  // concurrent `fetch` call (e.g. the `from` and `to` archive downloads in
  // the same `pythonSurface.compute` call), each of which needs its own,
  // freshly constructed `Response` wrapping the same bytes.
  const gate = new Promise<Buffer>((resolve) => {
    settle = resolve;
  });
  const fetchImpl = (init?: RequestInit): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      const onAbort = () => {
        signal?.removeEventListener('abort', onAbort);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort);
      gate.then((bytes) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(new Response(bytes, { status: 200 }));
      });
    });
  return { fetchImpl, release: (bytes: Buffer) => settle?.(bytes) };
}

describe('Python single-flight: each caller owns its own timeoutMs budget', () => {
  test('a short-budget owner is not rescued past its own deadline by a large-budget joiner, which retries independently and succeeds', async () => {
    const name = 'demo-deadline-short-owner';
    const bytes = sdistBytes(name.replace(/-/g, '_'));

    // Every archive URL this test touches gets its own abort-aware gate. The
    // *first* request to a given URL is held open (only settling via abort,
    // in this test) -- modelling the owner's (A's) attempt, which must
    // genuinely time out. Any *later* request to the same URL succeeds
    // immediately -- modelling a fresh, independent retry (B's, after A's
    // budget is exhausted) reaching a server that answers normally.
    const gatesByUrl = new Map<string, ReturnType<typeof abortAwareGate>>();
    let firstArchiveDispatch: (() => void) | undefined;
    const firstArchiveDispatched = new Promise<void>((resolve) => {
      firstArchiveDispatch = resolve;
    });
    let archiveAttempts = 0;

    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `https://pypi.org/pypi/${name}/json`) {
        return Promise.resolve(new Response(JSON.stringify(pypiJson(name, ['1.0.0', '2.0.0'])), { status: 200 }));
      }
      if (url.startsWith('https://files.pythonhosted.org/')) {
        archiveAttempts += 1;
        firstArchiveDispatch?.();
        const existing = gatesByUrl.get(url);
        if (!existing) {
          const gate = abortAwareGate();
          gatesByUrl.set(url, gate);
          return gate.fetchImpl(init);
        }
        return Promise.resolve(new Response(bytes, { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const wA = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
    const wB = await mkdtemp(join(tmpdir(), 'drift-python-work-'));

    try {
      // A: a tiny budget that cannot survive the archive request being held
      // open. A becomes the owner of the in-flight computation.
      const runA = pythonSurface.compute(makeRequest(name, '1.0.0', '2.0.0', 500, wA));

      // Deterministic barrier: wait until A has genuinely dispatched its
      // archive request (become the owner) before B joins.
      await firstArchiveDispatched;

      // B: a much larger budget, joining the same in-flight computation
      // (same package, same from/to) while A's archive request is still
      // held open, waiting only on the real `AbortSignal` A's own 80ms
      // budget will fire.
      const runB = pythonSurface.compute(makeRequest(name, '1.0.0', '2.0.0', 20_000, wB));

      const [resultA, resultB] = await Promise.all([runA, runB]);

      assert.equal(
        resultA.available,
        false,
        `A must not be rescued past its own 500ms budget just because B joined with a larger one, got: ${JSON.stringify(resultA)}`,
      );
      assert.equal(
        resultB.available,
        true,
        `B, with its own much larger budget, must not inherit A's timeout as authoritative -- it should retry independently and succeed, got: ${JSON.stringify(resultB)}`,
      );
      assert.ok(archiveAttempts >= 2, `expected at least one aborted attempt (A) and one successful retry (B), saw ${archiveAttempts} attempts`);

      // The in-flight entry for this exact version must have been evicted
      // once both A's and B's attempts settled -- proven indirectly but
      // concretely: B's success is durably written to the *persistent*
      // computed-artifact cache, so a third, independent, small-budget call
      // right afterward must be answered from that cache alone (no archive
      // network access at all), rather than hanging on -- or being timed
      // out by -- a stale in-flight promise still sitting in the map.
      const archiveAttemptsAfterAB = archiveAttempts;
      const wC = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
      try {
        const resultC = await pythonSurface.compute(makeRequest(name, '1.0.0', '2.0.0', 50, wC));
        assert.equal(resultC.available, true, 'a later call should hit the persistent cache B just wrote, regardless of its own small budget');
        assert.equal(archiveAttempts, archiveAttemptsAfterAB, 'the persistent cache hit must not touch the network again');
      } finally {
        await rm(wC, { recursive: true, force: true });
      }

      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, [], `expected no unhandled rejections, got: ${unhandled.map(String).join(', ')}`);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await Promise.all([wA, wB].map((d) => rm(d, { recursive: true, force: true })));
    }
  });

  test('a short-budget joiner detaches at its own deadline without cancelling a long-running owner, which still succeeds', async () => {
    const name = 'demo-deadline-short-joiner';
    const bytes = sdistBytes(name.replace(/-/g, '_'));

    const gate = abortAwareGate();
    let firstArchiveDispatch: (() => void) | undefined;
    const firstArchiveDispatched = new Promise<void>((resolve) => {
      firstArchiveDispatch = resolve;
    });

    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `https://pypi.org/pypi/${name}/json`) {
        return Promise.resolve(new Response(JSON.stringify(pypiJson(name, ['1.0.0', '2.0.0'])), { status: 200 }));
      }
      if (url.startsWith('https://files.pythonhosted.org/')) {
        firstArchiveDispatch?.();
        // Every request to any archive URL in this test shares the one
        // gate: A owns both the `from` and `to` computations, and both
        // must stay pending until explicitly released below -- B, with its
        // short budget, must never be the one who determines when this
        // resolves.
        return gate.fetchImpl(init);
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;

    const wA = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
    const wB = await mkdtemp(join(tmpdir(), 'drift-python-work-'));

    try {
      // A: a large budget, becomes the owner, dispatches the archive
      // request and holds it open (via the un-released gate).
      const runA = pythonSurface.compute(makeRequest(name, '1.0.0', '2.0.0', 20_000, wA));
      await firstArchiveDispatched;

      let aSettledEarly = false;
      runA.then(() => {
        aSettledEarly = true;
      });

      // B: a tiny budget, joining the same in-flight computation.
      const resultB = await pythonSurface.compute(makeRequest(name, '1.0.0', '2.0.0', 500, wB));

      assert.equal(
        resultB.available,
        false,
        `B must give up on its own 500ms schedule rather than wait indefinitely for A's still-open request, got: ${JSON.stringify(resultB)}`,
      );
      // B detaching must not have cancelled A's still-useful, still-running
      // computation -- confirmed before the gate is ever released, so this
      // cannot be explained by A simply having already finished by then.
      assert.equal(aSettledEarly, false, "B's detachment must not have settled (successfully or not) A's still-in-flight computation");

      gate.release(bytes);
      const resultA = await runA;
      assert.equal(
        resultA.available,
        true,
        `A, the long-running owner, must still be able to finish successfully once its own request actually completes, got: ${JSON.stringify(resultA)}`,
      );
    } finally {
      await Promise.all([wA, wB].map((d) => rm(d, { recursive: true, force: true })));
    }
  });
});
