import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchCocoaPodsSpec,
  githubRepoFromSpec,
  clearCocoaPodsSpecCache,
} from '../dist/evidence/cocoapods-spec.js';
import { fetchRegistryInfo } from '../dist/evidence/registry.js';
import { clearHttpCache } from '../dist/util/http.js';

/**
 * The podspec is the only place a pod declares its source repository,
 * `module_name`, and description. Drift used to fetch it for `module_name`
 * during localization and, separately, return `githubRepo: null` from
 * evidence — so FlexLayout / PinLayout / SwiftLint lost release research even
 * though their podspec names a GitHub `source`. One shared resolver fixes it.
 */

const realFetch = globalThis.fetch;

const PODSPEC = {
  name: 'FlexLayout',
  version: '2.0.10',
  module_name: 'FlexLayout',
  summary: 'FlexLayout wraps yoga.',
  description: 'A nice flexbox layout library for iOS.',
  homepage: 'https://github.com/layoutBox/FlexLayout',
  source: { git: 'https://github.com/layoutBox/FlexLayout.git', tag: '2.0.10' },
};

function stub(handler: (url: string) => unknown): { calls: () => string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = handler(url);
    if (body === undefined) return new Response('', { status: 404 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { calls: () => calls };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
  clearCocoaPodsSpecCache();
});

describe('fetchCocoaPodsSpec', () => {
  test('reads the typed subset and is fetched at most once per (name, version)', async () => {
    const s = stub((url) => (url.includes('/Specs/') ? PODSPEC : undefined));

    const a = await fetchCocoaPodsSpec('FlexLayout', '2.0.10');
    const b = await fetchCocoaPodsSpec('FlexLayout', '2.0.10');

    assert.equal(a?.moduleName, 'FlexLayout');
    assert.equal(a?.source?.git, 'https://github.com/layoutBox/FlexLayout.git');
    assert.equal(a?.homepage, 'https://github.com/layoutBox/FlexLayout');
    assert.equal(a?.description, 'A nice flexbox layout library for iOS.');
    assert.equal(b, a, 'the second call is served from cache');
    assert.equal(s.calls().filter((u) => u.includes('/Specs/')).length, 1);
  });

  test('a miss is not remembered by the spec resolver', async () => {
    stub(() => undefined);
    assert.equal(await fetchCocoaPodsSpec('Nope', '1.0.0'), null);
    clearHttpCache(); // the HTTP layer caches 404s; the spec resolver must not
    const s = stub((url) => (url.includes('/Specs/') ? PODSPEC : undefined));
    assert.ok(await fetchCocoaPodsSpec('Nope', '1.0.0'), 'a later success is not shadowed by the earlier miss');
    assert.ok(s.calls().some((u) => u.includes('/Specs/')));
  });
});

describe('githubRepoFromSpec', () => {
  const base = { name: 'X', version: '1', moduleName: null, homepage: null, summary: null, description: null };

  test('from an explicit source.git', () => {
    assert.equal(
      githubRepoFromSpec({ ...base, source: { git: 'https://github.com/layoutBox/PinLayout.git' } }),
      'layoutBox/PinLayout',
    );
  });
  test('from a GitHub homepage when source is not git', () => {
    assert.equal(
      githubRepoFromSpec({ ...base, source: { http: 'https://example.com/x.zip' }, homepage: 'https://github.com/realm/SwiftLint' }),
      'realm/SwiftLint',
    );
  });
  test('null for a non-GitHub source', () => {
    assert.equal(
      githubRepoFromSpec({ ...base, source: { git: 'https://gitlab.com/priv/thing.git' }, homepage: 'https://example.com' }),
      null,
    );
  });
});

describe('fetchRegistryInfo for cocoapods', () => {
  const trunk = { versions: [{ name: '2.0.9' }, { name: '2.0.10' }] };

  test('resolves the GitHub repo from the podspec and keeps Trunk versions', async () => {
    stub((url) => {
      if (url.includes('trunk.cocoapods.org')) return trunk;
      if (url.includes('/Specs/')) return PODSPEC;
      return undefined;
    });

    const info = await fetchRegistryInfo('FlexLayout', 'cocoapods', '2.0.10');
    assert.equal(info?.githubRepo, 'layoutBox/FlexLayout');
    assert.deepEqual(info?.versions.sort(), ['2.0.10', '2.0.9']);
    assert.equal(info?.description, 'A nice flexbox layout library for iOS.');
  });

  test('a pod whose podspec names no GitHub source keeps githubRepo null but still lists versions', async () => {
    stub((url) => {
      if (url.includes('trunk.cocoapods.org')) return trunk;
      if (url.includes('/Specs/')) {
        return { ...PODSPEC, homepage: 'https://example.com', source: { http: 'https://example.com/x.zip' } };
      }
      return undefined;
    });

    const info = await fetchRegistryInfo('PrivatePod', 'cocoapods', '2.0.10');
    assert.equal(info?.githubRepo, null);
    assert.equal(info?.versions.length, 2);
  });
});
