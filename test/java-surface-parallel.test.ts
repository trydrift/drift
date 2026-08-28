import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { javaSurface } from '../dist/evidence/surface/java.js';
import {
  setHelperArtifactOverride,
  clearHelperArtifactOverrides,
} from '../dist/evidence/surface/helper-artifact.js';
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
  // The japicmp fat JAR provisioning is exercised in its own unit test; here
  // it is short-circuited to a dummy path so the two Maven jar downloads are
  // the only fetches in flight.
  setHelperArtifactOverride('japicmp', join(cacheDir, 'japicmp.jar'));
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  clearHttpCache();
  clearHelperArtifactOverrides();
  configureHttpDiskCache(null);
  await rm(cacheDir, { recursive: true, force: true });
});

const exec: SurfaceRequest['exec'] = async (command, args) => {
  if (command === 'java' && args[0] === '-version') return { code: 0, stdout: '', stderr: 'openjdk 21' };
  if (command === 'java' && args[0] === '-jar') {
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

  test('returns a quick before failure without waiting for after', async () => {
    let startedBefore = false;
    let startedAfter = false;
    let releaseAfter!: () => void;
    const afterHeld = new Promise<void>((resolve) => { releaseAfter = resolve; });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('1.0.0')) {
        startedBefore = true;
        return new Response('missing', { status: 404 });
      }
      startedAfter = true;
      await afterHeld;
      return new Response(Buffer.from('PK\\x03\\x04fake-jar-bytes'), { status: 200 });
    }) as typeof fetch;

    const workdir = await mkdtemp(join(tmpdir(), 'drift-java-fail-fast-'));
    const result = javaSurface.compute({
      name: 'com.example:failfast', from: '1.0.0', to: '2.0.0', exec, workdir,
      logger: createLogger('error'), timeoutMs: 20_000,
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 500;
      const check = () => startedAfter ? resolve() : Date.now() >= deadline ? reject(new Error('after request did not start')) : setTimeout(check, 1);
      check();
    });
    const outcome = await Promise.race([
      result,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('waited for after')), 500)),
    ]);
    assert.equal(startedBefore, true);
    assert.equal(startedAfter, true);
    assert.equal(outcome.available, false);
    assert.equal(outcome.reason, 'version-unavailable');
    releaseAfter();
    await result;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await rm(workdir, { recursive: true, force: true });
  });
});
