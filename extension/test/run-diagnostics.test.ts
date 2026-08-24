import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRepoDiagnostic } from '../src/run-diagnostics.js';
import { resolveGitDir, startSpan } from '../../src/util/diagnostics.js';
import { __settings } from './vscode-stub.js';

const run = promisify(execFile);

async function withGitRepo<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'drift-extension-diag-'));
  try {
    await run('git', ['init', '-b', 'main'], { cwd: root });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await run('git', ['config', 'user.name', 'Test'], { cwd: root });
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function completedLogs(root: string): Promise<string[]> {
  const dir = join(resolveGitDir(root), 'drift');
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.log')).sort();
  return names.map((name) => join(dir, name));
}

async function onlyCompletedLog(root: string): Promise<{ path: string; contents: string }> {
  const logs = await completedLogs(root);
  assert.equal(logs.length, 1);
  return { path: logs[0]!, contents: await readFile(logs[0]!, 'utf8') };
}

beforeEach(() => {
  __settings.clear();
  __settings.set('diagnostics.recordRuns', true);
});

describe('runRepoDiagnostic', () => {
  test('does not record runs by default', async () => {
    await withGitRepo(async (root) => {
      __settings.clear();
      let ran = false;
      await runRepoDiagnostic({ command: 'test', mode: 'quick', repoRoot: root, spanName: 'scan' }, async () => {
        ran = true;
      });
      assert.equal(ran, true);
      assert.deepEqual(await completedLogs(root), []);
    });
  });

  test('keeps repository diagnostics isolated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-extension-diag-roots-'));
    const repoA = join(root, 'a');
    const repoB = join(root, 'b');
    try {
      await run('mkdir', [repoA]);
      await run('mkdir', [repoB]);
      for (const repo of [repoA, repoB]) {
        await run('git', ['init', '-b', 'main'], { cwd: repo });
        await run('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
        await run('git', ['config', 'user.name', 'Test'], { cwd: repo });
      }
      await runRepoDiagnostic({ command: 'test:a', mode: 'quick', repoRoot: repoA, spanName: 'dependency.scan' }, async () => {
        startSpan('package', { package: 'only-a' }).end();
      });
      await runRepoDiagnostic({ command: 'test:b', mode: 'quick', repoRoot: repoB, spanName: 'dependency.scan' }, async () => {
        startSpan('package', { package: 'only-b' }).end();
      });
      const logA = (await onlyCompletedLog(repoA)).contents;
      const logB = (await onlyCompletedLog(repoB)).contents;
      assert.match(logA, /only-a/);
      assert.doesNotMatch(logA, /only-b/);
      assert.match(logB, /only-b/);
      assert.doesNotMatch(logB, /only-a/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('preserves every completed run with a typed timestamped filename', async () => {
    await withGitRepo(async (root) => {
      await runRepoDiagnostic(
        { command: 'test:first', type: 'dev-quick', mode: 'quick', repoRoot: root, spanName: 'scan' },
        async () => startSpan('package', { package: 'first' }).end(),
      );
      await runRepoDiagnostic(
        { command: 'test:second', type: 'dev-quick', mode: 'quick', repoRoot: root, spanName: 'scan' },
        async () => startSpan('package', { package: 'second' }).end(),
      );

      const logs = await completedLogs(root);
      assert.equal(logs.length, 2);
      for (const path of logs) {
        assert.match(
          path.split('/').pop()!,
          /^run-dev-quick-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}\.log$/,
        );
      }
      const contents = await Promise.all(logs.map((path) => readFile(path, 'utf8')));
      assert.ok(contents.some((text) => text.includes('first')));
      assert.ok(contents.some((text) => text.includes('second')));
    });
  });

  test('records cancellation instead of success', async () => {
    await withGitRepo(async (root) => {
      await runRepoDiagnostic({ command: 'test', mode: 'quick', repoRoot: root, spanName: 'scan', isCancelled: () => true }, async () => undefined);
      const { path, contents } = await onlyCompletedLog(root);
      assert.match(path.split('/').pop()!, /^run-scan-quick-/);
      assert.match(contents, /status=cancelled/);
      assert.doesNotMatch(contents, /status=ok/);
    });
  });

  test('records and rethrows failures with redacted errors', async () => {
    await withGitRepo(async (root) => {
      await assert.rejects(
        runRepoDiagnostic({ command: 'test', mode: 'quick', repoRoot: root, spanName: 'scan' }, async () => {
          throw new Error('Bearer secret-token-value');
        }),
        /Bearer secret-token-value/,
      );
      const { contents } = await onlyCompletedLog(root);
      assert.match(contents, /status=threw/);
      assert.match(contents, /REDACTED/);
      assert.doesNotMatch(contents, /secret-token-value/);
    });
  });

  test('records deep mode and type in the header and filename', async () => {
    await withGitRepo(async (root) => {
      await runRepoDiagnostic({ command: 'test', mode: 'deep', repoRoot: root, spanName: 'verification' }, async () => undefined);
      const { path, contents } = await onlyCompletedLog(root);
      assert.match(path.split('/').pop()!, /^run-scan-deep-/);
      assert.match(contents, /type: scan-deep/);
      assert.match(contents, /mode: deep/);
    });
  });
});
