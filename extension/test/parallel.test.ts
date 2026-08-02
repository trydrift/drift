import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Git } from '../src/git.js';
import { batchCommits } from '../src/fix.js';
import type { CommitUnit } from '../../src/types.js';

/**
 * Running several agents at once.
 *
 * This was refused for a long time, and the reason was sound: every local agent
 * edits the same working tree on the same branch, so two of them overwrite each
 * other's edits and each other's commit scopes. Worktrees remove the shared
 * tree; batching by disjoint file scope removes the shared files. These tests
 * are about that pair of claims, because the whole safety argument for the
 * feature rests on them.
 *
 * The failure mode being guarded against is not "slower than hoped". It is a
 * fix that silently lands half of one concern and all of another, on a
 * developer's real branch, in a way no diff makes obvious.
 */

const unit = (order: number, files: string[], dependsOn: number[] = []): CommitUnit => ({
  order,
  message: `commit ${order}`,
  body: '',
  files,
  breakingChangeIds: [],
  instructions: '',
  dependsOn,
});

describe('deciding what may run at the same time', () => {
  test('units that share no file run together', () => {
    const batches = batchCommits([unit(1, ['a.ts']), unit(2, ['b.ts']), unit(3, ['c.ts'])], 3);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0]!.map((c) => c.order), [1, 2, 3]);
  });

  test('units that share a file never do', () => {
    // The entire correctness argument. Two agents editing one file produce two
    // whole-file replacements, and applying both means one silently wins.
    const batches = batchCommits([unit(1, ['a.ts', 'shared.ts']), unit(2, ['shared.ts'])], 4);
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[0]!.map((c) => c.order), [1]);
    assert.deepEqual(batches[1]!.map((c) => c.order), [2]);
  });

  test('plan order is never rearranged to fill a batch', () => {
    // Commit 3 does not overlap commit 1, but it does not get promoted past
    // commit 2 to join it: the plan orders concerns deliberately, and a later
    // agent seeing an earlier fix already applied is part of that order.
    const batches = batchCommits([unit(1, ['a.ts']), unit(2, ['a.ts']), unit(3, ['z.ts'])], 4);
    assert.deepEqual(
      batches.map((batch) => batch.map((c) => c.order)),
      [[1], [2, 3]],
    );
  });

  test('a commit waits for the commit the plan says it depends on', () => {
    // Disjoint files are not enough on their own. The planner knows about
    // orderings that file scopes do not express — an import path that has to
    // move before the call sites using it can be rewritten — and running the
    // dependent concern alongside its prerequisite would have the second agent
    // reading a tree the first has not finished changing.
    const batches = batchCommits([unit(1, ['a.ts']), unit(2, ['b.ts'], [1])], 4);
    assert.deepEqual(
      batches.map((batch) => batch.map((c) => c.order)),
      [[1], [2]],
    );
  });

  test('a dependency on an already-landed commit does not hold anything back', () => {
    // Commit 1 is finished and applied before batch two starts, so commits 2
    // and 3 depending on it is not a reason to serialise them against each
    // other.
    const batches = batchCommits(
      [unit(1, ['a.ts']), unit(2, ['b.ts'], [1]), unit(3, ['c.ts'], [1])],
      4,
    );
    assert.deepEqual(
      batches.map((batch) => batch.map((c) => c.order)),
      [[1], [2, 3]],
    );
  });

  test('a batch never exceeds the limit', () => {
    const commits = [1, 2, 3, 4, 5].map((n) => unit(n, [`${n}.ts`]));
    for (const batch of batchCommits(commits, 2)) assert.ok(batch.length <= 2);
  });

  test('a limit of one is exactly the sequential run it always was', () => {
    const commits = [unit(1, ['a.ts']), unit(2, ['b.ts'])];
    assert.deepEqual(batchCommits(commits, 1), [[commits[0]], [commits[1]]]);
  });

  test('every unit is run exactly once, whatever the batching', () => {
    // A batcher that dropped a commit would produce a fix that silently
    // skipped a concern — the one bug here that no error message would report.
    const commits = [
      unit(1, ['a.ts']),
      unit(2, ['a.ts', 'b.ts']),
      unit(3, ['c.ts']),
      unit(4, ['c.ts']),
      unit(5, ['d.ts']),
    ];
    for (const limit of [1, 2, 3, 8]) {
      const flat = batchCommits(commits, limit).flat();
      assert.deepEqual(
        flat.map((c) => c.order),
        [1, 2, 3, 4, 5],
        `limit ${limit}`,
      );
    }
  });
});

/**
 * The isolation itself, against real git.
 *
 * A mock would agree with whatever this file assumed about worktrees, and the
 * assumptions worth checking are precisely the ones git enforces.
 */
describe('isolating an agent in its own worktree', () => {
  let root = '';
  let git: Git;

  const run = (args: string[], cwd = root): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' });

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'drift-worktree-'));
    run(['init', '--initial-branch=main']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Drift Test']);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'src/b.ts'), 'export const b = 1;\n');
    run(['add', '.']);
    run(['commit', '-m', 'initial']);
    git = new Git(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('two worktrees at one commit see the same files and neither is the workspace', async () => {
    const base = await git.headSha();
    const one = join(root, '.git', 'drift-worktrees', 'commit-1');
    const two = join(root, '.git', 'drift-worktrees', 'commit-2');

    await git.addWorktree(one, base);
    await git.addWorktree(two, base);

    try {
      assert.equal(readFileSync(join(one, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
      assert.equal(readFileSync(join(two, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');

      // What isolation actually means: an agent's edit is invisible to the
      // other agent and to the developer's checkout until Drift applies it.
      writeFileSync(join(one, 'src/a.ts'), 'export const a = 2;\n');
      assert.equal(readFileSync(join(two, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
      assert.equal(readFileSync(join(root, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
    } finally {
      await git.removeWorktree(one);
      await git.removeWorktree(two);
    }
  });

  test("a worktree never takes the developer's branch hostage", async () => {
    // Checked out rather than detached, git refuses to have `main` in two
    // places — and a crashed run would leave the developer unable to switch
    // back to their own branch. `--detach` is the difference.
    const path = join(root, '.git', 'drift-worktrees', 'detached');
    await git.addWorktree(path, await git.headSha());

    try {
      assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim(), 'HEAD');
      assert.equal(await git.currentBranch(), 'main');
      // Still switchable, which is the property that matters.
      await git.checkout('main');
    } finally {
      await git.removeWorktree(path);
    }
  });

  test('a worktree with agent edits in it can still be torn down', async () => {
    // `worktree remove` refuses a dirty tree by default, which would mean
    // cleanup failing exactly when the run succeeded.
    const path = join(root, '.git', 'drift-worktrees', 'dirty');
    await git.addWorktree(path, await git.headSha());
    writeFileSync(join(path, 'src/a.ts'), 'edited by an agent\n');
    writeFileSync(join(path, 'src/new.ts'), 'created by an agent\n');

    await git.removeWorktree(path);
    assert.equal(existsSync(path), false);
  });

  test('a worktree left by a killed run does not block the next one', async () => {
    const path = join(root, '.git', 'drift-worktrees', 'orphan');
    await git.addWorktree(path, await git.headSha());
    rmSync(path, { recursive: true, force: true });

    await git.pruneWorktrees();
    await git.addWorktree(path, await git.headSha());
    await git.removeWorktree(path);
  });

  test('this git can do worktrees at all, which is what gates the feature', async () => {
    assert.equal(await git.supportsWorktrees(), true);
  });
});
