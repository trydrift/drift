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
    assert.deepEqual([...api.keys()], ['LRU']);
    assert.deepEqual(api.get('LRU')?.members, ['get']);
  });

  test('`export =` still works with a semicolon', () => {
    const api = extractExports('declare class LRU { get(k: string): void }\nexport = LRU;\n', 'index.d.ts');
    assert.deepEqual([...api.keys()], ['LRU']);
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
