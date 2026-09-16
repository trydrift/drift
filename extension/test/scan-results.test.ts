import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headline, uncheckedNotice } from '../src/ui/home.js';
import type { UncheckedDependency, UpgradeCandidate } from '../src/upgrades.js';

function candidate(name: string, breakingCount: number): UpgradeCandidate {
  return {
    id: `${name}@1->2`, name, kind: 'runtime', ecosystem: 'npm', packageManager: 'npm',
    manifestPath: 'package.json', current: '1.0.0', range: '^1.0.0', safeLatest: '2.0.0',
    selected: '2.0.0', latest: '2.0.0', versions: ['2.0.0'], status: 'ready',
    evidenceCount: 1, breakingCount, impactCount: 0, impactFiles: 0,
    impactConfidence: 'none', risk: 'none', gaps: [], toolRequests: [], summary: '',
  };
}

function unchecked(current: string, manifestPath: string): UncheckedDependency {
  return {
    name: 'fixture-lib', kind: 'runtime', ecosystem: 'npm', packageManager: 'npm',
    current, manifestPath, reason: 'Drift could not reach the npm registry for fixture-lib.',
  };
}

test('scan headline does not describe a safe upgrade as affecting code or unchecked declarations as reviewable upgrades', () => {
  const candidates = [candidate('zod', 8), candidate('fast-check', 0)];
  const summary = headline(candidates, 12, 10);
  assert.match(summary, /2 upgrades available.*among 12 dependencies scanned/);
  assert.match(summary, /1 has no code impact found/);
  assert.match(summary, /1 requires review before upgrading/);
  assert.match(summary, /10 dependency declarations could not be checked for upgrades/);
  assert.doesNotMatch(summary, /affects? code/);
  assert.doesNotMatch(summary, /11 require review/);
});

test('a zero-impact upgrade with a blocking recommendation is not called safe to take', () => {
  const blocked = { ...candidate('blocked', 0), recommendation: 'do-not-upgrade-yet' };
  const summary = headline([blocked], 1);
  assert.match(summary, /1 has no code impact found/);
  assert.doesNotMatch(summary, /safe to upgrade|safe to take/);
});

test('analysis errors remain visible beside other candidate verdicts', () => {
  const affected = { ...candidate('affected', 1), impactCount: 1, actionableImpactCount: 1, impactFiles: 1 };
  const error = { ...candidate('error', 0), status: 'error' as const };
  const summary = headline([affected, candidate('clean', 0), error], 3);
  assert.match(summary, /3 upgrades available/);
  assert.match(summary, /1 affects code in this repository/);
  assert.match(summary, /1 has no code impact found/);
  assert.match(summary, /1 could not be analyzed/);
});

test('failed project checks are distinct from located code impacts', () => {
  const failed = { ...candidate('failed', 0), verification: {
    status: 'failed' as const, checks: [], failedFiles: [],
  } };
  const summary = headline([failed], 1);
  assert.match(summary, /1 fails this repository's checks with the upgrade installed/);
  assert.doesNotMatch(summary, /affects code|no code impact found/);
});

test('scan headline still calls out a located impact', () => {
  const affected = { ...candidate('zod', 1), impactCount: 1, actionableImpactCount: 1, impactFiles: 1 };
  assert.match(headline([affected], 1), /1 affects code in this repository/);
});

test('unchecked notice groups versions and shows each manifest once', () => {
  const notice = uncheckedNotice([
    unchecked('1.0.0', 'eval/cases/a/package.json'),
    unchecked('1.0.0', 'eval/cases/b/package.json'),
    unchecked('2.0.0', 'eval/cases/c/package.json'),
  ]);
  assert.match(notice, /3 dependency declarations could not be checked/);
  assert.equal((notice.match(/- `fixture-lib`/g) ?? []).length, 2);
  assert.match(notice, /`fixture-lib` \(1\.0\.0\).*Declared in 2 manifests:/);
  assert.match(notice, /`fixture-lib` \(2\.0\.0\).*Declared in 1 manifest:/);
  for (const path of ['eval/cases/a/package.json', 'eval/cases/b/package.json', 'eval/cases/c/package.json']) {
    assert.equal(notice.split(`\`${path}\``).length - 1, 1);
  }
});
