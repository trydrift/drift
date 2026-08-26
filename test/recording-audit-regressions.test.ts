import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SURFACE_SCRIPT } from '../dist/evidence/surface/python.js';
import { parseHeader, parseHeaderSurface } from '../dist/evidence/surface/c-headers.js';
import { diffSurfaces } from '../dist/evidence/type-surface.js';
import { matchProse } from '../dist/analyze/index.js';
import { buildIndex } from '../dist/index/metarag.js';
import { localize } from '../dist/localize/index.js';
import { assessUpgrade } from '../dist/rationale/assess.js';
import { discoverNestedProjects } from '../dist/detect/nested.js';
import { lookupVersions } from '../dist/upgrade/versions.js';
import { clearHttpCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';

const execFile = promisify(execFileCallback);
const logger = createLogger('error');
const realFetch = globalThis.fetch;

function file(path: string, language: string, content: string) {
  return { path, language: language as never, content, lineCount: content.split('\n').length };
}

function dependency(name: string, ecosystem: string) {
  return {
    name,
    ecosystem: ecosystem as never,
    from: '1.0.0',
    to: '2.0.0',
    kind: 'runtime' as const,
    bump: 'major' as const,
    manifestPath: 'package.json',
  };
}

function change(overrides: Record<string, unknown> = {}) {
  return {
    id: 'audit-change',
    dependency: 'pkg',
    kind: 'removed-export' as const,
    summary: 'an upstream change',
    remediation: 'update the usage',
    symbols: ['Client.request'],
    confidence: 'high' as const,
    citations: ['evidence'],
    ...overrides,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

describe('recording audit: Python public surface identity', () => {
  test('sdist archive roots and docs are not Python API identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-python-surface-'));
    const script = join(root, 'surface.py');
    const extraction = join(root, 'extraction');
    const archiveRoot = join(extraction, 'itemloaders-1.0.1');

    try {
      await mkdir(join(archiveRoot, 'itemloaders'), { recursive: true });
      await mkdir(join(archiveRoot, 'docs'), { recursive: true });
      await writeFile(script, SURFACE_SCRIPT, 'utf8');
      await writeFile(join(archiveRoot, 'pyproject.toml'), '[project]\nname = "itemloaders"\n', 'utf8');
      await writeFile(join(archiveRoot, 'itemloaders', '__init__.py'), '', 'utf8');
      await writeFile(
        join(archiveRoot, 'itemloaders', 'processors.py'),
        'class TakeFirst: pass\nclass MapCompose: pass\nclass Compose: pass\n',
        'utf8',
      );
      await writeFile(join(archiveRoot, 'docs', 'conf.py'), 'def failure(error): pass\n', 'utf8');

      const result = await execFile('python3', [script, extraction, 'itemloaders']);
      const symbols = JSON.parse(result.stdout) as { name: string }[];
      const names = symbols.map((symbol) => symbol.name);

      assert.ok(names.includes('itemloaders.processors.TakeFirst'));
      assert.ok(names.includes('itemloaders.processors.MapCompose'));
      assert.ok(names.includes('itemloaders.processors.Compose'));
      assert.ok(!names.some((name) => name.startsWith('itemloaders-1.0.1.')));
      assert.ok(!names.some((name) => name.startsWith('docs.')));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('PEP 440 wrappers, src layouts, and non-package utility files canonicalize to import identity', async () => {
    for (const wrapper of ['itemloaders-1.0rc1', 'itemloaders-1.0.post1', 'itemloaders-1.0.dev1', 'itemloaders-2.0b3', 'itemloaders-1!2.0']) {
      const root = await mkdtemp(join(tmpdir(), 'drift-python-surface-'));
      const script = join(root, 'surface.py');
      const archive = join(root, 'extraction', wrapper);
      try {
        await mkdir(join(archive, 'src', 'mypackage'), { recursive: true });
        await writeFile(script, SURFACE_SCRIPT, 'utf8');
        await writeFile(join(archive, 'pyproject.toml'), '[project]\nname = "itemloaders"\n', 'utf8');
        await writeFile(join(archive, 'src', 'mypackage', '__init__.py'), '', 'utf8');
        await writeFile(join(archive, 'src', 'mypackage', 'client.py'), 'def fetch(): pass\n', 'utf8');
        await writeFile(join(archive, 'utility.py'), 'def accidental_api(): pass\n', 'utf8');

        const result = await execFile('python3', [script, join(root, 'extraction'), 'itemloaders']);
        const names = (JSON.parse(result.stdout) as { name: string }[]).map((symbol) => symbol.name);
        assert.ok(names.includes('mypackage.client.fetch'), wrapper);
        assert.ok(!names.some((name) => name.startsWith('src.') || name.includes(wrapper)), wrapper);
        assert.ok(!names.some((name) => name.includes('accidental_api')), wrapper);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test('PEP 420 namespace packages retain their top-level import identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-python-surface-'));
    const script = join(root, 'surface.py');
    const archive = join(root, 'extraction', 'google-cloud-foo-1.0.0');
    try {
      await mkdir(join(archive, 'google', 'cloud', 'foo'), { recursive: true });
      await mkdir(join(archive, 'google_cloud_foo.egg-info'), { recursive: true });
      await mkdir(join(archive, 'tools', 'utility'), { recursive: true });
      await writeFile(script, SURFACE_SCRIPT, 'utf8');
      await writeFile(join(archive, 'pyproject.toml'), '[project]\nname = "google-cloud-foo"\n', 'utf8');
      await writeFile(join(archive, 'google_cloud_foo.egg-info', 'top_level.txt'), 'google\n', 'utf8');
      await writeFile(join(archive, 'google', 'cloud', 'foo', '__init__.py'), '', 'utf8');
      await writeFile(join(archive, 'google', 'cloud', 'foo', 'client.py'), 'def fetch(): pass\n', 'utf8');
      await writeFile(join(archive, 'tools', 'utility', '__init__.py'), 'def accidental_api(): pass\n', 'utf8');

      const result = await execFile('python3', [script, join(root, 'extraction'), 'google-cloud-foo']);
      const names = (JSON.parse(result.stdout) as { name: string }[]).map((symbol) => symbol.name);
      assert.ok(names.includes('google.cloud.foo.client.fetch'));
      assert.ok(!names.some((name) => name.startsWith('cloud.foo') || name.startsWith('tools.')));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('recording audit: C and C++ public surface identity', () => {
  test('conversion operators are not members named after their primitive type', () => {
    const [entry] = parseHeader('class UISlider {\n public:\n  operator uint8_t();\n};');
    assert.ok(entry);
    assert.ok(!entry.members.includes('uint8_t'));
    assert.ok(entry.members.includes('operator uint8_t'));
  });

  test('operator removals and signature changes remain breaking surface changes', () => {
    const before = parseHeaderSurface([{ path: 'api.h', content: 'class Value {\n public:\n  operator uint8_t();\n  bool operator[](size_t index);\n};' }]);
    const removed = parseHeaderSurface([{ path: 'api.h', content: 'class Value {\n public:\n  bool operator[](size_t index);\n};' }]);
    const changed = parseHeaderSurface([{ path: 'api.h', content: 'class Value {\n public:\n  operator uint8_t();\n  bool operator[](int index);\n};' }]);
    assert.ok(diffSurfaces(before, removed).some((finding) => finding.symbol === 'Value.operator uint8_t'));
    assert.ok(diffSurfaces(before, changed).some((finding) => finding.symbol.includes('operator[](size_t)')));
  });

  test('subscript, call, and comparison operators are retained distinctly', () => {
    const [entry] = parseHeader([
      'class Value {',
      ' public:',
      '  bool operator[](size_t index);',
      '  void operator()(int value);',
      '  bool operator==(const Value &other) const;',
      '};',
    ].join('\n'));
    assert.ok(entry?.members.includes('operator[](size_t)'));
    assert.ok(entry?.members.includes('operator()(int)'));
    assert.ok(entry?.members.includes('operator==(const Value &) const'));
  });

  test('operator cv/ref/noexcept qualifiers remain part of canonical identity', () => {
    const [entry] = parseHeader([
      'class Value {',
      ' public:',
      '  explicit operator bool() const & noexcept;',
      '  void operator()() &;',
      '  void operator()(int value) &&;',
      '  int operator[](size_t index) const volatile &;',
      '};',
    ].join('\n'));

    assert.ok(entry?.members.includes('operator bool const & noexcept'));
    assert.ok(entry?.members.includes('operator()() &'));
    assert.ok(entry?.members.includes('operator()(int) &&'));
    assert.ok(entry?.members.includes('operator[](size_t) const volatile &'));
  });

  test('ref-qualifier changes are breaking and uncommon public operators are retained', () => {
    const before = parseHeaderSurface([{ path: 'api.h', content: [
      'class Awaitable {',
      ' public:',
      '  Awaitable operator co_await() &;',
      '};',
      'long double operator "" _distance(long double);',
    ].join('\n') }]);
    const after = parseHeaderSurface([{ path: 'api.h', content: [
      'class Awaitable {',
      ' public:',
      '  Awaitable operator co_await() &&;',
      '};',
      'long double operator "" _distance(long double);',
    ].join('\n') }]);

    assert.ok(before.get('Awaitable')?.members.includes('operator co_await() &'));
    assert.ok(before.has('operator""_distance(long double)'));
    assert.ok(diffSurfaces(before, after).some((finding) => finding.symbol.includes('operator co_await() &')));
  });

  test('namespace ownership survives surface extraction', () => {
    const entries = parseHeader(
      'namespace alpha {\nclass Widget { public: void open(); };\n}\nnamespace beta {\nclass Widget { public: void close(); };\n}',
    );
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['alpha.Widget', 'beta.Widget'],
    );
  });

  test('inline namespace version changes are transparent but ordinary namespace moves are not', () => {
    const v10 = parseHeaderSurface([{ path: 'fmt.h', content: 'namespace fmt {\ninline namespace v10 {\nvoid print();\n}\n}' }]);
    const v11 = parseHeaderSurface([{ path: 'fmt.h', content: 'namespace fmt {\ninline namespace v11 {\nvoid print();\n}\n}' }]);
    assert.deepEqual(diffSurfaces(v10, v11), []);
    assert.ok(v10.has('fmt.print'));

    const a = parseHeaderSurface([{ path: 'api.h', content: 'namespace a {\nvoid foo();\n}' }]);
    const b = parseHeaderSurface([{ path: 'api.h', content: 'namespace b {\nvoid foo();\n}' }]);
    assert.ok(diffSurfaces(a, b).some((finding) => finding.symbol === 'a.foo'));
  });

  test('anonymous namespace declarations are internal even in a public header', () => {
    const surface = parseHeaderSurface([{ path: 'api.h', content: 'namespace {\nvoid helper();\n}\nvoid public_api();' }]);
    assert.equal(surface.has('helper'), false);
    assert.equal(surface.has('public_api'), true);
  });

  test('surviving qualified APIs remain present across releases', () => {
    const before = parseHeaderSurface([
      { path: 'spdlog/logger.h', content: 'namespace spdlog {\nclass logger {\n public:\n  void level();\n  void name();\n  void sinks();\n};\n}' },
    ]);
    const after = parseHeaderSurface([
      { path: 'spdlog/details/logger.h', content: 'namespace spdlog {\nclass logger {\n public:\n  void level();\n  void name();\n  void sinks();\n};\n}' },
    ]);
    assert.deepEqual(diffSurfaces(before, after), []);
  });

  test('attributes do not hide surviving GoogleTest callables', () => {
    const before = parseHeaderSurface([{ path: 'gtest/gtest.h', content: 'int RUN_ALL_TESTS();\n' }]);
    const after = parseHeaderSurface([{
      path: 'gtest/gtest.h',
      content: '[[nodiscard]] int RUN_ALL_TESTS();\ninline int RUN_ALL_TESTS() { return 0; }\n',
    }]);
    assert.ok(after.has('RUN_ALL_TESTS'));
    assert.equal(diffSurfaces(before, after).some((change) => change.symbol === 'RUN_ALL_TESTS'), false);
  });

  test('common C declaration annotations do not hide surviving OpenSSL APIs', () => {
    const before = parseHeaderSurface([{
      path: 'openssl/ssl.h',
      content: '__owur int SSL_get_error(const SSL *s, int ret);\nvoid OPENSSL_cleanup(void);\n',
    }]);
    const after = parseHeaderSurface([{
      path: 'openssl/ssl.h',
      content: 'int SSL_get_error(const SSL *s, int ret);\nvoid OPENSSL_cleanup(void);\n',
    }]);
    assert.ok(after.has('SSL_get_error'));
    assert.ok(after.has('OPENSSL_cleanup'));
    assert.equal(diffSurfaces(before, after).length, 0);
  });

  test('repeated C declaration annotations are parsed without regex backtracking', () => {
    const annotations = Array.from({ length: 2_000 }, () => '__API').join('\t');
    const surface = parseHeaderSurface([{
      path: 'api.h',
      content: `${annotations}\tint public_api(void);\n`,
    }]);
    assert.ok(surface.has('public_api'));
  });
});

describe('recording audit: owner-aware localization', () => {
  test('qualified Dart members do not fall back to core bare-name matches', () => {
    const files = [file('lib/error.dart', 'dart', "import 'package:web/web.dart';\nfinal error = StateError('bad');")];
    const sites = localize(
      [change({ dependency: 'web', symbols: ['TouchListWrapper.StateError', 'StateError'] })],
      [dependency('web', 'pub')],
      buildIndex(files),
      files,
      { logger },
    );
    assert.equal(sites.length, 0);
  });

  test('qualified C++ members do not fall back to unrelated c_str calls', () => {
    const files = [file('src/log.cpp', 'cpp', '#include <spdlog/spdlog.h>\nvoid f() { other.c_str(); }')];
    const sites = localize(
      [change({ dependency: 'spdlog', symbols: ['basic_cstring_view.c_str', 'c_str'] })],
      [dependency('spdlog', 'conan')],
      buildIndex(files),
      files,
      { logger },
    );
    assert.equal(sites.length, 0);
  });

  test('C++ self calls and declarations do not impersonate a dependency function', () => {
    const files = [file(
      'src/light.h',
      'cpp',
      '#include <FastLED.h>\nclass Light {\n public:\n  inline int size() const { return 1; }\n  void draw() { this->size(); }\n};',
    )];
    const sites = localize(
      [change({ dependency: 'FastLED', symbols: ['size'], fromKind: 'function' })],
      [dependency('FastLED', 'arduino')],
      buildIndex(files),
      files,
      { logger },
    );
    assert.equal(sites.length, 0);
  });

  test('a removed C++ function does not match a longer namespace path but a call still does', () => {
    const files = [file(
      'src/log.cpp',
      'cpp',
      '#include <spdlog/spdlog.h>\nvoid f() {\n  auto x = spdlog::level::trace;\n  spdlog::level();\n}',
    )];
    const sites = localize(
      [change({ dependency: 'spdlog', symbols: ['spdlog.level', 'level'], fromKind: 'function' })],
      [dependency('spdlog', 'conan')],
      buildIndex(files),
      files,
      { logger },
    );
    assert.equal(sites.length, 1);
    assert.match(sites[0]?.excerpt ?? '', /spdlog::level\(\)/);
  });

  test('an explicitly owner-resolved member still localizes', () => {
    const files = [file('src/client.ts', 'typescript', "import { Client } from 'pkg';\nClient.request();")];
    const sites = localize(
      [change({ symbols: ['Client.request', 'request'] })],
      [dependency('pkg', 'npm')],
      buildIndex(files),
      files,
      { logger },
    );
    assert.ok(sites.length >= 1);
    assert.ok(sites.every((site) => site.confidence === 'high'));
  });

  test('unseen generic leaves require dependency ownership while real imports, aliases, and receivers survive', () => {
    for (const leaf of ['find', 'open', 'close', 'parse', 'create', 'get', 'set', 'read', 'write', 'build']) {
      const unrelated = [file('src/unrelated.ts', 'typescript', `import { Client } from 'pkg';\nother.${leaf}();`)];
      const falseSites = localize(
        [change({ symbols: [`Client.${leaf}`, leaf] })],
        [dependency('pkg', 'npm')],
        buildIndex(unrelated),
        unrelated,
        { logger },
      );
      assert.equal(falseSites.length, 0, leaf);

      const owned = [file('src/owned.ts', 'typescript', `import { Client as ApiClient } from 'pkg';\nconst client = new ApiClient();\nclient.${leaf}();`)];
      const trueSites = localize(
        [change({ symbols: [`Client.${leaf}`, leaf] })],
        [dependency('pkg', 'npm')],
        buildIndex(owned),
        owned,
        { logger },
      );
      assert.equal(trueSites.length, 1, leaf);
      assert.equal(trueSites[0]?.confidence, 'high', leaf);
    }
  });

  test('direct and destructured dependency members remain high-confidence positives', () => {
    const files = [file('src/direct.ts', 'typescript', "import { parse } from 'pkg';\nparse(input);")];
    const sites = localize(
      [change({ symbols: ['pkg.parse', 'parse'] })],
      [dependency('pkg', 'npm')],
      buildIndex(files),
      files,
      { logger },
    );
    assert.ok(sites.length >= 1);
    assert.ok(sites.every((site) => site.confidence === 'high'));
  });

  test('a same-package top-level export cannot impersonate an unrelated class member', () => {
    const files = [file('src/error.ts', 'typescript', "import { onError } from '@apollo/client/link/error';\nonError(handler);")];
    const sites = localize(
      [change({ dependency: '@apollo/client', symbols: ['QueryDataOptions.onError', 'onError'] })],
      [dependency('@apollo/client', 'npm')],
      buildIndex(files),
      files,
      { logger },
    );
    assert.equal(sites.length, 0);
  });

  test('a package-root relation alone cannot turn a public function into an internal method', () => {
    const files = [file(
      'tests/keys.py',
      'python',
      'from cryptography.hazmat.primitives.serialization import load_pem_private_key\nload_pem_private_key(data, None)',
    )];
    const sites = localize(
      [change({
        dependency: 'cryptography',
        symbols: [
          'cryptography.hazmat.backends.openssl.backend.Backend.load_pem_private_key',
          'Backend.load_pem_private_key',
          'load_pem_private_key',
        ],
      })],
      [dependency('cryptography', 'pypi')],
      buildIndex(files),
      files,
      { logger },
    );
    assert.equal(sites.length, 0);
  });

  test('a direct import from the qualified API module remains a real positive', () => {
    const files = [file('tests/server.py', 'python', 'from twisted.web.util import Redirect\nRedirect()')];
    const sites = localize(
      [change({ dependency: 'twisted', symbols: ['twisted.web.util.Redirect', 'Redirect'] })],
      [dependency('twisted', 'pypi')],
      buildIndex(files),
      files,
      { logger },
    );
    assert.ok(sites.length >= 1);
    assert.ok(sites.every((site) => site.confidence === 'high'));
  });
});

describe('recording audit: structured runtime requirements', () => {
  test('only a supported runtime with a numeric requirement is classified as runtime', () => {
    const [match] = matchProse('This release now requires Node.js >=18.');
    assert.equal(match?.kind, 'runtime-requirement');
    assert.deepEqual(match?.runtime, {
      kind: 'minimum-runtime',
      runtime: 'node',
      requirement: '>=18',
      sourceText: 'now requires Node.js >=18',
    });
  });

  test('feature, library, algorithm, and malformed prose are not runtime changes', () => {
    for (const text of [
      'Dropped support for HS512256',
      'Dropped support for importing internal files from lib/',
      'Dropped support for Mongoid < 8',
      'Dropped support for using HTML comments (...)',
      'Dropped support for legacy authentication',
      'Minimum Node version raised to .',
    ]) {
      assert.equal(matchProse(text).some((match) => match.kind === 'runtime-requirement'), false, text);
    }
  });

  test('bare dropped-support versions remain unsupported ranges without invented floors', () => {
    const ruby = matchProse('Removed support for Ruby 2.7').find((candidate) => candidate.kind === 'runtime-requirement');
    assert.deepEqual(ruby?.runtime, {
      kind: 'unsupported-runtime-range',
      runtime: 'ruby',
      requirement: '2.7.x',
      sourceText: 'Removed support for Ruby 2.7',
    });

    const node = matchProse('Dropped support for Node 16').find((candidate) => candidate.kind === 'runtime-requirement');
    assert.equal(node?.runtime?.kind, 'unsupported-runtime-range');
    assert.equal(node?.runtime?.requirement, '16.x');

    const withinRange = [file('.ruby-version', 'config', '2.7')];
    const affectedSites = localize(
      [change({ kind: 'runtime-requirement', symbols: ['ruby'], runtime: ruby?.runtime })] as never,
      [dependency('pkg', 'npm')],
      buildIndex(withinRange),
      withinRange,
      { logger },
    );
    assert.equal(affectedSites.length, 1, 'a declaration inside the explicitly unsupported range is a real finding');
    assert.equal(affectedSites[0]?.runtimeVerdict, 'incompatible');
    assert.equal(affectedSites[0]?.confidence, 'high');

    const outsideRange = [file('.ruby-version', 'config', '3.3.1')];
    const cleanSites = localize(
      [change({ kind: 'runtime-requirement', symbols: ['ruby'], runtime: ruby?.runtime })] as never,
      [dependency('pkg', 'npm')],
      buildIndex(outsideRange),
      outsideRange,
      { logger },
    );
    assert.deepEqual(cleanSites, [], 'a declaration outside the dropped range is unaffected');
  });

  test('an unsupported range that only partially overlaps a declared range surfaces as partial, not silent', () => {
    const node16 = matchProse('Dropped support for Node 16').find((candidate) => candidate.kind === 'runtime-requirement');
    const files = [file('package.json', 'json', '{"engines":{"node":">=16 <20"}}')];
    const sites = localize(
      [change({ kind: 'runtime-requirement', symbols: ['node'], runtime: node16?.runtime })] as never,
      [dependency('pkg', 'npm')],
      buildIndex(files),
      files,
      { logger },
    );
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.runtimeVerdict, 'partial');
  });

  test('dropped-support ^, ~, <, and <= preserve unsupported-range semantics rather than inverting into a floor', () => {
    const cases = [
      ['Dropped support for Node ^16', 'node', '^16', undefined],
      ['Dropped support for Node ~16', 'node', '~16', undefined],
      ['Dropped support for Node <18', 'node', '<18', '>=18'],
      ['Dropped support for Node <=16', 'node', '<=16', '>16'],
      ['No longer supports Python < 3.10', 'python', '<3.10', '>=3.10'],
    ] as const;
    for (const [text, runtime, requirement, derivedMinimum] of cases) {
      const match = matchProse(text).find((candidate) => candidate.kind === 'runtime-requirement');
      assert.equal(match?.runtime?.kind, 'unsupported-runtime-range', text);
      assert.equal(match?.runtime?.runtime, runtime, text);
      assert.equal(match?.runtime?.requirement, requirement, text);
      assert.equal(match?.runtime && 'derivedMinimum' in match.runtime ? match.runtime.derivedMinimum : undefined, derivedMinimum, text);
    }

    const caretFiles = [file('.nvmrc', 'config', '16.20.0')];
    const caretMatch = matchProse('Dropped support for Node ^16').find((c) => c.kind === 'runtime-requirement');
    const caretSites = localize(
      [change({ kind: 'runtime-requirement', symbols: ['node'], runtime: caretMatch?.runtime })] as never,
      [dependency('pkg', 'npm')],
      buildIndex(caretFiles),
      caretFiles,
      { logger },
    );
    assert.equal(caretSites.length, 1, 'a repository declaration inside the dropped ^16 line is affected');

    const clearFiles = [file('.nvmrc', 'config', '18.0.0')];
    const caretClear = localize(
      [change({ kind: 'runtime-requirement', symbols: ['node'], runtime: caretMatch?.runtime })] as never,
      [dependency('pkg', 'npm')],
      buildIndex(clearFiles),
      clearFiles,
      { logger },
    );
    assert.deepEqual(caretClear, [], 'Node 18 is untouched by a dropped ^16 line');
  });

  test('explicit dropped ranges and minimum-runtime phrasings remain minimum findings', () => {
    const cases = [
      ['Requires Node.js >=18', 'node', '>=18'],
      ['Requires Node.js >= 18', 'node', '>=18'],
      ['Minimum Java version raised to 21', 'java', '>=21'],
    ] as const;
    for (const [text, runtime, requirement] of cases) {
      const match = matchProse(text).find((candidate) => candidate.kind === 'runtime-requirement');
      assert.equal(match?.runtime?.kind, 'minimum-runtime', text);
      assert.equal(match?.runtime?.runtime, runtime, text);
      assert.equal(match?.runtime?.requirement, requirement, text);
    }
  });

  test('runtime localization is owner-aware and only reports incompatible declarations', () => {
    const files = [
      file('.nvmrc', 'config', '22.12.0\n'),
      file('.node-version', 'config', '24.0.0\n'),
      file('.ruby-version', 'config', '3.3.11\n'),
      file('.tool-versions', 'config', 'nodejs 22.12.0\nruby 3.3.11\ngitleaks 8.24.3\n'),
    ];
    const nodeChange = change({
      kind: 'runtime-requirement',
      dependency: 'pkg',
      symbols: ['node'],
      runtime: { kind: 'minimum-runtime', runtime: 'node', requirement: '>=24', sourceText: 'Node >=24' },
    });
    const sites = localize([nodeChange], [dependency('pkg', 'npm')], buildIndex(files), files, { logger });
    assert.deepEqual(sites.map((site) => [site.file, site.line]), [
      ['.nvmrc', 1],
      ['.tool-versions', 1],
    ]);

    const compatible = localize(
      [{ ...nodeChange, runtime: { ...nodeChange.runtime!, requirement: '>=18' } }],
      [dependency('pkg', 'npm')],
      buildIndex([file('.nvmrc', 'config', '22.12.0\n')]),
      [file('.nvmrc', 'config', '22.12.0\n')],
      { logger },
    );
    assert.equal(compatible.length, 0);

    const ruby = localize(
      [{ ...nodeChange, runtime: { ...nodeChange.runtime!, runtime: 'ruby', requirement: '>=3.2' }, symbols: ['ruby'] }],
      [dependency('pkg', 'npm')],
      buildIndex([file('.ruby-version', 'config', '3.3.11\n')]),
      [file('.ruby-version', 'config', '3.3.11\n')],
      { logger },
    );
    assert.equal(ruby.length, 0);
  });

  test('every supported runtime localizes only its incompatible authoritative declaration', () => {
    const fixtures = [
      ['node', '>=24', '.nvmrc', '22'],
      ['python', '>=3.13', 'Dockerfile', 'FROM python:3.11'],
      ['ruby', '>=3.4', '.ruby-version', '3.3'],
      ['go', '>=1.25', 'go.mod', 'go 1.23'],
      ['java', '>=21', 'Containerfile', 'FROM eclipse-temurin:17'],
      ['rust', '>=1.90', 'rust-toolchain', '1.82'],
    ] as const;
    for (const [runtime, requirement, path, content] of fixtures) {
      const files = [file(path, 'config', content)];
      const runtimeChange = change({
        id: `runtime-${runtime}`,
        kind: 'runtime-requirement',
        symbols: [runtime],
        runtime: { kind: 'minimum-runtime', runtime, requirement, sourceText: `${runtime} ${requirement}` },
      });
      const sites = localize([runtimeChange] as never, [dependency('pkg', 'npm')], buildIndex(files), files, { logger });
      assert.deepEqual(sites.map((site) => site.file), [path], runtime);
    }
  });
});

describe('recording audit: Swift tag families', () => {
  test('a calendar tag cannot outrank an ordinary semantic version', async () => {
    globalThis.fetch = (() => Promise.resolve(json([{ name: '2016.12.26' }]))) as typeof fetch;
    const result = await lookupVersions({
      name: 'facebook/yoga',
      ecosystem: 'swift',
      current: '3.2.1',
      range: '3.2.1',
    });
    assert.equal(result.outcome, 'unchecked');
    if (result.outcome === 'unchecked') assert.match(result.reason, /no tags.*family/i);
  });

  test('newer tags in the same semantic family remain selectable', async () => {
    globalThis.fetch = (() => Promise.resolve(json([{ name: '3.3.0' }, { name: '2016.12.26' }]))) as typeof fetch;
    const result = await lookupVersions({ name: 'facebook/yoga', ecosystem: 'swift', current: '3.2.1', range: '3.2.1' });
    assert.equal(result.outcome, 'upgrade');
    if (result.outcome === 'upgrade') assert.equal(result.latest, '3.3.0');
  });
});

describe('recording audit: nested project ownership', () => {
  test('fixture registries are not projects while legitimate siblings remain discoverable', async () => {
    const files = {
      'package.json': '{"name":"root"}',
      'extension/package.json': '{"name":"extension"}',
      'tests/registry/npm/@denotest/example/1.0.0/package.json': '{"name":"@denotest/example"}',
      'tests/testdata/snapshot/package.json': '{"name":"snapshot"}',
    };
    const paths = Object.keys(files);
    const strip = (path: string) => path.replace(/^\/+/, '');
    const fs = {
      async readDirectory(path: string) {
        const prefix = strip(path) ? `${strip(path)}/` : '';
        const names = new Set<string>();
        for (const filePath of paths) {
          if (!filePath.startsWith(prefix)) continue;
          const rest = filePath.slice(prefix.length);
          if (rest) names.add(rest.split('/')[0]!);
        }
        return [...names];
      },
      async isDirectory(path: string) {
        const target = strip(path);
        return paths.some((filePath) => filePath.startsWith(`${target}/`));
      },
      async readFile(path: string) {
        return files[strip(path)] ?? null;
      },
    };
    const found = await discoverNestedProjects('', fs);
    assert.deepEqual(found.map((project) => project.dir), ['extension']);
  });
});

describe('recording audit: weak localization recommendations', () => {
  test('lexical-only impact cannot headline as migration required', () => {
    const result = assessUpgrade({
      dependency: 'pkg',
      breakingChanges: [{
        ...change({ kind: 'runtime-requirement', symbols: ['node'] }),
      }],
      impactSites: [{
        breakingChangeId: 'audit-change',
        file: 'src/a.ts',
        line: 1,
        excerpt: 'node',
        matchedSymbol: 'node',
        confidence: 'low',
      }],
      evidence: [],
      security: { checked: false, current: [], target: [], resolved: [], introduced: [], carried: [], direction: 'unknown' },
      maintenance: { facts: [] },
      license: { verdict: 'ok', statement: 'ok', introduced: [] },
      gaps: [],
      surfaceCompared: true,
    });
    assert.equal(result.recommendation, 'upgrade-after-review');
  });

  test('decision headlines and reason counts use only high-confidence locally affected changes', () => {
    const mechanical = change({ id: 'mechanical', kind: 'removed-export' });
    const unusedDecision = change({ id: 'unused-decision', kind: 'signature-change' });
    const localDecision = change({ id: 'local-decision', kind: 'signature-change' });
    const baseInput = {
      dependency: 'pkg', evidence: [],
      security: { checked: false, current: [], target: [], resolved: [], introduced: [], carried: [], direction: 'unknown' as const },
      maintenance: { facts: [] }, license: { verdict: 'ok' as const, statement: 'ok', introduced: [] },
      gaps: [], surfaceCompared: true,
    };
    const mechanicalOnly = assessUpgrade({
      ...baseInput,
      breakingChanges: [mechanical, unusedDecision] as never,
      impactSites: [{ breakingChangeId: 'mechanical', file: 'a.ts', line: 1, excerpt: 'x', matchedSymbol: 'x', confidence: 'high' }] as never,
    });
    assert.equal(mechanicalOnly.recommendation, 'upgrade-after-review');
    assert.equal(mechanicalOnly.reasons.some((reason) => /developer decision/.test(reason)), false);

    const decision = assessUpgrade({
      ...baseInput,
      breakingChanges: [mechanical, unusedDecision, localDecision] as never,
      impactSites: [{ breakingChangeId: 'local-decision', file: 'b.ts', line: 1, excerpt: 'x()', matchedSymbol: 'x', confidence: 'high' }] as never,
    });
    assert.equal(decision.recommendation, 'manual-migration-required');
    assert.ok(decision.reasons.some((reason) => /^1 locally affected change requires/.test(reason)));

    const weak = assessUpgrade({
      ...baseInput,
      breakingChanges: [localDecision] as never,
      impactSites: [{ breakingChangeId: 'local-decision', file: 'b.ts', line: 1, excerpt: 'x()', matchedSymbol: 'x', confidence: 'medium' }] as never,
    });
    assert.equal(weak.recommendation, 'upgrade-after-review');
  });
});
