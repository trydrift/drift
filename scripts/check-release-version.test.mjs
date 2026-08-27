import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findVersionMismatches } from './check-release-version.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const aligned = {
  rootPkg: '0.1.0',
  rootLock: '0.1.0',
  rootLockPackage: '0.1.0',
  extPkg: '0.1.0',
  extLock: '0.1.0',
  extLockPackage: '0.1.0',
};

test('all six version fields match, no tag given -> passes', () => {
  assert.deepEqual(findVersionMismatches(aligned), []);
});

test('root package differs -> fails', () => {
  const problems = findVersionMismatches({ ...aligned, rootPkg: '0.1.1' });
  assert.ok(problems.some((line) => line.includes('package.json: 0.1.1')));
});

test('root lockfile top-level version differs -> fails', () => {
  const problems = findVersionMismatches({ ...aligned, rootLock: '0.1.1' });
  assert.ok(problems.some((line) => line.includes('package-lock.json (top level): 0.1.1')));
});

test('root lockfile package version differs -> fails', () => {
  const problems = findVersionMismatches({ ...aligned, rootLockPackage: '0.1.1' });
  assert.ok(problems.some((line) => line.includes('package-lock.json (root package): 0.1.1')));
});

test('extension package differs -> fails', () => {
  const problems = findVersionMismatches({ ...aligned, extPkg: '0.2.0' });
  assert.ok(problems.some((line) => line.includes('extension/package.json: 0.2.0')));
});

test('extension lockfile top-level version differs -> fails', () => {
  const problems = findVersionMismatches({ ...aligned, extLock: '0.1.1' });
  assert.ok(problems.some((line) => line.includes('extension/package-lock.json (top level): 0.1.1')));
});

test('extension lockfile package version differs -> fails', () => {
  const problems = findVersionMismatches({ ...aligned, extLockPackage: '0.1.1' });
  assert.ok(problems.some((line) => line.includes('extension/package-lock.json (root package): 0.1.1')));
});

test('tag differs from artifact version -> fails', () => {
  const problems = findVersionMismatches({ ...aligned, tag: 'v0.1.1' });
  assert.ok(problems.some((line) => line.includes('Tag/version mismatch')));
});

test('v0.1.0 tag with 0.1.0 artifact -> passes', () => {
  assert.deepEqual(findVersionMismatches({ ...aligned, tag: 'v0.1.0' }), []);
});

test('prerelease tag -> fails with the automated-release explanation', () => {
  const prerelease = Object.fromEntries(
    Object.keys(aligned).map((key) => [key, '0.2.0-beta.1']),
  );
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

test('malformed manifest versions fail', () => {
  const malformed = Object.fromEntries(
    Object.keys(aligned).map((key) => [key, '0.1.0-beta..1']),
  );
  const problems = findVersionMismatches(malformed);
  assert.equal(problems.filter((line) => line.includes('invalid semantic version')).length, 6);
});

test('cross-manifest prerelease with no tag -> passes', () => {
  const prerelease = Object.fromEntries(
    Object.keys(aligned).map((key) => [key, '0.1.0-beta.0']),
  );
  assert.deepEqual(findVersionMismatches(prerelease), []);
});

test('no tag given -> tag is never checked', () => {
  assert.deepEqual(findVersionMismatches({ ...aligned, tag: undefined }), []);
});

test('CLI executes when invoked from a path containing spaces', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'drift release test '));
  try {
    mkdirSync(join(tempRoot, 'scripts'), { recursive: true });
    mkdirSync(join(tempRoot, 'extension'), { recursive: true });
    for (const path of [
      'scripts/check-release-version.mjs',
      'scripts/semver-utils.mjs',
      'package.json',
      'package-lock.json',
      'extension/package.json',
      'extension/package-lock.json',
    ]) {
      cpSync(join(repoRoot, path), join(tempRoot, path));
    }
    const output = execFileSync(process.execPath, [join(tempRoot, 'scripts/check-release-version.mjs')], {
      encoding: 'utf8',
    });
    assert.match(output, /all manifests agree on version/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
