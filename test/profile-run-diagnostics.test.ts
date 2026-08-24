import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRunLog, withSpan } from '../dist/util/diagnostics.js';
import { measure, span } from '../dist/util/profile.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('always-on run diagnostics mirror profiler spans and capture event-loop stalls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-profile-diagnostics-'));
  try {
    const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
    await log.run(() =>
      withSpan('dependency.scan', { trigger: 'test' }, async () => {
        const scan = span('scan', 'total');
        try {
          await measure('module-maps', 'pypi', async () => {
            // Block for longer than the 100ms sampler period, then yield so its
            // delayed callback can record how late the event loop became.
            const until = performance.now() + 180;
            while (performance.now() < until) {
              // intentional test-only event-loop starvation
            }
            await sleep(20);
          });
        } finally {
          scan.end();
        }
      }),
    );
    log.finish('ok');

    const report = await readFile(log.path!, 'utf8');
    assert.match(report, /BEGIN work\.scan operation=total/);
    assert.match(report, /BEGIN work\.module-maps operation=pypi/);
    assert.match(report, /BEGIN event-loop\.lag lagMs=/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
