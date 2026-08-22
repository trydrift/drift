import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readArchive } from '../dist/util/archive.js';

/**
 * Every archive `readArchive` opens is a third party's bytes -- a PyPI
 * sdist, a GitHub tag mirror, a Maven sources jar -- and `maxBytes` on the
 * download only bounds the *compressed* size on the wire. A small,
 * legitimately-sized download can still decompress to gigabytes: nothing
 * before this bounded what `gunzipSync`/`inflateRawSync` were allowed to
 * produce, so a highly compressed archive could expand without limit during
 * unpacking, well after the network-level size ceiling had already passed.
 */

/** A minimal one-entry tar, gzip-compressed. */
function gzippedTar(path: string, content: Buffer): Buffer {
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
  content.copy(body);
  const end = Buffer.alloc(1024);
  return gzipSync(Buffer.concat([header, body, end]));
}

describe('a highly compressed archive cannot expand without limit during unpacking', () => {
  test('a gzip whose decompressed tar exceeds the ceiling is rejected, not fully decompressed', () => {
    // 10MB of a single repeated byte compresses to almost nothing, so this
    // download would sail through any reasonable network-level maxBytes
    // check and only reveal its true size once decompressed.
    const bomb = gzippedTar('big.py', Buffer.alloc(10 * 1024 * 1024, 'a'));
    assert.ok(bomb.length < 100 * 1024, `expected the compressed bomb to be tiny, got ${bomb.length} bytes`);

    assert.throws(() => readArchive(bomb, { maxDecompressedBytes: 1024 * 1024 }));
  });

  test('a normal, modestly sized archive is read exactly as before', () => {
    const normal = gzippedTar('small.py', Buffer.from('def thing():\n    pass\n'));
    const entries = readArchive(normal, { maxDecompressedBytes: 1024 * 1024 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.path, 'small.py');
    assert.equal(entries[0]!.read().toString('utf8').trim(), 'def thing():\n    pass'.trim());
  });

  test('the default ceiling protects a caller that passes no explicit limit at all', () => {
    const bomb = gzippedTar('big.py', Buffer.alloc(300 * 1024 * 1024, 'a'));
    assert.throws(() => readArchive(bomb));
  });
});
