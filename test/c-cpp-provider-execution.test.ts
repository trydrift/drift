import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { conanSurface, vcpkgSurface } from '../dist/evidence/surface/c.js';
import { clearHttpCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';

const realFetch = globalThis.fetch;

function tar(path: string, content: string): Buffer {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return gzipSync(Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512), Buffer.alloc(1024)]));
}

const request = {
  name: 'fmt',
  from: '9.1.0',
  to: '10.2.1',
  exec: async () => ({ code: 1, stdout: '', stderr: 'must not execute' }),
  workdir: '/tmp/drift-c-provider-test',
  logger: createLogger('error'),
  timeoutMs: 10_000,
};

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

describe('opaque C/C++ identities reach their surface providers', () => {
  test('Conan exact versions resolve and compare their published headers', async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith('/config.yml')) {
        return new Response('versions:\n  "9.1.0":\n    folder: all\n  "10.2.1":\n    folder: all\n');
      }
      if (url.endsWith('/all/conandata.yml')) {
        return new Response('sources:\n  "9.1.0":\n    url: "https://archives.test/fmt-9.1.0.tar.gz"\n  "10.2.1":\n    url: "https://archives.test/fmt-10.2.1.tar.gz"\n');
      }
      if (url.endsWith('fmt-9.1.0.tar.gz')) return new Response(new Uint8Array(tar('fmt/include/fmt.h', 'int old_api(void);')));
      if (url.endsWith('fmt-10.2.1.tar.gz')) return new Response(new Uint8Array(tar('fmt/include/fmt.h', 'int new_api(void);')));
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const outcome = await conanSurface.compute(request);
    assert.equal(outcome.available, true);
    if (outcome.available) assert.ok(outcome.changes.some((change) => change.symbol === 'old_api'));
  });

  test('vcpkg exact overrides resolve and compare their upstream headers', async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('/ports/fmt/vcpkg.json')) return new Response(JSON.stringify({ homepage: 'https://github.com/fmtlib/fmt' }));
      if (url.includes('/repos/fmtlib/fmt/tags')) return new Response(JSON.stringify([{ name: '9.1.0' }, { name: '10.2.1' }]));
      if (url.includes('/9.1.0')) return new Response(new Uint8Array(tar('fmt-9.1.0/include/fmt.h', 'int old_api(void);')));
      if (url.includes('/10.2.1')) return new Response(new Uint8Array(tar('fmt-10.2.1/include/fmt.h', 'int new_api(void);')));
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const outcome = await vcpkgSurface.compute(request);
    assert.equal(outcome.available, true);
    if (outcome.available) assert.ok(outcome.changes.some((change) => change.symbol === 'old_api'));
  });
});
