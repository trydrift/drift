import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  comparePackageVersions,
  parsePublishedVersion,
  satisfiesPackageRange,
} from '../dist/version-semantics.js';
import { parseChangelogSections, sectionsBetween } from '../dist/evidence/changelog.js';
import { selectReleases } from '../dist/evidence/releases.js';

describe('canonical ecosystem version semantics', () => {
  test('preserves raw registry identities', () => {
    const cases = [
      ['pypi', '3.11'],
      ['pypi', '0.23'],
      ['pypi', '0.8.0rc1'],
      ['pypi', '2.14.0b1'],
      ['rubygems', '4.0.0.beta1'],
      ['opam', 'v0.17.0'],
      ['maven', '2.4.0-b180830.0359'],
    ] as const;
    for (const [ecosystem, raw] of cases) {
      assert.equal(parsePublishedVersion(raw, ecosystem)?.raw, raw);
    }
  });

  test('orders PEP 440 epochs and dev/a/b/rc/final/post releases', () => {
    assert.equal(comparePackageVersions('1!1.0', '2.0', 'pypi'), 1);
    const ordered = ['1.0.dev1', '1.0a1', '1.0b1', '1.0rc1', '1.0', '1.0.post1'];
    for (let index = 1; index < ordered.length; index++) {
      assert.equal(comparePackageVersions(ordered[index - 1]!, ordered[index]!, 'pypi'), -1);
    }
  });

  test('uses RubyGems prerelease ordering', () => {
    assert.equal(comparePackageVersions('4.0.0.beta1', '4.0.0.rc1', 'rubygems'), -1);
    assert.equal(comparePackageVersions('4.0.0.rc1', '4.0.0', 'rubygems'), -1);
  });

  test('uses Maven qualifier ordering', () => {
    assert.equal(comparePackageVersions('1.0-alpha1', '1.0-beta1', 'maven'), -1);
    assert.equal(comparePackageVersions('1.0-rc1', '1.0', 'maven'), -1);
    assert.equal(comparePackageVersions('1.0', '1.0-sp1', 'maven'), -1);
  });

  test('uses NuGet prerelease ordering', () => {
    assert.equal(comparePackageVersions('1.0.0-beta.2', '1.0.0-beta.11', 'nuget'), -1);
    assert.equal(comparePackageVersions('1.0.0-rc.1', '1.0.0', 'nuget'), -1);
  });

  test('orders opam versions without dropping their v spelling', () => {
    assert.equal(comparePackageVersions('v0.17.0', 'v0.18.0', 'opam'), -1);
    assert.equal(parsePublishedVersion('v0.17.0', 'opam')?.raw, 'v0.17.0');
  });

  test('interprets ranges with the owning ecosystem grammar', () => {
    // PEP 440: `<1.0` must not admit a prerelease of 1.0 itself, because the
    // specified version is not a prerelease. Plain ordering says rc1 < 1.0;
    // the specifier says no.
    assert.equal(satisfiesPackageRange('1.0rc1', '>=1.0b1,<1.0', 'pypi'), false);
    assert.equal(satisfiesPackageRange('1.0rc1', '>=1.0b1,<1.0rc2', 'pypi'), true);
    assert.equal(satisfiesPackageRange('2.2.9', '~> 2.2', 'rubygems'), true);
    assert.equal(satisfiesPackageRange('3.0.0', '~> 2.2', 'rubygems'), false);
    assert.equal(satisfiesPackageRange('1.5', '[1.0,2.0)', 'maven'), true);
    assert.equal(satisfiesPackageRange('2.0', '[1.0,2.0)', 'maven'), false);
    assert.equal(satisfiesPackageRange('1.5.0', '[1.0.0,2.0.0)', 'nuget'), true);
    assert.equal(satisfiesPackageRange('v0.18.0', '{>= "v0.17.0" & < "v0.19.0"}', 'opam'), true);
  });

  test('release and changelog ranges use the same ecosystem ordering', () => {
    const sections = parseChangelogSections([
      '## 1.0',
      'final',
      '## 1.0rc1',
      'candidate',
      '## 1.0b1',
      'beta',
    ].join('\n'), 'pypi');
    assert.deepEqual(
      sectionsBetween(sections, '1.0b1', '1.0rc1', 'pypi').map((section) => section.version),
      ['1.0rc1'],
    );

    const releases = ['1.0b1', '1.0', '1.0rc1'].map((version) => ({
      tag: version,
      version,
      name: null,
      body: '',
      url: `https://example.test/${version}`,
      publishedAt: null,
    }));
    assert.deepEqual(selectReleases(releases, 10, 'pypi').map((release) => release.version), [
      '1.0',
      '1.0rc1',
      '1.0b1',
    ]);
  });

  test('separates exact identity from ordering for package-authored schemes', () => {
    // Conan and vcpkg let a recipe pick the version scheme, so there is no one
    // correct ordering — but the identity is exact, and refusing to recognise
    // it skipped every C/C++ change before the header differ could run.
    for (const [ecosystem, raw] of [
      ['conan', 'release-2026'],
      ['conan', '10.2.1'],
      ['vcpkg', 'date#1'],
      ['vcpkg', '2023-01-25'],
    ] as const) {
      const parsed = parsePublishedVersion(raw, ecosystem);
      assert.equal(parsed?.raw, raw);
      assert.equal(parsed?.release, null, 'no release tuple is invented');
    }

    // Ordering stays unknown; equality is still provable from the identity.
    assert.equal(comparePackageVersions('9.1.0', '10.2.1', 'conan'), null);
    assert.equal(comparePackageVersions('10.2.1', '10.2.1', 'conan'), 0);

    // A constraint is not an identity and still fails closed.
    for (const [ecosystem, raw] of [
      ['conan', '[>=1.0 <2.0]'],
      ['conan', '*'],
      ['vcpkg', '>=1.0'],
    ] as const) {
      assert.equal(parsePublishedVersion(raw, ecosystem), null, raw);
    }
  });
});
