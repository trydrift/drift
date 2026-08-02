import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearHttpCache, configureHttpDiskCache, fetchText } from '../../src/util/http.js';

describe('disk-backed evidence HTTP cache', () => {
  test('persists responses and revalidates stale ETags with If-None-Match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-evidence-cache-'));
    const seen: (string | undefined)[] = [];
    let requests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests += 1;
      const headers = init?.headers as Record<string, string>;
      seen.push(headers?.['If-None-Match']);
      if (headers?.['If-None-Match'] === '"v1"') {
        return {
          ok: false,
          status: 304,
          headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? '"v1"' : null) },
          text: async () => '',
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? '"v1"' : null) },
        text: async () => 'cached evidence',
      } as Response;
    }) as typeof fetch;
    const url = 'https://registry.example.test/package/react/19.0.0';

    try {
      configureHttpDiskCache(dir);
      clearHttpCache();
      assert.equal(await fetchText(url), 'cached evidence');
      clearHttpCache();
      assert.equal(await fetchText(url, { cacheTtlMs: 0 }), 'cached evidence');

      assert.equal(requests, 2);
      assert.deepEqual(seen, [undefined, '"v1"']);
    } finally {
      globalThis.fetch = originalFetch;
      configureHttpDiskCache(null);
      clearHttpCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
