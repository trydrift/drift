import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { matchingTag, pythonSurface } from '../dist/evidence/surface/python.js';
import { clearHttpCache, configureHttpDiskCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';
import { CONFIDENT_SURFACE_WEIGHT, type SurfaceRequest } from '../dist/evidence/surface/types.js';

/**
 * Provenance must survive caching.
 *
 * A Python surface computed from the GitHub-tag fallback (see python.ts,
 * "PyPI is unreadable") is not a fact about the published version — it's a
 * fact about this run's transient PyPI failure. Caching it under the same
 * key a canonical PyPI-derived surface uses would let one bad PyPI response
 * turn into a permanent, indefinitely-reused substitute for the real
 * artifact, silently, since this cache carries no TTL.
 */

/** A tar entry, built the way tar builds one: a 512-byte header, then bytes. */
function tarEntry(path: string, content: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);

  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  body.write(content, 0, 'utf8');
  return Buffer.concat([header, body]);
}

function pypiJson(name: string): object {
  return {
    info: { project_urls: { Source: `https://github.com/demo-org/${name}` } },
    releases: {
      '1.0.0': [{ url: `https://files.pythonhosted.org/packages/${name}-1.0.0.tar.gz`, filename: `${name}-1.0.0.tar.gz`, packagetype: 'sdist' }],
      '2.0.0': [{ url: `https://files.pythonhosted.org/packages/${name}-2.0.0.tar.gz`, filename: `${name}-2.0.0.tar.gz`, packagetype: 'sdist' }],
    },
  };
}

const sdistBytes = (module: string) => gzipSync(tarEntry(`${module}/${module}.py`, 'def thing():\n    pass\n'));

const realFetch = globalThis.fetch;
let cacheDir: string;
let calls: string[];

function stubFetch(respond: (url: string) => Response | null): void {
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const response = respond(url);
    return Promise.resolve(response ?? new Response('not found', { status: 404 }));
  }) as typeof fetch;
}

const exec: SurfaceRequest['exec'] = async (command, args) => {
  if (command === 'python3' && args[0] === '--version') return { code: 0, stdout: 'Python 3.11.0', stderr: '' };
  if (command === 'python3') {
    return {
      code: 0,
      stdout: JSON.stringify([{ name: 'thing', kind: 'function', signature: 'def thing()' }]),
      stderr: '',
    };
  }
  return { code: 1, stdout: '', stderr: 'unexpected command' };
};

async function request(name: string, workdir: string): Promise<SurfaceRequest> {
  return {
    name,
    from: '1.0.0',
    to: '2.0.0',
    exec,
    workdir,
    logger: createLogger('error'),
    timeoutMs: 20_000,
  };
}

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'drift-python-surface-'));
  configureHttpDiskCache(cacheDir);
  calls = [];
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  clearHttpCache();
  configureHttpDiskCache(null);
  await rm(cacheDir, { recursive: true, force: true });
});

describe('caching a Python surface computed via the GitHub fallback', () => {
  test('PyPI unreadable → GitHub fallback → the result says so', async () => {
    const name = 'demo-fallback-a';
    stubFetch((url) => {
      if (url === `https://pypi.org/pypi/${name}/json`) return new Response(JSON.stringify(pypiJson(name)), { status: 200 });
      if (url.startsWith('https://files.pythonhosted.org/')) return new Response('unavailable', { status: 500 });
      if (url.startsWith('https://api.github.com/repos/demo-org/'))
        return new Response(JSON.stringify([{ name: 'v1.0.0' }, { name: 'v2.0.0' }]), { status: 200 });
      if (url.startsWith('https://codeload.github.com/')) return new Response(sdistBytes(name.replace(/-/g, '_')), { status: 200 });
      return null;
    });

    const workdir = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
    const outcome = await pythonSurface.compute(await request(name, workdir));
    await rm(workdir, { recursive: true, force: true });

    assert.equal(outcome.available, true);
    if (!outcome.available) return;
    assert.match(outcome.locator, /GitHub tag mirror/);
  });

  test('a later call does not silently return the fallback result as canonical PyPI evidence', async () => {
    const name = 'demo-fallback-b';
    let pypiArchiveCalls = 0;
    stubFetch((url) => {
      if (url === `https://pypi.org/pypi/${name}/json`) return new Response(JSON.stringify(pypiJson(name)), { status: 200 });
      if (url.startsWith('https://files.pythonhosted.org/')) {
        pypiArchiveCalls += 1;
        return new Response('unavailable', { status: 500 });
      }
      if (url.startsWith('https://api.github.com/repos/demo-org/'))
        return new Response(JSON.stringify([{ name: 'v1.0.0' }, { name: 'v2.0.0' }]), { status: 200 });
      if (url.startsWith('https://codeload.github.com/')) return new Response(sdistBytes(name.replace(/-/g, '_')), { status: 200 });
      return null;
    });

    const workdir1 = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
    const first = await pythonSurface.compute(await request(name, workdir1));
    await rm(workdir1, { recursive: true, force: true });
    assert.equal(first.available, true);

    const callsAfterFirst = pypiArchiveCalls;
    assert.ok(callsAfterFirst > 0, 'the first computation must have actually tried PyPI');

    // Fresh in-memory HTTP cache stands in for a fresh process; the artifact
    // cache on disk is the only thing carried over between the two calls —
    // exactly what would happen on a second scan.
    clearHttpCache();

    const workdir2 = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
    const second = await pythonSurface.compute(await request(name, workdir2));
    await rm(workdir2, { recursive: true, force: true });

    assert.equal(second.available, true);
    // If the fallback result had been cached as canonical, this second call
    // would never have touched PyPI again.
    assert.ok(pypiArchiveCalls > callsAfterFirst, 'a cached fallback result must not skip retrying PyPI');
    if (second.available) assert.match(second.locator, /GitHub tag mirror/);
  });

  test('a normal PyPI-derived surface still benefits from the cache', async () => {
    const name = 'demo-canonical';
    let pypiArchiveCalls = 0;
    stubFetch((url) => {
      if (url === `https://pypi.org/pypi/${name}/json`) return new Response(JSON.stringify(pypiJson(name)), { status: 200 });
      if (url.startsWith('https://files.pythonhosted.org/')) {
        pypiArchiveCalls += 1;
        return new Response(sdistBytes(name.replace(/-/g, '_')), { status: 200 });
      }
      return null;
    });

    const workdir1 = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
    const first = await pythonSurface.compute(await request(name, workdir1));
    await rm(workdir1, { recursive: true, force: true });
    assert.equal(first.available, true);
    if (first.available) assert.doesNotMatch(first.locator, /GitHub tag mirror/);

    const callsAfterFirst = pypiArchiveCalls;
    assert.ok(callsAfterFirst > 0);

    clearHttpCache();

    const workdir2 = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
    const second = await pythonSurface.compute(await request(name, workdir2));
    await rm(workdir2, { recursive: true, force: true });

    assert.equal(second.available, true);
    // The archive was never re-downloaded: the parsed surface came from the
    // artifact cache instead.
    assert.equal(pypiArchiveCalls, callsAfterFirst);
  });

  test('a fallback-derived diff carries a genuinely lower weight, not just a note in the citation', async () => {
    const name = 'demo-fallback-weight';
    stubFetch((url) => {
      if (url === `https://pypi.org/pypi/${name}/json`) return new Response(JSON.stringify(pypiJson(name)), { status: 200 });
      if (url.startsWith('https://files.pythonhosted.org/')) return new Response('unavailable', { status: 500 });
      if (url.startsWith('https://api.github.com/repos/demo-org/'))
        return new Response(JSON.stringify([{ name: 'v1.0.0' }, { name: 'v2.0.0' }]), { status: 200 });
      if (url.startsWith('https://codeload.github.com/')) return new Response(sdistBytes(name.replace(/-/g, '_')), { status: 200 });
      return null;
    });

    const workdir = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
    const outcome = await pythonSurface.compute(await request(name, workdir));
    await rm(workdir, { recursive: true, force: true });

    assert.equal(outcome.available, true);
    if (!outcome.available) return;
    // The PR description called this "lower-confidence", but the weight
    // stayed the same 0.9 as a canonical PyPI diff -- so `judgeConfidence`
    // (which treats any surface diff at or above CONFIDENT_SURFACE_WEIGHT as
    // "a computed API diff ran", automatic high confidence) never actually
    // downgraded anything.
    assert.ok(
      outcome.weight < CONFIDENT_SURFACE_WEIGHT,
      `fallback-derived weight ${outcome.weight} must fall below the confident-surface threshold`,
    );
  });

  test('a canonical PyPI-derived diff keeps its normal weight, at or above the confident threshold', async () => {
    const name = 'demo-canonical-weight';
    stubFetch((url) => {
      if (url === `https://pypi.org/pypi/${name}/json`) return new Response(JSON.stringify(pypiJson(name)), { status: 200 });
      if (url.startsWith('https://files.pythonhosted.org/')) return new Response(sdistBytes(name.replace(/-/g, '_')), { status: 200 });
      return null;
    });

    const workdir = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
    const outcome = await pythonSurface.compute(await request(name, workdir));
    await rm(workdir, { recursive: true, force: true });

    assert.equal(outcome.available, true);
    if (!outcome.available) return;
    assert.ok(outcome.weight >= CONFIDENT_SURFACE_WEIGHT);
  });
});

describe('picking the right repository tag for a PyPI fallback, in a repo hosting more than one package', () => {
  test('prefers a tag that names this package over an equally version-matching sibling', () => {
    const tags = [{ name: 'package-a-v1.0.0' }, { name: 'package-b-v1.0.0' }];
    assert.equal(matchingTag(tags, 'package-a', '1.0.0'), 'package-a-v1.0.0');
    assert.equal(matchingTag(tags, 'package-b', '1.0.0'), 'package-b-v1.0.0');
  });

  test('an unqualified bare-version match is trusted only when it is the sole candidate', () => {
    assert.equal(matchingTag([{ name: 'v1.0.0' }], 'anything', '1.0.0'), 'v1.0.0');
  });

  test('two equally-plausible, unqualified tags are declined rather than guessed at', () => {
    // Neither tag names the package Drift is actually looking for -- picking
    // whichever sorted first used to mean the wrong sibling's source could be
    // downloaded and diffed as if it were the PyPI distribution.
    const tags = [{ name: 'v1.0.0' }, { name: 'release-1.0.0' }];
    assert.equal(matchingTag(tags, 'some-package', '1.0.0'), null);
  });

  test('an exact tag match still wins even with an underscore/dash mismatch in the name', () => {
    const tags = [{ name: 'my_package-1.2.3' }];
    assert.equal(matchingTag(tags, 'my-package', '1.2.3'), 'my_package-1.2.3');
  });
});
