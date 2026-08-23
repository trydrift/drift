import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchTypeSurface, clearTypeSurfaceCache } from '../dist/evidence/type-surface.js';
import { clearHttpCache, configureHttpDiskCache } from '../dist/util/http.js';
import { readComputed } from '../dist/util/artifact-cache.js';

/**
 * The disk-level counterpart to `test/type-surface-cache.test.ts`'s in-process
 * cache: a published npm version's own declarations cannot change, so their
 * parsed surface is worth remembering *between* scans, not only within one —
 * the same case `src/evidence/surface/python.ts` already covers for PyPI.
 *
 * The one thing this must get right that the in-process cache does not have to
 * worry about: a surface assembled by following a dependency range (a
 * "wrapper" package — see `mergeDependencySurfaces`) depends on which version
 * currently satisfies that range, which can change as new releases land. That
 * is a fact about the registry today, not about the pinned version being
 * asked about, so it must never be written to a cache with no TTL. Only a
 * surface built entirely from the package's own declarations is safe to keep
 * forever.
 */

const realFetch = globalThis.fetch;
let cacheDir: string;

function stubFetch(responder: (url: string) => Response | Promise<Response>): { calls: () => string[] } {
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    calls.push(String(input));
    return Promise.resolve(responder(String(input)));
  }) as typeof fetch;
  return { calls: () => calls };
}

function isMetadataApi(url: string): boolean {
  try {
    return new URL(url).hostname === 'data.jsdelivr.com';
  } catch {
    return false;
  }
}

function listing(...files: string[]): Response {
  return new Response(JSON.stringify({ files: files.map((name) => ({ name: `/${name}` })) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function reset(): Promise<void> {
  clearHttpCache();
  clearTypeSurfaceCache();
  cacheDir = await mkdtemp(join(tmpdir(), 'drift-surface-disk-'));
  configureHttpDiskCache(cacheDir);
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  configureHttpDiskCache(null);
  clearHttpCache();
  clearTypeSurfaceCache();
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('type surface disk cache', () => {
  test('a self-contained surface survives clearing the in-process cache', async () => {
    await reset();
    const stub = stubFetch((url) => {
      if (isMetadataApi(url)) return listing('package.json', 'index.d.ts');
      if (url.endsWith('/package.json')) return new Response('{"types":"index.d.ts"}', { status: 200 });
      if (url.endsWith('/index.d.ts')) {
        return new Response('export declare function go(a: string): void;', { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const first = await fetchTypeSurface('demo', '1.0.0');
    assert.ok(first?.api.has('go'));
    void stub;

    // A fresh process would have an empty in-process cache but the same disk
    // cache — simulated here by clearing only the in-process side. The HTTP
    // layer's own disk cache (separate from the artifact cache under test —
    // see the next test's comment) would also survive this and could answer
    // round two on its own, so every response is made to fail here: the only
    // way `second` can come back correct is the assembled *surface* itself
    // being read back from `readComputed`, not any individual HTTP response.
    clearTypeSurfaceCache();
    stubFetch(() => new Response('', { status: 500 }));
    const second = await fetchTypeSurface('demo', '1.0.0');

    assert.ok(second?.api.has('go'), 'answered from the artifact cache although every HTTP response now fails');
  });

  test('a wrapper surface assembled from a dependency range is never persisted', async () => {
    await reset();
    const stub = stubFetch((url) => {
      if (isMetadataApi(url) && url.includes('/helper/resolved')) {
        return new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 });
      }
      if (isMetadataApi(url) && url.includes('demo@1.0.0')) return listing('package.json', 'index.d.ts');
      if (isMetadataApi(url) && url.includes('helper@2.0.0')) return listing('package.json', 'index.d.ts');
      if (url.includes('/demo@1.0.0/package.json')) {
        return new Response(
          JSON.stringify({ types: 'index.d.ts', dependencies: { helper: '^2.0.0' } }),
          { status: 200 },
        );
      }
      if (url.includes('/demo@1.0.0/index.d.ts')) {
        return new Response("export { assist } from 'helper';", { status: 200 });
      }
      if (url.includes('/helper@2.0.0/package.json')) {
        return new Response('{"types":"index.d.ts"}', { status: 200 });
      }
      if (url.includes('/helper@2.0.0/index.d.ts')) {
        return new Response('export declare function assist(): void;', { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const first = await fetchTypeSurface('demo', '1.0.0');
    assert.ok(first, 'a surface was assembled');
    assert.ok(
      first!.viaDependencies.some((v) => v.startsWith('helper@')),
      'the fixture actually exercises dependency-following',
    );

    // Inspected directly rather than through a second `fetchTypeSurface` call:
    // the HTTP layer has its own, separate disk cache for individual jsDelivr
    // responses (`fileListing` marks them `immutable`), which would answer a
    // second round from disk regardless of whether the *assembled surface*
    // was persisted — that would make a request-count assertion pass for the
    // wrong reason. Reading the artifact-cache entries directly is the only
    // way to check what this change actually claims: that the wrapper's own
    // key was never written, while its dependency's was.
    const wrapperEntry = await readComputed('npm-surface:v1:demo@1.0.0#deps');
    const dependencyEntry = await readComputed('npm-surface:v1:helper@2.0.0#own');

    assert.equal(
      wrapperEntry,
      null,
      "a surface assembled from 'helper's range-resolved version must never be persisted",
    );
    assert.ok(
      dependencyEntry !== null,
      "'helper'@2.0.0's own surface has no such dependency and is safe to persist",
    );
  });
});
