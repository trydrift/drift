import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTypeSurface, clearTypeSurfaceCache } from '../dist/evidence/type-surface.js';
import { clearHttpCache } from '../dist/util/http.js';

/**
 * Tarball-backed surface acquisition, checked against the per-file jsDelivr
 * path it replaces.
 *
 * `collectDeclarationSources` used to fetch each declaration file from
 * jsDelivr's CDN one wave at a time — the entry point, then whatever it
 * re-exports, then whatever *those* re-export, a real critical-path chain
 * because a barrel's targets are only known after its own content comes
 * back. `computeTypeSurface` now tries a tarball read first (one download,
 * every file already in memory) and only falls back to that per-file path
 * when the tarball cannot be resolved or read.
 *
 * This is a swap of the *fetch mechanism*, not of the candidate-generation
 * logic (`expandTypesEntry`, `conventionalTypeEntries`, the five-candidate
 * expansion, the barrel/triple-slash traversal) — so every test here builds
 * one fixture, serves its files through *both* transports in separate runs,
 * and asserts the resulting surface is identical either way. `sortedApi`
 * below is that comparison in one place, rather than repeating the same
 * `[...api].sort()` dance in every test.
 */

const realFetch = globalThis.fetch;

function reset(): void {
  clearHttpCache();
  clearTypeSurfaceCache();
}

afterEach(() => {
  globalThis.fetch = realFetch;
  reset();
});

function stubFetch(responder: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: string | URL | Request) => Promise.resolve(responder(String(input)))) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status });
}

function isMetadataApi(url: string): boolean {
  try {
    return new URL(url).hostname === 'data.jsdelivr.com';
  } catch {
    return false;
  }
}

function isRegistry(url: string): boolean {
  try {
    return new URL(url).hostname === 'registry.npmjs.org';
  } catch {
    return false;
  }
}

function listing(...files: string[]): Response {
  return json({ files: files.map((name) => ({ name: `/${name}` })) });
}

/** A tar entry, built the way tar builds one: a 512-byte header, then bytes. */
function tarEntry(path: string, content: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148); // checksum field, blank while summing
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

/** A raw (uncompressed) tar archive, every path wrapped under `package/` — the real npm layout. */
function npmTarball(files: Record<string, string>): Buffer {
  return Buffer.concat(Object.entries(files).map(([path, content]) => tarEntry(`package/${path}`, content)));
}

/** Registers the two registry responses a tarball resolution needs: the packument, and the tarball bytes themselves. */
function serveTarball(
  registry: Map<string, Response | (() => Response)>,
  name: string,
  version: string,
  files: Record<string, string>,
): void {
  const encoded = encodeURIComponent(name).replaceAll('%40', '@');
  const tarballUrl = `https://example-registry.test/${encoded}/-/${encoded}-${version}.tgz`;
  registry.set(
    `https://registry.npmjs.org/${encoded}`,
    () => json({ 'dist-tags': { latest: version }, versions: { [version]: { dist: { tarball: tarballUrl } } } }),
  );
  registry.set(tarballUrl, () => new Response(npmTarball(files), { status: 200 }));
}

/** Serves the same files' *content* through the old per-file jsDelivr path, so a test can compare the two transports. */
function serveViaJsDelivr(name: string, version: string, files: Record<string, string>): void {
  stubFetch((url) => {
    if (isRegistry(url)) return new Response('', { status: 404 });
    if (isMetadataApi(url)) return listing(...Object.keys(files));
    for (const [path, content] of Object.entries(files)) {
      if (url.endsWith(`/${name}@${version}/${path}`)) return text(content);
    }
    return new Response('', { status: 404 });
  });
}

/** Serves the same files only through a resolvable tarball — every jsDelivr request 404s, proving the tarball path alone answered. */
function serveViaTarballOnly(name: string, version: string, files: Record<string, string>): void {
  const registry = new Map<string, Response | (() => Response)>();
  serveTarball(registry, name, version, files);
  stubFetch((url) => {
    const entry = registry.get(url);
    if (entry) return typeof entry === 'function' ? entry() : entry;
    return new Response('', { status: 404 });
  });
}

function sortedApi(surface: Awaited<ReturnType<typeof fetchTypeSurface>>) {
  if (!surface) return null;
  return {
    entryPath: surface.entryPath,
    ownSymbols: surface.ownSymbols,
    viaDependencies: [...surface.viaDependencies].sort(),
    subpaths: [...surface.subpaths].sort(),
    api: [...surface.api.entries()]
      .map(([key, entry]) => [key, { ...entry, members: [...entry.members].sort() }])
      .sort(([a], [b]) => a.localeCompare(b)),
  };
}

async function surfaceViaTarball(name: string, version: string, files: Record<string, string>) {
  reset();
  serveViaTarballOnly(name, version, files);
  const surface = await fetchTypeSurface(name, version);
  return sortedApi(surface);
}

async function surfaceViaJsDelivr(name: string, version: string, files: Record<string, string>) {
  reset();
  serveViaJsDelivr(name, version, files);
  const surface = await fetchTypeSurface(name, version);
  return sortedApi(surface);
}

describe('tarball-backed surface acquisition matches the per-file path it replaces', () => {
  test('a barrel re-export chain', async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', types: 'index.d.ts' }),
      'index.d.ts': "export * from './a';\n",
      'a.d.ts': "export * from './b';\nexport declare function fromA(): void;\n",
      'b.d.ts': 'export declare function fromB(): void;\n',
    };

    const tarball = await surfaceViaTarball('demo', '1.0.0', files);
    const jsdelivr = await surfaceViaJsDelivr('demo', '1.0.0', files);

    assert.ok(tarball, 'the tarball path produced a surface');
    assert.deepEqual(tarball, jsdelivr);
    assert.ok(tarball!.api.some(([name]) => name === 'fromA'));
    assert.ok(tarball!.api.some(([name]) => name === 'fromB'), 'the two-level re-export chain was followed');
  });

  test('triple-slash references', async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', types: 'index.d.ts' }),
      'index.d.ts': '/// <reference path="./ref.d.ts" />\nexport declare function main(): void;\n',
      'ref.d.ts': 'export declare const REF: number;\n',
    };

    const tarball = await surfaceViaTarball('demo', '1.0.0', files);
    const jsdelivr = await surfaceViaJsDelivr('demo', '1.0.0', files);

    assert.deepEqual(tarball, jsdelivr);
    assert.ok(tarball!.api.some(([name]) => name === 'REF'), 'the triple-slash reference was followed');
  });

  test('a deep re-export chain (four levels)', async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', types: 'index.d.ts' }),
      'index.d.ts': "export * from './l1';\n",
      'l1.d.ts': "export * from './l2';\n",
      'l2.d.ts': "export * from './l3';\n",
      'l3.d.ts': 'export declare function deep(): void;\n',
    };

    const tarball = await surfaceViaTarball('demo', '1.0.0', files);
    const jsdelivr = await surfaceViaJsDelivr('demo', '1.0.0', files);

    assert.deepEqual(tarball, jsdelivr);
    assert.ok(tarball!.api.some(([name]) => name === 'deep'), 'all four levels were followed');
  });

  test('a dual CJS/ESM package resolves types through the conditional exports map', async () => {
    const files = {
      'package.json': JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        exports: {
          '.': { types: './esm/index.d.ts', import: './esm/index.mjs', require: './cjs/index.cjs' },
        },
      }),
      'esm/index.d.ts': 'export declare function dual(): void;\n',
    };

    const tarball = await surfaceViaTarball('demo', '1.0.0', files);
    const jsdelivr = await surfaceViaJsDelivr('demo', '1.0.0', files);

    assert.deepEqual(tarball, jsdelivr);
    assert.equal(tarball!.entryPath, 'esm/index.d.ts');
    assert.ok(tarball!.api.some(([name]) => name === 'dual'));
  });

  test('the @types/* DefinitelyTyped fallback, tarball-resolved on both the package and its @types package', async () => {
    reset();
    const registry = new Map<string, Response | (() => Response)>();
    // The package itself declares nothing typed at all — no `types`, no
    // `typings`, no `types` condition in `exports`, no conventional path —
    // so resolution has to fall all the way through to DefinitelyTyped.
    serveTarball(registry, 'untyped-pkg', '2.0.0', {
      'package.json': JSON.stringify({ name: 'untyped-pkg', version: '2.0.0' }),
      'index.js': 'module.exports = {};\n',
    });
    serveTarball(registry, '@types/untyped-pkg', 'latest', {
      'package.json': JSON.stringify({ name: '@types/untyped-pkg', version: '2.0.5' }),
      'index.d.ts': 'export declare function fromDefinitelyTyped(): void;\n',
    });
    stubFetch((url) => {
      const entry = registry.get(url);
      if (entry) return typeof entry === 'function' ? entry() : entry;
      return new Response('', { status: 404 });
    });

    const surface = await fetchTypeSurface('untyped-pkg', '2.0.0');
    assert.equal(surface?.entryPath, '@types:@types/untyped-pkg');
    assert.ok(surface?.api.has('fromDefinitelyTyped'));
  });

  test('a version whose packument omits it falls back to the single-version registry endpoint (tier 2)', async () => {
    reset();
    const files = {
      'package.json': JSON.stringify({ name: 'demo', version: '9.9.9', types: 'index.d.ts' }),
      'index.d.ts': 'export declare function fromTierTwo(): void;\n',
    };
    const tarballUrl = 'https://example-registry.test/demo/-/demo-9.9.9.tgz';
    stubFetch((url) => {
      if (url === 'https://registry.npmjs.org/demo') {
        // The packument answers, but has never heard of this version — as if
        // it were unpublished, or published after the packument was cached
        // somewhere upstream.
        return json({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { dist: { tarball: 'unused' } } } });
      }
      if (url === 'https://registry.npmjs.org/demo/9.9.9') {
        return json({ dist: { tarball: tarballUrl } });
      }
      if (url === tarballUrl) return new Response(npmTarball(files), { status: 200 });
      return new Response('', { status: 404 });
    });

    const surface = await fetchTypeSurface('demo', '9.9.9');
    assert.ok(surface?.api.has('fromTierTwo'), 'tier 2 (the single-version endpoint) resolved the tarball');
  });

  test('a tarball that cannot be resolved degrades to the jsDelivr path, not to no evidence', async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', types: 'index.d.ts' }),
      'index.d.ts': 'export declare function stillFound(): void;\n',
    };
    reset();
    // Every registry.npmjs.org request fails outright; only the jsDelivr
    // endpoints answer — the same fixture `serveViaJsDelivr` would use.
    serveViaJsDelivr('demo', '1.0.0', files);

    const surface = await fetchTypeSurface('demo', '1.0.0');
    assert.ok(surface?.api.has('stillFound'), 'the per-file jsDelivr path still answered');
  });
});
