import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  comparePackageVersions,
  parsePublishedVersion,
  satisfiesPackageRange,
} from '../dist/version-semantics.js';
import { lookupVersions } from '../dist/upgrade/versions.js';
import { clearHttpCache } from '../dist/util/http.js';

/**
 * PEP 440 package versions and specifiers.
 *
 * Two mistakes are covered specifically. First, the ordered comparison
 * operators are not plain applications of the version ordering — `<1.0` does
 * not admit `1.0rc1` even though `1.0rc1 < 1.0`. Second, normalization is
 * structural: rewriting `-` to `.` before parsing turns the implicit post
 * release `1.0-1` (= `1.0.post1`) into the release `1.0.1`, which is a
 * different, and in ordering terms much newer, version.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

function cmp(a: string, b: string): number | null {
  return comparePackageVersions(a, b, 'pypi');
}

describe('PEP 440 ordering', () => {
  test('the canonical ladder', () => {
    const ordered = [
      '1.0.dev1',
      '1.0a1',
      '1.0a1.post1',
      '1.0b1',
      '1.0rc1',
      '1.0',
      '1.0+local',
      '1.0.post1.dev1',
      '1.0.post1',
      '1.0.post1+local',
      '1.0.post2',
      '1.0.1',
      '1!1.0',
    ];
    for (let i = 1; i < ordered.length; i++) {
      assert.equal(cmp(ordered[i - 1]!, ordered[i]!), -1, `${ordered[i - 1]} < ${ordered[i]}`);
      assert.equal(cmp(ordered[i]!, ordered[i - 1]!), 1, `${ordered[i]} > ${ordered[i - 1]}`);
    }
  });

  test('an epoch outranks the release segment entirely', () => {
    assert.equal(cmp('1!1.0', '2.0'), 1);
    assert.equal(cmp('1!1.0', '1!1.1'), -1);
  });

  test('trailing zeroes do not change a release', () => {
    assert.equal(cmp('1.0', '1.0.0'), 0);
    assert.equal(cmp('1', '1.0.0.0'), 0);
  });

  test('spelling variants normalize to the same version', () => {
    for (const [a, b] of [
      ['1.0alpha1', '1.0a1'],
      ['1.0.beta.2', '1.0b2'],
      ['1.0-rc-3', '1.0rc3'],
      ['1.0c1', '1.0rc1'],
      ['1.0preview1', '1.0rc1'],
      ['1.0a', '1.0a0'],
      ['1.0.post', '1.0.post0'],
      ['1.0-r2', '1.0.post2'],
      ['1.0.rev2', '1.0.post2'],
      ['1.0.dev', '1.0.dev0'],
      ['v1.0', '1.0'],
      ['1.0+ubuntu-1', '1.0+ubuntu.1'],
    ] as const) {
      assert.equal(cmp(a, b), 0, `${a} == ${b}`);
    }
  });

  test('an implicit post release is not a longer release segment', () => {
    // `1.0-1` is `1.0.post1`, which sits between `1.0` and `1.0.1`.
    assert.equal(cmp('1.0-1', '1.0.post1'), 0);
    assert.equal(cmp('1.0', '1.0-1'), -1);
    assert.equal(cmp('1.0-1', '1.0.1'), -1);
    assert.notEqual(cmp('1.0-1', '1.0.1'), 0);
  });

  test('a local label sorts after the public version it decorates', () => {
    assert.equal(cmp('1.0', '1.0+local'), -1);
    assert.equal(cmp('1.0+local.1', '1.0+local.2'), -1);
    // Numeric local segments outrank alphabetic ones.
    assert.equal(cmp('1.0+abc', '1.0+1'), -1);
  });

  test('raw identities survive parsing untouched', () => {
    for (const raw of ['0.8.0rc1', '2.14.0b1', '0.23', '3.11', '1!1.0', '1.0+local', '1.0-1', '1.0.post1.dev1']) {
      assert.equal(parsePublishedVersion(raw, 'pypi')?.raw, raw, raw);
    }
  });

  test('prerelease classification follows PEP 440, not the presence of a suffix', () => {
    for (const raw of ['1.0a1', '1.0b1', '1.0rc1', '1.0.dev1', '1.0.post1.dev1']) {
      assert.equal(parsePublishedVersion(raw, 'pypi')?.prerelease, true, raw);
    }
    for (const raw of ['1.0', '1.0.post1', '1.0+local', '1!1.0']) {
      assert.equal(parsePublishedVersion(raw, 'pypi')?.prerelease, false, raw);
    }
  });

  test('versions outside the grammar fail closed', () => {
    for (const raw of ['1.0.0-x86_64-linux', 'latest', '1.0.0.beta1.extra.junk', '']) {
      assert.equal(parsePublishedVersion(raw, 'pypi'), null, raw);
    }
  });
});

describe('PEP 440 specifiers', () => {
  const sat = (version: string, range: string): boolean | null =>
    satisfiesPackageRange(version, range, 'pypi');

  test('exclusive < does not admit a prerelease of the specified version', () => {
    assert.equal(sat('1.0rc1', '<1.0'), false);
    assert.equal(sat('1.0.dev1', '<1.0'), false);
    // A prerelease of an *earlier* release is still fine.
    assert.equal(sat('0.9.dev1', '<1.0'), true);
    // Unless the specifier is itself a prerelease.
    assert.equal(sat('1.0rc1', '<1.0rc2'), true);
    assert.equal(sat('1.0a1', '<1.0rc1'), true);
  });

  test('exclusive > does not admit a post release or local build of the specified version', () => {
    assert.equal(sat('1.0.post1', '>1.0'), false);
    assert.equal(sat('1.0+local', '>1.0'), false);
    assert.equal(sat('1.0.post2', '>1.0.post1'), true);
    assert.equal(sat('1.1', '>1.0'), true);
  });

  test('inclusive comparisons ignore the candidate local label', () => {
    assert.equal(sat('1.0+local', '>=1.0'), true);
    assert.equal(sat('1.0+local', '<=1.0'), true);
  });

  test('== ignores a candidate local label when the specifier has none', () => {
    assert.equal(sat('1.0+local', '==1.0'), true);
    assert.equal(sat('1.0', '==1.0'), true);
    assert.equal(sat('1.0.post1', '==1.0'), false);
  });

  test('== with a local label applies local comparison', () => {
    assert.equal(sat('1.0+local', '==1.0+local'), true);
    assert.equal(sat('1.0+other', '==1.0+local'), false);
    assert.equal(sat('1.0', '==1.0+local'), false);
  });

  test('!= is exactly the negation of ==', () => {
    assert.equal(sat('1.0+local', '!=1.0'), false);
    assert.equal(sat('1.0.1', '!=1.0'), true);
    assert.equal(sat('1.0.5', '!=1.0.*'), false);
    assert.equal(sat('1.1', '!=1.0.*'), true);
  });

  test('wildcard equality is a release prefix match', () => {
    assert.equal(sat('1.0.5', '==1.0.*'), true);
    assert.equal(sat('1.0', '==1.0.*'), true);
    assert.equal(sat('1.0.dev1', '==1.0.*'), true);
    assert.equal(sat('1.1', '==1.0.*'), false);
    assert.equal(sat('1!1.0.5', '==1.0.*'), false);
    assert.equal(sat('1!1.0.5', '==1!1.0.*'), true);
  });

  test('a wildcard on an operator that does not take one is unknown, not a loose match', () => {
    for (const range of ['>=1.0.*', '<=1.0.*', '>1.0.*', '<1.0.*', '~=1.0.*']) {
      assert.equal(sat('1.0.5', range), null, range);
    }
  });

  test('~= is >= plus a prefix match with the last segment dropped', () => {
    assert.equal(sat('2.2', '~=2.2'), true);
    assert.equal(sat('2.9', '~=2.2'), true);
    assert.equal(sat('3.0', '~=2.2'), false);
    assert.equal(sat('2.1', '~=2.2'), false);
    assert.equal(sat('1.4.6', '~=1.4.5'), true);
    assert.equal(sat('1.5.0', '~=1.4.5'), false);
    // A single release segment has no defined ceiling.
    assert.equal(sat('1.5', '~=1'), null);
  });

  test('=== is arbitrary string equality over the raw identity', () => {
    assert.equal(sat('1.0', '===1.0'), true);
    assert.equal(sat('1.0', '===1.0.0'), false);
    assert.equal(sat('1.0+local', '===1.0+local'), true);
  });

  test('epochs are compared, never dropped', () => {
    assert.equal(sat('1!1.0', '>=1.0'), true);
    assert.equal(sat('1.0', '>=1!1.0'), false);
    assert.equal(sat('1!1.0', '==1!1.0'), true);
  });

  test('a specifier Drift cannot evaluate is unknown, not satisfied', () => {
    for (const range of ['not a specifier', '@1.0', '>=', '==1.0;python_version<"3"']) {
      assert.equal(sat('1.0', range), null, range);
    }
  });
});

describe('PEP 440 discovery behaviour', () => {
  test('an implicit post release is not selected as a newer release segment', async () => {
    clearHttpCache();
    // If `1.0-1` were read as `1.0.1`, it would outrank `1.0.post1` and the
    // scan would offer a target the registry index does not order that way.
    const versions = ['1.0', '1.0-1', '1.0.1'];
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ releases: Object.fromEntries(versions.map((v) => [v, []])) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )) as typeof fetch;

    const result = await lookupVersions({ name: 'demo', ecosystem: 'pypi', current: '1.0', range: '>=1.0' });

    assert.equal(result.outcome, 'upgrade');
    if (result.outcome === 'upgrade') {
      assert.equal(result.latest, '1.0.1');
      assert.deepEqual(result.versions, ['1.0.1', '1.0-1']);
    }
  });

  test('a stable install is not moved onto a prerelease by an exclusive ceiling', async () => {
    clearHttpCache();
    const versions = ['0.7.1', '0.8.0rc1', '0.8.0'];
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ releases: Object.fromEntries(versions.map((v) => [v, []])) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )) as typeof fetch;

    const result = await lookupVersions({
      name: 'defusedxml',
      ecosystem: 'pypi',
      current: '0.7.1',
      range: '>=0.7.1,<0.8.0',
    });

    assert.equal(result.outcome, 'upgrade');
    if (result.outcome === 'upgrade') {
      assert.equal(result.latest, '0.8.0');
      // `<0.8.0` excludes both 0.8.0 and its own release candidate, so there
      // is no in-range upgrade at all.
      assert.equal(result.safeLatest, undefined);
    }
  });
});
