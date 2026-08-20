import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, unitAtLine, packageNameFromSpecifier } from '../dist/index/metarag.js';
import { localize } from '../dist/localize/index.js';
import { analyze } from '../dist/analyze/index.js';
import { DEFAULT_CONFIG } from '../dist/config/schema.js';
import { createLogger } from '../dist/util/logger.js';

const logger = createLogger('error');

/** A minimal DependencyChange, for tests that only need name + ecosystem. */
const dep = (name: string, ecosystem: string) => ({
  name,
  ecosystem: ecosystem as never,
  from: '1.0.0',
  to: '2.0.0',
  kind: 'runtime' as const,
  bump: 'major' as const,
  manifestPath: 'package.json',
});

const file = (path: string, language: string, content: string) => ({
  path,
  language: language as never,
  content,
  lineCount: content.split('\n').length,
});

const moduleSystemChange = (
  dependency: string,
  affectedSpecifiers?: string[],
  affectedSpecifierPatterns?: string[],
) => ({
  id: `bc-module-${dependency}-${affectedSpecifiers?.join('-') ?? affectedSpecifierPatterns?.join('-') ?? 'all'}`,
  dependency,
  kind: 'module-system-change' as const,
  summary: 'The package no longer exposes CommonJS loading compatibility',
  remediation: 'Use ESM-compatible loading.',
  symbols: [],
  moduleSystem: {
    from: 'dual' as const,
    to: 'esm' as const,
    incompatibleUsage: ['require' as const],
    ...(affectedSpecifiers ? { affectedSpecifiers } : {}),
    ...(affectedSpecifierPatterns ? { affectedSpecifierPatterns } : {}),
  },
  confidence: 'high' as const,
  citations: ['ev_1'],
});

describe('specifier parsing', () => {
  test('resolves subpaths to their package', () => {
    assert.equal(packageNameFromSpecifier('lodash/fp'), 'lodash');
    assert.equal(packageNameFromSpecifier('@scope/pkg/sub/deep'), '@scope/pkg');
    assert.equal(packageNameFromSpecifier('express'), 'express');
  });
});

describe('Meta-RAG index', () => {
  test('records imports with the names they bind', () => {
    const index = buildIndex([
      file(
        'src/api.ts',
        'typescript',
        `import { createClient, type Options } from 'acme-sdk';
import defaultExport from 'other-pkg';
import './local';

export function makeClient(options: Options) {
  return createClient(options);
}`,
      ),
    ]);

    const imports = index.files[0]!.imports;
    assert.equal(imports.length, 2, 'relative imports are not dependencies');

    const acme = imports.find((i) => i.packageName === 'acme-sdk');
    assert.ok(acme?.bindings.includes('createClient'));
    assert.ok(acme?.bindings.includes('Options'));
  });

  test('recovers names from destructured require', () => {
    const index = buildIndex([
      file('src/legacy.js', 'javascript', `const { createClient } = require('acme-sdk');`),
    ]);
    assert.ok(index.files[0]!.imports[0]?.bindings.includes('createClient'));
  });

  test('preserves JavaScript and TypeScript loading forms', () => {
    const index = buildIndex([
      file(
        'src/loads.js',
        'javascript',
        `import x from 'pkg';
const y = require('pkg');
const z = await import('pkg');
export { q } from 'pkg';`,
      ),
    ]);

    assert.deepEqual(
      index.files[0]!.imports.map((record) => [record.line, record.loadStyle]),
      [
        [1, 'esm-static'],
        [2, 'commonjs-require'],
        [3, 'esm-dynamic'],
        [4, 're-export'],
      ],
    );
  });

  test('builds a reverse importer map', () => {
    const index = buildIndex([
      file('a.ts', 'typescript', `import { x } from 'acme-sdk';`),
      file('b.ts', 'typescript', `import { y } from 'acme-sdk';`),
      file('c.ts', 'typescript', `import { z } from 'other';`),
    ]);

    assert.deepEqual(index.importers.get('acme-sdk')?.sort(), ['a.ts', 'b.ts']);
  });

  test('indexes functions, classes and methods with boundaries', () => {
    const index = buildIndex([
      file(
        'src/client.ts',
        'typescript',
        `export function helper(a: string): number {
  return a.length;
}

export class Client {
  request(path: string) {
    return fetch(path);
  }
}`,
      ),
    ]);

    const units = index.files[0]!.units;
    assert.ok(units.some((u) => u.name === 'helper' && u.kind === 'function'));
    assert.ok(units.some((u) => u.name === 'Client' && u.kind === 'class'));
    assert.ok(units.some((u) => u.name === 'Client.request' && u.kind === 'method'));
  });

  test('finds the innermost unit containing a line', () => {
    const index = buildIndex([
      file(
        'src/client.ts',
        'typescript',
        `export class Client {
  request() {
    return 1;
  }
}`,
      ),
    ]);

    const unit = unitAtLine(index.files[0]!, 3);
    assert.equal(unit?.name, 'Client.request', 'the method wins over the enclosing class');
  });

  test('does not let a nested const shadow its enclosing function', () => {
    const index = buildIndex([
      file(
        'src/api.ts',
        'typescript',
        `export function fetchUser(id: string) {
  const client = createClient();
  return client.request(id);
}`,
      ),
    ]);

    const unit = unitAtLine(index.files[0]!, 2);
    assert.equal(
      unit?.name,
      'fetchUser',
      'reporting a call site as "in `client`" instead of "in `fetchUser`" is worse than useless',
    );
  });

  test('indexes python declarations', () => {
    const index = buildIndex([
      file(
        'app.py',
        'python',
        `from flask import Flask

def create_app():
    return Flask(__name__)

class Config:
    debug = True`,
      ),
    ]);

    const indexed = index.files[0]!;
    assert.equal(indexed.imports[0]?.packageName, 'flask');
    assert.ok(indexed.units.some((u) => u.name === 'create_app'));
    assert.ok(indexed.units.some((u) => u.name === 'Config'));
  });
});

describe('localization', () => {
  const removedExport = {
    id: 'bc_1',
    dependency: 'acme-sdk',
    kind: 'removed-export' as const,
    summary: '`createClient` was removed.',
    remediation: 'Replace it.',
    symbols: ['createClient'],
    confidence: 'high' as const,
    citations: ['ev_1'],
  };

  const dependencyChange = {
    name: 'acme-sdk',
    ecosystem: 'npm' as const,
    from: '1.0.0',
    to: '2.0.0',
    kind: 'runtime' as const,
    bump: 'major' as const,
    manifestPath: 'package.json',
  };

  test('finds usages in importing files', () => {
    const files = [
      file(
        'src/api.ts',
        'typescript',
        `import { createClient } from 'acme-sdk';

export function setup() {
  return createClient({ retries: 3 });
}`,
      ),
    ];

    const sites = localize([removedExport], [dependencyChange], buildIndex(files), files, { logger });

    assert.ok(sites.length >= 1);
    assert.equal(sites[0]?.file, 'src/api.ts');
    assert.equal(sites[0]?.confidence, 'high', 'the symbol was bound from that import');
  });

  test('ignores files that do not import the dependency', () => {
    const files = [
      file('src/unrelated.ts', 'typescript', `function createClient() { return null; }`),
    ];

    const sites = localize([removedExport], [dependencyChange], buildIndex(files), files, { logger });
    assert.equal(sites.length, 0, 'a same-named local function is not an impact site');
  });

  test('attributes a site to its enclosing symbol', () => {
    const files = [
      file(
        'src/api.ts',
        'typescript',
        `import { createClient } from 'acme-sdk';

export function setup() {
  return createClient();
}`,
      ),
    ];

    const sites = localize([removedExport], [dependencyChange], buildIndex(files), files, { logger });
    const inFunction = sites.find((s) => s.line === 4);
    assert.equal(inFunction?.enclosingSymbol, 'setup');
  });

  test('respects word boundaries', () => {
    const files = [
      file(
        'src/api.ts',
        'typescript',
        `import { get } from 'acme-sdk';

const a = getUserById(1);
const b = forget();
const c = get('/x');`,
      ),
    ];

    const change = { ...removedExport, symbols: ['get'] };
    const sites = localize([change], [dependencyChange], buildIndex(files), files, { logger });
    const lines = sites.map((s) => s.line);

    assert.ok(lines.includes(5), 'the real call is found');
    assert.ok(!lines.includes(3), 'getUserById must not match');
    assert.ok(!lines.includes(4), 'forget must not match');
  });

  test('skips comment-only lines', () => {
    const files = [
      file(
        'src/api.ts',
        'typescript',
        `import { createClient } from 'acme-sdk';
// createClient is deprecated
const c = createClient();`,
      ),
    ];

    const sites = localize([removedExport], [dependencyChange], buildIndex(files), files, { logger });
    assert.ok(!sites.some((s) => s.line === 2), 'a comment is not an impact site');
  });

  test('searches the whole repo for endpoint changes, which have no import edge', () => {
    const files = [
      file('src/http.ts', 'typescript', `const res = await fetch('/api/v1/users/123');`),
    ];

    const endpointChange = {
      ...removedExport,
      kind: 'removed-endpoint' as const,
      symbols: ['/api/v1/users'],
    };

    const sites = localize([endpointChange], [dependencyChange], buildIndex(files), files, { logger });
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.confidence, 'low', 'no import link could be established');
  });

  test('maps python distribution names to their import names', () => {
    const files = [file('app.py', 'python', `import bs4\nsoup = bs4.BeautifulSoup(html)`)];

    const pypiChange = {
      ...dependencyChange,
      name: 'beautifulsoup4',
      ecosystem: 'pypi' as const,
    };
    const change = { ...removedExport, dependency: 'beautifulsoup4', symbols: ['BeautifulSoup'] };

    const sites = localize([change], [pypiChange], buildIndex(files), files, { logger });
    assert.equal(sites.length, 1, 'beautifulsoup4 is imported as bs4');
  });

  test('matches a scoped package name, where \\b would silently fail', () => {
    const files = [
      file('src/a.ts', 'typescript', `import timer from '@szmarczak/http-timer';\ntimer();`),
    ];

    const scoped = { ...dependencyChange, name: '@szmarczak/http-timer' };
    const change = {
      ...removedExport,
      dependency: '@szmarczak/http-timer',
      kind: 'config-change' as const,
      symbols: ['@szmarczak/http-timer'],
    };

    const sites = localize([change], [scoped], buildIndex(files), files, { logger });
    assert.ok(
      sites.length > 0,
      '`\\b@scope/pkg\\b` never matches, because \\b is defined against word characters',
    );
  });

  test('module-system changes only localize incompatible CommonJS require sites', () => {
    const files = [
      file(
        'src/usage.js',
        'javascript',
        `import x from 'pkg';
const y = require('pkg');
const z = await import('pkg');
export { q } from 'pkg';
const text = "pkg";
// require('pkg') in a comment`,
      ),
    ];
    const change = {
      id: 'bc-module',
      dependency: 'pkg',
      kind: 'module-system-change' as const,
      summary: 'The package is now ESM-only and no longer supports `require()`',
      remediation: 'Use ESM-compatible loading.',
      symbols: [],
      moduleSystem: { from: 'dual' as const, to: 'esm' as const, incompatibleUsage: ['require' as const] },
      confidence: 'high' as const,
      citations: ['ev_1'],
    };

    const sites = localize([change], [dep('pkg', 'npm')], buildIndex(files), files, { logger });

    assert.deepEqual(sites.map((site) => site.line), [2]);
    assert.equal(sites[0]?.matchedSymbol, 'require');
  });

  test('module-system changes support scoped package require sites', () => {
    const files = [
      file('src/usage.js', 'javascript', `const plugin = require('@scope/pkg');`),
    ];
    const change = {
      id: 'bc-module-scoped',
      dependency: '@scope/pkg',
      kind: 'module-system-change' as const,
      summary: 'The package is now ESM-only and no longer supports `require()`',
      remediation: 'Use ESM-compatible loading.',
      symbols: [],
      moduleSystem: { from: 'dual' as const, to: 'esm' as const, incompatibleUsage: ['require' as const] },
      confidence: 'high' as const,
      citations: ['ev_1'],
    };

    const sites = localize([change], [dep('@scope/pkg', 'npm')], buildIndex(files), files, { logger });

    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.file, 'src/usage.js');
  });

  test('subpath module-system changes do not flag the root package require', () => {
    const files = [
      file(
        'src/usage.js',
        'javascript',
        `const root = require('pkg');
const foo = require('pkg/foo');`,
      ),
    ];
    const change = moduleSystemChange('pkg', ['pkg/foo']);

    const sites = localize([change], [dep('pkg', 'npm')], buildIndex(files), files, { logger });

    assert.deepEqual(sites.map((site) => site.line), [2]);
    assert.equal(sites[0]?.excerpt, `const foo = require('pkg/foo');`);
  });

  test('subpath module-system changes only flag the affected subpath', () => {
    const files = [
      file(
        'src/usage.js',
        'javascript',
        `const foo = require('pkg/foo');
const bar = require('pkg/bar');`,
      ),
    ];
    const change = moduleSystemChange('pkg', ['pkg/foo']);

    const sites = localize([change], [dep('pkg', 'npm')], buildIndex(files), files, { logger });

    assert.deepEqual(sites.map((site) => site.line), [1]);
  });

  test('subpath module-system changes handle scoped packages', () => {
    const files = [
      file(
        'src/usage.js',
        'javascript',
        `const root = require('@scope/pkg');
const foo = require('@scope/pkg/foo');`,
      ),
    ];
    const change = moduleSystemChange('@scope/pkg', ['@scope/pkg/foo']);

    const sites = localize([change], [dep('@scope/pkg', 'npm')], buildIndex(files), files, { logger });

    assert.deepEqual(sites.map((site) => site.line), [2]);
  });

  test('root module-system changes do not flag unaffected subpaths', () => {
    const files = [
      file(
        'src/usage.js',
        'javascript',
        `const root = require('pkg');
const foo = require('pkg/foo');`,
      ),
    ];
    const change = moduleSystemChange('pkg', ['pkg']);

    const sites = localize([change], [dep('pkg', 'npm')], buildIndex(files), files, { logger });

    assert.deepEqual(sites.map((site) => site.line), [1]);
  });

  test('package-wide module-system changes still flag package and subpath require sites', () => {
    const files = [
      file(
        'src/usage.js',
        'javascript',
        `const root = require('pkg');
const foo = require('pkg/foo');`,
      ),
    ];
    const change = moduleSystemChange('pkg');

    const sites = localize([change], [dep('pkg', 'npm')], buildIndex(files), files, { logger });

    assert.deepEqual(sites.map((site) => site.line), [1, 2]);
  });

  test('affected subpath module-system changes respect loading style', () => {
    const files = [
      file(
        'src/usage.js',
        'javascript',
        `import x from 'pkg/foo';
const z = await import('pkg/foo');
export { x } from 'pkg/foo';
const y = require('pkg/foo');`,
      ),
    ];
    const change = moduleSystemChange('pkg', ['pkg/foo']);

    const sites = localize([change], [dep('pkg', 'npm')], buildIndex(files), files, { logger });

    assert.deepEqual(sites.map((site) => site.line), [4]);
  });

  test('wildcard subpath module-system changes flag matching require sites only', () => {
    const files = [
      file(
        'src/usage.js',
        'javascript',
        `const root = require('pkg');
const a = require('pkg/features/foo');
const b = require('pkg/features/bar');
const deep = require('pkg/features/deep/path');
const other = require('pkg/other');
const typo = require('pkg/feature/foo');
const external = require('other/features/foo');`,
      ),
    ];
    const change = moduleSystemChange('pkg', undefined, ['pkg/features/*']);

    const sites = localize([change], [dep('pkg', 'npm')], buildIndex(files), files, { logger });

    assert.deepEqual(sites.map((site) => site.line), [2, 3, 4]);
  });

  test('scoped wildcard subpath module-system changes stay inside the scoped package', () => {
    const files = [
      file(
        'src/usage.js',
        'javascript',
        `const root = require('@scope/pkg');
const a = require('@scope/pkg/features/foo');
const other = require('@scope/other/features/foo');`,
      ),
    ];
    const change = moduleSystemChange('@scope/pkg', undefined, ['@scope/pkg/features/*']);

    const sites = localize([change], [dep('@scope/pkg', 'npm')], buildIndex(files), files, { logger });

    assert.deepEqual(sites.map((site) => site.line), [2]);
  });

  test('exact and wildcard metadata does not create duplicate impact sites', () => {
    const files = [
      file(
        'src/usage.js',
        'javascript',
        `const a = require('pkg/features/foo');`,
      ),
    ];
    const change = moduleSystemChange('pkg', ['pkg/features/foo'], ['pkg/features/*']);

    const sites = localize([change], [dep('pkg', 'npm')], buildIndex(files), files, { logger });

    assert.deepEqual(sites.map((site) => site.line), [1]);
  });

  test('original ESM-only helper prose regression has no finding, site, or require migration', async () => {
    const evidence = [{
      id: 'ev_svelte_like',
      source: 'changelog' as const,
      dependency: '@example/plugin',
      title: '@example/plugin release notes',
      content: 'perf: switch from debug to obug (smaller, esm-only)',
      weight: 0.65,
    }];
    const changes = [dep('@example/plugin', 'npm')];
    const breaking = await analyze(changes, evidence, { config: DEFAULT_CONFIG, logger });
    const files = [
      file('package.json', 'config', `{"type":"module"}`),
      file('src/svelte.config.js', 'javascript', `import { vitePreprocess } from '@example/plugin';`),
    ];
    const sites = localize(breaking, changes, buildIndex(files), files, { logger });

    assert.equal(breaking.some((change) => change.kind === 'module-system-change'), false);
    assert.equal(sites.length, 0);
    assert.equal(breaking.some((change) => /require\(/i.test(change.remediation)), false);
  });

  test('genuine ESM-only prose localizes require and generates matching remediation', async () => {
    const evidence = [{
      id: 'ev_esm',
      source: 'changelog' as const,
      dependency: '@example/plugin',
      title: '@example/plugin release notes',
      content: 'This package is now ESM-only.',
      weight: 0.65,
    }];
    const changes = [dep('@example/plugin', 'npm')];
    const breaking = await analyze(changes, evidence, { config: DEFAULT_CONFIG, logger });
    const files = [
      file('src/config.cjs', 'javascript', `const { plugin } = require('@example/plugin');`),
    ];
    const sites = localize(breaking, changes, buildIndex(files), files, { logger });
    const moduleChange = breaking.find((change) => change.kind === 'module-system-change');

    assert.ok(moduleChange);
    assert.deepEqual(moduleChange.symbols, []);
    assert.match(moduleChange.remediation, /require\('@example\/plugin'\)/);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.line, 1);
    assert.equal(sites[0]?.matchedSymbol, 'require');
  });

  test('locates a runtime requirement in config, not in source prose', () => {
    const files = [
      file('src/a.ts', 'typescript', `// Requires Node.js 14 or later to run.\nexport const x = 1;`),
      file('.nvmrc', 'config', '12.22.0\n'),
      file('package.json', 'config', `{\n  "engines": { "node": ">=12" }\n}`),
    ];

    const runtimeChange = {
      ...removedExport,
      kind: 'runtime-requirement' as const,
      symbols: ['Node.js'],
    };

    const sites = localize([runtimeChange], [dependencyChange], buildIndex(files), files, { logger });
    const paths = sites.map((s) => s.file);

    assert.ok(paths.includes('.nvmrc'));
    assert.ok(paths.includes('package.json'));
    assert.ok(
      !paths.includes('src/a.ts'),
      'matching "Node.js" in a source comment is a pure false positive',
    );
  });

  test('deduplicates multiple symbol hits on one line', () => {
    const files = [
      file(
        'src/api.ts',
        'typescript',
        `import { createClient, Options } from 'acme-sdk';
const c = createClient({} as Options);`,
      ),
    ];

    const change = { ...removedExport, symbols: ['createClient', 'Options'] };
    const sites = localize([change], [dependencyChange], buildIndex(files), files, { logger });
    const line2 = sites.filter((s) => s.line === 2);

    assert.equal(line2.length, 1, 'one line is one site');
  });
});

/**
 * Precision: a match has to be evidence, not a coincidence.
 *
 * Both of these came from a real run of Drift against Scrapy, whose Twisted
 * dependency reported a handful of genuine removals as 229 affected sites. The
 * sites were things like `def __init__(self):` in files that had never heard of
 * the class that changed, and sentences inside docstrings that happened to
 * contain the word `define`. A report like that is worse than no report: it
 * costs a developer an afternoon and teaches them the tool guesses.
 */
describe('symbols too generic to be evidence', () => {
  test("a dotted symbol's leaf is dropped when every class in the language has one", () => {
    const change = {
      id: 'bc1',
      dependency: 'twisted',
      kind: 'removed-export' as const,
      summary: '`_synctest.Todo.__init__` was removed.',
      remediation: 'Use the replacement.',
      // What `symbolsFromFinding` now produces: the qualified forms, never the
      // bare `__init__`.
      symbols: ['_synctest.Todo.__init__', 'Todo.__init__'],
      confidence: 'high' as const,
      citations: ['e1'],
    };

    const files = [
      file(
        'extras/bench.py',
        'python',
        `import twisted

class Server:
    def __init__(self):
        Resource.__init__(self)`,
      ),
    ];

    const sites = localize(change ? [change] : [], [dep('twisted', 'pypi')], buildIndex(files), files, {
      logger,
    });

    assert.equal(sites.length, 0, 'a constructor in an unrelated class is not a use of Todo');
  });

  test('a qualified reference to the same symbol is still found', () => {
    const change = {
      id: 'bc1',
      dependency: 'twisted',
      kind: 'removed-export' as const,
      summary: '`_synctest.Todo.__init__` was removed.',
      remediation: 'Use the replacement.',
      symbols: ['_synctest.Todo.__init__', 'Todo.__init__'],
      confidence: 'high' as const,
      citations: ['e1'],
    };

    const files = [
      file('t.py', 'python', `import twisted\n\nTodo.__init__(self, reason)`),
    ];

    const sites = localize([change], [dep('twisted', 'pypi')], buildIndex(files), files, { logger });
    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.matchedSymbol, 'Todo.__init__');
  });
});

describe('prose is not code', () => {
  const change = (symbols: string[]) => ({
    id: 'bc1',
    dependency: 'twisted',
    kind: 'removed-export' as const,
    summary: '`define` is no longer exported.',
    remediation: 'Use the replacement.',
    symbols,
    confidence: 'high' as const,
    citations: ['e1'],
  });

  test('an identifier inside a docstring is not an impact site', () => {
    const files = [
      file(
        'scrapy/commands/__init__.py',
        'python',
        `import twisted


def process_options(self):
    """Long help text.

    To define format set a colon at the end of the option.
    """
    return None`,
      ),
    ];

    const sites = localize([change(['define'])], [dep('twisted', 'pypi')], buildIndex(files), files, {
      logger,
    });
    assert.equal(sites.length, 0);
  });

  test('an identifier inside an ordinary string is not an impact site either', () => {
    const files = [
      file('a.js', 'javascript', `const twisted = require('twisted');\nconst msg = "please define a handler";`),
    ];

    const sites = localize([change(['define'])], [dep('twisted', 'npm')], buildIndex(files), files, {
      logger,
    });
    assert.equal(sites.length, 0);
  });

  test('the same identifier used as code is still found', () => {
    const files = [
      file('a.js', 'javascript', `const twisted = require('twisted');\ntwisted.define({ a: 1 });`),
    ];

    const sites = localize([change(['define'])], [dep('twisted', 'npm')], buildIndex(files), files, {
      logger,
    });
    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.line, 2);
  });

  test('a URL path symbol is still matched inside the string it must live in', () => {
    // The reason string contents cannot simply be discarded for every symbol:
    // an endpoint only ever appears inside a literal.
    const files = [
      file('a.js', 'javascript', `const api = require('api-client');\nfetch('/api/v1/users');`),
    ];

    const endpoint = {
      id: 'bc2',
      dependency: 'api-client',
      kind: 'removed-endpoint' as const,
      summary: '`GET /api/v1/users` was removed.',
      remediation: 'Use /api/v2/users.',
      symbols: ['/api/v1/users'],
      confidence: 'high' as const,
      citations: ['e1'],
    };

    const sites = localize([endpoint], [dep('api-client', 'npm')], buildIndex(files), files, {
      logger,
    });
    assert.equal(sites.length, 1);
  });

  test('a scoped package name is still matched inside its import string', () => {
    const files = [file('a.ts', 'typescript', `import x from '@scope/pkg';\nconsole.log(x);`)];

    const moved = {
      id: 'bc3',
      dependency: '@scope/pkg',
      kind: 'moved-export' as const,
      summary: '`@scope/pkg` moved.',
      remediation: 'Import from @scope/other.',
      symbols: ['@scope/pkg'],
      confidence: 'high' as const,
      citations: ['e1'],
    };

    const sites = localize([moved], [dep('@scope/pkg', 'npm')], buildIndex(files), files, { logger });
    assert.equal(sites.length, 1);
  });
});

describe('generic nouns as derived leaves', () => {
  test('a bare noun leaf does not match an unrelated local of the same name', () => {
    // `maildir.AbstractMaildirDomain.root` used to contribute `root`, which
    // matched `root = Root()` in a benchmark script with no maildir in it.
    const change = {
      id: 'bc1',
      dependency: 'twisted',
      kind: 'removed-export' as const,
      summary: '`maildir.AbstractMaildirDomain.root` was removed.',
      remediation: 'Use the replacement.',
      symbols: ['maildir.AbstractMaildirDomain.root', 'AbstractMaildirDomain.root'],
      confidence: 'high' as const,
      citations: ['e1'],
    };

    const files = [
      file('extras/bench.py', 'python', `import twisted\n\nroot = Root()\nfactory = Site(root)`),
    ];

    const sites = localize([change], [dep('twisted', 'pypi')], buildIndex(files), files, { logger });
    assert.equal(sites.length, 0);
  });
});

/**
 * Precision: the line a developer is sent to has to be a line with work on it.
 *
 * Both of these came from a real run against Scrapy. `cryptography` changed
 * `base.Certificate` from a class to a variable, and Drift reported 59 sites
 * across four files — every one of them either an `import` line, which the
 * change does not break, or a use of Twisted's unrelated `Certificate`, which
 * the change has nothing to do with.
 */
describe('a site has to be somewhere there is work to do', () => {
  const typeChange = {
    id: 'bc1',
    dependency: 'cryptography',
    kind: 'type-change' as const,
    summary: '`base.Certificate` changed from a class to a variable.',
    remediation: 'Update declarations, `new` expressions, and type positions.',
    symbols: ['Certificate', 'base.Certificate'],
    confidence: 'medium' as const,
    citations: ['e1'],
  };

  test('a symbol bound from another package is that package’s symbol', () => {
    const files = [
      file(
        'tests/test_crawl.py',
        'python',
        `from cryptography import x509
from twisted.internet.ssl import Certificate


def check(cert):
    if isinstance(cert, Certificate):  # Twisted
        return True
    return False`,
      ),
    ];

    const sites = localize(
      [typeChange],
      [dep('cryptography', 'pypi')],
      buildIndex(files),
      files,
      { logger },
    );

    assert.equal(sites.length, 0, 'Certificate here is twisted.internet.ssl.Certificate');
  });

  test('a changed shape does not break the import that names it', () => {
    const files = [
      file(
        'src/tls.py',
        'python',
        `from cryptography.x509 import Certificate


def load(der):
    return Certificate.from_der(der)`,
      ),
    ];

    const sites = localize(
      [typeChange],
      [dep('cryptography', 'pypi')],
      buildIndex(files),
      files,
      { logger },
    );

    assert.equal(sites.length, 1, 'the use site, not the import line');
    assert.equal(sites[0]?.line, 5);
  });

  test('a removed export does break the import, and that line is the site', () => {
    const files = [
      file('src/tls.py', 'python', `from cryptography.x509 import Certificate\n`),
    ];

    const removed = { ...typeChange, kind: 'removed-export' as const };
    const sites = localize([removed], [dep('cryptography', 'pypi')], buildIndex(files), files, {
      logger,
    });

    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.line, 1);
  });

  test('a shared prefix is not a shared package', () => {
    const files = [
      file('src/a.ts', 'typescript', `import { hash } from 'crypto-js';\nhash('x');`),
    ];

    const change = { ...typeChange, dependency: 'crypto', symbols: ['hash'] };
    const sites = localize([change], [dep('crypto', 'npm')], buildIndex(files), files, { logger });

    assert.equal(sites.length, 0, 'crypto-js is not crypto');
  });
});

describe('a changed signature is a fact about calls', () => {
  const signatureChange = {
    id: 'bc1',
    dependency: '@radix-ui/react-slot',
    kind: 'signature-change' as const,
    summary: 'The signature of `Slot` changed.',
    remediation: 'Update every call site to match the new signature.',
    symbols: ['Slot'],
    confidence: 'high' as const,
    citations: ['e1'],
  };

  const localizeIn = (files: ReturnType<typeof file>[]) =>
    localize(
      [signatureChange],
      [dep('@radix-ui/react-slot', 'npm')],
      buildIndex(files),
      files,
      { logger },
    );

  test('a reference that passes no arguments has nothing to update', () => {
    const sites = localizeIn([
      file(
        'components/ui/button.tsx',
        'typescript',
        `import { Slot } from '@radix-ui/react-slot';

export function Button({ asChild, ...props }) {
  const Comp = asChild ? Slot : 'button';
  return <Comp {...props} />;
}`,
      ),
    ]);

    assert.equal(sites.length, 0, 'storing the name is not calling it');
  });

  test('the call, the construction and the element are all sites', () => {
    const sites = localizeIn([
      file(
        'src/app.tsx',
        'typescript',
        `import { Slot } from '@radix-ui/react-slot';

const a = Slot({ children: null });
const b = new Slot({});
const c = <Slot asChild />;
const d = Slot<HTMLDivElement>({});
const held: Array<Slot> = [];
export { Slot };`,
      ),
    ]);

    assert.deepEqual(sites.map((s) => s.line), [3, 4, 5, 6]);
  });

  test('an argument list opened on the next line still counts', () => {
    const sites = localizeIn([
      file(
        'src/wrap.ts',
        'typescript',
        `import { Slot } from '@radix-ui/react-slot';

const rendered = Slot
  ({ children: null });`,
      ),
    ]);

    assert.deepEqual(sites.map((s) => s.line), [3]);
  });

  test('languages that call without parens keep the plain search', () => {
    const files = [
      file(
        'app/views.rb',
        'ruby',
        `require 'acme'

def show
  render Slot, locals: {}
end`,
      ),
    ];

    const change = { ...signatureChange, dependency: 'acme' };
    const sites = localize([change], [dep('acme', 'rubygems')], buildIndex(files), files, {
      logger,
    });

    assert.equal(sites.length, 1, 'a paren rule would go silent on Ruby');
  });
});

/**
 * The zod 3 → 4 report, end to end.
 *
 * A surface diff has no call sites in front of it, so it reports a moved
 * parameter for every caller. With a call site in hand the question is
 * narrower — a call is only exposed to the parameters it actually fills — and
 * for the majority of what that upgrade flagged the answer is that there was
 * never anything to change. Those sites reached the developer as flagged
 * concerns and then an agent, which spent tokens concluding "no change
 * needed"; the point of these is that they are never flagged at all.
 */
describe('a call site the new signature still accepts', () => {
  const change = (symbol: string, before: string, after: string) => ({
    id: `bc-${symbol}`,
    dependency: 'acme-schema',
    kind: 'signature-change' as const,
    summary: `The signature of \`${symbol}\` changed.`,
    remediation: 'Update every call site to match the new signature.',
    symbols: [symbol],
    confidence: 'high' as const,
    citations: ['e1'],
    before,
    after,
  });

  const localizeIn = (changes: ReturnType<typeof change>[], content: string) => {
    const files = [file('src/schema.ts', 'typescript', content)];
    return localize(changes, [dep('acme-schema', 'npm')], buildIndex(files), files, { logger });
  };

  const stringChange = change(
    'string',
    'declare const string: (params?: RawCreateParams & { coerce?: true; }) => ZodString;',
    'export declare function string(params?: string | core.$ZodStringParams): ZodString;',
  );

  test('a zero-argument call is not a site of a change to an optional parameter', () => {
    const sites = localizeIn(
      [stringChange],
      `import { z } from 'acme-schema';

export const schema = z.object({
  name: z.string(),
  note: z.string(),
});`,
    );

    assert.equal(sites.length, 0, 'z.string() passes nothing the new parameter type can reach');
  });

  test('a call that fills the moved parameter is still reported', () => {
    const sites = localizeIn(
      [
        change(
          'array',
          'declare const array: <El extends ZodTypeAny>(schema: El) => ZodArray<El>;',
          'export declare function array<T extends core.SomeType>(element: T): ZodArray<T>;',
        ),
      ],
      `import { z } from 'acme-schema';

export const many = z.array(z.string());`,
    );

    assert.equal(sites.length, 1, 'an argument really is passed into the parameter that moved');
  });

  /**
   * `.optional()` is a method on the schema object. The free function
   * `z.optional(type)` requires an argument, so a call passing none was never
   * calling it, whatever the two share as a name.
   */
  test('a method that shares a name with the changed function is not a site', () => {
    const sites = localizeIn(
      [
        change(
          'optional',
          'declare const optional: <Inner extends ZodTypeAny>(type: Inner) => ZodOptional<Inner>;',
          'export declare function optional<T extends core.SomeType>(innerType: T): ZodOptional<T>;',
        ),
      ],
      `import { z } from 'acme-schema';

export const schema = z.object({
  note: z.string().optional(),
});`,
    );

    assert.equal(sites.length, 0, 'z.string().optional() is not z.optional(...)');
  });

  test('a multi-line argument list is counted as the one argument it is', () => {
    const sites = localizeIn(
      [
        change(
          'object',
          'declare const object: <Shape extends ZodRawShape>(shape: Shape) => ZodObject<Shape>;',
          'export declare function object<T extends core.$ZodLooseShape>(shape?: T): ZodObject<T, core.$strip>;',
        ),
      ],
      `import { z } from 'acme-schema';

export const schema = z.object({
  name: z.string(),
  count: z.number(),
});`,
    );

    assert.equal(sites.length, 1, 'a shape spanning several lines is still one filled parameter');
  });

  test('a change with no declaration text behind it is reported as before', () => {
    const { before: _before, after: _after, ...textless } = stringChange;
    const sites = localizeIn(
      [textless as typeof stringChange],
      `import { z } from 'acme-schema';

export const name = z.string();`,
    );

    assert.equal(sites.length, 1, 'nothing to compare means nothing is dismissed');
  });
});

/**
 * The report that prompted this suite listed seven "impact sites" for a change
 * to Svelte's `render`, in a Phaser game. Four were `this.render()`, three were
 * `private render(): void {`, and not one of them had anything to do with
 * Svelte — the repository owned two classes with a method of that name.
 *
 * A name search cannot tell those apart from a call into a dependency. What
 * separates them is where the name came from, which is a question the index can
 * actually answer.
 */
describe('a match has to resolve to the dependency', () => {
  const change = {
    id: 'bc1',
    dependency: 'svelte',
    kind: 'signature-change' as const,
    summary: 'The signature of `render` changed.',
    remediation: 'Update every call site.',
    symbols: ['render'],
    confidence: 'high' as const,
    citations: ['e1'],
  };

  const sitesIn = (files: ReturnType<typeof file>[], ecosystem = 'npm') =>
    localize([change], [dep('svelte', ecosystem)], buildIndex(files), files, { logger });

  test('a method on the enclosing object is never an import', () => {
    const sites = sitesIn([
      file(
        'src/game/SettingsOverlay.ts',
        'typescript',
        `import { mount } from 'svelte';

export class SettingsOverlay {
  open() {
    this.render();
  }

  private render(): void {}
}`,
      ),
    ]);

    assert.equal(sites.length, 0, 'this.render() is this class’s own method');
  });

  test('a declaration is not a call into anything', () => {
    const sites = sitesIn([
      file(
        'src/game/Slot.ts',
        'typescript',
        `import { mount } from 'svelte';

export class Slot {
  render(): void {}
}`,
      ),
    ]);

    assert.equal(sites.length, 0, 'the line that declares a method is not a site of a call');
  });

  test('an unbound name in a language whose imports enumerate is not the package’s', () => {
    const sites = sitesIn([
      file(
        'src/app.ts',
        'typescript',
        `import { mount } from 'svelte';

export function draw() {
  render({ target: document.body });
}`,
      ),
    ]);

    assert.equal(sites.length, 0, 'the only Svelte import in this file binds `mount`');
  });

  test('the name this file actually imported is still a site', () => {
    const sites = sitesIn([
      file(
        'src/ssr.ts',
        'typescript',
        `import { render } from 'svelte/server';

export const html = render(App, { props: {} });`,
      ),
    ]);

    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.confidence, 'high');
  });

  test('a namespace import resolves the whole path under it', () => {
    const sites = sitesIn([
      file(
        'src/ssr.ts',
        'typescript',
        `import * as server from 'svelte/server';

export const html = server.render(App);`,
      ),
    ]);

    assert.equal(sites.length, 1, 'server.render is reached through a binding of this dependency');
  });

  test('a qualified path is read to its root, not to the segment before the match', () => {
    const sites = sitesIn(
      [
        file(
          'app/main.py',
          'python',
          `import svelte.server

def ssr(app):
    return svelte.server.render(app)`,
        ),
      ],
      'pypi',
    );

    assert.equal(sites.length, 1, '`svelte` is the import; `server` is a submodule of it');
  });

  test('a language whose imports name nothing keeps the match', () => {
    const sites = sitesIn(
      [
        file(
          'lib/app.dart',
          'dart',
          `import 'package:svelte/svelte.dart';

void go() {
  render(context);
}`,
        ),
      ],
      'pub',
    );

    assert.ok(
      sites.length > 0,
      'a Dart import brings in everything it exports without naming any of it, so absence proves nothing',
    );
  });

  test('self is self in Python too', () => {
    const sites = sitesIn(
      [
        file(
          'app/view.py',
          'python',
          `from svelte import mount

class View:
    def draw(self):
        return self.render()

    def render(self):
        return 1`,
        ),
      ],
      'pypi',
    );

    assert.equal(sites.length, 0);
  });
});

/**
 * The masked views of a file — comments stripped, string contents blanked — are
 * computed once per file and shared across every finding that searches it. That
 * turned twenty per cent of a scan's CPU into a cache lookup, and it is only
 * sound while "the same index entry" really does mean "the same content".
 */
describe('reusing the masked view of a file', () => {
  const change = (id: string, symbols: string[]) => ({
    id,
    dependency: 'acme-sdk',
    ecosystem: 'npm' as never,
    kind: 'removed-export' as const,
    summary: `${symbols.join(', ')} removed`,
    symbols,
    confidence: 'high' as const,
    citations: [],
    remediation: 'use the replacement',
  });

  const source = `import { createClient, render } from 'acme-sdk';
// createClient is mentioned in this comment and must never match
const url = 'https://example.com/createClient';
export const a = createClient();
export const b = render();`;

  test('two findings over the same file agree with one finding over it', () => {
    const index = buildIndex([file('src/app.ts', 'typescript', source)]);
    const files = [file('src/app.ts', 'typescript', source)];

    const together = localize(
      [change('c1', ['createClient']), change('c2', ['render'])],
      [dep('acme-sdk', 'npm')],
      index,
      files,
      { logger, maxSitesPerChange: 40 },
    );
    const first = localize([change('c1', ['createClient'])], [dep('acme-sdk', 'npm')], index, files, {
      logger,
      maxSitesPerChange: 40,
    });

    const forC1 = together.filter((site) => site.breakingChangeId === 'c1');
    assert.deepEqual(
      forC1.map((s) => `${s.file}:${s.line}:${s.matchedSymbol}`),
      first.map((s) => `${s.file}:${s.line}:${s.matchedSymbol}`),
      'a second finding in the same call must not change what the first one found',
    );
  });

  test('the same call repeated gives the same answer', () => {
    const index = buildIndex([file('src/app.ts', 'typescript', source)]);
    const files = [file('src/app.ts', 'typescript', source)];
    const run = () =>
      JSON.stringify(
        localize([change('c1', ['createClient'])], [dep('acme-sdk', 'npm')], index, files, {
          logger,
          maxSitesPerChange: 40,
        }).map((s) => `${s.file}:${s.line}:${s.matchedSymbol}:${s.confidence}`),
      );

    assert.equal(run(), run());
    assert.equal(run(), run());
  });

  test('a rebuilt index sees the new content, never the old masked view', () => {
    const before = buildIndex([file('src/app.ts', 'typescript', source)]);
    localize([change('c1', ['createClient'])], [dep('acme-sdk', 'npm')], before, [file('src/app.ts', 'typescript', source)], {
      logger,
      maxSitesPerChange: 40,
    });

    // The call is gone; the only remaining mention is in a comment.
    const edited = `import { render } from 'acme-sdk';
// createClient used to be called here
export const b = render();`;
    const after = buildIndex([file('src/app.ts', 'typescript', edited)]);
    const sites = localize(
      [change('c1', ['createClient'])],
      [dep('acme-sdk', 'npm')],
      after,
      [file('src/app.ts', 'typescript', edited)],
      { logger, maxSitesPerChange: 40 },
    );

    assert.deepEqual(sites, [], 'a mention inside a comment is not an impact site');
  });
});
