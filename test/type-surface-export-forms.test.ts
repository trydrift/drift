import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractExports, expandTypesEntry, relativeImports } from '../dist/evidence/type-surface.js';

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

  test('an export list needs no space after `export`', () => {
    // `ansis@4.3.1` ships one minified line: `export{a as default,Ansis,…,a as
    // blue,a as magenta,…};`. Requiring whitespace after `export` left the
    // surface holding the two `export type` aliases it spells out, and every
    // colour the package actually publishes was reported missing from it.
    const api = extractExports(
      'declare const a: object, fg: object;\nexport{a as default,fg,a as blue,a as magenta};\n',
      'index.d.ts',
    );
    assert.ok(api.has('blue'), 'a minified export list is still an export list');
    assert.ok(api.has('magenta'));
    assert.ok(api.has('fg'));
  });

  test('a binding imported from a sibling and re-exported is followed', () => {
    // `socket.io-client@4.8.3` imports `Socket` from `./socket.js` and
    // publishes it in an `export { … }` list with no `from` clause. Nothing
    // queued the file that declares it, so the alias never resolved and
    // `Socket` — the type most of its users name — was absent from a surface
    // that reported itself complete.
    assert.deepEqual(
      relativeImports('import { Socket } from "./socket.js";\nexport { Socket, lookup as io };\n'),
      ['./socket.js'],
    );
  });

  test('a file with nothing to resolve follows no imports', () => {
    // Queueing every relative import would spend the declaration-file budget
    // on files contributing only private locals, and exhausting it marks the
    // surface incomplete — a wrong answer traded for no answer.
    assert.deepEqual(relativeImports('import { Socket } from "./socket.js";\nexport { Socket } from "./socket.js";\n'), []);
  });

  test('declarations inside `declare module "pkg"` are exported without saying so', () => {
    // `mongoose@9.9.4` splits its API across twenty-five `types/*.d.ts` files
    // reached by triple-slash reference, each re-opening `declare module
    // 'mongoose'` around a bare `class Document`. All of it parsed as private
    // locals: 604 symbols in the surface, and `Document` reported absent.
    const api = extractExports(
      "declare module 'mongoose' {\n  class Document { save(): void }\n  namespace Types { class ObjectId {} }\n}\n",
      'document.d.ts',
      undefined,
      undefined,
      'mongoose',
    );
    assert.ok(api.has('Document'), 'an ambient module block exports what it declares');
    assert.ok(api.has('Types'));
  });

  test('a module block augmenting another package is not credited to this one', () => {
    // The same syntax is how a package augments someone else's module. Putting
    // `Request` in this package's surface would let the check answer "yes, that
    // export exists" about a package that never published it — wrong in the
    // direction that hides real breakage.
    const api = extractExports(
      "declare module 'express' {\n  interface Request { user: object }\n}\n",
      'index.d.ts',
      undefined,
      undefined,
      'my-express-plugin',
    );
    assert.ok(!api.has('Request'), "another package's module is not this package's surface");
  });

  test('a DefinitelyTyped package declares the module it provides types for', () => {
    // `@types/react` declares `declare module 'react'`, not `declare module
    // '@types/react'`, so the owning check has to see through the prefix.
    const api = extractExports(
      "declare module 'react' {\n  function useState(): void;\n}\n",
      'index.d.ts',
      undefined,
      undefined,
      '@types/react',
    );
    assert.ok(api.has('useState'));
  });

  test('`export * as NS from` binds the name, not just the file', () => {
    // `typedoc@0.28.19` publishes `JSONOutput` and `OptionDefaults` this way,
    // two barrels deep. Every sibling in the same export statements resolved,
    // so a 282-symbol surface looked healthy while both were reported missing.
    const api = extractExports('export * as JSONOutput from "./schema.js";\n', 'index.d.ts');
    assert.ok(api.has('JSONOutput'));
    assert.equal(api.get('JSONOutput')?.shapeUnknown, true, 'its members live in a file this side cannot see');
  });

  test('a name imported under an alias and re-exported resolves', () => {
    // `tsdown@0.23.0` imports `d as UserConfig` and `t as defineConfig` from
    // generated chunks and re-exports them. The export names `UserConfig`; the
    // target file exports `d`, so the alias resolved to nothing and both names
    // a consumer writes were absent from a 106-symbol surface.
    const api = extractExports(
      'import { d as UserConfig, t as defineConfig } from "./chunk.mjs";\nexport { UserConfig, defineConfig };\n',
      'index.d.ts',
    );
    assert.ok(api.has('UserConfig'));
    assert.ok(api.has('defineConfig'));
  });

  test('`export { X }` inside a namespace publishes `N.X`', () => {
    // `@fastify/ajv-compiler@4.0.6`: `StandaloneValidator` is declared at file
    // scope, listed inside `declare namespace AjvCompiler`, and reached through
    // `export = AjvCompiler` — so a consumer imports it as a named export.
    const api = extractExports(
      'declare function StandaloneValidator(o: object): void;\n' +
        'declare namespace AjvCompiler {\n  export { StandaloneValidator }\n}\n' +
        'export = AjvCompiler;\n',
      'index.d.ts',
    );
    assert.ok(api.has('default.StandaloneValidator'), 'reachable as a named import off the module');
  });

  test('`export type * as NS from` binds the name too', () => {
    // `meriyah@7.3.3` publishes the namespace `prettier` imports from it as
    // `export type * as ESTree from './estree.ts'` — the same publication with
    // the values left out.
    const api = extractExports("export type * as ESTree from './estree.ts';\n", 'index.d.ts');
    assert.ok(api.has('ESTree'));
  });

  test("a package's own module block outranks a declaration it bundles", () => {
    // `cypress` ships `cy-blob-util`, `lodash` and `sinon` declarations beside
    // its own. One of those claimed `default` first, and first-writer-wins
    // locked out `declare module 'cypress' { … export = cypress }` — so
    // `defineConfig`, the one export a `cypress.config.js` names, existed
    // nowhere in a 223-symbol surface.
    const api = extractExports(
      'declare const vendored: { somethingElse(): void };\nexport = vendored;\n' +
        "declare module 'cypress' {\n" +
        '  interface CypressNpmApi { defineConfig(config: object): object }\n' +
        '  const cypress: CypressNpmApi\n' +
        '  export = cypress\n' +
        '}\n',
      'index.d.ts',
      undefined,
      undefined,
      'cypress',
    );
    assert.ok(
      (api.get('default')?.members ?? []).includes('defineConfig'),
      "the package's own module block wins",
    );
  });

  test('a generic method is a member', () => {
    // A member name followed by `<` was not matched at all, so every generic
    // method on every interface and class was missing from every surface —
    // invisible to presence checks *and* to the diff, on both sides.
    //
    // `cypress@14.5.4` is the case that exposed it: `defineConfig<
    // ComponentDevServerOpts = any>(config: …)` sits one line above the plain
    // `defineComponentFramework(config: …)`. The plain one was a member; the
    // generic one did not exist.
    const api = extractExports(
      'export interface Api {\n' +
        '  plain(c: object): object\n' +
        '  generic<T = any>(c: object): T\n' +
        '  prop: string\n' +
        '  optionalGeneric?<T>(x: T): T\n' +
        '}\n',
      'index.d.ts',
    );
    const members = api.get('Api')?.members ?? [];
    assert.ok(members.includes('generic'), 'a generic method is still a method');
    assert.ok(members.includes('plain'));
    assert.ok(members.includes('prop'));
    assert.ok(members.includes('optionalGeneric'));

    const required = api.get('Api')?.requiredMembers ?? [];
    assert.ok(required.includes('generic'), '`<` marks type parameters, not optionality');
    assert.ok(!required.includes('optionalGeneric'), '`?` still means optional');
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
