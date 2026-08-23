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
import { clearHttpCache, configureHttpDiskCache, fetchText } from '../dist/util/http.js';

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

  test('overlapping runs cannot mix events: A starts, B starts, A finishes after B, run.log is only B', async () => {
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

      // B finishes first, A finishes after — A must not be allowed to
      // overwrite B's report since B is the newer run.
      runB.finish('ok');
      runA.finish('ok');

      const contents = await readFile(runB.path!, 'utf8');
      assert.ok(contents.includes('(B)'));
      assert.ok(!contents.includes('(A)'));
      assert.ok(!contents.includes('from-A'));
      assert.ok(contents.includes('from-B'));
    });
  });

  test('an older run finishing after a newer one never overwrites run.log, even sequentially', async () => {
    await withGitRepo(async (root) => {
      const runA = startRunLog({ command: 'drift outdated (older)', mode: 'quick', repoRoot: root });
      const runB = startRunLog({ command: 'drift outdated (newer)', mode: 'quick', repoRoot: root });
      runB.finish('ok');
      runA.finish('ok'); // stale — must be dropped

      const contents = await readFile(runB.path!, 'utf8');
      assert.ok(contents.includes('(newer)'));
      assert.ok(!contents.includes('(older)'));
    });
  });
});

describe('HTTP and exec aggregation', () => {
  test('network summary aggregates by host and reports revalidated/fetched, without leaking a token', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        recordHttpRequest({ host: 'registry.npmjs.org', method: 'GET', path: '/react', startOffsetMs: 0, durationMs: 120, status: 200, cache: 'miss' });
        recordHttpRequest({ host: 'registry.npmjs.org', method: 'GET', path: '/vue', startOffsetMs: 10, durationMs: 400, status: 304, cache: 'hit' });
        recordHttpRequest({ host: 'cdn.jsdelivr.net', method: 'GET', path: '/npm/react/index.d.ts', startOffsetMs: 20, durationMs: 900, status: 200, cache: 'miss' });
      });
      log.finish('ok');

      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /requests: 3/);
      assert.match(contents, /registry\.npmjs\.org\s+requests=2/);
      assert.match(contents, /cdn\.jsdelivr\.net\s+requests=1/);
      assert.match(contents, /revalidated_304: 1/);
      assert.match(contents, /fetched: 2/);
      assert.ok(!contents.toLowerCase().includes('authorization'));
      assert.ok(!contents.toLowerCase().includes('bearer'));
    });
  });

  test('serial (non-overlapping) requests measure max_concurrent as 1', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        let offset = 0;
        for (let i = 0; i < 20; i++) {
          recordHttpRequest({ host: 'h', method: 'GET', path: `/${i}`, startOffsetMs: offset, durationMs: 10, status: 200, cache: 'miss' });
          offset += 10; // each request starts exactly when the previous ends
        }
      });
      log.finish('ok');
      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /max_concurrent: 1/);
    });
  });

  test('two overlapping requests measure max_concurrent as 2', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        recordHttpRequest({ host: 'h', method: 'GET', path: '/a', startOffsetMs: 0, durationMs: 100, status: 200, cache: 'miss' });
        recordHttpRequest({ host: 'h', method: 'GET', path: '/b', startOffsetMs: 50, durationMs: 100, status: 200, cache: 'miss' });
      });
      log.finish('ok');
      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /max_concurrent: 2/);
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
        });
        log.finish('ok');
        const contents = await readFile(log.path!, 'utf8');
        assert.match(contents, /max_concurrent: 1/);
        assert.ok(!contents.includes('max_concurrent: 16'));
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
      assert.match(contents, /requests: 1/);
      assert.match(contents, /retries: 2/);
      assert.match(contents, /backoff_time: 0\.15s/);
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
        assert.match(contents, /requests: 1/);
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
      assert.match(contents, /type-surface: 1 hits \/ 2 misses/);
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
        }
      });
      log.finish('ok');
      const contents = await readFile(log.path!, 'utf8');
      assert.ok(!contents.includes('HIGH_NETWORK_WAIT'));
      assert.match(contents, /max_concurrent: 10/);
    });
  });

  test('flags low observed concurrency only with real evidence of many serial requests', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        let offset = 0;
        for (let i = 0; i < 12; i++) {
          recordHttpRequest({ host: 'h', method: 'GET', path: `/${i}`, startOffsetMs: offset, durationMs: 10, status: 200, cache: 'miss' });
          offset += 10;
        }
      });
      log.finish('ok');
      const contents = await readFile(log.path!, 'utf8');
      assert.match(contents, /LOW_OBSERVED_CONCURRENCY: 12 HTTP requests were made but the maximum observed concurrency was 1/);
    });
  });

  test('flags a single very slow request by evidence, not inference', async () => {
    await withGitRepo(async (root) => {
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        recordHttpRequest({ host: 'slow.example', method: 'GET', path: '/big', startOffsetMs: 0, durationMs: 5000, status: 200, cache: 'miss' });
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
