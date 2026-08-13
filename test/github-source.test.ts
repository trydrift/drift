import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGitHubDeclaration, attachGitHubSources } from '../dist/evidence/github-source.js';
import { buildPlan } from '../dist/plan/index.js';
import { DEFAULT_CONFIG } from '../dist/config/schema.js';
import { clearHttpCache } from '../dist/util/http.js';
import type { RemediationPlan } from '../dist/types.js';

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

describe('attachGitHubSources', () => {
  const repo = { owner: 'acme', repo: 'app', baseBranch: 'main', beforeSha: 'a'.repeat(40), afterSha: 'b'.repeat(40) };
  const dependencyChange = {
    name: 'acme-sdk',
    ecosystem: 'npm' as const,
    from: '1.0.0',
    to: '2.0.0',
    kind: 'runtime' as const,
    bump: 'major' as const,
    manifestPath: 'package.json',
  };
  const breaking = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    dependency: 'acme-sdk',
    kind: 'removed-export' as const,
    summary: `\`createClient\` was removed (${id}).`,
    remediation: 'Replace every usage of `createClient`.',
    symbols: ['createClient'],
    confidence: 'high' as const,
    citations: [] as string[],
    ...overrides,
  });
  const site = (breakingChangeId: string) => ({
    breakingChangeId,
    file: 'src/index.ts',
    line: 12,
    excerpt: 'createClient()',
    matchedSymbol: 'createClient',
    confidence: 'high' as const,
  });

  function stubRegistryAndGitHub(): void {
    stubFetch((url) => {
      if (url.includes('registry.npmjs.org')) {
        return json({ 'dist-tags': { latest: '2.0.0' }, repository: { url: 'https://github.com/acme/acme-sdk' } });
      }
      if (url.includes('/tags?')) return json([{ name: 'v2.0.0' }]);
      if (url.includes('/search/code')) return json({ items: [{ path: 'src/client.ts' }] });
      if (url.startsWith('https://raw.githubusercontent.com/')) return text('export function createClient() {}\n');
      return text('', 404);
    });
  }

  test('without a token, the plan is returned unchanged and nothing is fetched', async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return text('', 500);
    });

    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence: [],
      breakingChanges: [breaking('bc_1')],
      impactSites: [site('bc_1')],
    }) as RemediationPlan;

    const result = await attachGitHubSources(plan, undefined);
    assert.equal(result, plan, 'the exact same plan is returned, not a copy');
    assert.equal(called, false);
  });

  test('only resolves breaking changes that actually reach code in this repository', async () => {
    stubRegistryAndGitHub();

    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence: [],
      // bc_1 has an impact site; bc_2 is upstream-only and should never be
      // looked up — spending a rate-limited lookup on a symbol the report
      // won't even show would be exactly the mistake this function exists
      // to avoid.
      breakingChanges: [breaking('bc_1'), breaking('bc_2', { id: 'bc_2', symbols: ['neverUsed'] })],
      impactSites: [site('bc_1')],
    }) as RemediationPlan;

    const result = await attachGitHubSources(plan, 'tok');
    const bc1 = result.breakingChanges.find((b: { id: string }) => b.id === 'bc_1');
    const bc2 = result.breakingChanges.find((b: { id: string }) => b.id === 'bc_2');
    assert.equal(bc1!.sourceUrl, 'https://github.com/acme/acme-sdk/blob/v2.0.0/src/client.ts#L1');
    assert.equal(bc2!.sourceUrl, undefined, 'an unreachable breaking change is never looked up');
  });

  test('no breaking change reaches code in this repository: the plan is returned unchanged', async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return text('', 500);
    });

    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence: [],
      breakingChanges: [breaking('bc_1')],
      impactSites: [], // upstream-only
    }) as RemediationPlan;

    const result = await attachGitHubSources(plan, 'tok');
    assert.equal(result, plan);
    assert.equal(called, false);
  });
});
