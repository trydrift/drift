import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasActiveRun,
  noteCache,
  recordExecCommand,
  recordHttpAttempt,
  recordHttpRequest,
  redactCommand,
  redactText,
  resolveGitDir,
  sanitizeArgs,
  runElapsedMs,
  startRunLog,
  startSpan,
  withSpan,
} from '../dist/util/diagnostics.js';
import { clearHttpCache, configureHttpDiskCache, fetchJson, fetchText } from '../dist/util/http.js';

const run = promisify(execFile);

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function childRunScript(): string {
  return `
    import { writeFile, readFile } from 'node:fs/promises';
    import { startRunLog, startSpan } from '${join(process.cwd(), 'dist/util/diagnostics.js')}';
    const [root, label, started, finishSignal] = process.argv.slice(1);
    const log = startRunLog({ command: 'drift outdated (' + label + ')', mode: 'quick', repoRoot: root });
    await log.run(async () => {
      const span = startSpan('package', { package: 'from-' + label });
      await writeFile(started, 'started');
      for (;;) {
        try {
          await readFile(finishSignal);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      span.end();
    });
    log.finish('ok');
  `;
}

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

  test('a redacted thrown error never leaks a token into the report', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      try {
        await log.run(async () => {
          throw new Error('request to https://x/y failed: Authorization: Bearer topsecrettoken123456');
        });
      } catch {
        // expected
      }
      log.finish('threw', { message: redactText('Authorization: Bearer topsecrettoken123456') });
      const contents = await readFile(log.path!, 'utf8');
      assert.ok(!contents.includes('topsecrettoken123456'));
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

  test('running twice preserves an immutable log for each run', async () => {
    await withGitRepo(async (root) => {
      const first = startRunLog({ command: 'drift outdated (first)', mode: 'quick', repoRoot: root });
      first.finish('ok');
      const second = startRunLog({ command: 'drift outdated (second)', mode: 'quick', repoRoot: root });
      second.finish('ok');

      const dir = join(root, '.git', 'drift');
      const entries = (await readdir(dir)).filter((entry) => entry.endsWith('.log'));
      assert.equal(entries.length, 2);
      const firstContents = await readFile(first.path!, 'utf8');
      const secondContents = await readFile(second.path!, 'utf8');
      assert.ok(firstContents.includes('(first)'));
      assert.ok(!firstContents.includes('(second)'));
      assert.ok(secondContents.includes('(second)'));
      assert.ok(!secondContents.includes('(first)'));
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

  test('logging is disabled gracefully when the git dir cannot be written to', async () => {
    await withGitRepo(async (root) => {
      await chmod(join(root, '.git'), 0o500);
      try {
        const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
        // No path, but calling into every API must still be a safe no-op.
        assert.equal(log.path, null);
        await log.run(async () => {
          startSpan('x').end();
          recordHttpRequest({ host: 'h', method: 'GET', path: '/', startOffsetMs: 0, durationMs: 1, status: 200, cache: 'miss' });
          recordExecCommand({ label: 'git status', durationMs: 1, exitCode: 0 });
        });
        assert.doesNotThrow(() => log.finish('ok'));
      } finally {
        await chmod(join(root, '.git'), 0o700);
      }
    });
  });
});

describe('span correctness', () => {
  test('nested spans record duration, depth, and parent/child order in the timeline', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(() =>
        withSpan('upgrade.scan', undefined, async () => {
          const inner = startSpan('package react');
          inner.end({ package: 'react' });
        }),
      );
      log.finish('ok');

      const contents = await readFile(log.path!, 'utf8');
      const beginOuter = contents.indexOf('BEGIN upgrade.scan');
      const beginInner = contents.indexOf('BEGIN package react');
      const endInner = contents.indexOf('END package react');
      const endOuter = contents.indexOf('END upgrade.scan');
      assert.ok(beginOuter < beginInner);
      assert.ok(beginInner < endInner);
      assert.ok(endInner < endOuter);
      const innerLine = contents.split('\n').find((l) => l.includes('BEGIN package react'))!;
      const outerLine = contents.split('\n').find((l) => l.includes('BEGIN upgrade.scan'))!;
      assert.ok(innerLine.startsWith('  '));
      assert.ok(!outerLine.startsWith(' '));
    });
  });

  test('a failed span records status and duration, and the summary is still produced', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        const span = startSpan('surface.target', { package: 'foo' });
        span.fail(new Error('request timeout'));
      });
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
      await log.run(async () => {
        startSpan('upgrade.scan'); // never ended — simulates a throw mid-scan
      });
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

  test('a run only affects spans started inside run(), not the enclosing scope', async () => {
    await withGitRepo(async (root) => {
      assert.equal(hasActiveRun(), false);
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      assert.equal(hasActiveRun(), false); // starting alone does not enter the context
      await log.run(async () => {
        assert.equal(hasActiveRun(), true);
      });
      assert.equal(hasActiveRun(), false); // context exits when run() returns
      log.finish('ok');
    });
  });
});

describe('concurrency safety', () => {
  test('two concurrently-analysed packages remain siblings, never nested under each other', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(() =>
        withSpan('upgrade.scan', undefined, () =>
          Promise.all([
            withSpan('package', { package: 'react' }, async () => {
              await new Promise((r) => setTimeout(r, 20));
              const inner = startSpan('evidence', { package: 'react' });
              await new Promise((r) => setTimeout(r, 5));
              inner.end();
            }),
            withSpan('package', { package: 'vite' }, async () => {
              const inner = startSpan('evidence', { package: 'vite' });
              await new Promise((r) => setTimeout(r, 5));
              inner.end();
            }),
          ]),
        ),
      );
      log.finish('ok');

      const contents = await readFile(log.path!, 'utf8');
      const lines = contents.split('\n');
      const reactPackageLine = lines.findIndex((l) => l.includes('BEGIN package') && l.includes('react'));
      const vitePackageLine = lines.findIndex((l) => l.includes('BEGIN package') && l.includes('vite'));
      const reactEvidenceLine = lines.findIndex((l) => l.includes('BEGIN evidence') && l.includes('react'));
      const viteEvidenceLine = lines.findIndex((l) => l.includes('BEGIN evidence') && l.includes('vite'));
      // Both package spans are top-level (same indentation), never nested
      // inside each other, regardless of which one's async work finishes first.
      const packageIndent = (i: number) => lines[i]!.match(/^\s*/)![0]!.length;
      assert.equal(packageIndent(reactPackageLine), packageIndent(vitePackageLine));
      // Each package's evidence span is nested inside its own package span,
      // and only its own.
      assert.ok(packageIndent(reactEvidenceLine) > packageIndent(reactPackageLine));
      assert.ok(packageIndent(viteEvidenceLine) > packageIndent(vitePackageLine));
    });
  });

  test('duplicate package spans use wall-clock union instead of summed overlap', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(() =>
        Promise.all([
          withSpan('package', { package: 'dup' }, async () => {
            await new Promise((r) => setTimeout(r, 30));
          }),
          withSpan('package', { package: 'dup' }, async () => {
            await new Promise((r) => setTimeout(r, 30));
          }),
        ]),
      );
      log.finish('ok');

      const contents = await readFile(log.path!, 'utf8');
      const line = contents.split('\n').find((l) => l.trim().startsWith('dup')) ?? '';
      const match = /(\d+\.\d+)s/.exec(line);
      assert.ok(match, line);
      assert.ok(Number(match[1]) < 0.08, line);
      assert.doesNotMatch(contents, /spanning 1\d\d\.\d%/);
    });
  });

  test('overlapping runs keep events isolated when A finishes after B', async () => {
    await withGitRepo(async (root) => {
      const runA = startRunLog({ command: 'drift outdated (A)', mode: 'quick', repoRoot: root });
      const runB = startRunLog({ command: 'drift outdated (B)', mode: 'quick', repoRoot: root });

      // Interleave: both write concurrently into their own ambient context.
      await Promise.all([
        runA.run(async () => {
          const span = startSpan('package', { package: 'from-A' });
          await new Promise((r) => setTimeout(r, 15));
          span.end();
        }),
        runB.run(async () => {
          const span = startSpan('package', { package: 'from-B' });
          await new Promise((r) => setTimeout(r, 5));
          span.end();
        }),
      ]);

      // B finishes first, then A. Each report must remain isolated.
      runB.finish('ok');
      runA.finish('ok');

      const contents = await readFile(runB.path!, 'utf8');
      assert.ok(contents.includes('(B)'));
      assert.ok(!contents.includes('(A)'));
      assert.ok(!contents.includes('from-A'));
      assert.ok(contents.includes('from-B'));
    });
  });

  test('sequential overlapping runs keep their reports isolated', async () => {
    await withGitRepo(async (root) => {
      const runA = startRunLog({ command: 'drift outdated (older)', mode: 'quick', repoRoot: root });
      const runB = startRunLog({ command: 'drift outdated (newer)', mode: 'quick', repoRoot: root });
      runB.finish('ok');
      runA.finish('ok');

      const contents = await readFile(runB.path!, 'utf8');
      assert.ok(contents.includes('(newer)'));
      assert.ok(!contents.includes('(older)'));
    });
  });

  test('cross-process runs preserve both reports when newer finishes first', async () => {
    await withGitRepo(async (root) => {
      const dir = await mkdtemp(join(tmpdir(), 'drift-diag-race-'));
      try {
        const aStarted = join(dir, 'a.started');
        const bStarted = join(dir, 'b.started');
        const aFinish = join(dir, 'a.finish');
        const bFinish = join(dir, 'b.finish');
        const script = childRunScript();
        const procA = run(process.execPath, ['--input-type=module', '-e', script, root, 'A', aStarted, aFinish]);
        await waitForFile(aStarted);
        const procB = run(process.execPath, ['--input-type=module', '-e', script, root, 'B', bStarted, bFinish]);
        await waitForFile(bStarted);

        await writeFile(bFinish, 'finish');
        await procB;
        await writeFile(aFinish, 'finish');
        await procA;

        const logs = (await readdir(join(root, '.git', 'drift'))).filter((entry) => entry.endsWith('.log'));
        assert.equal(logs.length, 2);
        const contents = await Promise.all(logs.map((entry) => readFile(join(root, '.git', 'drift', entry), 'utf8')));
        assert.ok(contents.some((text) => text.includes('(A)') && text.includes('from-A')));
        assert.ok(contents.some((text) => text.includes('(B)') && text.includes('from-B')));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  test('cross-process runs preserve both reports when older finishes first too', async () => {
    await withGitRepo(async (root) => {
      const dir = await mkdtemp(join(tmpdir(), 'drift-diag-race-'));
      try {
        const aStarted = join(dir, 'a.started');
        const bStarted = join(dir, 'b.started');
        const aFinish = join(dir, 'a.finish');
        const bFinish = join(dir, 'b.finish');
        const script = childRunScript();
        const procA = run(process.execPath, ['--input-type=module', '-e', script, root, 'A', aStarted, aFinish]);
        await waitForFile(aStarted);
        const procB = run(process.execPath, ['--input-type=module', '-e', script, root, 'B', bStarted, bFinish]);
        await waitForFile(bStarted);

        await writeFile(aFinish, 'finish');
        await procA;
        await writeFile(bFinish, 'finish');
        await procB;

        const logs = (await readdir(join(root, '.git', 'drift'))).filter((entry) => entry.endsWith('.log'));
        assert.equal(logs.length, 2);
        const contents = await Promise.all(logs.map((entry) => readFile(join(root, '.git', 'drift', entry), 'utf8')));
        assert.ok(contents.some((text) => text.includes('(A)') && text.includes('from-A')));
        assert.ok(contents.some((text) => text.includes('(B)') && text.includes('from-B')));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('HTTP and exec aggregation', () => {
  test('fetchJson network request is one logical request', async () => {
    const realFetch = globalThis.fetch;
    const cacheDir = await mkdtemp(join(tmpdir(), 'drift-diag-json-'));
    configureHttpDiskCache(cacheDir);
    clearHttpCache();
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }) as typeof fetch;
    try {
      await withGitRepo(async (root) => {
        const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
        await log.run(() => fetchJson('https://example.com/data.json'));
        log.finish('ok');
        const contents = await readFile(log.path!, 'utf8');
        assert.match(contents, /logical_requests: 1/);
        assert.match(contents, /network_attempts: 1/);
        assert.match(contents, /network_required_requests: 1/);
        assert.match(contents, /example\.com\s+requests=1/);
      });
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = realFetch;
      clearHttpCache();
      configureHttpDiskCache(null);
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test('fetchJson retries remain one logical request', async () => {
    const realFetch = globalThis.fetch;
    const cacheDir = await mkdtemp(join(tmpdir(), 'drift-diag-json-retry-'));
    configureHttpDiskCache(cacheDir);
    clearHttpCache();
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(calls < 3 ? new Response('retry', { status: 503 }) : new Response('{"ok":true}', { status: 200 }));
    }) as typeof fetch;
    try {
      await withGitRepo(async (root) => {
        const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
        await log.run(() => fetchJson('https://example.com/retry.json', { retries: 2 }));
        log.finish('ok');
        const contents = await readFile(log.path!, 'utf8');
        assert.match(contents, /logical_requests: 1/);
        assert.match(contents, /network_attempts: 3/);
        assert.match(contents, /retries: 2/);
      });
      assert.equal(calls, 3);
    } finally {
      globalThis.fetch = realFetch;
      clearHttpCache();
      configureHttpDiskCache(null);
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test('concurrent fetchJson calls coalesce without losing the second logical caller', async () => {
    const realFetch = globalThis.fetch;
    const cacheDir = await mkdtemp(join(tmpdir(), 'drift-diag-json-coalesce-'));
    configureHttpDiskCache(cacheDir);
    clearHttpCache();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    try {
      await withGitRepo(async (root) => {
        const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
        await log.run(() => Promise.all([fetchJson('https://example.com/coalesce.json'), fetchJson('https://example.com/coalesce.json')]));
        log.finish('ok');
        const contents = await readFile(log.path!, 'utf8');
        assert.match(contents, /logical_requests: 2/);
        assert.match(contents, /network_attempts: 1/);
        assert.match(contents, /coalesced_hits=1/);
      });
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = realFetch;
      clearHttpCache();
      configureHttpDiskCache(null);
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test('fetchJson disk cache hit is a logical request without a second network attempt', async () => {
    const realFetch = globalThis.fetch;
    const cacheDir = await mkdtemp(join(tmpdir(), 'drift-diag-json-disk-'));
    configureHttpDiskCache(cacheDir);
    clearHttpCache();
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }) as typeof fetch;
    try {
      await withGitRepo(async (root) => {
        const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
        await log.run(async () => {
          await fetchJson('https://example.com/disk.json');
          clearHttpCache();
          await fetchJson('https://example.com/disk.json');
        });
        log.finish('ok');
        const contents = await readFile(log.path!, 'utf8');
        assert.match(contents, /logical_requests: 2/);
        assert.match(contents, /network_attempts: 1/);
        assert.match(contents, /disk_hits=1/);
      });
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = realFetch;
      clearHttpCache();
      configureHttpDiskCache(null);
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test('cache-only logical requests do not become fake network attempts', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        recordHttpRequest({ host: 'example.com', method: 'GET', path: '/a', startOffsetMs: 0, durationMs: 1, status: null, cache: 'memory_hit' });
        recordHttpRequest({ host: 'example.com', method: 'GET', path: '/b', startOffsetMs: 1, durationMs: 1, status: null, cache: 'disk_hit' });
        recordHttpRequest({ host: 'example.com', method: 'GET', path: '/c', startOffsetMs: 2, durationMs: 1, status: null, cache: 'coalesced_hit' });
      });
      log.finish('ok');

      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /logical_requests: 3/);
      assert.match(contents, /network_attempts: 0/);
      assert.match(contents, /max_concurrent_attempts: 0/);
      assert.ok(!contents.includes('LOW_OBSERVED_CONCURRENCY'));
      assert.ok(!contents.includes('HTTP network attempts'));
    });
  });

  test('network summary aggregates by host and reports revalidation/network-required requests, without leaking a token', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        recordHttpRequest({ host: 'registry.npmjs.org', method: 'GET', path: '/react', startOffsetMs: 0, durationMs: 120, status: 200, cache: 'miss' });
        recordHttpRequest({ host: 'registry.npmjs.org', method: 'GET', path: '/vue', startOffsetMs: 10, durationMs: 400, status: 304, cache: 'revalidated_304' });
        recordHttpRequest({ host: 'cdn.jsdelivr.net', method: 'GET', path: '/npm/react/index.d.ts', startOffsetMs: 20, durationMs: 900, status: 200, cache: 'miss' });
      });
      log.finish('ok');

      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /logical_requests: 3/);
      assert.match(contents, /registry\.npmjs\.org\s+requests=2/);
      assert.match(contents, /cdn\.jsdelivr\.net\s+requests=1/);
      assert.match(contents, /revalidated_304: 1/);
      assert.match(contents, /network_required_requests: 3/);
      assert.ok(!contents.toLowerCase().includes('authorization'));
      assert.ok(!contents.toLowerCase().includes('bearer'));
    });
  });

  test('20 serial attempts measure max_concurrent_attempts as 1', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        let offset = 0;
        for (let i = 0; i < 20; i++) {
          recordHttpRequest({ host: 'h', method: 'GET', path: `/${i}`, startOffsetMs: offset, durationMs: 10, status: 200, cache: 'miss' });
          recordHttpAttempt({ host: 'h', method: 'GET', path: `/${i}`, startOffsetMs: offset, durationMs: 10, status: 200 });
          offset += 10; // each request starts exactly when the previous ends
        }
      });
      log.finish('ok');
      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /max_concurrent_attempts: 1/);
    });
  });

  test('two overlapping attempts measure max_concurrent_attempts as 2', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        recordHttpRequest({ host: 'h', method: 'GET', path: '/a', startOffsetMs: 0, durationMs: 100, status: 200, cache: 'miss' });
        recordHttpAttempt({ host: 'h', method: 'GET', path: '/a', startOffsetMs: 0, durationMs: 100, status: 200 });
        recordHttpRequest({ host: 'h', method: 'GET', path: '/b', startOffsetMs: 50, durationMs: 100, status: 200, cache: 'miss' });
        recordHttpAttempt({ host: 'h', method: 'GET', path: '/b', startOffsetMs: 50, durationMs: 100, status: 200 });
      });
      log.finish('ok');
      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /max_concurrent_attempts: 2/);
    });
  });

  test('backoff between attempts does not inflate observed HTTP concurrency', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        recordHttpRequest({ host: 'h', method: 'GET', path: '/a', startOffsetMs: 0, durationMs: 5200, status: 200, cache: 'miss', retries: 1, backoffMs: 5000 });
        recordHttpAttempt({ host: 'h', method: 'GET', path: '/a', startOffsetMs: 0, durationMs: 100, status: 503 });
        recordHttpAttempt({ host: 'h', method: 'GET', path: '/b', startOffsetMs: 1000, durationMs: 100, status: 200 });
        recordHttpRequest({ host: 'h', method: 'GET', path: '/b', startOffsetMs: 1000, durationMs: 100, status: 200, cache: 'miss' });
        recordHttpAttempt({ host: 'h', method: 'GET', path: '/a', startOffsetMs: 5100, durationMs: 100, status: 200 });
      });
      log.finish('ok');
      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /logical_requests: 2/);
      assert.match(contents, /network_attempts: 3/);
      assert.match(contents, /max_concurrent_attempts: 1/);
      assert.match(contents, /retry_backoff_time: 5\.00s/);
    });
  });

  test('configured concurrency env vars never substitute for measured concurrency', async () => {
    const previous = process.env.DRIFT_NETWORK_CONCURRENCY;
    process.env.DRIFT_NETWORK_CONCURRENCY = '16';
    try {
      await withGitRepo(async (root) => {
        const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
        await log.run(async () => {
          recordHttpRequest({ host: 'h', method: 'GET', path: '/a', startOffsetMs: 0, durationMs: 10, status: 200, cache: 'miss' });
          recordHttpAttempt({ host: 'h', method: 'GET', path: '/a', startOffsetMs: 0, durationMs: 10, status: 200 });
        });
        log.finish('ok');
        const contents = await readFile(log.path!, 'utf8');
        assert.match(contents, /max_concurrent_attempts: 1/);
        assert.ok(!contents.includes('max_concurrent_attempts: 16'));
      });
    } finally {
      if (previous === undefined) delete process.env.DRIFT_NETWORK_CONCURRENCY;
      else process.env.DRIFT_NETWORK_CONCURRENCY = previous;
    }
  });

  test('retries are counted once per logical request, not once per attempt', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        // A request that took 3 attempts (2 retries), recorded once — the
        // way http.ts now records it, instead of once per attempt.
        recordHttpRequest({ host: 'h', method: 'GET', path: '/flaky', startOffsetMs: 0, durationMs: 300, status: 200, cache: 'miss', retries: 2, backoffMs: 150 });
      });
      log.finish('ok');
      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /logical_requests: 1/);
      assert.match(contents, /retries: 2/);
      assert.match(contents, /retry_backoff_time: 0\.15s/);
    });
  });

  test('an end-to-end request with 3 attempts records 2 retries, once, not once per attempt', async () => {
    const realFetch = globalThis.fetch;
    const cacheDir = await mkdtemp(join(tmpdir(), 'drift-diag-http-'));
    configureHttpDiskCache(cacheDir);
    clearHttpCache();
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      if (calls < 3) return Promise.resolve(new Response('server error', { status: 503 }));
      return Promise.resolve(new Response('# ok', { status: 200 }));
    }) as typeof fetch;
    try {
      await withGitRepo(async (root) => {
        const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
        await log.run(() => fetchText('https://example.com/flaky.md', { retries: 2 }));
        log.finish('ok');
        const contents = await readFile(log.path!, 'utf8');
        assert.match(contents, /logical_requests: 1/);
        assert.match(contents, /network_attempts: 3/);
        assert.match(contents, /retries: 2/);
      });
      assert.equal(calls, 3);
    } finally {
      globalThis.fetch = realFetch;
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test('exec aggregation reports sanitized labels and timing', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        recordExecCommand({ label: 'git ls-files', durationMs: 810, exitCode: 0 });
        recordExecCommand({ label: 'npm view react', durationMs: 720, exitCode: 0 });
      });
      log.finish('ok');

      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /external processes:/);
      assert.match(contents, /count: 2/);
      assert.match(contents, /git ls-files/);
      assert.match(contents, /npm view react/);
    });
  });

  test('repeated subprocess invocations are aggregated as a signal', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        for (let i = 0; i < 4; i++) recordExecCommand({ label: 'git status', durationMs: 50, exitCode: 0 });
      });
      log.finish('ok');
      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /repeated commands:/);
      assert.match(contents, /git status\s+4x/);
    });
  });

  test('cache diagnostics report hits and misses per named cache', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        noteCache('type-surface', true);
        noteCache('type-surface', false);
        noteCache('type-surface', false);
      });
      log.finish('ok');

      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /type-surface: .*misses=2/);
    });
  });

  test('HTTP cache diagnostics distinguish memory, disk, coalesced, stale, 304, misses, and writes', async () => {
    const realFetch = globalThis.fetch;
    const cacheDir = await mkdtemp(join(tmpdir(), 'drift-diag-cache-'));
    configureHttpDiskCache(cacheDir);
    clearHttpCache();
    let calls = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls += 1;
      if (url.endsWith('/coalesced')) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return new Response('coalesced', { status: 200, headers: { etag: '"coalesced"' } });
      }
      if (url.endsWith('/revalidate') && init?.headers && new Headers(init.headers).has('if-none-match')) {
        return new Response(null, { status: 304 });
      }
      return new Response(`body-${calls}`, { status: 200, headers: { etag: `"${calls}"` } });
    }) as typeof fetch;
    try {
      await withGitRepo(async (root) => {
        const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
        await log.run(async () => {
          await fetchText('https://example.com/memory');
          await fetchText('https://example.com/memory');

          clearHttpCache();
          await fetchText('https://example.com/memory');

          clearHttpCache();
          await Promise.all([fetchText('https://example.com/coalesced'), fetchText('https://example.com/coalesced')]);

          await fetchText('https://example.com/stale', { cacheTtlMs: 1 });
          clearHttpCache();
          await new Promise((resolve) => setTimeout(resolve, 5));
          await fetchText('https://example.com/stale', { cacheTtlMs: 1 });

          await fetchText('https://example.com/revalidate');
          clearHttpCache();
          await fetchText('https://example.com/revalidate', { cacheTtlMs: 1 });
        });
        log.finish('ok');
        const contents = await readFile(log.path!, 'utf8');
        assert.match(contents, /http: .*memory_hits=1/);
        assert.match(contents, /http: .*disk_hits=1/);
        assert.match(contents, /http: .*coalesced_hits=1/);
        assert.match(contents, /http: .*revalidated_304=1/);
        assert.match(contents, /http: .*misses=6/);
        assert.match(contents, /http: .*writes=6/);
      });
    } finally {
      globalThis.fetch = realFetch;
      clearHttpCache();
      configureHttpDiskCache(null);
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test('many memory hits produce a healthy HTTP network avoidance rate', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        for (let i = 0; i < 80; i++) noteCache('http', 'memory_hit');
        for (let i = 0; i < 20; i++) noteCache('http', 'miss');
      });
      log.finish('ok');
      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /http: .*memory_hits=80/);
      assert.match(contents, /http: .*misses=20/);
      assert.match(contents, /avoidance_rate=80\.0%/);
      assert.ok(!contents.includes('LOW_CACHE_HIT_RATE'));
    });
  });

  test('module-level record functions are safe no-ops with no active run', () => {
    assert.equal(hasActiveRun(), false);
    assert.doesNotThrow(() => {
      recordHttpRequest({ host: 'x', method: 'GET', path: '/', startOffsetMs: 0, durationMs: 1, status: 200, cache: 'miss' });
      recordExecCommand({ label: 'git status', durationMs: 1, exitCode: 0 });
      noteCache('http', true);
      startSpan('x').end();
      assert.equal(runElapsedMs(), 0);
    });
  });
});

describe('diagnostic flags are evidence-based', () => {
  test('does not claim serial waiting from cumulative-vs-wall-clock time alone', async () => {
    // Ten fully-overlapped 100ms requests: cumulative time (1000ms) vastly
    // exceeds wall-clock, but they are NOT serial — concurrency was high.
    // The old HIGH_NETWORK_WAIT heuristic would have flagged this; it must not.
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        for (let i = 0; i < 10; i++) {
          recordHttpRequest({ host: 'h', method: 'GET', path: `/${i}`, startOffsetMs: 0, durationMs: 100, status: 200, cache: 'miss' });
          recordHttpAttempt({ host: 'h', method: 'GET', path: `/${i}`, startOffsetMs: 0, durationMs: 100, status: 200 });
        }
      });
      log.finish('ok');
      const contents = await readFile(log.path!, 'utf8');
      assert.ok(!contents.includes('HIGH_NETWORK_WAIT'));
      assert.match(contents, /max_concurrent_attempts: 10/);
    });
  });

  test('flags low observed concurrency only with real evidence of many serial requests', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        let offset = 0;
        for (let i = 0; i < 12; i++) {
          recordHttpRequest({ host: 'h', method: 'GET', path: `/${i}`, startOffsetMs: offset, durationMs: 10, status: 200, cache: 'miss' });
          recordHttpAttempt({ host: 'h', method: 'GET', path: `/${i}`, startOffsetMs: offset, durationMs: 10, status: 200 });
          offset += 10;
        }
      });
      log.finish('ok');
      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /LOW_OBSERVED_CONCURRENCY: 12 HTTP network attempts were made but the maximum observed attempt concurrency was 1/);
    });
  });

  test('flags a single very slow request by evidence, not inference', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        recordHttpRequest({ host: 'slow.example', method: 'GET', path: '/big', startOffsetMs: 0, durationMs: 5000, status: 200, cache: 'miss' });
        recordHttpAttempt({ host: 'slow.example', method: 'GET', path: '/big', startOffsetMs: 0, durationMs: 5000, status: 200 });
      });
      log.finish('ok');
      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /SLOW_HTTP_REQUEST: GET slow\.example\/big took 5\.00s/);
    });
  });

  test('flags repeated network fetches of the same resource', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        for (let i = 0; i < 3; i++) {
          recordHttpRequest({ host: 'h', method: 'GET', path: '/same', startOffsetMs: i * 10, durationMs: 5, status: 200, cache: 'miss' });
          recordHttpAttempt({ host: 'h', method: 'GET', path: '/same', startOffsetMs: i * 10, durationMs: 5, status: 200 });
        }
      });
      log.finish('ok');
      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /REPEATED_NETWORK_FETCH: h\/same was fetched from the network 3 times/);
    });
  });
});

describe('overhead', () => {
  test('10,000 span start/end pairs complete well under 200ms', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      const elapsed = await log.run(async () => {
        const started = Date.now();
        for (let i = 0; i < 10_000; i++) {
          const span = startSpan('package', { package: `pkg-${i}` });
          span.end({ files: i });
        }
        return Date.now() - started;
      });
      log.finish('ok');
      assert.ok(elapsed < 200, `expected under 200ms, took ${elapsed}ms`);
    });
  });
});
