import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { classifyPubPackage, pubSurface } from '../dist/evidence/surface/dart.js';
import { clearHttpCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';

const realFetch = globalThis.fetch;
const entry = (path: string, content = '') => ({ path, size: Buffer.byteLength(content), read: () => Buffer.from(content) });

function tar(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [path, content] of Object.entries(files)) {
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
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

function serve(before: Buffer, after: Buffer): void {
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes('-1.0.0.tar.gz')) return new Response(new Uint8Array(before));
    if (url.includes('-2.0.0.tar.gz')) return new Response(new Uint8Array(after));
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const request = (name = 'cupertino_icons') => ({
  name,
  from: '1.0.0',
  to: '2.0.0',
  exec: async () => ({ code: 1, stdout: '', stderr: 'must not execute' }),
  workdir: '/tmp/drift-pub-role-test',
  logger: createLogger('error'),
  timeoutMs: 10_000,
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

describe('Pub package roles', () => {
  test('classifies code, asset, tooling, and unsupported packages', () => {
    assert.equal(classifyPubPackage([entry('lib/demo.dart', 'class Demo {}')]), 'code');
    assert.equal(classifyPubPackage([
      entry('pubspec.yaml', 'flutter:\n  assets:\n    - assets/logo.png\n'),
      entry('assets/logo.png', 'png'),
    ]), 'asset');
    assert.equal(classifyPubPackage([entry('bin/demo.dart', 'void main() {}')]), 'tooling');
    assert.equal(classifyPubPackage([entry('README.md', 'hello')]), 'unsupported');
  });

  test('cupertino_icons-shaped packages compare declared font assets', async () => {
    const pubspec = 'flutter:\n  fonts:\n    - family: CupertinoIcons\n      fonts:\n        - asset: assets/CupertinoIcons.ttf\n';
    serve(
      tar({ 'pubspec.yaml': pubspec, 'assets/CupertinoIcons.ttf': 'old-font' }),
      tar({ 'pubspec.yaml': pubspec, 'assets/CupertinoIcons.ttf': 'new-font' }),
    );
    const outcome = await pubSurface.compute(request());
    assert.equal(outcome.available, true);
    if (!outcome.available) return;
    assert.match(outcome.locator, /published Pub roles: asset → asset/);
    assert.equal(outcome.changes[0]?.kind, 'signature-changed');
    assert.doesNotMatch(outcome.locator, /published lib\//);
  });

  test('tooling packages compare executables and bin contents', async () => {
    serve(
      tar({ 'pubspec.yaml': 'executables:\n  drift_tool: old\n', 'bin/old.dart': 'void main() {}' }),
      tar({ 'pubspec.yaml': 'executables:\n  drift_tool: new\n', 'bin/new.dart': 'void main() {}' }),
    );
    const outcome = await pubSurface.compute(request('drift_tool'));
    assert.equal(outcome.available, true);
    if (outcome.available) assert.ok(outcome.changes.some((change) => change.symbol.includes('executable:drift_tool')));
  });

  test('artifact failure is explicit and cannot become no-public-surface', async () => {
    globalThis.fetch = (async () => new Response('gateway', { status: 503 })) as typeof fetch;
    const outcome = await pubSurface.compute(request());
    assert.equal(outcome.available, false);
    if (outcome.available) return;
    assert.equal(outcome.reason, 'artifact-unavailable');
    assert.notEqual(outcome.reason, 'no-public-surface');
  });

  test('an unclassified archive reports an explicit unsupported role', async () => {
    const archive = tar({ 'README.md': 'hello' });
    serve(archive, archive);
    const outcome = await pubSurface.compute(request('docs_only'));
    assert.equal(outcome.available, false);
    if (!outcome.available) assert.equal(outcome.reason, 'artifact-type-unsupported');
  });
});
