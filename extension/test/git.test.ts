import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('initializing a checkout', () => {
  test('creates a repository with a baseline commit on main', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'drift-git-init-'));
    try {
      writeFileSync(join(fresh, 'package.json'), '{"dependencies":{}}\n');
      const initialized = new Git(fresh);
      await initialized.init('main');
      const sha = await initialized.commitAll('chore: baseline before Drift', '', {
        allowEmpty: true,
        identity: { name: 'Drift', email: 'drift@example.invalid' },
      });

      assert.ok(sha);
      assert.equal(await initialized.currentBranch(), 'main');
      assert.equal(await initialized.isClean(), true);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
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
    const created = await git.createBranch('drift/upgrade-react-18.3.1-to-19.2.0');
    assert.deepEqual(created, { created: true, name: 'drift/upgrade-react-18.3.1-to-19.2.0' });
    assert.equal(await git.currentBranch(), 'drift/upgrade-react-18.3.1-to-19.2.0');
    // Uncommitted work follows the checkout rather than being left behind.
    assert.deepEqual(await git.dirtyFiles(), ['src/app.ts']);
  });

  test('switches to an existing branch rather than failing or clobbering it', async () => {
    await git.checkout('main');
    const again = await git.createBranch('drift/upgrade-react-18.3.1-to-19.2.0');
    assert.deepEqual(again, { created: false, name: 'drift/upgrade-react-18.3.1-to-19.2.0' });
    assert.equal(await git.currentBranch(), 'drift/upgrade-react-18.3.1-to-19.2.0');
  });

  /**
   * The exact failure a user hit: proposing `main/drift/upgrade-...` (the
   * current branch prefixed onto the branch name, meant to group upgrades in
   * `git branch --list` by where they came from) can never be created as-is
   * — `refs/heads/main` already exists as a leaf ref, so git refuses to also
   * treat it as a directory for `refs/heads/main/drift/...`, failing with
   * "cannot lock ref" rather than anything `branchExists` would catch ahead
   * of time.
   */
  test('falls back to a flat name instead of nesting under an existing branch', async () => {
    await git.checkout('main');
    const result = await git.createBranch('main/drift/upgrade-zod-3.25.76-to-4.4.3');
    assert.equal(result.created, true);
    assert.equal(result.name, 'main-drift/upgrade-zod-3.25.76-to-4.4.3');
    assert.equal(await git.currentBranch(), 'main-drift/upgrade-zod-3.25.76-to-4.4.3');
  });

  test('resolveNestedBranchName leaves an already-safe name untouched', async () => {
    assert.equal(
      await git.resolveNestedBranchName('drift/upgrade-zod-3.25.76-to-4.4.3'),
      'drift/upgrade-zod-3.25.76-to-4.4.3',
    );
  });

  test('resolveNestedBranchName collapses every conflicting ancestor, not just the first', async () => {
    await git.checkout('main');
    await git.createBranch('a');
    await git.checkout('main');
    await git.createBranch('a-b');
    await git.checkout('main');
    // Both `a` and the folded `a-b` already exist as branches, so a naive
    // single-pass fix that only checks the first segment would still try
    // (and fail) to nest under `a-b`.
    const resolved = await git.resolveNestedBranchName('a/b/c');
    assert.equal(resolved, 'a-b-c');
    await git.checkout('main');
    const created = await git.createBranch('a/b/c');
    assert.equal(created.name, 'a-b-c');
  });
});

describe('pushing', () => {
  test('sets upstream, and names the branch a pull request would target', async () => {
    await git.checkout('main');
    await git.push('main');

    assert.equal(await git.hasUpstream('main'), true);
    assert.equal(await git.defaultBranch(), 'main');
  });

  /**
   * The property the whole shipping flow rests on: whatever Drift pushed, the
   * remote's history was only ever added to.
   *
   * Proven by making the push one git would have to force to accept — a local
   * branch rewritten behind a remote that has moved on — and requiring it to be
   * refused. A `push` that quietly grew a `--force` would pass every other test
   * in this file and silently destroy somebody's colleague's commit.
   */
  test('is refused rather than forced when it would rewrite the remote', async () => {
    await git.checkout('main');
    await git.push('main');

    // Somebody else pushes. Here that is done directly in the bare origin's
    // other clone — the effect is the same: origin/main has moved.
    const other = mkdtempSync(join(tmpdir(), 'drift-git-other-'));
    try {
      execFileSync('git', ['clone', origin, other]);
      execFileSync('git', ['config', 'user.email', 'other@example.com'], { cwd: other });
      execFileSync('git', ['config', 'user.name', 'Other Dev'], { cwd: other });
      writeFileSync(join(other, 'theirs.ts'), 'export const theirs = 1;\n');
      execFileSync('git', ['add', '.'], { cwd: other });
      execFileSync('git', ['commit', '-m', 'theirs'], { cwd: other });
      execFileSync('git', ['push'], { cwd: other });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }

    // Our main now diverges from theirs. A forcing push would win; ours must not.
    writeFileSync(join(root, 'ours.ts'), 'export const ours = 1;\n');
    await git.commitAll('ours');

    await assert.rejects(() => git.push('main'), /push failed/);

    const remoteLog = execFileSync('git', ['log', '--oneline', 'main'], { cwd: origin, encoding: 'utf8' });
    assert.match(remoteLog, /theirs/, "the other developer's commit is still on the remote");
    assert.doesNotMatch(remoteLog, /ours/, 'nothing was force-pushed over it');
  });
});

/**
 * The mechanism `advanceBase` (extension/src/fix.ts) relies on: a fresh
 * worktree's base needs to be a real commit, and `snapshotTree` +
 * `commitTree` is how a floating one gets built from whatever is on disk
 * right now — including edits nothing has committed to the branch yet. A
 * later batch's worktree is only correct if checking it out actually
 * contains the previous batch's output, which is what this proves against
 * real git rather than against the call sequence alone.
 */
describe('snapshots chaining into successive worktree bases', () => {
  test('a worktree built from a snapshot taken after an edit contains that edit', async () => {
    const isolated = mkdtempSync(join(tmpdir(), 'drift-git-chain-'));
    try {
      execFileSync('git', ['init', '--initial-branch=main'], { cwd: isolated });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: isolated });
      execFileSync('git', ['config', 'user.name', 'Drift Test'], { cwd: isolated });
      writeFileSync(join(isolated, 'a.ts'), 'export const a = 1;\n');
      execFileSync('git', ['add', '.'], { cwd: isolated });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: isolated });

      const chainGit = new Git(isolated);
      const startRef = await chainGit.headSha();

      // "Batch 1" edits a file without committing it to the branch — exactly
      // what happens when a review is pending rather than auto-committing.
      writeFileSync(join(isolated, 'a.ts'), 'export const a = 2;\n');
      const baseAfterBatch1 = await chainGit.commitTree(
        await chainGit.snapshotTree(),
        startRef,
        'drift: snapshot after batch 1',
      );

      const worktreePath = join(isolated, '.git', 'drift-worktrees', 'commit-2');
      await chainGit.addWorktree(worktreePath, baseAfterBatch1);
      try {
        // Batch 2's worktree must see batch 1's edit, not the state the whole
        // run started from — this is exactly what a stale, once-computed base
        // would fail to provide.
        assert.equal(readFileSync(join(worktreePath, 'a.ts'), 'utf8'), 'export const a = 2;\n');
      } finally {
        await chainGit.removeWorktree(worktreePath);
      }

      // The real branch never moved — the snapshot commit is unreferenced,
      // exactly as `commitTree`'s contract promises.
      assert.equal(await chainGit.headSha(), startRef);
      assert.equal((await chainGit.dirtyFiles())[0], 'a.ts');
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
