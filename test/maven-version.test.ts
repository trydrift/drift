import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  comparePackageVersions,
  parsePublishedVersion,
  classifyPackageBump,
  packageVersionsBetween,
} from '../dist/version-semantics.js';
import { lookupVersions } from '../dist/upgrade/versions.js';
import { clearHttpCache } from '../dist/util/http.js';

/**
 * Maven ordering is separator-sensitive. The previous comparator tokenised
 * versions with `/[0-9]+|[a-z]+/` and compared the flattened list, which made
 * `1-1` and `1.1` indistinguishable and could therefore order two real
 * releases the wrong way round — while owning upgrade discovery, latest
 * selection, changelog ranges, and bump classification.
 *
 * These cases are the reference `ComparableVersion` behaviour.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

function cmp(a: string, b: string): number | null {
  return comparePackageVersions(a, b, 'maven');
}

/** Assert a strictly ascending chain, in both directions. */
function ascending(chain: readonly string[]): void {
  for (let i = 0; i + 1 < chain.length; i++) {
    const [a, b] = [chain[i]!, chain[i + 1]!];
    assert.equal(cmp(a, b), -1, `${a} < ${b}`);
    assert.equal(cmp(b, a), 1, `${b} > ${a}`);
  }
}

function equal(a: string, b: string): void {
  assert.equal(cmp(a, b), 0, `${a} == ${b}`);
  assert.equal(cmp(b, a), 0, `${b} == ${a}`);
}

describe('Maven ComparableVersion ordering', () => {
  test('qualifier ladder', () => {
    ascending(['1-alpha', '1-beta', '1-milestone', '1-rc', '1-snapshot', '1', '1-sp']);
  });

  test('canonical release aliases', () => {
    equal('1', '1-final');
    equal('1', '1-ga');
    equal('1', '1-release');
    equal('1', '1.0');
    equal('1', '1.0.0');
    equal('1', '1-0');
    equal('1.0', '1.0-0');
  });

  test('single-letter qualifier aliases only apply before a digit', () => {
    equal('1a1', '1-alpha-1');
    equal('1b2', '1-beta-2');
    equal('1m3', '1-milestone-3');
    equal('1cr', '1rc');
    equal('1X', '1x');
    // Bare `a` is an unknown qualifier, not alpha, so it sorts after release.
    ascending(['1', '1-a']);
  });

  test('separator structure is preserved', () => {
    // The whole point: these four are four different versions.
    ascending(['1.foo', '1-foo', '1-1', '1.1']);
    assert.notEqual(cmp('1-1', '1.1'), 0);
  });

  test('digit/string transitions behave as hyphens', () => {
    equal('1a', '1-a');
    equal('1.0a', '1-a');
    equal('1.0.0a', '1-a');
    // A qualifier followed by a digit after a dot sorts below the hyphenated form.
    ascending(['1.0.0.x1', '1.0.0-x2']);
  });

  test('unknown qualifiers sort after known ones, then lexically', () => {
    ascending(['1-snapshot', '1', '1-sp', '1-abc', '1-def']);
  });

  test('numeric segments compare numerically, not lexically', () => {
    ascending(['1-m2', '1-m11']);
    ascending(['1-rc2', '1-rc123']);
    ascending(['2.0.2', '2.0.123', '2.1.0']);
    // Beyond 2^53 — real Maven builds carry timestamped numeric segments.
    ascending(['1.0-20260101999999999999', '1.0-20260102000000000000']);
  });

  test('the documented number chain', () => {
    ascending([
      '2.0', '2-1', '2.0.a', '2.0.0.a', '2.0.2', '2.0.123', '2.1.0',
      '2.1-a', '2.1b', '2.1-c', '2.1-1', '2.1.0.1', '2.2', '2.123',
    ]);
  });

  test('the documented qualifier chain', () => {
    ascending([
      '1-alpha2snapshot', '1-alpha2', '1-alpha-123', '1-beta-2', '1-beta123',
      '1-m2', '1-m11', '1-rc', '1-cr2', '1-rc123', '1-SNAPSHOT', '1',
      '1-sp', '1-sp2', '1-sp123', '1-abc', '1-def', '1-pom-1', '1-1-snapshot',
      '1-1', '1-2', '1-123',
    ]);
  });

  test('leading zeroes do not change a version', () => {
    equal('1.0.01', '1.0.1');
    equal('1.01.0', '1.1.0');
  });
});

describe('Maven identity survives the comparison layer', () => {
  test('exact raw spellings are preserved', () => {
    for (const raw of ['2.4.0-b180830.0359', '1.0.0.Final', '3.2.0', '1.0-SNAPSHOT', '5.3.39.RELEASE']) {
      assert.equal(parsePublishedVersion(raw, 'maven')?.raw, raw, raw);
    }
  });

  test('unorderable Maven constructs fail closed instead of being guessed', () => {
    for (const raw of ['RELEASE', 'LATEST', '${revision}', '']) {
      assert.equal(parsePublishedVersion(raw, 'maven'), null, raw);
    }
  });

  test('prerelease qualifiers are recognised, release aliases are not', () => {
    for (const raw of ['1.0-alpha-1', '1.0-beta', '1.0-rc1', '1.0-SNAPSHOT', '1.0-M2']) {
      assert.equal(parsePublishedVersion(raw, 'maven')?.prerelease, true, raw);
    }
    for (const raw of ['1.0', '1.0.Final', '1.0-GA', '1.0-sp1']) {
      assert.equal(parsePublishedVersion(raw, 'maven')?.prerelease, false, raw);
    }
  });
});

describe('Maven ordering drives selection, not just comparison', () => {
  test('a separator-sensitive release is selected in the right order', async () => {
    // Under a flattening comparator `1-1` and `1.1` tie, so the newest release
    // depends on list order. Under Maven semantics `1.1` is unambiguously newer.
    clearHttpCache();
    const versions = ['1', '1-1', '1.1', '1-sp'];
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ response: { docs: versions.map((v) => ({ v })) } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )) as typeof fetch;

    const result = await lookupVersions({
      name: 'com.example:demo',
      ecosystem: 'maven',
      current: '1',
      range: '1',
    });

    assert.equal(result.outcome, 'upgrade');
    if (result.outcome === 'upgrade') assert.equal(result.latest, '1.1');
  });

  test('release ranges follow Maven ordering', () => {
    const all = ['1.0', '1.0-sp', '1.1', '1.1-rc1', '1.2'];
    assert.deepEqual(packageVersionsBetween(all, '1.0', '1.2', 'maven'), ['1.0-sp', '1.1-rc1', '1.1', '1.2']);
  });

  test('bump classification uses the Maven release tuple', () => {
    assert.equal(classifyPackageBump('1.0.0', '2.0.0', 'maven'), 'major');
    assert.equal(classifyPackageBump('1.0.0', '1.1.0', 'maven'), 'minor');
    assert.equal(classifyPackageBump('1.0.0', '1.0.1', 'maven'), 'patch');
    assert.equal(classifyPackageBump('1.0-alpha-1', '1.0', 'maven'), 'prerelease');
  });
});
