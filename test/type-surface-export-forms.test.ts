import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractExports, expandTypesEntry } from '../dist/evidence/type-surface.js';

/**
 * Three ways a package can publish its API that produced *zero* exported
 * symbols, and therefore "this version pair has no comparable surface" — the
 * strongest evidence Drift has, lost to a parser detail. Each was found by
 * running the real published packages named in the comments.
 */

describe('export forms that carry a package API', () => {
  test('`export =` does not require a semicolon', () => {
    // `lru-cache@7.18.3` ends `export = LRUCache` with no semicolon, and ASI
    // makes that valid. Requiring one cost the whole package: a `declare
    // class` plus a `declare namespace`, parsed to nothing.
    const api = extractExports('declare class LRU { get(k: string): void }\nexport = LRU\n', 'index.d.ts');
    assert.deepEqual([...api.keys()], ['default']);
    assert.deepEqual(api.get('default')?.members, ['get']);
  });

  test('`export =` still works with a semicolon', () => {
    const api = extractExports('declare class LRU { get(k: string): void }\nexport = LRU;\n', 'index.d.ts');
    assert.deepEqual([...api.keys()], ['default']);
  });

  test('`export =` publishes members only under the name the module is reachable by', () => {
    // `glob@8` calls its local declaration `G`, so Drift reported `G.sync` and
    // `G.hasMagic` — symbols that appear in no consumer anywhere and read as
    // gibberish in a report — while the line to find says `glob.sync(...)`.
    //
    // Keeping the local name *as well* was tried and is worse in both
    // directions: it puts `G` in front of a reader, and it reports every change
    // twice, once under each name (26 findings for glob 8 -> 13, where there
    // are 13). A named import off an `export =` namespace still matches,
    // because `default.Glob` contributes the bare leaf `Glob`.
    const api = extractExports(
      'declare function G(p: string): string[];\ndeclare namespace G { function sync(p: string): string[]; }\nexport = G\n',
      'index.d.ts',
    );
    assert.deepEqual([...api.keys()].sort(), ['default', 'default.sync']);
    assert.ok(!api.has('G.sync'), 'the package-internal name is not a consumer-visible symbol');
  });

  test('a default-exported class publishes its members under `default`', () => {
    // `telnet-client@1.4.11` — `export default class telnet_client`. The only
    // name an importer can reach it by is `default`, and `default.exec` is
    // what localization needs to find `client.exec(…)`.
    const api = extractExports(
      'export default class TC { connect(o: object): void; exec(c: string): void; }\n',
      'index.d.ts',
    );
    assert.deepEqual([...api.keys()], ['default']);
    assert.deepEqual(api.get('default')?.members, ['connect', 'exec']);
  });

  test('a default-exported function is published too', () => {
    const api = extractExports('export default function go(a: string): void;\n', 'index.d.ts');
    assert.deepEqual([...api.keys()], ['default']);
  });

  test('a default export with no declaration to name is not invented', () => {
    // `export default { … }` and `export default class { … }` name nothing
    // that can be compared across versions.
    assert.equal(extractExports('export default { a: 1 };\n', 'index.d.ts').size, 0);
    assert.equal(extractExports('export default class { x(): void }\n', 'index.d.ts').size, 0);
  });
});

describe('expanding a declared types entry', () => {
  test('a JavaScript entry never stands in for a declaration file', () => {
    // `uuid@9.0.1` declares no `types` and an `exports` map whose only
    // reachable string is `./dist/esm-browser/index.js`. That path exists, so
    // it was selected as the types entry and parsed as TypeScript to zero
    // exports — while `@types/uuid@9` went unread, because the DefinitelyTyped
    // fallback only runs when no entry was found at all.
    const candidates = expandTypesEntry('dist/esm-browser/index.js');
    assert.ok(!candidates.includes('dist/esm-browser/index.js'));
    assert.ok(candidates.includes('dist/esm-browser/index.d.ts'));
  });

  test('an extensionless entry is still tried verbatim', () => {
    assert.ok(expandTypesEntry('dist/source').includes('dist/source'));
  });

  test('a declaration entry is returned as itself', () => {
    assert.deepEqual(expandTypesEntry('index.d.cts'), ['index.d.cts', 'index.d.ts']);
  });
});

describe('binding a default export to what the consumer called it', () => {
  test('a default import, a require, and a named import are told apart', async () => {
    const { buildIndex } = await import('../dist/index/metarag.js');
    const of = (content: string) =>
      buildIndex([{ path: 'a.ts', language: 'typescript', content }])
        .files[0]!.imports.map((record) => record.defaultBinding);

    assert.deepEqual(of("import glob from 'glob';"), ['glob']);
    assert.deepEqual(of("import g, { sync } from 'glob';"), ['g']);
    assert.deepEqual(of("const g = require('glob');"), ['g']);
    // A named import binds an export that merely shares the module's name, and
    // a namespace import binds the namespace — neither is the default.
    assert.deepEqual(of("import { glob } from 'glob';"), [undefined]);
    assert.deepEqual(of("import * as glob from 'glob';"), [undefined]);
  });
});

describe('following a re-export that names a subpath', () => {
  test('the package carries the version and the subpath picks the entry', async () => {
    const { typesFromExports, expandTypesEntry: expand } = await import('../dist/evidence/type-surface.js');
    // `lit@2` publishes nothing of its own: its entry is four lines of
    // `export * from 'lit-element/lit-element.js'`. Matching that specifier
    // against `dependencies` verbatim never found `lit-element`, so the edge
    // was dropped and the whole package resolved to "no public surface".
    // These pin the two halves the fix depends on.
    assert.equal(typesFromExports({ '.': { types: './development/index.d.ts', default: './index.js' } }), './development/index.d.ts');
    assert.ok(expand('lit-element.js').includes('lit-element.d.ts'));
  });
});
