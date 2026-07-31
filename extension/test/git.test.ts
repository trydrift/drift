import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Git } from '../src/git.js';

/**
 * The git layer, against a real repository.
 *
 * These are the operations that write to someone's checkout, and the promises
 * around them — a commit scoped to the files it names, a branch that is created
 * or switched to but never clobbered, a push that sets upstream and never
 * forces — are only worth anything if git agrees. A mock would agree with
 * whatever this file assumed.
 */

let root = '';
let origin = '';
let git: Git;

function run(args: string[], cwd = root): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function write(path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'drift-git-'));
  origin = mkdtempSync(join(tmpdir(), 'drift-origin-'));

  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin]);
  run(['init', '--initial-branch=main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Drift Test']);
  run(['remote', 'add', 'origin', origin]);

  write('package.json', '{"dependencies":{"react":"18.3.1"}}\n');
  write('src/app.ts', 'export const a = 1;\n');
  run(['add', '.']);
  run(['commit', '-m', 'initial']);

  git = new Git(root);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(origin, { recursive: true, force: true });
});

describe('reading a checkout', () => {
  test('finds the working tree root and the branch', async () => {
    assert.ok((await git.repoRoot())?.endsWith(root.split('/').pop()!));
    assert.equal(await git.currentBranch(), 'main');
    assert.equal(await git.isDetached(), false);
    assert.equal(await git.isUnborn(), false);
  });

  test('reports the remote it would push to', async () => {
    assert.equal(await git.remoteUrl(), origin);
    assert.equal(await git.hasRemote(), true);
  });

  test('has no upstream until something is pushed', async () => {
    assert.equal(await git.hasUpstream('main'), false);
  });
});

describe('committing an upgrade', () => {
  test('commits the files it was given and leaves the rest of the tree alone', async () => {
    write('package.json', '{"dependencies":{"react":"19.2.0"}}\n');
    write('package-lock.json', '{"lockfileVersion":3}\n');
    write('src/app.ts', 'export const a = 2; // half-finished work\n');

    const dirty = await git.dirtyFiles();
    assert.deepEqual(dirty.sort(), ['package-lock.json', 'package.json', 'src/app.ts']);

    const sha = await git.commitPaths(
      ['package.json', 'package-lock.json'],
      'chore(deps): upgrade react to 19.2.0',
      '- react 18.3.1 → 19.2.0 (no breaking changes found)',
    );

    assert.ok(sha);
    const committed = run(['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort();
    assert.deepEqual(committed, ['package-lock.json', 'package.json']);

    // The developer's unfinished source edit is still theirs, uncommitted.
    assert.deepEqual(await git.dirtyFiles(), ['src/app.ts']);
    assert.match(run(['log', '-1', '--format=%B']), /chore\(deps\): upgrade react to 19\.2\.0/);
  });

  test('returns null rather than making an empty commit', async () => {
    assert.equal(await git.commitPaths(['package.json'], 'nothing to see', ''), null);
    assert.equal(await git.commitPaths([], 'nothing at all', ''), null);
  });

  test('stages without committing when that is all that was asked', async () => {
    await git.stagePaths(['src/app.ts']);
    assert.equal(run(['diff', '--cached', '--name-only']).trim(), 'src/app.ts');
    run(['reset', '-q']);
  });
});

describe('branching', () => {
  test('creates a branch and carries the working tree onto it', async () => {
    const created = await git.createBranch('drift/upgrade-react-19.2.0');
    assert.deepEqual(created, { created: true });
    assert.equal(await git.currentBranch(), 'drift/upgrade-react-19.2.0');
    // Uncommitted work follows the checkout rather than being left behind.
    assert.deepEqual(await git.dirtyFiles(), ['src/app.ts']);
  });

  test('switches to an existing branch rather than failing or clobbering it', async () => {
    await git.checkout('main');
    const again = await git.createBranch('drift/upgrade-react-19.2.0');
    assert.deepEqual(again, { created: false });
    assert.equal(await git.currentBranch(), 'drift/upgrade-react-19.2.0');
  });
});

describe('pushing', () => {
  test('sets upstream, and names the branch a pull request would target', async () => {
    await git.checkout('main');
    await git.push('main');

    assert.equal(await git.hasUpstream('main'), true);
    assert.equal(await git.defaultBranch(), 'main');
  });
});
