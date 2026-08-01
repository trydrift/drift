import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareUrl,
  dependencyFilesIn,
  dependencyPaths,
  pullRequestBody,
  remoteSlug,
  upgradeBranchName,
  upgradeCommitMessage,
} from '../src/ship.js';
import type { UpgradeCandidate } from '../src/upgrades.js';

/**
 * Everything here writes to somebody's repository or to their GitHub account,
 * so the decisions are made by pure functions and checked without either.
 *
 * The one that matters most is `dependencyPaths`: it decides which files go
 * into the commit, and the promise Drift makes is that an upgrade commit
 * contains the manifest and the lockfile and nothing else — not the source file
 * the developer had open, not the note they were half way through writing.
 */

function candidate(over: Partial<UpgradeCandidate> = {}): UpgradeCandidate {
  return {
    id: 'package.json#react@18.3.1->19.2.0',
    name: 'react',
    kind: 'runtime',
    ecosystem: 'npm',
    packageManager: 'npm',
    manifestPath: 'package.json',
    current: '18.3.1',
    range: '^18.0.0',
    selected: '19.2.0',
    latest: '19.2.0',
    versions: ['19.2.0'],
    status: 'ready',
    evidenceCount: 3,
    breakingCount: 0,
    impactCount: 0,
    impactFiles: 0,
    risk: 'none',
    gaps: [],
    summary: 'No breaking changes found for this version of react.',
    ...over,
  };
}

describe('choosing what goes into the commit', () => {
  test('takes the manifest and lockfile an upgrade changed', () => {
    const paths = dependencyPaths(
      [candidate()],
      ['package.json', 'package-lock.json', 'src/app.tsx'],
    );
    assert.deepEqual(paths, ['package-lock.json', 'package.json']);
  });

  test('never sweeps in unrelated work, however dirty the tree', () => {
    const paths = dependencyPaths(
      [candidate()],
      ['README.md', 'src/index.ts', 'notes.txt', '.env'],
    );
    assert.deepEqual(paths, []);
  });

  test('claims the root lockfile a workspace install rewrote', () => {
    const paths = dependencyPaths(
      [candidate({ manifestPath: 'packages/web/package.json', workspace: 'packages/web' })],
      ['packages/web/package.json', 'package-lock.json'],
    );
    assert.deepEqual(paths, ['package-lock.json', 'packages/web/package.json']);
  });

  test('leaves a dirty root manifest alone when the upgrade was in a member', () => {
    const paths = dependencyPaths(
      [candidate({ manifestPath: 'packages/web/package.json', workspace: 'packages/web' })],
      ['package.json', 'packages/web/package.json'],
    );
    assert.deepEqual(paths, ['packages/web/package.json']);
  });

  test('only offers files that are actually dirty', () => {
    assert.deepEqual(dependencyPaths([candidate()], []), []);
  });

  test('recognises manifests from every ecosystem when Drift did not do the install', () => {
    const paths = dependencyFilesIn([
      'go.mod',
      'Cargo.lock',
      'pyproject.toml',
      'Gemfile.lock',
      'src/main.rs',
    ]);
    assert.deepEqual(paths, ['Cargo.lock', 'Gemfile.lock', 'go.mod', 'pyproject.toml']);
  });
});

describe('naming the branch', () => {
  test('names a single upgrade after the package and the version', () => {
    assert.equal(
      upgradeBranchName([candidate()], { now: new Date('2026-07-31T10:00:00Z') }),
      'drift/upgrade-react-18.3.1-to-19.2.0-2026-07-31',
    );
  });

  test('makes a scoped package a legal ref component', () => {
    assert.equal(
      upgradeBranchName([candidate({ name: '@types/node', selected: '22.10.5' })], {
        now: new Date('2026-07-31T10:00:00Z'),
      }),
      'drift/upgrade-types-node-18.3.1-to-22.10.5-2026-07-31',
    );
  });

  test('dates a batch, so two batches never collide on one ref', () => {
    const name = upgradeBranchName([candidate(), candidate({ name: 'vite' })], {
      now: new Date('2026-07-31T10:00:00Z'),
    });
    assert.equal(name, 'drift/upgrade-2-packages-2026-07-31');
  });

  test("honours a team's own prefix, trailing slash or not", () => {
    assert.equal(
      upgradeBranchName([candidate()], { prefix: 'deps/', now: new Date('2026-07-31T10:00:00Z') }),
      'deps/upgrade-react-18.3.1-to-19.2.0-2026-07-31',
    );
  });
});

describe('writing the commit', () => {
  test('uses the convention every other dependency bot uses', () => {
    const { subject } = upgradeCommitMessage([candidate()]);
    assert.equal(subject, 'chore(deps): upgrade react to 19.2.0');
  });

  test('counts the batch rather than listing it in the subject', () => {
    const { subject, body } = upgradeCommitMessage([candidate(), candidate({ name: 'vite' })]);
    assert.equal(subject, 'chore(deps): upgrade 2 packages');
    assert.match(body, /- react 18\.3\.1 → 19\.2\.0/);
    assert.match(body, /- vite 18\.3\.1 → 19\.2\.0/);
  });

  test('says what the evidence found, not what the version number implies', () => {
    const clean = upgradeCommitMessage([candidate()]).body;
    assert.match(clean, /no breaking changes upstream/);

    const risky = upgradeCommitMessage([
      candidate({ breakingCount: 4, impactCount: 2, impactFiles: 1 }),
    ]).body;
    assert.match(risky, /4 breaking changes upstream/);
    assert.match(risky, /2 places in this repository/);
  });

  test('says where a workspace upgrade happened', () => {
    const { body } = upgradeCommitMessage([
      candidate({ workspace: 'packages/web', workspaceName: '@acme/web' }),
    ]);
    assert.match(body, /in @acme\/web/);
  });
});

describe('the pull request body', () => {
  test('leads with the evidence a reviewer would otherwise have to gather', () => {
    const body = pullRequestBody([candidate({ evidenceCount: 3, breakingCount: 2 })]);
    assert.match(body, /\| Package \| Version \| Verdict \| Evidence \|/);
    assert.match(body, /`react`/);
    assert.match(body, /18\.3\.1 → 19\.2\.0/);
  });

  test('names what needs review, and stays quiet when nothing does', () => {
    const affected = pullRequestBody([
      candidate({ breakingCount: 3, impactCount: 5, impactFiles: 2 }),
    ]);
    assert.match(affected, /### Needs review/);
    assert.match(affected, /5 places across 2 files/);

    assert.doesNotMatch(pullRequestBody([candidate()]), /### Needs review/);
  });
});

describe('finding GitHub', () => {
  test('reads the slug out of every shape a remote takes', () => {
    assert.equal(remoteSlug('git@github.com:acme/app.git'), 'acme/app');
    assert.equal(remoteSlug('https://github.com/acme/app'), 'acme/app');
    assert.equal(remoteSlug(null), null);
    assert.equal(remoteSlug('https://gitlab.com/acme/app.git'), null);
  });

  test('falls back to a compare link that opens the real branches', () => {
    assert.equal(
      compareUrl('git@github.com:acme/app.git', 'main', 'drift/upgrade-react-18.3.1-to-19.2.0'),
      'https://github.com/acme/app/compare/main...drift%2Fupgrade-react-18.3.1-to-19.2.0?expand=1',
    );
  });

  test('has no link to offer when the remote is not GitHub', () => {
    assert.equal(compareUrl('git@bitbucket.org:acme/app.git', 'main', 'topic'), null);
  });
});
