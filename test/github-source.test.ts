import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGitHubDeclaration } from '../dist/evidence/github-source.js';
import { clearHttpCache } from '../dist/util/http.js';

/**
 * `resolveGitHubDeclaration` is a chain of three best-effort steps — match a
 * git tag, find a candidate file via code search, confirm the symbol is
 * still there at the resolved tag — and every one of them can fail for an
 * ordinary reason. These tests are about that chain failing *safely*: a
 * miss anywhere returns `null` rather than a URL that might be wrong.
 */

const realFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status });
}

function stubFetch(responder: (url: string) => Response | Promise<Response>): void {
  clearHttpCache();
  globalThis.fetch = ((input: string | URL | Request) => Promise.resolve(responder(String(input)))) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

describe('resolveGitHubDeclaration', () => {
  test('resolves a real blob URL and line when every step succeeds', async () => {
    stubFetch((url) => {
      if (url.includes('/tags?')) return json([{ name: 'v4.4.3' }, { name: 'v4.4.2' }]);
      if (url.includes('/search/code')) return json({ items: [{ path: 'src/types/boolean.ts' }] });
      if (url.startsWith('https://raw.githubusercontent.com/')) {
        return text('// header\nexport function coercedBoolean(x: unknown) {}\n');
      }
      return text('', 404);
    });

    const result = await resolveGitHubDeclaration('colinhacks/zod', '4.4.3', 'coercedBoolean', undefined);
    assert.deepEqual(result, {
      url: 'https://github.com/colinhacks/zod/blob/v4.4.3/src/types/boolean.ts#L2',
      line: 2,
    });
  });

  test('no matching tag: returns null without ever calling code search', async () => {
    let searchCalled = false;
    stubFetch((url) => {
      if (url.includes('/tags?')) return json([{ name: 'v1.0.0' }]);
      if (url.includes('/search/code')) {
        searchCalled = true;
        return json({ items: [] });
      }
      return text('', 404);
    });

    const result = await resolveGitHubDeclaration('colinhacks/zod', '4.4.3', 'coercedBoolean', undefined);
    assert.equal(result, null);
    assert.equal(searchCalled, false, 'a failed tag match should short-circuit before spending a search call');
  });

  test('code search finds nothing: returns null', async () => {
    stubFetch((url) => {
      if (url.includes('/tags?')) return json([{ name: 'v4.4.3' }]);
      if (url.includes('/search/code')) return json({ items: [] });
      return text('', 404);
    });

    const result = await resolveGitHubDeclaration('colinhacks/zod', '4.4.3', 'coercedBoolean', undefined);
    assert.equal(result, null);
  });

  test('code search points at a file that no longer has the symbol at the resolved tag: returns null, not a stale link', async () => {
    stubFetch((url) => {
      if (url.includes('/tags?')) return json([{ name: 'v4.4.3' }]);
      if (url.includes('/search/code')) return json({ items: [{ path: 'src/types/boolean.ts' }] });
      // The default branch (where search looked) has moved on; this symbol
      // isn't in the file at the tag actually being cited.
      if (url.startsWith('https://raw.githubusercontent.com/')) return text('export function somethingElse() {}\n');
      return text('', 404);
    });

    const result = await resolveGitHubDeclaration('colinhacks/zod', '4.4.3', 'coercedBoolean', undefined);
    assert.equal(result, null, 'an unverified match must not become a URL — it would point at the wrong thing');
  });

  test('search results are filtered to real source, never a compiled .d.ts or node_modules', async () => {
    stubFetch((url) => {
      if (url.includes('/tags?')) return json([{ name: 'v4.4.3' }]);
      if (url.includes('/search/code')) {
        return json({
          items: [
            { path: 'dist/index.d.ts' },
            { path: 'vendor/node_modules/other/index.ts' },
            { path: 'src/types/boolean.ts' },
          ],
        });
      }
      if (url.startsWith('https://raw.githubusercontent.com/')) {
        return text('export function coercedBoolean() {}\n');
      }
      return text('', 404);
    });

    const result = await resolveGitHubDeclaration('colinhacks/zod', '4.4.3', 'coercedBoolean', undefined);
    assert.equal(result?.url, 'https://github.com/colinhacks/zod/blob/v4.4.3/src/types/boolean.ts#L1');
  });
});
