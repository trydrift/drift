import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ambiguityKey,
  discoverTargets,
  upgradeCommandFor,
  type UpgradeCandidate,
} from '../src/upgrades.js';

/**
 * `/scan` and `/upgrade` decide, per directory, which tool owns the
 * dependencies and which command moves a version. Both decisions write to
 * someone's repository when they are wrong, so they are exercised against a
 * real temporary tree rather than a mocked filesystem.
 */

let root = '';

function write(path: string, content = ''): void {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'drift-upgrades-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('discovering what owns a directory', () => {
  test('reads the manifest the detected manager owns', async () => {
    write('pnpm-lock.yaml', 'lockfileVersion: 6\n');
    write('package.json', '{"dependencies":{"left-pad":"^1.0.0"}}');

    const { targets, ambiguities } = await discoverTargets(root);
    assert.deepEqual(ambiguities, []);
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.manager.id, 'pnpm');
    assert.equal(targets[0]!.manifestPath, 'package.json');
    assert.equal(targets[0]!.lockfilePath, 'pnpm-lock.yaml');
    assert.equal(targets[0]!.dir, '');
  });

  test('finds every ecosystem present side by side', async () => {
    write('Cargo.toml', '[dependencies]\nserde = "1.0"\n');
    write('Cargo.lock', '');
    write('go.mod', 'module example.com/x\n');

    const { targets } = await discoverTargets(root);
    assert.deepEqual(
      targets.map((t) => t.manager.id).sort(),
      ['cargo', 'go', 'pnpm'],
    );
  });

  test('reports two managers claiming one ecosystem instead of guessing', async () => {
    write('package-lock.json', '{}');

    const { targets, ambiguities } = await discoverTargets(root);
    assert.equal(ambiguities.length, 1);
    assert.equal(ambiguities[0]!.ecosystem, 'npm');
    assert.deepEqual(ambiguities[0]!.candidates.map((c) => c.manager.id), ['npm', 'pnpm']);
    // The scan only reads, so it still gets a target to work with.
    assert.ok(targets.some((t) => t.manager.ecosystem === 'npm'));
  });

  test('an answered ambiguity is neither re-asked nor overridden', async () => {
    const preferences = new Map([[ambiguityKey('', 'npm'), 'pnpm' as const]]);
    const { targets, ambiguities } = await discoverTargets(root, [''], preferences);
    assert.deepEqual(ambiguities, []);
    assert.equal(targets.find((t) => t.manager.ecosystem === 'npm')!.manager.id, 'pnpm');
  });

  test('scans the directories it is given, not just the root', async () => {
    write('packages/api/package.json', '{"dependencies":{}}');
    write('packages/api/package-lock.json', '{}');

    const { targets } = await discoverTargets(root, ['packages/api']);
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.dir, 'packages/api');
    assert.equal(targets[0]!.manifestPath, 'packages/api/package.json');
    assert.equal(targets[0]!.lockfilePath, 'packages/api/package-lock.json');
  });

  test('a directory with no manifest yields nothing rather than throwing', async () => {
    const { targets, ambiguities } = await discoverTargets(root, ['does/not/exist']);
    assert.deepEqual(targets, []);
    assert.deepEqual(ambiguities, []);
  });
});

describe('the command an upgrade will run', () => {
  const candidate = (over: Partial<UpgradeCandidate> = {}): UpgradeCandidate => ({
    id: 'x',
    name: 'left-pad',
    kind: 'runtime',
    ecosystem: 'npm',
    packageManager: 'npm',
    manifestPath: 'package.json',
    current: '1.0.0',
    range: '^1.0.0',
    selected: '1.3.0',
    latest: '2.0.0',
    versions: ['2.0.0', '1.3.0'],
    status: 'ready',
    evidenceCount: 0,
    breakingCount: 0,
    impactCount: 0,
    impactFiles: 0,
    risk: 'none',
    summary: '',
    ...over,
  });

  test('is shown before it runs, per manager', () => {
    assert.equal(upgradeCommandFor(candidate()), 'npm install left-pad@1.3.0');
    assert.equal(
      upgradeCommandFor(candidate({ packageManager: 'yarn' })),
      'yarn upgrade left-pad@1.3.0',
    );
    assert.equal(
      upgradeCommandFor(candidate({ packageManager: 'poetry', ecosystem: 'pypi' })),
      'poetry add left-pad==1.3.0',
    );
  });

  test('forcing targets the newest published version', () => {
    assert.equal(upgradeCommandFor(candidate(), 'force'), 'npm install left-pad@2.0.0 --force');
  });

  test('--force is npm-specific and is not invented elsewhere', () => {
    assert.equal(
      upgradeCommandFor(candidate({ packageManager: 'pnpm' }), 'force'),
      'pnpm add left-pad@2.0.0',
    );
  });

  test('is null where the ecosystem cannot pin a version', () => {
    assert.equal(
      upgradeCommandFor(candidate({ packageManager: 'gradle', ecosystem: 'maven' })),
      null,
    );
  });
});
