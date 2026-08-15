import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyIgnoredSourceFiles, gitignoreRules } from '../dist/repo/worktree.js';

/**
 * A worktree is `git worktree add`'s checkout: tracked files only. A project
 * whose build reads a gitignored, hand-generated file as if it were source
 * would fail every check there for a reason that has nothing to do with the
 * upgrade being tested. `copyIgnoredSourceFiles` closes that gap by copying
 * what a `build` run in the developer's own checkout already sees: every
 * gitignored file, minus directories a fresh install or build regenerates on
 * its own — no guessing at which ones the project actually needs.
 */

/** A fake `git` that answers `ls-files` from a fixed list of ignored paths. */
function fakeGit(ignored: string[]) {
  return async (_command: string, args: readonly string[]) => {
    if (args[0] === 'ls-files') {
      return { code: 0, stdout: ignored.length ? `${ignored.join('\0')}\0` : '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

describe('carrying gitignored source into a worktree', () => {
  test('copies every gitignored file, not just ones it can guess are referenced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-worktree-src-'));
    const worktree = await mkdtemp(join(tmpdir(), 'drift-worktree-dst-'));
    try {
      await mkdir(join(root, 'src', 'generated'), { recursive: true });
      await writeFile(join(root, 'src', 'generated', 'config.ts'), 'export const config = 1;');
      await mkdir(join(root, 'scratch'), { recursive: true });
      await writeFile(join(root, 'scratch', 'notes.txt'), 'just some local notes, never imported anywhere');

      const exec = fakeGit(['src/generated/config.ts', 'scratch/notes.txt']);
      const { copied, oversized } = await copyIgnoredSourceFiles(root, worktree, exec as never, {});

      // Nothing greps the tracked source for a reference — everything
      // gitignored and outside the denylist comes along, the same as it
      // would sit on disk for a local `npm run build`.
      assert.deepEqual(copied.sort(), ['scratch/notes.txt', 'src/generated/config.ts']);
      assert.deepEqual(oversized, []);
      const contents = await readFile(join(worktree, 'src', 'generated', 'config.ts'), 'utf8');
      assert.equal(contents, 'export const config = 1;');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test('never descends into regenerable directories like node_modules or dist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-worktree-src-'));
    const worktree = await mkdtemp(join(tmpdir(), 'drift-worktree-dst-'));
    try {
      const exec = fakeGit(['node_modules/left-pad/index.js', 'dist/bundle.js']);
      const { copied } = await copyIgnoredSourceFiles(root, worktree, exec as never, {});

      assert.deepEqual(copied, []);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test('reports an oversized file instead of silently dropping it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-worktree-src-'));
    const worktree = await mkdtemp(join(tmpdir(), 'drift-worktree-dst-'));
    try {
      await writeFile(join(root, 'huge.bin'), Buffer.alloc(1024));

      const exec = fakeGit(['huge.bin']);
      // A tiny cap, injected in place of the real 25MB one, so the test does
      // not need to write an actual multi-megabyte fixture to exercise it.
      const { copied, oversized } = await copyIgnoredSourceFiles(root, worktree, exec as never, {}, 512);

      assert.deepEqual(copied, []);
      assert.deepEqual(oversized, ['huge.bin']);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });
});

describe('naming the .gitignore rule behind a carried-over file', () => {
  test('reduces many matching files to the one deduplicated rule that covers them', async () => {
    // A single `dist/` rule can match hundreds of files. The report should
    // name the rule once, not repeat it per file.
    const exec = async (_command: string, args: readonly string[]) => {
      if (args[0] === 'check-ignore') {
        const paths = args.slice(args.indexOf('--') + 1);
        const stdout = paths.map((p) => `.gitignore:1:dist/\t${p}`).join('\n');
        return { code: 0, stdout: stdout ? `${stdout}\n` : '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };

    const rules = await gitignoreRules('/repo', ['dist/a.js', 'dist/b.js'], exec as never, {});
    assert.deepEqual(rules, ['.gitignore:1:dist/']);
  });

  test('names rules from a nested .gitignore by their path from the repo root', async () => {
    const exec = async (_command: string, args: readonly string[]) => {
      if (args[0] === 'check-ignore') {
        return { code: 0, stdout: 'packages/app/.gitignore:3:*.generated.ts\tpackages/app/src/x.generated.ts\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };

    const rules = await gitignoreRules('/repo', ['packages/app/src/x.generated.ts'], exec as never, {});
    assert.deepEqual(rules, ['packages/app/.gitignore:3:*.generated.ts']);
  });

  test('returns nothing for an empty file list without shelling out', async () => {
    const rules = await gitignoreRules('/repo', [], (() => {
      throw new Error('should not be called');
    }) as never, {});
    assert.deepEqual(rules, []);
  });
});
