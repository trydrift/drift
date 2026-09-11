import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ArtifactUnavailableError,
  clearTypeSurfaceCache,
  diffSurfaces,
  fetchTypeSurface,
} from '../dist/evidence/type-surface.js';
import { clearHttpCache } from '../dist/util/http.js';

const realFetch = globalThis.fetch;

function tarEntry(path: string, content: string): Buffer {
  const bytes = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, bytes, Buffer.alloc(Math.ceil(bytes.length / 512) * 512 - bytes.length)]);
}

function packageTarball(version: string, files: Record<string, string>): Buffer {
  const manifest = JSON.stringify({ name: 'emoji-regex', version, types: 'index.d.ts' });
  return Buffer.concat([
    tarEntry('package/package.json', manifest),
    ...Object.entries(files).map(([path, content]) => tarEntry(`package/${path}`, content)),
    Buffer.alloc(1024),
  ]);
}

function installRegistryFallback(archives: Record<string, Buffer>): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.hostname === 'data.jsdelivr.com' || parsed.hostname === 'cdn.jsdelivr.net') {
      return new Response('unavailable', { status: 503 });
    }
    if (parsed.hostname === 'registry.npmjs.org') {
      const version = decodeURIComponent(parsed.pathname.split('/').at(-1)!);
      if (!archives[version]) return new Response('unavailable', { status: 503 });
      return Response.json({
        name: 'emoji-regex',
        version,
        dist: { tarball: `https://artifacts.example/emoji-regex-${version}.tgz` },
      });
    }
    if (parsed.hostname === 'artifacts.example') {
      const version = /emoji-regex-(.+)\.tgz$/.exec(parsed.pathname)?.[1];
      const archive = version ? archives[version] : undefined;
      return archive
        ? new Response(new Uint8Array(archive), { status: 200 })
        : new Response('unavailable', { status: 503 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
  clearTypeSurfaceCache();
});

describe('authoritative npm declaration fallback', () => {
  test('finds and diffs emoji-regex-style root declarations when jsDelivr fails', async () => {
    const calls = installRegistryFallback({
      '10.4.0': packageTarball('10.4.0', {
        'index.d.ts': 'export declare function regex(): RegExp;\nexport declare const legacy: boolean;',
      }),
      '10.6.0': packageTarball('10.6.0', {
        'index.d.ts': 'export declare function regex(): RegExp;',
      }),
    });

    const [before, after] = await Promise.all([
      fetchTypeSurface('emoji-regex', '10.4.0'),
      fetchTypeSurface('emoji-regex', '10.6.0'),
    ]);

    assert.ok(before?.api.has('regex'));
    assert.ok(after?.api.has('regex'));
    assert.deepEqual(diffSurfaces(before!.api, after!.api).map((change) => change.symbol), ['legacy']);
    assert.ok(calls.some((url) => url === 'https://registry.npmjs.org/emoji-regex/10.6.0'));
  });

  test('a successfully inspected artifact with no declarations proves absence', async () => {
    const archive = packageTarball('1.0.0', {});
    installRegistryFallback({ '1.0.0': archive });
    assert.equal(await fetchTypeSurface('emoji-regex', '1.0.0'), null);
  });

  test('registry and CDN failure is artifact-unavailable, not no-public-surface', async () => {
    installRegistryFallback({});
    await assert.rejects(
      fetchTypeSurface('emoji-regex', '10.6.0'),
      (error: unknown) => error instanceof ArtifactUnavailableError,
    );
  });

  test('an archive with a traversing path is rejected in full', async () => {
    const unsafe = Buffer.concat([
      tarEntry('package/package.json', JSON.stringify({ name: 'emoji-regex', version: '10.6.0', types: 'index.d.ts' })),
      tarEntry('package/index.d.ts', 'export declare const ok: true;'),
      tarEntry('package/../../escape.d.ts', 'export declare const bad: true;'),
      Buffer.alloc(1024),
    ]);
    installRegistryFallback({ '10.6.0': unsafe });
    await assert.rejects(
      fetchTypeSurface('emoji-regex', '10.6.0'),
      (error: unknown) => error instanceof ArtifactUnavailableError,
    );
  });

  test('registry metadata must preserve the exact requested identity', async () => {
    const archive = packageTarball('10.6.0', { 'index.d.ts': 'export declare const ok: true;' });
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.hostname.endsWith('jsdelivr.net')) return new Response('unavailable', { status: 503 });
      if (url.hostname === 'registry.npmjs.org') {
        return Response.json({ version: '10.6.1', dist: { tarball: 'https://artifacts.example/pkg.tgz' } });
      }
      if (url.hostname === 'artifacts.example') return new Response(new Uint8Array(archive));
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    await assert.rejects(
      fetchTypeSurface('emoji-regex', '10.6.0'),
      (error: unknown) => error instanceof ArtifactUnavailableError,
    );
  });
});
