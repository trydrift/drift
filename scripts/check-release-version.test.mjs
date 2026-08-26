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

test('no tag given -> tag is never checked even if it would mismatch', () => {
  // Sanity: omitting `tag` must not implicitly compare against anything.
  assert.deepEqual(findVersionMismatches({ ...aligned, tag: undefined }), []);
});
