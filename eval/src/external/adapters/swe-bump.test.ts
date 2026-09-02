import assert from 'node:assert/strict';
import test from 'node:test';
import { exactSweBumpVersionPair, scoreSweBump, type SweBumpPrediction, type SweBumpTask } from './swe-bump.ts';

const TASK: SweBumpTask = {
  id: 'owner__repo-dependency__^2.0.0',
  name: 'repo',
  owner: 'owner',
  pkgManager: 'npm',
  package: 'dependency',
  versionTo: '^2.0.0',
  nodeVersion: '20',
  commit: 'deadbeef',
};

function prediction(exactVersionPair: SweBumpPrediction['exactVersionPair']): SweBumpPrediction {
  return {
    dependencyChanges: exactVersionPair
      ? [{ name: 'dependency', from: exactVersionPair.from, to: exactVersionPair.to }]
      : [],
    breakingChanges: [],
    impactSites: [],
    verdict: 'insufficient-evidence',
    summary: '',
    manifestVersionTo: TASK.versionTo,
    versionFrom: '^1.0.0',
    exactVersionPair,
  };
}

test('SWE-Bump constructs analysis input only from exact version identities', () => {
  assert.deepEqual(exactSweBumpVersionPair('1.9.4', '2.0.0'), { from: '1.9.4', to: '2.0.0' });
  assert.deepEqual(exactSweBumpVersionPair('v1.9.4', 'v2.0.0'), { from: '1.9.4', to: '2.0.0' });
  assert.equal(exactSweBumpVersionPair('^1.0.0', '2.0.0'), null);
  assert.equal(exactSweBumpVersionPair('1.9.4', '^2.0.0'), null);
});

test('SWE-Bump does not score a range as a missed exact dependency update', () => {
  const result = scoreSweBump({
    task: TASK,
    prediction: prediction(null),
    excluded: null,
    datasetVersion: 'v',
    sourceHash: 'hash',
    durationMs: 1,
  });

  assert.equal(result.outcomes.detectedUpdate, undefined);
  assert.equal(result.outcomes.identifiedAffected, undefined);
  assert.equal(result.outcomes.localized, undefined);
  assert.equal(result.outcomes.falseSafe, undefined);
  assert.match(result.notAdjudicated?.detectedUpdate ?? '', /range/);
  assert.equal(result.provenance.fromVersion, null);
  assert.equal(result.provenance.toVersion, null);
});

test('SWE-Bump scores an authoritative exact version pair', () => {
  const exactTask = { ...TASK, versionTo: '2.0.0' };
  const result = scoreSweBump({
    task: exactTask,
    prediction: prediction({ from: '1.9.4', to: '2.0.0' }),
    excluded: null,
    datasetVersion: 'v',
    sourceHash: 'hash',
    durationMs: 1,
  });

  assert.equal(result.outcomes.detectedUpdate, true);
  assert.equal(result.notAdjudicated, undefined);
  assert.equal(result.provenance.fromVersion, '1.9.4');
  assert.equal(result.provenance.toVersion, '2.0.0');
});

test('SWE-Bump scores normalized semver identity rather than manifest spelling', () => {
  const exactTask = { ...TASK, versionTo: 'v2.0.0' };
  const exactVersionPair = exactSweBumpVersionPair('v1.9.4', exactTask.versionTo);
  assert.ok(exactVersionPair);

  const result = scoreSweBump({
    task: exactTask,
    prediction: prediction(exactVersionPair),
    excluded: null,
    datasetVersion: 'v',
    sourceHash: 'hash',
    durationMs: 1,
  });

  assert.equal(result.outcomes.detectedUpdate, true);
  assert.equal(result.provenance.fromVersion, '1.9.4');
  assert.equal(result.provenance.toVersion, '2.0.0');
});
