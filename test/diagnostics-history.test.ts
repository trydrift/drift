import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGitDir, startRunLog, startSpan } from '../dist/util/diagnostics.js';

const run = promisify(execFile);

async function withGitRepo<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'drift-diag-history-'));
  const git = (args: string[]) => run('git', args, { cwd: root });
  try {
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    await writeFile(join(root, 'file.txt'), 'hello\n');
    await git(['add', '-A']);
    await git(['commit', '-m', 'initial']);
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function entries(root: string): Promise<string[]> {
  return (await readdir(join(resolveGitDir(root), 'drift'))).sort();
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop()!;
}

describe('typed diagnostic history', () => {
  test('overlapping runs keep independent markers and completed logs regardless of finish order', async () => {
    await withGitRepo(async (root) => {
      const first = startRunLog({ command: 'test:first', type: 'dev-quick', mode: 'quick', repoRoot: root });
      const second = startRunLog({ command: 'test:second', type: 'dev-quick', mode: 'quick', repoRoot: root });
      assert.equal((await entries(root)).filter((name) => name.endsWith('.in-progress')).length, 2);

      await first.run(async () => startSpan('package', { package: 'first' }).end());
      await second.run(async () => startSpan('package', { package: 'second' }).end());

      second.finish('ok');
      assert.equal((await entries(root)).filter((name) => name.endsWith('.log')).length, 1);
      assert.equal((await entries(root)).filter((name) => name.endsWith('.in-progress')).length, 1);

      first.finish('ok');
      const final = await entries(root);
      assert.equal(final.filter((name) => name.endsWith('.log')).length, 2);
      assert.equal(final.filter((name) => name.endsWith('.in-progress')).length, 0);

      const contents = await Promise.all(
        final
          .filter((name) => name.endsWith('.log'))
          .map((name) => readFile(join(resolveGitDir(root), 'drift', name), 'utf8')),
      );
      assert.ok(contents.some((text) => text.includes('test:first') && text.includes('first')));
      assert.ok(contents.some((text) => text.includes('test:second') && text.includes('second')));
    });
  });

  test('same-millisecond runs receive distinct collision-safe paths', async () => {
    await withGitRepo(async (root) => {
      const originalNow = Date.now;
      Date.now = () => Date.UTC(2026, 7, 24, 15, 4, 12, 483);
      try {
        const first = startRunLog({ command: 'test:first', type: 'dev-quick', mode: 'quick', repoRoot: root });
        const second = startRunLog({ command: 'test:second', type: 'dev-quick', mode: 'quick', repoRoot: root });
        assert.ok(first.path);
        assert.ok(second.path);
        assert.notEqual(first.path, second.path);
        assert.match(basename(first.path!), /^run-dev-quick-2026-08-24T15-04-12\.483Z-[a-f0-9]{8}\.log$/);
        assert.match(basename(second.path!), /^run-dev-quick-2026-08-24T15-04-12\.483Z-[a-f0-9]{8}\.log$/);
        first.finish('ok');
        second.finish('ok');
      } finally {
        Date.now = originalNow;
      }
      assert.equal((await entries(root)).filter((name) => name.endsWith('.log')).length, 2);
    });
  });

  test('run type is sanitized and recorded in both filename and header', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'test', type: 'Dev / Quick', mode: 'quick', repoRoot: root });
      assert.ok(log.path);
      assert.match(basename(log.path!), /^run-dev-quick-/);
      log.finish('ok');
      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /type: dev-quick/);
    });
  });

  test('finish remains idempotent for immutable typed logs', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'test', type: 'scan-quick', mode: 'quick', repoRoot: root });
      log.finish('ok');
      const before = await readFile(log.path!, 'utf8');
      log.finish('error', { note: 'must not be written' });
      const after = await readFile(log.path!, 'utf8');
      assert.equal(after, before);
      assert.equal((await entries(root)).filter((name) => name.endsWith('.log')).length, 1);
    });
  });

  test('linked worktrees keep independent diagnostic histories', async () => {
    await withGitRepo(async (root) => {
      const worktree = `${root}-worktree`;
      await run('git', ['worktree', 'add', '-b', 'feature', worktree], { cwd: root });
      try {
        const mainLog = startRunLog({ command: 'main', type: 'scan-quick', mode: 'quick', repoRoot: root });
        mainLog.finish('ok');
        const worktreeLog = startRunLog({ command: 'worktree', type: 'scan-deep', mode: 'deep', repoRoot: worktree });
        worktreeLog.finish('ok');
        assert.notEqual(resolveGitDir(root), resolveGitDir(worktree));
        assert.equal((await entries(root)).filter((name) => name.endsWith('.log')).length, 1);
        assert.equal((await entries(worktree)).filter((name) => name.endsWith('.log')).length, 1);
      } finally {
        await run('git', ['worktree', 'remove', '--force', worktree], { cwd: root }).catch(() => {});
      }
    });
  });

  test('separate processes can finish in either order without suppressing either run', async () => {
    await withGitRepo(async (root) => {
      const script = `
        import { readFile, writeFile } from 'node:fs/promises';
        import { startRunLog, startSpan } from '${join(process.cwd(), 'dist/util/diagnostics.js')}';
        const [root, label, ready, release] = process.argv.slice(1);
        const log = startRunLog({ command: 'child:' + label, type: 'dev-quick', mode: 'quick', repoRoot: root });
        await log.run(async () => {
          startSpan('package', { package: label }).end();
          await writeFile(ready, 'ready');
          for (;;) {
            try { await readFile(release); break; }
            catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
          }
        });
        log.finish('ok');
      `;
      const coordination = await mkdtemp(join(tmpdir(), 'drift-diag-history-process-'));
      try {
        const aReady = join(coordination, 'a.ready');
        const bReady = join(coordination, 'b.ready');
        const aRelease = join(coordination, 'a.release');
        const bRelease = join(coordination, 'b.release');
        const child = (label: string, ready: string, release: string) =>
          run(process.execPath, ['--input-type=module', '-e', script, root, label, ready, release]);

        const a = child('A', aReady, aRelease);
        const b = child('B', bReady, bRelease);
        for (const path of [aReady, bReady]) {
          for (;;) {
            try { await readFile(path); break; }
            catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
          }
        }
        await writeFile(bRelease, 'go');
        await new Promise((resolve) => setTimeout(resolve, 20));
        await writeFile(aRelease, 'go');
        await Promise.all([a, b]);

        const logs = (await entries(root)).filter((name) => name.endsWith('.log'));
        assert.equal(logs.length, 2);
        const contents = await Promise.all(logs.map((name) => readFile(join(resolveGitDir(root), 'drift', name), 'utf8')));
        assert.ok(contents.some((text) => text.includes('child:A')));
        assert.ok(contents.some((text) => text.includes('child:B')));
      } finally {
        await rm(coordination, { recursive: true, force: true });
      }
    });
  });
});
