import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyIgnoredSourceFiles, gitignoreRules, createWorktree } from '../dist/repo/worktree.js';

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

describe('never copying anything secret-shaped into a worktree', () => {
  test('.env, private keys, and credentials files are never copied, allowlist or not', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-worktree-src-'));
    const worktree = await mkdtemp(join(tmpdir(), 'drift-worktree-dst-'));
    try {
      const sensitive = [
        '.env',
        '.env.local',
        '.npmrc',
        '.aws/credentials',
        'id_rsa',
        'server.pem',
        'service-account.json',
        'secrets.yaml',
      ];
      for (const rel of sensitive) {
        await mkdir(join(root, join(rel, '..')), { recursive: true });
        await writeFile(join(root, rel), 'super-secret');
      }

      const exec = fakeGit(sensitive);
      const { copied, secrets } = await copyIgnoredSourceFiles(root, worktree, exec as never, {});

      assert.deepEqual(copied, [], 'nothing sensitive-shaped is ever copied');
      assert.deepEqual(secrets.sort(), sensitive.sort());
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test('a plain generated file is unaffected by the secrets denylist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-worktree-src-'));
    const worktree = await mkdtemp(join(tmpdir(), 'drift-worktree-dst-'));
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'config.generated.ts'), 'export const x = 1;');

      const exec = fakeGit(['src/config.generated.ts']);
      const { copied, secrets } = await copyIgnoredSourceFiles(root, worktree, exec as never, {});

      assert.deepEqual(copied, ['src/config.generated.ts']);
      assert.deepEqual(secrets, []);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });
});

describe('an explicit allowlist narrows what gets copied', () => {
  test('with an allowlist set, only matching files are copied — even non-secret ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-worktree-src-'));
    const worktree = await mkdtemp(join(tmpdir(), 'drift-worktree-dst-'));
    try {
      await mkdir(join(root, 'src', 'generated'), { recursive: true });
      await writeFile(join(root, 'src', 'generated', 'config.ts'), 'export const config = 1;');
      await mkdir(join(root, 'scratch'), { recursive: true });
      await writeFile(join(root, 'scratch', 'notes.txt'), 'not named in the allowlist');

      const exec = fakeGit(['src/generated/config.ts', 'scratch/notes.txt']);
      const { copied } = await copyIgnoredSourceFiles(root, worktree, exec as never, {}, undefined, [
        'src/generated/**',
      ]);

      assert.deepEqual(copied, ['src/generated/config.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test('a secret matching the allowlist is still never copied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-worktree-src-'));
    const worktree = await mkdtemp(join(tmpdir(), 'drift-worktree-dst-'));
    try {
      await mkdir(join(root, 'config'), { recursive: true });
      await writeFile(join(root, 'config', '.env'), 'SECRET=1');

      const exec = fakeGit(['config/.env']);
      const { copied, secrets } = await copyIgnoredSourceFiles(root, worktree, exec as never, {}, undefined, [
        'config/**',
      ]);

      assert.deepEqual(copied, []);
      assert.deepEqual(secrets, ['config/.env']);
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

/** A fake `git` whose `rev-parse --git-common-dir` answers with a fixed value, recording every call. */
function fakeGitRepo(commonDirOutput: string) {
  const calls: { command: string; args: string[] }[] = [];
  const exec = async (command: string, args: readonly string[]) => {
    calls.push({ command, args: [...args] });
    if (args[0] === 'rev-parse') return { code: 0, stdout: commonDirOutput, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, exec };
}

describe('where a worktree is put', () => {
  test('an ordinary checkout resolves the relative .git dir against root', async () => {
    const { exec } = fakeGitRepo('.git\n');
    const worktree = await createWorktree('/repo', 'probe-root', { exec: exec as never, runId: 'r1' });
    assert.equal(worktree.path, join('/repo', '.git', 'drift-worktrees', 'r1', 'probe-root'));
  });

  test('a linked worktree (an absolute --git-common-dir) is used as-is, never joined onto root again', async () => {
    // This is what `git rev-parse --git-common-dir` prints when Drift itself
    // is checked out with `git worktree add` — e.g. its own CI. Joining that
    // absolute path onto `root` a second time used to build a path that does
    // not exist, so verification failed everywhere except an ordinary clone.
    const { exec } = fakeGitRepo('/main-checkout/.git\n');
    const worktree = await createWorktree('/some/linked-worktree', 'probe-root', {
      exec: exec as never,
      runId: 'r1',
    });
    assert.equal(worktree.path, join('/main-checkout/.git', 'drift-worktrees', 'r1', 'probe-root'));
    assert.ok(!worktree.path.includes('linked-worktree'));
  });

  test('every worktree from one call site shares a run namespace by default', async () => {
    const { exec } = fakeGitRepo('.git\n');
    const a = await createWorktree('/repo', 'probe-root', { exec: exec as never });
    const b = await createWorktree('/repo', 'probe-pkg', { exec: exec as never });
    const runSegment = (p: string) => p.split(`${join('drift-worktrees', '')}`)[1]!.split(/[\\/]/)[0];
    assert.equal(runSegment(a.path), runSegment(b.path), 'both came from this process, so they share a namespace');
  });

  test('two different run IDs never collide on the same path', async () => {
    const { exec } = fakeGitRepo('.git\n');
    const a = await createWorktree('/repo', 'probe-root', { exec: exec as never, runId: 'run-a' });
    const b = await createWorktree('/repo', 'probe-root', { exec: exec as never, runId: 'run-b' });
    assert.notEqual(a.path, b.path);
  });

  test("the pre-add cleanup only targets this run's own namespaced path", async () => {
    const { calls, exec } = fakeGitRepo('.git\n');
    const worktree = await createWorktree('/repo', 'probe-root', { exec: exec as never, runId: 'run-a' });
    const removals = calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    assert.ok(removals.length > 0);
    for (const removal of removals) {
      assert.ok(removal.args.includes(worktree.path), "every removal names this run's own path");
    }
  });
});

/** A fake `git` that fails `rev-parse --git-common-dir`, as it does outside any repository. */
function fakeNonGit() {
  return async (_command: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
      return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

describe('verifying a directory that has never been git init\'d', () => {
  test('falls back to a plain copy instead of throwing, when no specific commit was requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-worktree-nongit-'));
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'index.ts'), 'export const x = 1;');

      const worktree = await createWorktree(root, 'probe-root', { exec: fakeNonGit() as never, runId: 'r1' });
      try {
        const contents = await readFile(join(worktree.path, 'src', 'index.ts'), 'utf8');
        assert.equal(contents, 'export const x = 1;');
      } finally {
        await worktree.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('still throws when a specific commit was requested, since there is nothing to check out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-worktree-nongit-'));
    try {
      await assert.rejects(
        createWorktree(root, 'change-abc123', { at: 'abc123', exec: fakeNonGit() as never, runId: 'r1' }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('never copies regenerable directories or secret-shaped files into the fallback checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-worktree-nongit-'));
    try {
      await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
      await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = {};');
      await writeFile(join(root, '.env'), 'SECRET=1');
      await writeFile(join(root, 'package.json'), '{}');

      const worktree = await createWorktree(root, 'probe-root', { exec: fakeNonGit() as never, runId: 'r1' });
      try {
        await assert.rejects(readFile(join(worktree.path, 'node_modules', 'left-pad', 'index.js')));
        await assert.rejects(readFile(join(worktree.path, '.env')));
        const pkg = await readFile(join(worktree.path, 'package.json'), 'utf8');
        assert.equal(pkg, '{}');
        assert.deepEqual(worktree.skippedSecrets, ['.env']);
      } finally {
        await worktree.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
