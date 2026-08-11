import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitWorkingTreeManifests } from '../dist/repo/local-git.js';
import { selectCandidate, selectorFor } from '../dist/cli.js';
import { createLogger } from '../dist/util/logger.js';

const run = promisify(execFile);

/**
 * The `outdated --upgrade` → `fix` handoff, and who gets upgraded.
 *
 * `--upgrade` leaves an uncommitted manifest edit, exactly as `npm install
 * pkg@version` would. `fix` resolves its range with `includeWorkingTree:
 * false`, because it checks `after` out into a worktree and the working tree
 * is not a ref — so the command Drift recommended after an upgrade analysed
 * the *previous* dependency commit and reported on a version the developer had
 * already moved off.
 */

async function withGitRepo<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'drift-wt-'));
  const git = (args: string[]) => run('git', args, { cwd: root });
  try {
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { react: '18.0.0' } }, null, 2));
    await writeFile(join(root, 'app.js'), 'export const x = 1;\n');
    await git(['add', '-A']);
    await git(['commit', '-m', 'initial']);
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('commitWorkingTreeManifests: making an uncommitted upgrade analysable', () => {
  test('a clean tree yields no commit', async () => {
    await withGitRepo(async (root) => {
      assert.equal(await commitWorkingTreeManifests(root, 'msg'), null);
    });
  });

  test('an uncommitted manifest edit becomes a real commit on top of HEAD', async () => {
    await withGitRepo(async (root) => {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ dependencies: { react: '19.0.0' } }, null, 2),
      );

      const sha = await commitWorkingTreeManifests(root, 'chore(deps): upgrade');
      assert.ok(sha, 'the dirty manifest should produce a commit');

      const { stdout } = await run('git', ['show', `${sha}:package.json`], { cwd: root });
      assert.match(stdout, /19\.0\.0/, 'the commit must contain the upgraded version');

      const { stdout: parent } = await run('git', ['rev-parse', `${sha}^`], { cwd: root });
      const { stdout: head } = await run('git', ['rev-parse', 'HEAD'], { cwd: root });
      assert.equal(parent.trim(), head.trim(), 'it must sit directly on HEAD');
    });
  });

  test('the developer’s working tree, index, and branch are untouched', async () => {
    await withGitRepo(async (root) => {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ dependencies: { react: '19.0.0' } }, null, 2),
      );

      const { stdout: headBefore } = await run('git', ['rev-parse', 'HEAD'], { cwd: root });
      await commitWorkingTreeManifests(root, 'chore(deps): upgrade');
      const { stdout: headAfter } = await run('git', ['rev-parse', 'HEAD'], { cwd: root });

      assert.equal(headAfter, headBefore, 'HEAD must not move');

      // The edit is still sitting uncommitted, exactly where the developer
      // left it — Drift analysed it without taking it away from them.
      const { stdout: status } = await run('git', ['status', '--porcelain'], { cwd: root });
      assert.match(status, /package\.json/);
      assert.match(await readFile(join(root, 'package.json'), 'utf8'), /19\.0\.0/);
    });
  });

  test('unrelated work in progress is not swept into the dependency commit', async () => {
    await withGitRepo(async (root) => {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ dependencies: { react: '19.0.0' } }, null, 2),
      );
      // A half-finished refactor in the same tree. It is not a manifest, and a
      // dependency commit that contains it is not a dependency commit.
      await writeFile(join(root, 'app.js'), 'export const x = 2; // mid-refactor\n');

      const sha = await commitWorkingTreeManifests(root, 'chore(deps): upgrade');
      assert.ok(sha);

      const { stdout } = await run('git', ['show', `${sha}:app.js`], { cwd: root });
      assert.equal(stdout, 'export const x = 1;\n', 'app.js must be HEAD’s version, not the dirty one');
    });
  });

  test('the commit is checkoutable into a worktree, which is what fix does with it', async () => {
    await withGitRepo(async (root) => {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ dependencies: { react: '19.0.0' } }, null, 2),
      );
      const sha = await commitWorkingTreeManifests(root, 'chore(deps): upgrade');
      assert.ok(sha);

      const worktree = join(root, 'wt');
      await run('git', ['worktree', 'add', '--detach', worktree, sha], { cwd: root });
      try {
        assert.match(await readFile(join(worktree, 'package.json'), 'utf8'), /19\.0\.0/);
      } finally {
        await run('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
      }
    });
  });
});

/**
 * Which `react` did they mean?
 *
 * In a monorepo a bare package name is not an identifier. Picking whichever
 * the scan sorted first is a write to a manifest the developer did not name.
 */
const candidate = (name: string, manifestPath: string, workspace?: string) =>
  ({ name, manifestPath, ecosystem: 'npm', packageManager: 'npm', ...(workspace ? { workspace } : {}) }) as never;

describe('CLI package selection in a monorepo', () => {
  const logger = createLogger('error');

  test('a name declared once needs no qualifier', () => {
    const all = [candidate('react', 'package.json')];
    assert.equal(selectorFor(all[0]!, all), 'react');
    assert.equal(selectCandidate(all, 'react', logger)?.manifestPath, 'package.json');
  });

  test('a name declared twice is qualified by its directory', () => {
    const all = [
      candidate('react', 'packages/web/package.json', 'packages/web'),
      candidate('react', 'packages/admin/package.json', 'packages/admin'),
    ];
    assert.equal(selectorFor(all[0]!, all), 'packages/web:react');
    assert.equal(selectorFor(all[1]!, all), 'packages/admin:react');
  });

  test('an ambiguous bare name is refused, not guessed', () => {
    const all = [
      candidate('react', 'packages/web/package.json', 'packages/web'),
      candidate('react', 'packages/admin/package.json', 'packages/admin'),
    ];
    assert.equal(selectCandidate(all, 'react', logger), null);
  });

  test('a qualified name resolves to exactly that workspace', () => {
    const all = [
      candidate('react', 'packages/web/package.json', 'packages/web'),
      candidate('react', 'packages/admin/package.json', 'packages/admin'),
    ];
    assert.equal(
      selectCandidate(all, 'packages/admin:react', logger)?.manifestPath,
      'packages/admin/package.json',
    );
  });

  test('a scoped npm name is not mistaken for a workspace qualifier', () => {
    // `@scope/pkg` has no colon, but the parser splits on the LAST colon, so a
    // name that never had one must survive untouched.
    const all = [candidate('@acme/sdk', 'package.json')];
    assert.equal(selectCandidate(all, '@acme/sdk', logger)?.name, '@acme/sdk');
  });

  test('an unknown package is reported, not silently skipped', () => {
    const all = [candidate('react', 'package.json')];
    assert.equal(selectCandidate(all, 'vue', logger), null);
  });
});
