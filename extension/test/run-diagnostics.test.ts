import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRepoDiagnostic } from '../src/run-diagnostics.js';
import { startSpan } from '../../src/util/diagnostics.js';

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

describe('runRepoDiagnostic', () => {
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
      const logA = await readFile(join(repoA, '.git/drift/run.log'), 'utf8');
      const logB = await readFile(join(repoB, '.git/drift/run.log'), 'utf8');
      assert.match(logA, /only-a/);
      assert.doesNotMatch(logA, /only-b/);
      assert.match(logB, /only-b/);
      assert.doesNotMatch(logB, /only-a/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('records cancellation instead of success', async () => {
    await withGitRepo(async (root) => {
      await runRepoDiagnostic({ command: 'test', mode: 'quick', repoRoot: root, spanName: 'scan', isCancelled: () => true }, async () => undefined);
      const log = await readFile(join(root, '.git/drift/run.log'), 'utf8');
      assert.match(log, /status=cancelled/);
      assert.doesNotMatch(log, /status=ok/);
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
      const log = await readFile(join(root, '.git/drift/run.log'), 'utf8');
      assert.match(log, /status=threw/);
      assert.match(log, /REDACTED/);
      assert.doesNotMatch(log, /secret-token-value/);
    });
  });

  test('records deep mode in the header', async () => {
    await withGitRepo(async (root) => {
      await runRepoDiagnostic({ command: 'test', mode: 'deep', repoRoot: root, spanName: 'verification' }, async () => undefined);
      const log = await readFile(join(root, '.git/drift/run.log'), 'utf8');
      assert.match(log, /mode: deep/);
    });
  });
});
