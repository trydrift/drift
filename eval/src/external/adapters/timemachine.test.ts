import assert from 'node:assert/strict';
import test from 'node:test';
import {
  repinRequirements,
  resolvedVersions,
  scoreTimemachine,
  type TimemachinePrediction,
  type TimemachineTask,
} from './timemachine.ts';

const TASK: TimemachineTask = {
  repo_name: 'owner/repo',
  repo_url: 'https://example.invalid/owner/repo',
  commit_hash: 'deadbeefdeadbeef',
  reproduction_target_date: '2020-01-01',
  reproduction_target_version: '3.8',
  migration_target_date: '2021-01-01',
  migration_target_version: '3.9',
  dependency_versions: '',
  script_source: 'verified',
  version_source: 'verified',
  test_type: 'pytest',
  difficulty: 'Medium',
  license: 'MIT',
};

test('TimeMachine repins only dependencies with an exact historical identity', () => {
  const result = repinRequirements(
    ['requests>=2.20', 'urllib3==1.26.18', 'certifi'].join('\n'),
    resolvedVersions(['requests==2.32.4', 'urllib3==2.5.0', 'certifi==2025.8.3'].join('\n')),
  );

  assert.equal(result.text, ['requests>=2.20', 'urllib3==2.5.0', 'certifi'].join('\n'));
  assert.deepEqual(result.changed, [{ name: 'urllib3', from: '1.26.18', to: '2.5.0' }]);
  assert.deepEqual(result.unresolved, [
    { name: 'requests', requirement: 'requests>=2.20', to: '2.32.4' },
    { name: 'certifi', requirement: 'certifi', to: '2025.8.3' },
  ]);
});

test('TimeMachine does not apply whole-project failure truth to a partial exact migration', () => {
  const prediction: TimemachinePrediction = {
    dependencyChanges: [{ name: 'urllib3', from: '1.26.18', to: '2.5.0' }],
    breakingChanges: [],
    impactSites: [{ file: 'consumer.py', line: 1, matchedSymbol: 'urllib3' }],
    verdict: 'locally-affected',
    summary: '',
    repinned: [{ name: 'urllib3', from: '1.26.18', to: '2.5.0' }],
    unresolved: [{ name: 'requests', requirement: 'requests>=2.20', to: '2.32.4' }],
    manifestPath: 'requirements.txt',
  };

  const result = scoreTimemachine({
    task: TASK,
    subset: 'verified',
    prediction,
    excluded: null,
    datasetVersion: 'dataset-version',
    sourceHash: 'source-hash',
    durationMs: 1,
  });

  assert.equal(result.outcomes.detectedUpdate, true, 'the exact subset can still adjudicate update detection');
  assert.equal(result.outcomes.identifiedAffected, undefined);
  assert.equal(result.outcomes.localized, undefined);
  assert.equal(result.outcomes.falseSafe, undefined);
  assert.equal(result.notAdjudicated?.detectedUpdate, undefined);
  assert.match(result.notAdjudicated?.identifiedAffected ?? '', /whole-project failure/);
  assert.match(result.notAdjudicated?.localized ?? '', /whole-project failure/);
  assert.match(result.notAdjudicated?.falseSafe ?? '', /whole-project failure/);
});

test('TimeMachine localization never exceeds affected-identification', () => {
  // Impact sites present, but the verdict is hedged — not `locally-affected`.
  const prediction: TimemachinePrediction = {
    dependencyChanges: [{ name: 'urllib3', from: '1.26.18', to: '2.5.0' }],
    breakingChanges: [],
    impactSites: [{ file: 'consumer.py', line: 1, matchedSymbol: 'urllib3' }],
    verdict: 'verification-incomplete',
    summary: '',
    repinned: [{ name: 'urllib3', from: '1.26.18', to: '2.5.0' }],
    unresolved: [],
    manifestPath: 'requirements.txt',
  };

  const result = scoreTimemachine({
    task: TASK,
    subset: 'verified',
    prediction,
    excluded: null,
    datasetVersion: 'v',
    sourceHash: 'h',
    durationMs: 1,
  });

  assert.equal(result.outcomes.identifiedAffected, false);
  assert.equal(result.outcomes.localized, false, 'localized cannot be true where affected is false');
});
