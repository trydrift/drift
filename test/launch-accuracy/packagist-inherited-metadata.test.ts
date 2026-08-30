import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { expandPackagistVersions, packagistReleaseFor } from '../../dist/evidence/packagist.js';
import { fetchRegistryInfo } from '../../dist/evidence/registry.js';
import { clearHttpCache } from '../../dist/util/http.js';

/**
 * Packagist serves p2 documents "minified": later version entries carry only
 * what changed since the entry before them. Reading each entry as
 * self-contained lost `phpstan/phpstan`'s source repository — and with it every
 * release note and changelog that repository would have supplied — so the
 * package fell to Evidence Missing for a reason that was Drift's, not PHP's.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

function stub(responder: (url: string) => Response): void {
  clearHttpCache();
  globalThis.fetch = ((input: string | URL | Request) =>
    Promise.resolve(responder(String(input)))) as typeof fetch;
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** p2 order: newest first, first entry complete, later entries deltas. */
const PHPSTAN_P2 = [
  {
    version: '2.1.17',
    description: 'PHPStan - PHP Static Analysis Tool',
    homepage: 'https://phpstan.org',
    source: { url: 'https://github.com/phpstan/phpstan.git' },
  },
  { version: '2.1.16' },
  { version: '2.1.15' },
  { version: '2.0.0', abandoned: false },
];

describe('Packagist p2 inheritance is expanded once, everywhere', () => {
  test('later entries inherit metadata from the entry before them', () => {
    const expanded = expandPackagistVersions(PHPSTAN_P2);

    assert.deepEqual(
      expanded.map((release) => release.version),
      ['2.1.17', '2.1.16', '2.1.15', '2.0.0'],
    );
    for (const release of expanded) {
      assert.equal(release.sourceUrl, 'https://github.com/phpstan/phpstan.git', release.version);
      assert.equal(release.homepage, 'https://phpstan.org', release.version);
    }
  });

  test('an explicit null removes a field rather than inheriting it', () => {
    const expanded = expandPackagistVersions([
      { version: '2.0.0', homepage: 'https://example.test' },
      { version: '1.0.0', homepage: null },
    ]);
    assert.equal(expanded[0]?.homepage, 'https://example.test');
    assert.equal(expanded[1]?.homepage, null);
  });

  test('an exact raw version selects that version’s effective metadata', () => {
    const expanded = expandPackagistVersions(PHPSTAN_P2);
    assert.equal(packagistReleaseFor(expanded, '2.1.15')?.sourceUrl, 'https://github.com/phpstan/phpstan.git');
    // A `v`-prefixed tag is a spelling of the same release, not another one.
    assert.equal(packagistReleaseFor(expanded, 'v2.1.15')?.version, '2.1.15');
    assert.equal(packagistReleaseFor(expanded, '9.9.9'), null);
  });

  test('the registry provider resolves the repository for an inherited version', async () => {
    stub((url) => (url.includes('/p2/phpstan/phpstan.json') ? json({ packages: { 'phpstan/phpstan': PHPSTAN_P2 } }) : new Response('', { status: 404 })));

    const info = await fetchRegistryInfo('phpstan/phpstan', 'packagist', '2.1.15');

    assert.equal(info?.githubRepo, 'phpstan/phpstan');
    assert.equal(info?.homepage, 'https://phpstan.org');
    assert.deepEqual(info?.versions, ['2.1.17', '2.1.16', '2.1.15', '2.0.0']);
  });

  test('exact raw versions survive the expansion', async () => {
    const raw = [
      { version: 'v3.0.0', source: { url: 'https://github.com/guzzle/guzzle.git' } },
      { version: '2.9.0' },
    ];
    stub((url) => (url.includes('/p2/guzzle/guzzle.json') ? json({ packages: { 'guzzle/guzzle': raw } }) : new Response('', { status: 404 })));

    const info = await fetchRegistryInfo('guzzle/guzzle', 'packagist', 'v3.0.0');
    assert.deepEqual(info?.versions, ['v3.0.0', '2.9.0']);
  });
});
