import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, unitAtLine, packageNameFromSpecifier } from '../dist/index/metarag.js';
import { localize } from '../dist/localize/index.js';
import { createLogger } from '../dist/util/logger.js';

const logger = createLogger('error');

const file = (path: string, language: string, content: string) => ({
  path,
  language: language as never,
  content,
  lineCount: content.split('\n').length,
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
