import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findVersionMismatches } from './check-release-version.mjs';

const aligned = { rootPkg: '0.1.0', rootLock: '0.1.0', extPkg: '0.1.0', extLock: '0.1.0' };

test('all four versions match, no tag given -> passes', () => {
  assert.deepEqual(findVersionMismatches(aligned), []);
});

test('root package differs -> fails', () => {
  const problems = findVersionMismatches({ ...aligned, rootPkg: '0.1.1' });
  assert.ok(problems.length > 0);
  assert.ok(problems.some((line) => line.includes('package.json: 0.1.1')));
});

test('extension package differs -> fails', () => {
  const problems = findVersionMismatches({ ...aligned, extPkg: '0.2.0' });
  assert.ok(problems.length > 0);
  assert.ok(problems.some((line) => line.includes('extension/package.json: 0.2.0')));
});

test('a lockfile differs -> fails', () => {
  const problems = findVersionMismatches({ ...aligned, rootLock: '0.1.1' });
  assert.ok(problems.length > 0);
  assert.ok(problems.some((line) => line.includes('package-lock.json (root package): 0.1.1')));
});

test('extension lockfile differs -> fails', () => {
  const problems = findVersionMismatches({ ...aligned, extLock: '0.1.1' });
  assert.ok(problems.length > 0);
  assert.ok(problems.some((line) => line.includes('extension/package-lock.json (root package): 0.1.1')));
});

test('tag differs from artifact version -> fails', () => {
  const problems = findVersionMismatches({ ...aligned, tag: 'v0.1.1' });
  assert.ok(problems.length > 0);
  assert.ok(problems.some((line) => line.includes('Tag/version mismatch')));
});

test('v0.1.0 tag with 0.1.0 artifact -> passes', () => {
  assert.deepEqual(findVersionMismatches({ ...aligned, tag: 'v0.1.0' }), []);
});

test('prerelease tag -> fails with the automated-release explanation', () => {
  const prerelease = {
    rootPkg: '0.2.0-beta.1',
    rootLock: '0.2.0-beta.1',
    extPkg: '0.2.0-beta.1',
    extLock: '0.2.0-beta.1',
  };
  const problems = findVersionMismatches({ ...prerelease, tag: 'v0.2.0-beta.1' });
  assert.ok(problems.includes('Automated releases only accept stable semantic versions.'));
  assert.ok(problems.includes('Prerelease tags must not be published through release.yml.'));
});

test('malformed tag -> fails', () => {
  const problems = findVersionMismatches({ ...aligned, tag: 'v0.1' });
  assert.ok(problems.some((line) => line.includes('Invalid release tag')));
});

test('empty tag value -> fails', () => {
  const problems = findVersionMismatches({ ...aligned, tag: '' });
  assert.ok(problems.some((line) => line.includes('Invalid release tag')));
});

test('build metadata tag -> fails because automated tags are exactly vX.Y.Z', () => {
  const problems = findVersionMismatches({ ...aligned, tag: 'v0.1.0+build.1' });
  assert.ok(problems.some((line) => line.includes('Invalid release tag')));
});

test('malformed manifest version -> fails', () => {
  const malformed = {
    rootPkg: '0.1.0-beta..1',
    rootLock: '0.1.0-beta..1',
    extPkg: '0.1.0-beta..1',
    extLock: '0.1.0-beta..1',
  };
  const problems = findVersionMismatches(malformed);
  assert.equal(problems.filter((line) => line.includes('invalid semantic version')).length, 4);
});

test('cross-manifest prerelease with no tag -> passes', () => {
  const prerelease = {
    rootPkg: '0.1.0-beta.0',
    rootLock: '0.1.0-beta.0',
    extPkg: '0.1.0-beta.0',
    extLock: '0.1.0-beta.0',
  };
  assert.deepEqual(findVersionMismatches(prerelease), []);
});

test('no tag given -> tag is never checked even if it would mismatch', () => {
  // Sanity: omitting `tag` must not implicitly compare against anything.
  assert.deepEqual(findVersionMismatches({ ...aligned, tag: undefined }), []);
});
