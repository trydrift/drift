import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasActiveRun,
  noteCache,
  recordExecCommand,
  recordHttpRequest,
  redactCommand,
  redactText,
  resolveGitDir,
  sanitizeArgs,
  startRunLog,
  startSpan,
} from '../dist/util/diagnostics.js';

const run = promisify(execFile);

async function withGitRepo<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'drift-diag-'));
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

describe('secret redaction', () => {
  test('redacts --token and --copilot-token values from a command summary', () => {
    const summary = redactCommand(['analyze', '--dir', '/repo', '--token', 'super-secret-token', '--copilot-token', 'another-secret']);
    assert.ok(!summary.includes('super-secret-token'));
    assert.ok(!summary.includes('another-secret'));
    assert.match(summary, /--token \[REDACTED\]/);
    assert.match(summary, /--copilot-token \[REDACTED\]/);
  });

  test('redacts --token=value form too', () => {
    const summary = redactCommand(['analyze', '--token=super-secret-token']);
    assert.ok(!summary.includes('super-secret-token'));
  });

  test('redacts credential-shaped text even outside a recognised flag', () => {
    assert.equal(redactText('Authorization: Bearer abcdef123456'), '[REDACTED]');
    assert.ok(!redactText('token was ghp_abcdefghijklmnopqrstuvwxyz012345').includes('ghp_abcdefghijklmnopqrstuvwxyz012345'));
  });

  test('sanitizeArgs never leaks a sensitive flag value positionally', () => {
    const args = sanitizeArgs(['--dir', '/repo', '--token', 'sek', '--verify']);
    assert.deepEqual(args, ['--dir', '/repo', '--token', '[REDACTED]', '--verify']);
  });

  test('an end-to-end run log never contains a token passed on the command line', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({
        command: redactCommand(['analyze', '--dir', root, '--token', 'super-secret-token', '--copilot-token', 'another-secret']),
        mode: 'quick',
        repoRoot: root,
      });
      log.finish('ok');
      const contents = await readFile(log.path!, 'utf8');
      assert.ok(!contents.includes('super-secret-token'));
      assert.ok(!contents.includes('another-secret'));
    });
  });
});

describe('path resolution', () => {
  test('resolves the .git directory even when cwd differs from the target repo', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      assert.ok(log.path);
      assert.ok(log.path!.startsWith(join(root, '.git', 'drift')));
      log.finish('ok');
    });
  });

  test('follows a worktree .git file (gitdir: pointer) to the real git dir', async () => {
    await withGitRepo(async (root) => {
      const worktreeDir = join(root, '..', `${join(root).split('/').pop()}-wt`);
      await run('git', ['worktree', 'add', '-b', 'wt-branch', worktreeDir], { cwd: root });
      try {
        const resolved = resolveGitDir(worktreeDir);
        // The worktree's .git is a file, not a directory; resolution must
        // follow it back into the main repo's .git/worktrees/<name>.
        assert.ok(resolved.includes(join('.git', 'worktrees')));
        const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: worktreeDir });
        assert.ok(log.path);
        log.finish('ok');
        const contents = await readFile(log.path!, 'utf8');
        assert.match(contents, /DRIFT RUN DIAGNOSTIC/);
      } finally {
        await run('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: root }).catch(() => {});
      }
    });
  });

  test('running twice leaves exactly one file, containing only the latest run', async () => {
    await withGitRepo(async (root) => {
      const first = startRunLog({ command: 'drift outdated (first)', mode: 'quick', repoRoot: root });
      first.finish('ok');
      const second = startRunLog({ command: 'drift outdated (second)', mode: 'quick', repoRoot: root });
      second.finish('ok');

      const dir = join(root, '.git', 'drift');
      const entries = await readdir(dir);
      assert.deepEqual(entries, ['run.log']);
      const contents = await readFile(join(dir, 'run.log'), 'utf8');
      assert.ok(contents.includes('(second)'));
      assert.ok(!contents.includes('(first)'));
    });
  });

  test('the working tree stays clean after a run — the log lives inside .git', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      log.finish('ok');
      const { stdout } = await run('git', ['status', '--porcelain'], { cwd: root });
      assert.equal(stdout.trim(), '');
    });
  });
});

describe('span correctness', () => {
  test('nested spans record duration, depth, and parent/child order in the timeline', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      const outer = log.startSpan('upgrade.scan');
      const inner = log.startSpan('package react');
      inner.end({ package: 'react' });
      outer.end({ packages: 1 });
      log.finish('ok');

      const contents = await readFile(log.path!, 'utf8');
      const beginOuter = contents.indexOf('BEGIN upgrade.scan');
      const beginInner = contents.indexOf('BEGIN package react');
      const endInner = contents.indexOf('END package react');
      const endOuter = contents.indexOf('END upgrade.scan');
      assert.ok(beginOuter < beginInner);
      assert.ok(beginInner < endInner);
      assert.ok(endInner < endOuter);
      // The inner span is indented relative to the outer one.
      const innerLine = contents.split('\n').find((l) => l.includes('BEGIN package react'))!;
      const outerLine = contents.split('\n').find((l) => l.includes('BEGIN upgrade.scan'))!;
      assert.ok(innerLine.startsWith('  '));
      assert.ok(!outerLine.startsWith(' '));
    });
  });

  test('a failed span records status and duration, and the summary is still produced', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      const span = log.startSpan('surface.target', { package: 'foo' });
      span.fail(new Error('request timeout'));
      log.finish('error');

      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /END surface\.target duration=\d+ms status=error error=/);
      assert.match(contents, /SUMMARY/);
      assert.match(contents, /diagnostic flags:/);
    });
  });

  test('a span still open when finish() is called is closed as interrupted, not dropped', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      log.startSpan('upgrade.scan'); // never ended — simulates a throw mid-scan
      log.finish('threw');

      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /status=interrupted/);
    });
  });

  test('finish() is idempotent', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      log.finish('ok');
      const before = await readFile(log.path!, 'utf8');
      log.finish('ok', { note: 'should be ignored' });
      const after = await readFile(log.path!, 'utf8');
      assert.equal(before, after);
    });
  });

  test('no run is active once finish() has been called', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      assert.equal(hasActiveRun(), true);
      log.finish('ok');
      assert.equal(hasActiveRun(), false);
    });
  });
});

describe('HTTP and exec aggregation', () => {
  test('network summary aggregates by host and reports cache hit/miss, without leaking a token', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      log.recordHttp({ host: 'registry.npmjs.org', method: 'GET', path: '/react', durationMs: 120, status: 200, cache: 'miss' });
      log.recordHttp({ host: 'registry.npmjs.org', method: 'GET', path: '/vue', durationMs: 400, status: 200, cache: 'hit' });
      log.recordHttp({ host: 'cdn.jsdelivr.net', method: 'GET', path: '/npm/react/index.d.ts', durationMs: 900, status: 200, cache: 'miss' });
      log.finish('ok');

      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /requests: 3/);
      assert.match(contents, /registry\.npmjs\.org\s+requests=2/);
      assert.match(contents, /cdn\.jsdelivr\.net\s+requests=1/);
      assert.match(contents, /cache_hits: 1/);
      assert.match(contents, /cache_misses: 2/);
      assert.ok(!contents.toLowerCase().includes('authorization'));
      assert.ok(!contents.toLowerCase().includes('bearer'));
    });
  });

  test('exec aggregation reports sanitized labels and timing', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      log.recordExec({ label: 'git ls-files', durationMs: 810, exitCode: 0 });
      log.recordExec({ label: 'npm view react', durationMs: 720, exitCode: 0 });
      log.finish('ok');

      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /external processes:/);
      assert.match(contents, /count: 2/);
      assert.match(contents, /git ls-files/);
      assert.match(contents, /npm view react/);
    });
  });

  test('cache diagnostics report hits and misses per named cache', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      log.noteCache('type-surface', true);
      log.noteCache('type-surface', false);
      log.noteCache('type-surface', false);
      log.finish('ok');

      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /type-surface: 1 hits \/ 2 misses/);
    });
  });

  test('module-level record functions are safe no-ops with no active run', () => {
    assert.equal(hasActiveRun(), false);
    assert.doesNotThrow(() => {
      recordHttpRequest({ host: 'x', method: 'GET', path: '/', durationMs: 1, status: 200, cache: 'miss' });
      recordExecCommand({ label: 'git status', durationMs: 1, exitCode: 0 });
      noteCache('http', true);
      startSpan('x').end();
    });
  });
});

describe('overhead', () => {
  test('10,000 span start/end pairs complete well under 200ms', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      const started = Date.now();
      for (let i = 0; i < 10_000; i++) {
        const span = log.startSpan('package', { package: `pkg-${i}` });
        span.end({ files: i });
      }
      const elapsed = Date.now() - started;
      log.finish('ok');
      assert.ok(elapsed < 200, `expected under 200ms, took ${elapsed}ms`);
    });
  });
});
