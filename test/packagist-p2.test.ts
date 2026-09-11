import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { expandPackagistP2, exactPackagistRelease } from '../dist/evidence/packagist-p2.js';
import { fetchRegistryInfo } from '../dist/evidence/registry.js';
import { resolveModuleMaps } from '../dist/localize/modules.js';
import { clearHttpCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';

const realFetch = globalThis.fetch;

const releases = [
  {
    version: '2.1.0',
    description: 'PHPStan',
    homepage: 'https://phpstan.org/',
    source: { url: 'https://github.com/phpstan/phpstan.git' },
    autoload: { 'psr-4': { 'PHPStan\\': 'src/' } },
    abandoned: false,
  },
  { version: '2.0.4' },
  { version: '2.0.3', homepage: null, autoload: null },
];

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

describe('Packagist p2 expansion', () => {
  test('inherits omitted fields while preserving exact raw identities and explicit null', () => {
    const expanded = expandPackagistP2(releases);
    const inherited = exactPackagistRelease(expanded, '2.0.4');
    assert.equal(inherited?.version, '2.0.4');
    assert.deepEqual(inherited?.source, { url: 'https://github.com/phpstan/phpstan.git' });
    assert.equal(inherited?.homepage, 'https://phpstan.org/');
    assert.deepEqual(inherited?.autoload, { 'psr-4': { 'PHPStan\\': 'src/' } });
    assert.equal(exactPackagistRelease(expanded, '2.0.3')?.homepage, null);
    assert.equal(exactPackagistRelease(expanded, 'v2.0.4'), undefined, 'identity is not normalized');
  });

  test('registry source discovery selects effective metadata for the exact target', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ packages: { 'phpstan/phpstan': releases } }), {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const info = await fetchRegistryInfo('phpstan/phpstan', 'packagist', '2.0.4');
    assert.equal(info?.githubRepo, 'phpstan/phpstan');
    assert.equal(info?.homepage, 'https://phpstan.org/');
    assert.equal(info?.description, 'PHPStan');
  });

  test('module mapping uses the same expanded exact-version metadata', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ packages: { 'phpstan/phpstan': releases } }), {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const maps = await resolveModuleMaps([{
      name: 'phpstan/phpstan',
      ecosystem: 'packagist',
      from: '2.0.3',
      to: '2.0.4',
      kind: 'runtime',
      bump: 'patch',
      manifestPath: 'composer.json',
    }], { logger: createLogger('error') });
    assert.deepEqual(maps.get('packagist|phpstan/phpstan')?.names, ['PHPStan']);
  });
});
