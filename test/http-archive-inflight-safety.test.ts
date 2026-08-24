import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchArchive, clearHttpCache, configureHttpDiskCache } from '../dist/util/http.js';

/**
 * `fetchArchive`'s persistent disk cache is correctly keyed by URL alone —
 * an archive's bytes are immutable content, and one cached copy is the
 * right thing to share with every caller. Its *in-flight* coalescing used
 * to be keyed by URL alone too, which is wrong in a different way: two
 * genuinely concurrent callers for the same URL, with *different*
 * `maxBytes`/`timeoutMs`/`retries`, used to join the exact same underlying
 * network attempt and its exact same result — meaning a caller with a
 * strict `maxBytes` (e.g. `localize/modules.ts`'s 64MB decompression
 * safety ceiling) could silently receive bytes a looser concurrent caller
 * requested, or a caller with a generous timeout could be cut off by a
 * stricter concurrent caller's shorter one.
 *
 * These tests use small synthetic limits (bytes, milliseconds) rather than
 * allocating anything close to 64MB, since the property under test is the
 * *coalescing key*, not the archive/memory safety logic itself (covered by
 * `archive-bomb.test.ts`).
 */

const realFetch = globalThis.fetch;
let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'drift-http-archive-'));
  configureHttpDiskCache(cacheDir);
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  clearHttpCache();
  configureHttpDiskCache(null);
  await rm(cacheDir, { recursive: true, force: true });
});

/** A response whose body streams in small chunks, so `readBounded`'s streaming size check is genuinely exercised. */
function chunkedResponse(bytes: Buffer, chunkSize = 16): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe('fetchArchive in-flight coalescing respects each caller\'s own safety constraints', () => {
  test('a strict maxBytes caller and a loose maxBytes caller, same URL, concurrent: strict rejects, loose succeeds, and each triggers its own network attempt', async () => {
    const url = 'https://example.com/archive-a.tar.gz';
    const body = Buffer.alloc(500, 'x');
    let networkCalls = 0;
    globalThis.fetch = (() => {
      networkCalls += 1;
      return Promise.resolve(chunkedResponse(body));
    }) as typeof fetch;

    const [strict, loose] = await Promise.all([
      fetchArchive(url, { maxBytes: 10, retries: 0 }),
      fetchArchive(url, { maxBytes: 10_000, retries: 0 }),
    ]);

    assert.equal(strict.ok, false, `the strict caller's 10-byte cap must be enforced, got: ${JSON.stringify(strict)}`);
    assert.equal(loose.ok, true, `the loose caller must succeed with the full body, got: ${JSON.stringify(loose)}`);
    if (loose.ok) assert.equal(loose.bytes.length, 500);
    assert.equal(
      networkCalls,
      2,
      `the strict and loose callers have different maxBytes and must not coalesce into one shared attempt, got ${networkCalls} network calls`,
    );
  });

  test('a strict maxBytes caller does not corrupt what a loose caller receives, and vice versa (order reversed)', async () => {
    const url = 'https://example.com/archive-a-reversed.tar.gz';
    const body = Buffer.alloc(500, 'y');
    globalThis.fetch = (() => Promise.resolve(chunkedResponse(body))) as typeof fetch;

    // Loose caller started first this time -- the strict caller joining
    // second must still enforce its own cap rather than inheriting the
    // first caller's successful (oversized, from its own perspective) result.
    const [loose, strict] = await Promise.all([
      fetchArchive(url, { maxBytes: 10_000, retries: 0 }),
      fetchArchive(url, { maxBytes: 10, retries: 0 }),
    ]);

    assert.equal(loose.ok, true);
    assert.equal(strict.ok, false, `the strict caller must reject even when it joins after a looser caller already started, got: ${JSON.stringify(strict)}`);
  });

  test('a short-timeout owner does not shortchange a long-timeout caller for the same URL', async () => {
    const url = 'https://example.com/archive-b.tar.gz';
    const body = Buffer.alloc(200, 'z');
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let attempts = 0;

    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      attempts += 1;
      const attempt = attempts;
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => {
          signal?.removeEventListener('abort', onAbort);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort);
        if (attempt === 1) {
          // The short-budget caller's own attempt: held open, only ever
          // settled by its own abort.
          return;
        }
        // The long-budget caller's own, independent attempt: resolves once
        // explicitly released below, well after the short caller has
        // already timed out.
        slowGate.then(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve(chunkedResponse(body));
        });
      });
    }) as typeof fetch;

    const shortPromise = fetchArchive(url, { timeoutMs: 60, retries: 0, maxBytes: 10_000 });
    const longPromise = fetchArchive(url, { timeoutMs: 20_000, retries: 0, maxBytes: 10_000 });

    const short = await shortPromise;
    assert.equal(short.ok, false, `the short-timeout caller must respect its own 60ms budget, got: ${JSON.stringify(short)}`);
    assert.equal(attempts, 2, 'the long-timeout caller must have started its own, separate network attempt rather than joining the short one');

    releaseSlow?.();
    const long = await longPromise;
    assert.equal(long.ok, true, `the long-timeout caller must not have inherited the short caller's timeout, got: ${JSON.stringify(long)}`);
  });

  test('same URL and identical options still coalesce into exactly one underlying fetch', async () => {
    const url = 'https://example.com/archive-c.tar.gz';
    const body = Buffer.alloc(300, 'w');
    let networkCalls = 0;
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    globalThis.fetch = (() => {
      networkCalls += 1;
      return gate.then(() => chunkedResponse(body));
    }) as typeof fetch;

    const options = { maxBytes: 10_000, timeoutMs: 20_000, retries: 0 };
    const first = fetchArchive(url, options);
    const second = fetchArchive(url, options);
    releaseGate?.();

    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(networkCalls, 1, `identical options for the same URL must coalesce into one network call, got ${networkCalls}`);
  });

  test('an oversized archive already on disk is still rejected for a later, stricter caller', async () => {
    const url = 'https://example.com/archive-d.tar.gz';
    const body = Buffer.alloc(500, 'v');
    let networkCalls = 0;
    globalThis.fetch = (() => {
      networkCalls += 1;
      return Promise.resolve(chunkedResponse(body));
    }) as typeof fetch;

    // A loose caller downloads and caches the full 500-byte archive to disk.
    const loose = await fetchArchive(url, { maxBytes: 10_000, retries: 0 });
    assert.equal(loose.ok, true);
    assert.equal(networkCalls, 1);

    // A later, independent, stricter caller must not be served the cached
    // (oversized, from its perspective) bytes straight off disk.
    const strict = await fetchArchive(url, { maxBytes: 10, retries: 0 });
    assert.equal(strict.ok, false, `a stricter later caller must reject bytes that are cached but exceed its own cap, got: ${JSON.stringify(strict)}`);
    assert.equal(networkCalls, 2, 'the disk-cache size mismatch must trigger a fresh network attempt, not a silent oversized hit');
  });
});
