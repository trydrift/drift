import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchArchive, fetchText, clearHttpCache, configureHttpDiskCache } from '../dist/util/http.js';

/**
 * Absence is most of what a scan learns.
 *
 * There is no API that says whether a third-party repository has a changelog,
 * so Drift guesses filenames — and on a warm scan of Scrapy's dependencies,
 * every one of the 1,397 requests that still reached the network was a 404
 * being asked again. Remembering those is the single largest saving available
 * on a repeat scan.
 *
 * What must not be remembered is a *refusal*. A 403, a timeout or a 502 is the
 * server declining to answer, and writing one down as "confirmed absent" is
 * exactly how a rate-limited network becomes a report full of "no changelog
 * found" — a fair record of a throttled laptop and a libel against the tool.
 */

const realFetch = globalThis.fetch;
let cacheDir: string;

function stub(responder: (url: string) => Response): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = ((input: string | URL | Request) => {
    calls += 1;
    return Promise.resolve(responder(String(input)));
  }) as typeof fetch;
  return { calls: () => calls };
}

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'drift-http-cache-'));
  configureHttpDiskCache(cacheDir);
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  clearHttpCache();
  configureHttpDiskCache(null);
  await rm(cacheDir, { recursive: true, force: true });
});

describe('remembering that something is not there', () => {
  test('a 404 is written down, so the next process does not ask again', async () => {
    const first = stub(() => new Response('nope', { status: 404 }));
    assert.equal(await fetchText('https://example.com/CHANGELOG.md'), null);
    assert.equal(first.calls(), 1);

    // A fresh in-memory cache stands in for a fresh process; the disk cache
    // is the only thing carried over.
    clearHttpCache();
    const second = stub(() => new Response('nope', { status: 404 }));
    assert.equal(await fetchText('https://example.com/CHANGELOG.md'), null);
    assert.equal(second.calls(), 0);
  });

  test('a 403 is never written down — a refusal is not an answer', async () => {
    stub(() => new Response('rate limited', { status: 403 }));
    assert.equal(await fetchText('https://example.com/a.md'), null);

    clearHttpCache();
    const retry = stub(() => new Response('# found it', { status: 200 }));
    // The resource was there all along; a cached 403 would have hidden it.
    assert.equal(await fetchText('https://example.com/a.md'), '# found it');
    assert.equal(retry.calls(), 1);
  });

  test('a network error is never written down either', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('ECONNRESET'))) as typeof fetch;
    assert.equal(await fetchText('https://example.com/b.md', { retries: 0 }), null);

    clearHttpCache();
    const retry = stub(() => new Response('# back up', { status: 200 }));
    assert.equal(await fetchText('https://example.com/b.md'), '# back up');
    assert.equal(retry.calls(), 1);
  });

  test('a 500 is never written down, however many times it is retried', async () => {
    stub(() => new Response('boom', { status: 500 }));
    assert.equal(await fetchText('https://example.com/c.md', { retries: 0 }), null);

    clearHttpCache();
    const retry = stub(() => new Response('# recovered', { status: 200 }));
    assert.equal(await fetchText('https://example.com/c.md'), '# recovered');
    assert.equal(retry.calls(), 1);
  });

  test('a remembered absence expires, so a document added later is still found', async () => {
    stub(() => new Response('nope', { status: 404 }));
    assert.equal(await fetchText('https://example.com/d.md'), null);

    // Aged past the absence window by editing the entry rather than waiting six
    // hours. This is the property the whole TTL exists for: a changelog added
    // this morning must not stay invisible because it was absent last night.
    const [entry] = await readdir(cacheDir);
    const path = join(cacheDir, entry!);
    const stored = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(stored.absent, true, 'the 404 was recorded as a definitive absence');
    stored.fetchedAt = Date.now() - 7 * 60 * 60 * 1000;
    await writeFile(path, JSON.stringify(stored), 'utf8');

    clearHttpCache();
    const later = stub(() => new Response('# added since', { status: 200 }));
    assert.equal(await fetchText('https://example.com/d.md'), '# added since');
    assert.equal(later.calls(), 1);
  });

  test('an entry from before absences were recorded is re-fetched, not trusted', async () => {
    // Older cache layouts wrote `body: null` for anything that failed, including
    // rate limits. Without the explicit flag those would now read as confirmed
    // absences that nothing ever confirmed.
    stub(() => new Response('nope', { status: 404 }));
    await fetchText('https://example.com/f.md');

    const [entry] = await readdir(cacheDir);
    const path = join(cacheDir, entry!);
    const stored = JSON.parse(await readFile(path, 'utf8'));
    delete stored.absent;
    await writeFile(path, JSON.stringify(stored), 'utf8');

    clearHttpCache();
    const retry = stub(() => new Response('# was there all along', { status: 200 }));
    assert.equal(await fetchText('https://example.com/f.md'), '# was there all along');
    assert.equal(retry.calls(), 1);
  });

  test('a successful body is still cached, and still preferred', async () => {
    stub(() => new Response('# real content', { status: 200 }));
    assert.equal(await fetchText('https://example.com/e.md'), '# real content');

    clearHttpCache();
    const second = stub(() => new Response('nope', { status: 404 }));
    assert.equal(await fetchText('https://example.com/e.md'), '# real content');
    assert.equal(second.calls(), 0);
  });
});

/**
 * The surface providers that diff a compiled API each download an archive and
 * unpack it, and every one of them called `fetch` directly — outside the cache
 * entirely. A warm scan of Scrapy's dependencies re-downloaded ninety-four
 * archives it had fetched an hour before.
 *
 * These are the most cacheable things Drift fetches: a published version's
 * artifact is immutable by every registry's own rules, so there is no TTL to
 * reason about and nothing to revalidate.
 */
describe('downloading an immutable archive', () => {
  test('the bytes are kept, and the second ask never reaches the network', async () => {
    const first = stub(() => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    const one = await fetchArchive('https://example.com/pkg-1.0.0.tar.gz');
    assert.ok(one.ok && Buffer.from([1, 2, 3, 4]).equals(one.bytes));
    assert.equal(first.calls(), 1);

    clearHttpCache();
    const second = stub(() => new Response(new Uint8Array([9, 9]), { status: 200 }));
    const two = await fetchArchive('https://example.com/pkg-1.0.0.tar.gz');
    assert.ok(two.ok && Buffer.from([1, 2, 3, 4]).equals(two.bytes));
    assert.equal(second.calls(), 0);
  });

  test('a failure keeps its status, so a provider can still tell 404 from 503', async () => {
    stub(() => new Response('nope', { status: 404 }));
    const missing = await fetchArchive('https://example.com/gone.jar');
    assert.deepEqual(missing, { ok: false, status: 404 });

    clearHttpCache();
    stub(() => new Response('later', { status: 503 }));
    const down = await fetchArchive('https://example.com/flaky.jar');
    assert.ok(!down.ok && down.status === 503);
  });

  test('a failure is never cached — a 503 now is not a missing artifact forever', async () => {
    stub(() => new Response('down', { status: 503 }));
    assert.equal((await fetchArchive('https://example.com/a.jar')).ok, false);

    clearHttpCache();
    const retry = stub(() => new Response(new Uint8Array([7]), { status: 200 }));
    const back = await fetchArchive('https://example.com/a.jar');
    assert.ok(back.ok && back.bytes[0] === 7);
    assert.equal(retry.calls(), 1);
  });

  test('a request that never completes is reported, not thrown', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('ECONNRESET'))) as typeof fetch;
    const result = await fetchArchive('https://example.com/b.jar');
    assert.ok(!result.ok && result.status === 0);
    assert.match(result.error ?? '', /ECONNRESET/);
  });

  test('two callers asking at once share one download', async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return new Promise((resolve) =>
        setTimeout(() => resolve(new Response(new Uint8Array([5]), { status: 200 })), 10),
      );
    }) as typeof fetch;

    const [a, b] = await Promise.all([
      fetchArchive('https://example.com/shared.tgz'),
      fetchArchive('https://example.com/shared.tgz'),
    ]);
    assert.ok(a.ok && b.ok);
    assert.equal(calls, 1);
  });
});

describe('reporting a retry as it happens', () => {
  test('a 429 is reported as rate-limited, before the caller has any other way to know', async () => {
    stub(() => new Response('slow down', { status: 429 }));
    const retries: { attempt: number; reason: string }[] = [];
    await fetchText('https://example.com/e.md', {
      retries: 1,
      onRetry: (attempt, reason) => retries.push({ attempt, reason }),
    });
    assert.deepEqual(retries, [{ attempt: 1, reason: 'rate-limited' }]);
  });

  test('a 500 is reported as a server error', async () => {
    stub(() => new Response('boom', { status: 500 }));
    const retries: { attempt: number; reason: string }[] = [];
    await fetchText('https://example.com/f.md', {
      retries: 1,
      onRetry: (attempt, reason) => retries.push({ attempt, reason }),
    });
    assert.deepEqual(retries, [{ attempt: 1, reason: 'server-error' }]);
  });

  test('a thrown network error is reported distinctly from an HTTP error', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('ECONNRESET'))) as typeof fetch;
    const retries: { attempt: number; reason: string }[] = [];
    await fetchText('https://example.com/g.md', {
      retries: 1,
      onRetry: (attempt, reason) => retries.push({ attempt, reason }),
    });
    assert.deepEqual(retries, [{ attempt: 1, reason: 'network-error' }]);
  });

  test('a call that never retries never reports one', async () => {
    stub(() => new Response('# ok', { status: 200 }));
    const retries: unknown[] = [];
    await fetchText('https://example.com/h.md', { onRetry: (attempt, reason) => retries.push({ attempt, reason }) });
    assert.deepEqual(retries, []);
  });
});
