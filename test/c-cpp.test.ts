import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readArchive, readTar, readZip } from '../dist/util/archive.js';
import { parseHeader, parseHeaderSurface, publicHeaders } from '../dist/evidence/surface/c-headers.js';
import { chooseAssembly } from '../dist/evidence/surface/dotnet.js';
import { folderForVersion, sourceUrlForVersion, matchesVersion } from '../dist/evidence/surface/c.js';
import { diffSurfaces } from '../dist/evidence/type-surface.js';
import { buildIndex } from '../dist/index/metarag.js';
import { localize } from '../dist/localize/index.js';
import { createLogger } from '../dist/util/logger.js';

const logger = createLogger('error');

/* ---------------- archives ---------------- */

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

/** A zip with one stored (uncompressed) entry, built by hand. */
function storedZip(path: string, content: string): Buffer {
  const name = Buffer.from(path, 'utf8');
  const data = Buffer.from(content, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt32LE(0, 14); // crc, unchecked by the reader
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42); // local header offset

  const centralStart = local.length + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return Buffer.concat([local, name, data, central, name, eocd]);
}

describe('reading archives without unpacking them', () => {
  test('a tarball, entry by entry', () => {
    const tar = Buffer.concat([
      tarEntry('pkg-1.0/include/pkg.h', '#define PKG 1\n'),
      tarEntry('pkg-1.0/README', 'hello'),
      Buffer.alloc(1024),
    ]);

    const entries = readTar(tar);
    assert.deepEqual(
      entries.map((e) => e.path),
      ['pkg-1.0/include/pkg.h', 'pkg-1.0/README'],
    );
    assert.equal(entries[0]!.read().toString('utf8'), '#define PKG 1\n');
  });

  test('a zip, through its central directory', () => {
    const entries = readZip(storedZip('lib/net8.0/Thing.dll', 'MZ...'));
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.path, 'lib/net8.0/Thing.dll');
    assert.equal(entries[0]!.read().toString('utf8'), 'MZ...');
  });

  test('the format is sniffed from the bytes, not from the URL', () => {
    // A CDN serving a `.zip` URL as a tarball is not hypothetical, and the
    // file's own first bytes are never wrong about what it is.
    assert.equal(readArchive(storedZip('a.h', 'x'))[0]?.path, 'a.h');
    assert.equal(
      readArchive(Buffer.concat([tarEntry('b.h', 'y'), Buffer.alloc(1024)]))[0]?.path,
      'b.h',
    );
  });
});

/* ---------------- header surface ---------------- */

describe('the public surface of a C library', () => {
  test('functions keep their parameter types and lose their parameter names', () => {
    // Renaming a parameter breaks no caller in C, so a signature that carried
    // names would report a changed signature on every tidy-up commit.
    const before = parseHeader('int zread(int fd, char *buf);');
    const after = parseHeader('int zread(int handle, char *dest);');
    assert.deepEqual(diffSurfaces(toApi(before), toApi(after)), []);

    const changed = parseHeader('int zread(int fd, char *buf, size_t n);');
    assert.equal(diffSurfaces(toApi(before), toApi(changed))[0]?.kind, 'signature-changed');
  });

  test('a struct losing a field is a member removal', () => {
    const before = toApi(parseHeader('struct Point {\n  int x;\n  int y;\n  int z;\n};'));
    const after = toApi(parseHeader('struct Point {\n  int x;\n  int y;\n};'));

    const changes = diffSurfaces(before, after);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.symbol, 'Point.z');
  });

  test('a class hides what it has not made public', () => {
    // C++ default access differs by keyword. Getting it wrong puts every
    // private field into the compared surface, and a library tidying its
    // internals then reports as dozens of removals nobody could have touched.
    const [entry] = parseHeader(
      'class Session {\n  int fd_;\n public:\n  void close();\n};',
    );
    assert.deepEqual(entry?.members, ['close']);
  });

  test('a private namespace is not API, however it is spelled', () => {
    assert.deepEqual(parseHeader('namespace detail {\n  int helper(void);\n}\n'), []);
    assert.deepEqual(
      parseHeader('FMT_BEGIN_DETAIL_NAMESPACE\nint helper(void);\nFMT_END_DETAIL_NAMESPACE\n'),
      [],
    );
    // ArduinoJson closes its private region by opening a public one.
    const entries = parseHeader(
      [
        'ARDUINOJSON_BEGIN_PRIVATE_NAMESPACE',
        'int helper(void);',
        'ARDUINOJSON_BEGIN_PUBLIC_NAMESPACE',
        'class JsonDocument {',
        ' public:',
        '  void clear();',
        '};',
      ].join('\n'),
    );
    assert.deepEqual(
      entries.map((e) => e.name),
      ['JsonDocument'],
    );
  });

  test('a declaration below a directive is still found', () => {
    // The statement join used to run from `#pragma once` straight through the
    // blank line to the class below it, and skip past the class entirely.
    const entries = parseHeader('#pragma once\n\n#include <stdio.h>\n\nclass Foo {\n public:\n  void go();\n};');
    assert.deepEqual(
      entries.map((e) => e.name),
      ['Foo'],
    );
  });

  test('version macros are excluded, because they change every release', () => {
    assert.deepEqual(parseHeader('#define ZLIB_VERSION "1.3.1"\n#define ZLIB_VERNUM 0x1310'), []);
    assert.equal(parseHeader('#define Z_OK 0')[0]?.name, 'Z_OK');
  });

  test('the release directory is stripped, or every header reads as new', () => {
    const files = publicHeaders([
      'zlib-1.3.1/zlib.h',
      'zlib-1.3.1/include/zconf.h',
      'zlib-1.3.1/test/infcover.c',
      'zlib-1.3.1/contrib/minizip/crypt.h',
      'zlib-1.3.1/gzguts.h',
    ]);

    assert.deepEqual(
      files.map((f) => f.path).sort(),
      ['include/zconf.h', 'zlib.h'],
    );
  });

  test('a symbol that moved between headers has not been removed', () => {
    const before = parseHeaderSurface([{ path: 'a.h', content: 'int go(void);' }]);
    const after = parseHeaderSurface([{ path: 'b.h', content: 'int go(void);' }]);
    assert.deepEqual(diffSurfaces(before, after), []);
  });
});

function toApi(entries: ReturnType<typeof parseHeader>) {
  return new Map(entries.map((entry) => [entry.name, entry]));
}

/* ---------------- source resolution ---------------- */

describe('finding a version’s source', () => {
  const config = `versions:\n  "1.3.1":\n    folder: all\n  "1.2.13":\n    folder: legacy\n`;

  test('a quoted version key is a string, not the number 1.3', () => {
    assert.equal(folderForVersion(config, '1.3.1'), 'all');
    assert.equal(folderForVersion(config, '1.2.13'), 'legacy');
    assert.equal(folderForVersion(config, '9.9.9'), null);
  });

  test('conandata names the upstream archive, per version', () => {
    const conandata = [
      'sources:',
      '  "1.3.1":',
      '    url:',
      '      - "https://zlib.net/zlib-1.3.1.tar.gz"',
      '    sha256: "abc"',
      '  "1.2.13":',
      '    url: "https://zlib.net/zlib-1.2.13.tar.gz"',
      'patches:',
      '  "1.3.1":',
      '    - patch_file: "patches/01.patch"',
    ].join('\n');

    assert.equal(sourceUrlForVersion(conandata, '1.3.1'), 'https://zlib.net/zlib-1.3.1.tar.gz');
    assert.equal(sourceUrlForVersion(conandata, '1.2.13'), 'https://zlib.net/zlib-1.2.13.tar.gz');
    // `patches:` is a sibling of `sources:`, not more of it.
    assert.equal(sourceUrlForVersion(conandata, '0.0.1'), null);
  });

  test('tag spellings vary, so tags are matched rather than constructed', () => {
    for (const tag of ['v1.3.1', '1.3.1', 'zlib-1.3.1', 'release-1.3.1']) {
      assert.ok(matchesVersion(tag, '1.3.1'), tag);
    }
    assert.ok(!matchesVersion('v1.3.2', '1.3.1'));
  });
});

/* ---------------- .NET ---------------- */

describe('which assembly in a NuGet package to read', () => {
  test('the same framework on both sides, or the diff is of two libraries', () => {
    const chosen = chooseAssembly([
      'lib/net48/Thing.dll',
      'lib/netstandard2.0/Thing.dll',
      'lib/net8.0/Thing.dll',
      'Thing.nuspec',
    ]);
    assert.equal(chosen?.framework, 'netstandard2.0');
  });

  test('a reference assembly wins, being the public surface by definition', () => {
    const chosen = chooseAssembly(['lib/net8.0/Thing.dll', 'ref/net8.0/Thing.dll']);
    assert.equal(chosen?.path, 'ref/net8.0/Thing.dll');
  });

  test('resource assemblies carry localised strings, never API', () => {
    const chosen = chooseAssembly([
      'lib/net8.0/fr/Thing.resources.dll',
      'lib/net8.0/Thing.dll',
    ]);
    assert.equal(chosen?.path, 'lib/net8.0/Thing.dll');
  });

  test('a package with no managed assembly has no surface to compare', () => {
    assert.equal(chooseAssembly(['runtimes/win-x64/native/thing.dll', 'Thing.nuspec']), null);
  });
});

/* ---------------- localization ---------------- */

describe('localizing a C dependency', () => {
  const change = {
    id: 'bc1',
    dependency: 'ArduinoJson',
    kind: 'removed-export' as const,
    summary: '`DynamicJsonDocument` was removed.',
    remediation: 'Use `JsonDocument`.',
    symbols: ['DynamicJsonDocument'],
    confidence: 'high' as const,
    citations: ['e1'],
  };

  const dependency = {
    name: 'ArduinoJson',
    ecosystem: 'arduino' as const,
    from: '6.21.5',
    to: '7.0.4',
    kind: 'runtime' as const,
    bump: 'major' as const,
    manifestPath: 'platformio.ini',
  };

  const file = (path: string, content: string) => ({
    path,
    language: (path.endsWith('.c') || path.endsWith('.h') ? 'c' : 'cpp') as never,
    content,
    lineCount: content.split('\n').length,
  });

  test('an include is an import edge, whatever the header’s case', () => {
    const files = [
      file(
        'src/main.ino',
        `#include <ArduinoJson.h>

void setup() {
  DynamicJsonDocument doc(1024);
}`,
      ),
    ];

    const sites = localize([change], [dependency], buildIndex(files), files, { logger });
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.line, 4);
    // C has no import that binds a name — an include is a textual splice — so
    // `medium` is the correct ceiling and `high` would be a claim nothing
    // short of a compiler could support.
    assert.equal(sites[0]?.confidence, 'medium');
  });

  test('a file that includes nothing from the library is not a site', () => {
    const files = [file('src/other.cpp', '#include <Wire.h>\n\nint DynamicJsonDocument = 1;')];
    const sites = localize([change], [dependency], buildIndex(files), files, { logger });
    assert.equal(sites.length, 0);
  });

  test('a removed header is found on the include line itself', () => {
    const removedHeader = { ...change, symbols: ['ArduinoJson.h'] };
    const files = [file('src/main.ino', '#include <ArduinoJson.h>\nvoid setup() {}')];

    const sites = localize([removedHeader], [dependency], buildIndex(files), files, { logger });
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.line, 1);
  });
});
