import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureHelperArtifact,
  clearHelperArtifactOverrides,
} from '../dist/evidence/surface/helper-artifact.js';
import { javaSurface } from '../dist/evidence/surface/java.js';
import { clearHttpCache, configureHttpDiskCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';

/**
 * japicmp is provisioned by Drift, not by Homebrew: one pinned version,
 * downloaded from Maven Central, SHA-256-verified before `java -jar` ever runs
 * it, kept in a Drift-owned cache, acquired single-flight. Java itself stays an
 * external prerequisite Drift never installs.
 */

const realFetch = globalThis.fetch;
let cacheDir: string;

const JAR_BYTES = Buffer.from('PK pretend this is a fat jar');
const JAR_SHA = createHash('sha256').update(JAR_BYTES).digest('hex');

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'drift-japicmp-'));
  configureHttpDiskCache(cacheDir);
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  clearHttpCache();
  clearHelperArtifactOverrides();
  configureHttpDiskCache(null);
  await rm(cacheDir, { recursive: true, force: true });
});

describe('Drift-managed helper artifact', () => {
  test('downloads once, verifies the checksum, and serves the cache thereafter', async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(JAR_BYTES, { status: 200 });
    }) as typeof fetch;

    const spec = {
      id: 'demo-helper',
      version: '1.2.3',
      url: 'https://repo1.maven.org/maven2/demo/helper.jar',
      sha256: JAR_SHA,
    };

    const [a, b] = await Promise.all([ensureHelperArtifact(spec), ensureHelperArtifact(spec)]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(fetches, 1, 'concurrent callers share one download (single-flight)');
    if (a.ok) assert.deepEqual(await readFile(a.path), JAR_BYTES);

    const third = await ensureHelperArtifact(spec);
    assert.equal(third.ok, true);
    assert.equal(fetches, 1, 'a cached, checksum-matching artifact is reused without re-downloading');
  });

  test('a checksum mismatch is refused before use', async () => {
    globalThis.fetch = (async () => new Response(JAR_BYTES, { status: 200 })) as typeof fetch;

    const result = await ensureHelperArtifact({
      id: 'demo-helper',
      version: '9.9.9',
      url: 'https://repo1.maven.org/maven2/demo/helper.jar',
      sha256: 'deadbeef'.repeat(8),
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, 'checksum-failed');
  });

  test('a cache directory that cannot be created is cache-failed, not a throw', async () => {
    globalThis.fetch = (async () => new Response(JAR_BYTES, { status: 200 })) as typeof fetch;
    // Occupy the `helpers/` cache path with a file so `mkdir` cannot create it.
    await writeFile(join(cacheDir, 'helpers'), 'in the way');

    const result = await ensureHelperArtifact({
      id: 'demo-helper',
      version: '1.2.3',
      url: 'https://repo1.maven.org/maven2/demo/helper.jar',
      sha256: JAR_SHA,
    });

    assert.equal(result.ok, false, 'a filesystem cache failure does not reject the promise');
    if (!result.ok) assert.equal(result.error.kind, 'cache-failed');
  });

  test('a publication rename failure is cache-failed and cleans up its temp file', async () => {
    globalThis.fetch = (async () => new Response(JAR_BYTES, { status: 200 })) as typeof fetch;
    // Occupy the destination path with a non-empty directory so `rename` fails
    // after the temp file is already written.
    const helpers = join(cacheDir, 'helpers');
    await mkdir(join(helpers, 'demo-helper-7.7.7.jar', 'child'), { recursive: true });

    const result = await ensureHelperArtifact({
      id: 'demo-helper',
      version: '7.7.7',
      url: 'https://repo1.maven.org/maven2/demo/helper.jar',
      sha256: JAR_SHA,
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, 'cache-failed');
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(helpers);
    assert.ok(
      !entries.some((name) => name.endsWith('.tmp')),
      'the temp file is cleaned up best-effort after a failed publish',
    );
  });

  test('a failed download is reported as download-failed', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;

    const result = await ensureHelperArtifact({
      id: 'demo-helper',
      version: '4.5.6',
      url: 'https://repo1.maven.org/maven2/demo/missing.jar',
      sha256: JAR_SHA,
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, 'download-failed');
  });
});

describe('javaSurface error separation', () => {
  const baseRequest = {
    name: 'com.example:demo',
    from: '1.0.0',
    to: '2.0.0',
    workdir: '',
    logger: createLogger('error'),
    timeoutMs: 20_000,
  };

  test('Java missing is tool-missing, with a prose remedy and no auto-install offer', async () => {
    globalThis.fetch = (async (input) =>
      String(input).endsWith('.pom')
        ? new Response('<project><packaging>jar</packaging></project>')
        : new Response('', { status: 404 })) as typeof fetch;
    const workdir = await mkdtemp(join(tmpdir(), 'drift-java-none-'));
    const outcome = await javaSurface.compute({
      ...baseRequest,
      workdir,
      exec: async (command) =>
        command === 'java'
          ? { code: 127, stdout: '', stderr: 'command not found', failure: 'not-found' }
          : { code: 1, stdout: '', stderr: '' },
    });
    await rm(workdir, { recursive: true, force: true });

    assert.equal(outcome.available, false);
    if (!outcome.available) {
      assert.equal(outcome.reason, 'tool-missing');
      assert.match(outcome.detail, /Java is not installed/);
      assert.equal(outcome.install, undefined, 'Drift does not offer to install Java');
    }
  });

  test('a helper checksum failure is a distinct toolchain-failed message', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('.pom')) return new Response('<project><packaging>jar</packaging></project>');
      if (url.includes('/japicmp/')) return new Response(Buffer.from('corrupt'), { status: 200 });
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const workdir = await mkdtemp(join(tmpdir(), 'drift-java-badsum-'));
    const outcome = await javaSurface.compute({
      ...baseRequest,
      workdir,
      exec: async (command, args) =>
        command === 'java' && args[0] === '-version'
          ? { code: 0, stdout: '', stderr: 'openjdk 21' }
          : { code: 1, stdout: '', stderr: 'unexpected' },
    });
    await rm(workdir, { recursive: true, force: true });

    assert.equal(outcome.available, false);
    if (!outcome.available) {
      assert.equal(outcome.reason, 'toolchain-failed');
      assert.match(outcome.detail, /SHA-256 check/);
    }
  });

  test('a helper acquisition failure never blames Java when Java is present', async () => {
    globalThis.fetch = (async (input) =>
      String(input).endsWith('.pom')
        ? new Response('<project><packaging>jar</packaging></project>')
        : new Response('', { status: 503 })) as typeof fetch;

    const workdir = await mkdtemp(join(tmpdir(), 'drift-java-dl-'));
    const outcome = await javaSurface.compute({
      ...baseRequest,
      workdir,
      exec: async (command, args) =>
        command === 'java' && args[0] === '-version'
          ? { code: 0, stdout: '', stderr: 'openjdk 21' }
          : { code: 1, stdout: '', stderr: 'unexpected' },
    });
    await rm(workdir, { recursive: true, force: true });

    assert.equal(outcome.available, false);
    if (!outcome.available) {
      assert.equal(outcome.reason, 'toolchain-failed');
      assert.doesNotMatch(outcome.detail, /Java is not installed/);
      assert.match(outcome.detail, /japicmp helper/);
    }
  });
});
