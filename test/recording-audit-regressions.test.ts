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
      await writeFile(
        join(archiveRoot, 'itemloaders', 'processors.py'),
        'class TakeFirst: pass\nclass MapCompose: pass\nclass Compose: pass\n',
        'utf8',
      );
      await writeFile(join(archiveRoot, 'docs', 'conf.py'), 'def failure(error): pass\n', 'utf8');

      const result = await execFile('python3', [script, extraction]);
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
});

describe('recording audit: C and C++ public surface identity', () => {
  test('conversion operators are not members named after their primitive type', () => {
    const [entry] = parseHeader('class UISlider {\n public:\n  operator uint8_t();\n};');
    assert.ok(entry);
    assert.ok(!entry.members.includes('uint8_t'));
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

  test('surviving qualified APIs remain present across releases', () => {
    const before = parseHeaderSurface([
      { path: 'spdlog/logger.h', content: 'namespace spdlog { class logger { public: void level(); void name(); void sinks(); }; }' },
    ]);
    const after = parseHeaderSurface([
      { path: 'spdlog/details/logger.h', content: 'namespace spdlog { class logger { public: void level(); void name(); void sinks(); }; }' },
    ]);
    assert.deepEqual(diffSurfaces(before, after), []);
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

  test('an explicitly owner-resolved member still localizes', () => {
    const files = [file('src/client.ts', 'typescript', "import { Client } from 'pkg';\nClient.request();")];
    const sites = localize(
      [change({ symbols: ['Client.request', 'request'] })],
      [dependency('pkg', 'npm')],
      buildIndex(files),
      files,
      { logger },
    );
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.confidence, 'high');
  });
});

describe('recording audit: structured runtime requirements', () => {
  test('only a supported runtime with a numeric requirement is classified as runtime', () => {
    const [match] = matchProse('This release now requires Node.js >=18.');
    assert.equal(match?.kind, 'runtime-requirement');
    assert.deepEqual(match?.runtime, {
      kind: 'runtime-requirement',
      runtime: 'node',
      requirement: '>=18',
      sourceText: 'requires Node.js >=18',
    });
  });

  test('feature, library, algorithm, and malformed prose are not runtime changes', () => {
    for (const text of [
      'Dropped support for HS512256',
      'Dropped support for importing internal files from lib/',
      'Dropped support for Mongoid < 8',
      'Dropped support for using HTML comments (...)',
      'Minimum Node version raised to .',
    ]) {
      assert.equal(matchProse(text).some((match) => match.kind === 'runtime-requirement'), false, text);
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
      runtime: { kind: 'runtime-requirement', runtime: 'node', requirement: '>=24', sourceText: 'Node >=24' },
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
    assert.deepEqual(result, { outcome: 'up-to-date' });
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
});
