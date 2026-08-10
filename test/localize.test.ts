import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, unitAtLine, packageNameFromSpecifier } from '../dist/index/metarag.js';
import { localize } from '../dist/localize/index.js';
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
