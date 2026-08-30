import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGzip } from 'node:zlib';
import { fetchTypeSurface, clearTypeSurfaceCache, VersionUnavailableError } from '../../dist/evidence/type-surface.js';
import { fetchNpmArtifact, clearNpmArtifactCache } from '../../dist/evidence/npm-artifact.js';
import { clearHttpCache, configureHttpDiskCache } from '../../dist/util/http.js';

/**
 * jsDelivr is a mirror, not an authority.
 *
 * `emoji-regex@10.6.0` publishes `index.d.ts`. Drift reported it as having no
 * usable declaration surface because jsDelivr did not answer — a provider
 * failure serialised as a fact about the package. An absence claim needs
 * positive provenance: the artifact has to have been inspected.
 */

const realFetch = globalThis.fetch;

function reset(): void {
  configureHttpDiskCache(null);
  clearHttpCache();
  clearTypeSurfaceCache();
  clearNpmArtifactCache();
}

/** Build a real gzipped npm tarball, so the archive reader is exercised. */
async function tarball(files: Record<string, string>): Promise<Buffer> {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'utf8');
    header.write('0000000\0', 108, 8, 'utf8');
    header.write('0000000\0', 116, 8, 'utf8');
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
    header.write('00000000000\0', 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8');
    header.write('0', 156, 1, 'utf8');
    header.write('ustar\x0000', 257, 8, 'utf8');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const tar = Buffer.concat(blocks);
  return new Promise((resolve, reject) => {
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    gzip.on('end', () => resolve(Buffer.concat(chunks)));
    gzip.on('error', reject);
    gzip.end(tar);
  });
}

interface Scenario {
  /** Everything jsDelivr is willing to answer. Absent hosts 404. */
  jsdelivr?: Record<string, unknown>;
  /** `null` means the registry metadata itself is unavailable. */
  registryTarball?: Buffer | null;
  /** Bytes served for the tarball URL, when it differs from a real archive. */
  tarballBody?: Buffer;
}

const TARBALL_URL = 'https://registry.npmjs.org/emoji-regex/-/artifact.tgz';

function stub(scenario: Scenario): void {
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);

    if (url.startsWith('https://cdn.jsdelivr.net') || url.startsWith('https://data.jsdelivr.com')) {
      for (const [suffix, body] of Object.entries(scenario.jsdelivr ?? {})) {
        if (url.includes(suffix)) {
          return Promise.resolve(
            new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 }),
          );
        }
      }
      return Promise.resolve(new Response('', { status: 502 }));
    }

    if (url === TARBALL_URL) {
      const body = scenario.tarballBody ?? scenario.registryTarball;
      if (!body) return Promise.resolve(new Response('', { status: 503 }));
      return Promise.resolve(new Response(new Uint8Array(body), { status: 200 }));
    }

    if (url.startsWith('https://registry.npmjs.org/')) {
      if (scenario.registryTarball === null) return Promise.resolve(new Response('', { status: 503 }));
      return Promise.resolve(
        new Response(JSON.stringify({ dist: { tarball: TARBALL_URL } }), { status: 200 }),
      );
    }

    return Promise.resolve(new Response('', { status: 404 }));
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  reset();
});

const EMOJI_REGEX_FILES = {
  'package.json': JSON.stringify({ name: 'emoji-regex', version: '10.6.0', types: 'index.d.ts' }),
  'index.d.ts': 'declare function emojiRegex(): RegExp;\nexport = emojiRegex;\n',
};

describe('npm declaration surfaces are authoritative, not CDN-dependent', () => {
  test('the published tarball answers when jsDelivr will not', async () => {
    reset();
    stub({ registryTarball: await tarball(EMOJI_REGEX_FILES) });

    const surface = await fetchTypeSurface('emoji-regex', '10.6.0');

    assert.ok(surface, 'emoji-regex@10.6.0 publishes index.d.ts and must be found');
    assert.equal(surface?.entryPath, 'index.d.ts');
  });

  test('the artifact reader exposes files, package.json, and contents', async () => {
    reset();
    stub({ registryTarball: await tarball(EMOJI_REGEX_FILES) });

    const result = await fetchNpmArtifact('emoji-regex', '10.6.0');

    assert.equal(result.state, 'ok');
    if (result.state !== 'ok') return;
    assert.ok(result.artifact.files.has('index.d.ts'));
    assert.equal(result.artifact.packageJson?.name, 'emoji-regex');
    assert.match(result.artifact.read('index.d.ts') ?? '', /emojiRegex/);
    assert.equal(result.artifact.read('nope.d.ts'), null);
  });

  test('a tarball that cannot be downloaded is artifact-unavailable, not an empty package', async () => {
    reset();
    stub({ registryTarball: null });

    const result = await fetchNpmArtifact('emoji-regex', '10.6.0');
    assert.equal(result.state, 'artifact-unavailable');

    clearNpmArtifactCache();
    clearTypeSurfaceCache();
    await assert.rejects(
      () => fetchTypeSurface('emoji-regex', '10.6.0'),
      (err: unknown) =>
        err instanceof VersionUnavailableError && err.inspection === 'artifact-unavailable',
      'an unfetchable artifact must never be reported as a package that publishes nothing',
    );
  });

  test('a tarball that is not an archive is artifact-corrupt', async () => {
    reset();
    stub({
      registryTarball: Buffer.from('placeholder'),
      tarballBody: Buffer.from('not actually gzip'),
    });

    const result = await fetchNpmArtifact('emoji-regex', '10.6.0');
    assert.equal(result.state, 'artifact-corrupt');
  });

  test('an inspected artifact with no declarations really is no-public-surface', async () => {
    reset();
    stub({
      registryTarball: await tarball({
        'package.json': JSON.stringify({ name: 'plain', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};\n',
      }),
    });

    const surface = await fetchTypeSurface('plain', '1.0.0');
    assert.equal(surface, null, 'an inspected package with no .d.ts genuinely has no surface');
  });
});
