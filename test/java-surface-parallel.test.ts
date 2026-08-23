import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { javaSurface } from '../dist/evidence/surface/java.js';
import { clearHttpCache, configureHttpDiskCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';
import type { SurfaceRequest } from '../dist/evidence/surface/types.js';

/**
 * The "before" and "after" jar downloads are independent Maven Central
 * fetches; there is no reason `downloadJar(from)` should block
 * `downloadJar(to)` from starting. This proves it with a barrier on the
 * jar fetch itself -- both requests must be in flight simultaneously before
 * either is allowed to resolve, which a serial implementation cannot satisfy.
 */

const realFetch = globalThis.fetch;
let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'drift-java-parallel-'));
  configureHttpDiskCache(cacheDir);
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  clearHttpCache();
  configureHttpDiskCache(null);
  await rm(cacheDir, { recursive: true, force: true });
});

const exec: SurfaceRequest['exec'] = async (command, args) => {
  if (command === 'japicmp' && args[0] === '--help') return { code: 0, stdout: '', stderr: '' };
  if (command === 'japicmp') {
    return { code: 0, stdout: '***! MODIFIED CLASS: PUBLIC com.example.Client\n', stderr: '' };
  }
  return { code: 1, stdout: '', stderr: 'unexpected command' };
};

describe('Maven before/after jar preparation', () => {
  test('downloads the "before" and "after" jars concurrently, not serially', async () => {
    const inFlight = new Set<string>();
    let bothSeenInFlightTogether = false;
    let releaseBefore: (() => void) | undefined;
    let releaseAfter: (() => void) | undefined;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.startsWith('https://repo1.maven.org/')) return new Response('not found', { status: 404 });

      inFlight.add(url);
      if (inFlight.size >= 2) bothSeenInFlightTogether = true;

      await new Promise<void>((resolve) => {
        if (url.includes('1.0.0')) releaseBefore = resolve;
        else releaseAfter = resolve;
        // Release both once both are known to be in flight, proving neither
        // waited for the other to be issued.
        if (releaseBefore && releaseAfter) {
          releaseBefore();
          releaseAfter();
        }
      });

      inFlight.delete(url);
      const bytes = Buffer.from('PK\x03\x04fake-jar-bytes');
      return new Response(bytes, { status: 200 });
    }) as typeof fetch;

    const workdir = await mkdtemp(join(tmpdir(), 'drift-java-work-'));
    const outcome = await javaSurface.compute({
      name: 'com.example:demo',
      from: '1.0.0',
      to: '2.0.0',
      exec,
      workdir,
      logger: createLogger('error'),
      timeoutMs: 20_000,
    });
    await rm(workdir, { recursive: true, force: true });

    assert.equal(bothSeenInFlightTogether, true, 'both jar downloads must be in flight at the same time');
    // The outcome may report failure (a fake jar isn't a real one japicmp
    // would open successfully) or the stubbed japicmp success above -- this
    // test's only concern is the concurrency of the two downloads.
    assert.ok(outcome.available === true || outcome.available === false);
  });
});
