import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pinBeforeVersions,
  repinRequirements,
  resolveHistoricalPins,
  resolvedVersions,
  scoreTimemachine,
  type TimemachinePrediction,
  type TimemachineTask,
} from './timemachine.ts';
import { blankImpactFunnel } from '../impact-funnel.ts';

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

test('TimeMachine repins from a declared exact pin, and leaves a range unresolved without a lockfile', () => {
  const result = repinRequirements(
    ['requests>=2.20', 'urllib3==1.26.18', 'certifi'].join('\n'),
    resolvedVersions(['requests==2.32.4', 'urllib3==2.5.0', 'certifi==2025.8.3'].join('\n')),
  );

  assert.equal(result.text, ['requests>=2.20', 'urllib3==2.5.0', 'certifi'].join('\n'));
  assert.deepEqual(result.changed, [{ name: 'urllib3', from: '1.26.18', to: '2.5.0', fromSource: 'requirement-pin' }]);
  assert.deepEqual(result.unresolved, [
    { name: 'requests', requirement: 'requests>=2.20', to: '2.32.4' },
    { name: 'certifi', requirement: 'certifi', to: '2025.8.3' },
  ]);
});

test('TimeMachine recovers a range requirement\'s before-version from a committed lockfile (issue #213)', () => {
  const result = repinRequirements(
    ['requests>=2.20', 'certifi'].join('\n'),
    resolvedVersions(['requests==2.32.4', 'certifi==2025.8.3'].join('\n')),
    new Map([
      ['requests', { version: '2.25.1', source: 'poetry.lock' }],
      // `certifi` has no lockfile entry, so it stays unresolved rather than guessed.
    ]),
  );

  assert.equal(result.text, ['requests==2.32.4', 'certifi'].join('\n'), 'the recovered range is now repinned in the text');
  assert.deepEqual(result.changed, [{ name: 'requests', from: '2.25.1', to: '2.32.4', fromSource: 'poetry.lock' }]);
  assert.deepEqual(result.unresolved, [{ name: 'certifi', requirement: 'certifi', to: '2025.8.3' }]);
});

test('resolveHistoricalPins reads uv.lock / poetry.lock TOML and Pipfile.lock JSON, most authoritative first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tm-pins-'));
  try {
    await writeFile(
      join(dir, 'poetry.lock'),
      ['[[package]]', 'name = "django"', 'version = "3.2.18"', '', '[[package]]', 'name = "Requests"', 'version = "2.25.1"'].join('\n'),
    );
    await writeFile(
      join(dir, 'Pipfile.lock'),
      JSON.stringify({ default: { django: { version: '==4.0.0' }, urllib3: { version: '==1.26.5' } } }),
    );
    const pins = await resolveHistoricalPins(dir);
    // poetry.lock is higher priority than Pipfile.lock, so its django wins.
    assert.deepEqual(pins.get('django'), { version: '3.2.18', source: 'poetry.lock' });
    // Name normalisation: `Requests` in the lock matches `requests`.
    assert.deepEqual(pins.get('requests'), { version: '2.25.1', source: 'poetry.lock' });
    // urllib3 only appears in Pipfile.lock.
    assert.deepEqual(pins.get('urllib3'), { version: '1.26.5', source: 'Pipfile.lock' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveHistoricalPins returns nothing when no lockfile is committed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tm-nopins-'));
  try {
    await mkdir(join(dir, 'src'));
    assert.equal((await resolveHistoricalPins(dir)).size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('TimeMachine does not repin when the lockfile before-version already equals the target', () => {
  const result = repinRequirements(
    'requests>=2.20',
    resolvedVersions('requests==2.32.4'),
    new Map([['requests', { version: '2.32.4', source: 'uv.lock' }]]),
  );
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.unresolved, []);
});

describe('pinBeforeVersions', () => {
  test('rewrites a range or a bare name to an explicit == at the pinned version', () => {
    const result = pinBeforeVersions(
      ['django>=3.2', 'pyyaml', 'certifi==2025.8.3'].join('\n'),
      new Map([
        ['django', { version: '3.2.18', source: 'poetry.lock' }],
        ['pyyaml', { version: '3.12', source: 'pypi-date-filtered' }],
      ]),
    );
    assert.equal(result.text, ['django==3.2.18', 'pyyaml==3.12', 'certifi==2025.8.3'].join('\n'));
    assert.deepEqual(result.pinned, [
      { name: 'django', version: '3.2.18', source: 'poetry.lock' },
      { name: 'pyyaml', version: '3.12', source: 'pypi-date-filtered' },
    ]);
  });

  test('leaves a requirement untouched when there is no pin for it, or it already states that exact version', () => {
    const result = pinBeforeVersions(
      ['requests>=2.20', 'urllib3==1.26.18'].join('\n'),
      new Map([['urllib3', { version: '1.26.18', source: 'uv.lock' }]]),
    );
    assert.equal(result.text, ['requests>=2.20', 'urllib3==1.26.18'].join('\n'));
    assert.deepEqual(result.pinned, []);
  });

  test('composed with repinRequirements, a bare requirement becomes fully resolvable end to end (issue #213 regression)', () => {
    // This is exactly the shape that silently failed before the before-commit
    // fix: a bare name with no operator at all has no `declaredExact`, so
    // without pinning the before-text first, Drift's own manifest diff would
    // see an unresolvable `from` and triage the change out — a `dependency-
    // update-not-detected` miss that looked like a detection failure but was
    // actually a construction bug in this harness.
    const pins = new Map([['pyyaml', { version: '3.12', source: 'pypi-date-filtered' }]]);
    const before = pinBeforeVersions('pyyaml', pins);
    assert.equal(before.text, 'pyyaml==3.12');

    const after = repinRequirements(before.text, resolvedVersions('pyyaml==6.0.2'), pins);
    assert.deepEqual(after.changed, [{ name: 'pyyaml', from: '3.12', to: '6.0.2', fromSource: 'requirement-pin' }]);
    assert.deepEqual(after.unresolved, []);
    assert.equal(after.text, 'pyyaml==6.0.2');
  });
});

test('TimeMachine does not apply whole-project failure truth to a partial exact migration', () => {
  const prediction: TimemachinePrediction = {
    dependencyChanges: [{ name: 'urllib3', from: '1.26.18', to: '2.5.0' }],
    breakingChanges: [],
    impactSites: [{ file: 'consumer.py', line: 1, matchedSymbol: 'urllib3' }],
    verdict: 'locally-affected',
    summary: '',
    repinned: [{ name: 'urllib3', from: '1.26.18', to: '2.5.0', fromSource: 'requirement-pin' }],
    unresolved: [{ name: 'requests', requirement: 'requests>=2.20', to: '2.32.4' }],
    manifestPath: 'requirements.txt',
    impactFunnel: blankImpactFunnel('consumer-usage-not-found'),
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
    repinned: [{ name: 'urllib3', from: '1.26.18', to: '2.5.0', fromSource: 'requirement-pin' }],
    unresolved: [],
    manifestPath: 'requirements.txt',
    impactFunnel: blankImpactFunnel('consumer-usage-not-found'),
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
