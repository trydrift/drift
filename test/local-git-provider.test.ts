import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalGitProvider, WORKING_TREE } from '../dist/repo/local-git.js';

const run = promisify(execFile);

/**
 * `LocalGitProvider.listFiles`, against a real checkout.
 *
 * This is what expands `proto/**\/*.proto` in a user's configuration, so the
 * thing that must never happen is a listing that is quietly short: a file
 * missing from it becomes a contract Drift never compared and never mentioned.
 * A stub cannot catch that — the failure modes are git's own (a ref that does
 * not exist, a nested path, an untracked file) — so this drives the real
 * binary.
 */

async function withGitRepo<T>(fn: (root: string, git: (args: string[]) => Promise<unknown>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'drift-lgp-'));
  const git = (args: string[]) => run('git', args, { cwd: root });
  try {
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    await mkdir(join(root, 'proto', 'users', 'v1'), { recursive: true });
    await writeFile(join(root, 'proto', 'users', 'v1', 'users.proto'), 'syntax = "proto3";\n');
    await writeFile(join(root, 'proto', 'common.proto'), 'syntax = "proto3";\n');
    await writeFile(join(root, 'README.md'), '# hi\n');
    await git(['add', '-A']);
    await git(['commit', '-m', 'initial']);
    return await fn(root, git);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('listing the files at a ref from a local checkout', () => {
  test('every tracked file is listed, at every depth, repo-relative', async () => {
    await withGitRepo(async (root) => {
      const provider = new LocalGitProvider(root, { before: 'HEAD', after: 'HEAD' });
      const files = await provider.listFiles('HEAD');

      assert.deepEqual(files?.sort(), [
        'README.md',
        'proto/common.proto',
        'proto/users/v1/users.proto',
      ]);
    });
  });

  test('a ref that does not exist returns null, never an empty list', async () => {
    // The distinction the whole feature rests on. `[]` here would tell the
    // caller the pattern matches nothing, and every contract it covers would be
    // reported as clean without being read.
    await withGitRepo(async (root) => {
      const provider = new LocalGitProvider(root, { before: 'HEAD', after: 'HEAD' });

      assert.equal(await provider.listFiles('no-such-ref'), null);
    });
  });

  test('the working tree includes files that are not committed yet', async () => {
    await withGitRepo(async (root) => {
      await writeFile(join(root, 'proto', 'orders.proto'), 'syntax = "proto3";\n');
      const provider = new LocalGitProvider(root, { before: 'HEAD', after: WORKING_TREE });

      const files = await provider.listFiles(WORKING_TREE);

      assert.ok(
        files?.includes('proto/orders.proto'),
        'an uncommitted contract is what the developer is asking about; listing the commit instead would miss it',
      );
    });
  });

  test('the working tree listing respects .gitignore', async () => {
    await withGitRepo(async (root, git) => {
      await writeFile(join(root, '.gitignore'), 'generated/\n');
      await mkdir(join(root, 'generated'), { recursive: true });
      await writeFile(join(root, 'generated', 'stub.proto'), 'syntax = "proto3";\n');
      await git(['add', '.gitignore']);
      const provider = new LocalGitProvider(root, { before: 'HEAD', after: WORKING_TREE });

      const files = await provider.listFiles(WORKING_TREE);

      assert.ok(files, 'the listing must succeed');
      assert.ok(
        !files.some((f) => f.startsWith('generated/')),
        'generated output is not a contract this repository maintains',
      );
    });
  });

  test('a commit listed by SHA describes that commit, not the working tree', async () => {
    await withGitRepo(async (root, git) => {
      const { stdout } = (await git(['rev-parse', 'HEAD'])) as { stdout: string };
      const head = stdout.trim();
      await writeFile(join(root, 'proto', 'later.proto'), 'syntax = "proto3";\n');

      const provider = new LocalGitProvider(root, { before: head, after: WORKING_TREE });
      const files = await provider.listFiles(head);

      assert.ok(!files?.includes('proto/later.proto'));
    });
  });
});
