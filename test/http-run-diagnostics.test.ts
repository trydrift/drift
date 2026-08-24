import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRunLog, withSpan } from '../dist/util/diagnostics.js';
import { clearHttpCache, configureHttpDiskCache, fetchJson } from '../dist/util/http.js';
import { span } from '../dist/util/profile.js';

const realFetch = globalThis.fetch;

test('run log correlates coalesced JSON waits with one timed physical request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-http-diagnostics-'));
  clearHttpCache();
  configureHttpDiskCache(null);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let physicalFetches = 0;
  globalThis.fetch = (async () => {
    physicalFetches += 1;
    await gate;
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
    await log.run(() =>
      withSpan('dependency.scan', { trigger: 'test' }, async () => {
        const scan = span('scan', 'total');
        try {
          const first = fetchJson<{ ok: boolean }>('https://registry.example.test/pkg', {
            timeoutMs: 5_000,
            retries: 0,
          });
          const second = fetchJson<{ ok: boolean }>('https://registry.example.test/pkg', {
            timeoutMs: 5_000,
            retries: 0,
          });
          await new Promise((resolve) => setImmediate(resolve));
          release();
          assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
        } finally {
          scan.end();
        }
      }),
    );
    log.finish('ok');

    assert.equal(physicalFetches, 1);
    const report = await readFile(log.path!, 'utf8');
    assert.match(report, /BEGIN work\.http-coalesced-json .*requestKey=[0-9a-f]{10}/);
    // Span metadata discovered at settlement is merged into the span before the
    // report is rendered, so it appears on the BEGIN record with the rest of
    // that span's metadata; END intentionally stays a compact duration line.
    assert.match(
      report,
      /BEGIN work\.http .*requestKey=[0-9a-f]{10} .*timeoutMs=5000 .*abortTimerFired=false .*headersMs=/,
    );
    assert.match(report, /END work\.http duration=\d+ms/);
    assert.match(report, /BEGIN work\.json-parse .*requestKey=[0-9a-f]{10}/);
  } finally {
    globalThis.fetch = realFetch;
    clearHttpCache();
    configureHttpDiskCache(null);
    await rm(root, { recursive: true, force: true });
  }
});
