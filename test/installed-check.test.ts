import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkInstalled } from '../dist/upgrade/installed-check.js';
import { buildIndex } from '../dist/index/metarag.js';

/**
 * Checking the code against the version that is actually installed.
 *
 * The tests that matter most here are the ones about *not* reporting. A check
 * that answers "this name does not exist" from an incomplete reading of a
 * package turns every correct import into a false alarm, which is worse than
 * not running at all — so the refusals are pinned as hard as the findings.
 */

/** The language the walk would have recorded, so the right extractor runs. */
function languageOf(path: string) {
  if (path.endsWith('.ts')) return 'typescript' as const;
  if (path.endsWith('.py')) return 'python' as const;
  return 'javascript' as const;
}

function indexOf(files: Record<string, string>) {
  return buildIndex(
    Object.entries(files).map(([path, content]) => ({
      path,
      language: languageOf(path),
      content,
      lineCount: content.split('\n').length,
    })),
  );
}

/** A surface in the shape `fetchTypeSurface` returns, with named exports. */
function surface(names: string[], options: { incomplete?: boolean; viaKeyed?: string[] } = {}) {
  const api = new Map();
  for (const name of names) {
    api.set(name, { name, kind: 'function', signature: `declare function ${name}(): void`, members: [], requiredMembers: [] });
  }
  for (const key of options.viaKeyed ?? []) {
    const name = key.split('#')[1]!;
    api.set(key, { name: key, kind: 'function', signature: '', members: [], requiredMembers: [], via: key.split('#')[0] });
  }
  return {
    api,
    entryPath: 'index.d.ts',
    viaDependencies: [],
    ownSymbols: names.length,
    subpaths: [],
    incomplete: options.incomplete ?? false,
  };
}

const installed = (version: string | null = '2.0.0', ecosystem = 'npm') =>
  new Map([['pkg', { version, ecosystem }]]);

describe('an import the installed version does not export', () => {
  test('is reported, with the file and line of the import', async () => {
    const files = { 'src/a.ts': "import { gone, kept } from 'pkg';\nexport const x = gone(kept());\n" };

    const result = await checkInstalled({
      index: indexOf(files),
      contents: new Map(Object.entries(files)),
      installed: installed(),
      fetchSurface: async () => surface(['kept']),
    });

    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0]?.symbol, 'gone');
    assert.equal(result.missing[0]?.file, 'src/a.ts');
    assert.equal(result.missing[0]?.line, 1);
    assert.equal(result.missing[0]?.installedVersion, '2.0.0');
    assert.equal(result.checkedPackages, 1);
  });

  test('is found through a require() destructure as well as an import', async () => {
    const index = indexOf({ 'src/b.js': "const { gone } = require('pkg');\nmodule.exports = gone;\n" });

    const result = await checkInstalled({
      index,
      installed: installed(),
      fetchSurface: async () => surface(['kept']),
    });

    assert.deepEqual(result.missing.map((m) => m.symbol), ['gone']);
  });

  test('every name an import binds is checked, not just the first', async () => {
    const files = { 'src/c.ts': "import { a, b, c } from 'pkg';\nexport default [a, b, c];\n" };

    const result = await checkInstalled({
      index: indexOf(files),
      contents: new Map(Object.entries(files)),
      installed: installed(),
      fetchSurface: async () => surface(['b']),
    });

    assert.deepEqual(result.missing.map((m) => m.symbol).sort(), ['a', 'c']);
    assert.equal(result.packages[0]?.checked, 3);
  });
});

describe('what is deliberately never reported', () => {
  test('a module-object binding is not a missing named export', async () => {
    // `const pkg = require('pkg')` binds the module, which is what `export =`
    // publishes. Checking it against the named surface would report every
    // CommonJS default import in existence.
    const index = indexOf({ 'src/d.js': "const pkg = require('pkg');\npkg.anything();\n" });

    const result = await checkInstalled({
      index,
      installed: installed(),
      fetchSurface: async () => surface(['somethingElse']),
    });

    assert.deepEqual(result.missing, []);
  });

  test('a default import is not a missing named export', async () => {
    const index = indexOf({ 'src/e.ts': "import pkg from 'pkg';\nexport default pkg;\n" });

    const result = await checkInstalled({
      index,
      installed: installed(),
      fetchSurface: async () => surface(['somethingElse']),
    });

    assert.deepEqual(result.missing, []);
  });

  test('a namespace import binds the module, not a name', async () => {
    const index = indexOf({ 'src/f.ts': "import * as pkg from 'pkg';\nexport default pkg;\n" });

    const result = await checkInstalled({
      index,
      installed: installed(),
      fetchSurface: async () => surface([]),
    });

    assert.deepEqual(result.missing, []);
  });

  test('an incomplete surface reports nothing at all, and says why', async () => {
    // The load-bearing refusal: a partially expanded re-export graph cannot
    // support "this name does not exist" for any name.
    const index = indexOf({ 'src/g.ts': "import { gone } from 'pkg';\nexport default gone;\n" });

    const result = await checkInstalled({
      index,
      installed: installed(),
      fetchSurface: async () => surface(['kept'], { incomplete: true }),
    });

    assert.deepEqual(result.missing, []);
    assert.equal(result.packages[0]?.unchecked?.reason, 'incomplete-surface');
    assert.equal(result.checkedPackages, 0);
    assert.equal(result.uncheckedPackages, 1);
  });

  test('an unreadable surface is unknown, never an error', async () => {
    const index = indexOf({ 'src/h.ts': "import { gone } from 'pkg';\nexport default gone;\n" });

    const result = await checkInstalled({
      index,
      installed: installed(),
      fetchSurface: async () => null,
    });

    assert.deepEqual(result.missing, []);
    assert.equal(result.packages[0]?.unchecked?.reason, 'no-surface');
  });

  test('a fetch that throws is unknown, never an error', async () => {
    const index = indexOf({ 'src/i.ts': "import { gone } from 'pkg';\nexport default gone;\n" });

    const result = await checkInstalled({
      index,
      installed: installed(),
      fetchSurface: async () => {
        throw new Error('network');
      },
    });

    assert.deepEqual(result.missing, []);
    assert.equal(result.packages[0]?.unchecked?.reason, 'no-surface');
  });

  test('a non-npm ecosystem is not checked, and says so', async () => {
    const index = indexOf({ 'src/j.py': 'from pkg import gone\n' });

    const result = await checkInstalled({
      index,
      installed: installed('2.0.0', 'pypi'),
      fetchSurface: async () => surface([]),
    });

    assert.deepEqual(result.missing, []);
    assert.equal(result.packages[0]?.unchecked?.reason, 'unsupported-ecosystem');
  });

  test('a dependency with no installed version is not checked', async () => {
    const index = indexOf({ 'src/k.ts': "import { gone } from 'pkg';\nexport default gone;\n" });

    const result = await checkInstalled({
      index,
      installed: installed(null),
      fetchSurface: async () => surface([]),
    });

    assert.deepEqual(result.missing, []);
    assert.equal(result.packages[0]?.unchecked?.reason, 'version-unknown');
  });

  test('a symbol reached through a re-export is present, however it is keyed', async () => {
    // `vue@3.4.0` keys 327 of 332 entries plainly and 5 as `specifier#name`.
    // Both forms mean the consumer can import the name.
    const index = indexOf({ 'src/l.ts': "import { computed } from 'pkg';\nexport default computed;\n" });

    const result = await checkInstalled({
      index,
      installed: installed(),
      fetchSurface: async () => surface([], { viaKeyed: ['@vue/reactivity#computed'] }),
    });

    assert.deepEqual(result.missing, []);
  });

  test('a package nothing imports is not fetched at all', async () => {
    const index = indexOf({ 'src/m.ts': "export const x = 1;\n" });
    let fetched = false;

    const result = await checkInstalled({
      index,
      installed: installed(),
      fetchSurface: async () => {
        fetched = true;
        return surface([]);
      },
    });

    assert.equal(fetched, false, 'no network for a package this repository never imports');
    assert.equal(result.packages[0]?.unchecked?.reason, 'no-imports');
  });
});

describe('a renamed import names the export, not the alias', () => {
  const contentsOf = (files: Record<string, string>) => new Map(Object.entries(files));

  test('ESM `a as renamed` checks `a` and never the alias', async () => {
    const files = { 'src/r1.ts': "import { a as renamed } from 'pkg';\nexport default renamed;\n" };

    const result = await checkInstalled({
      index: indexOf(files),
      contents: contentsOf(files),
      installed: installed(),
      fetchSurface: async () => surface(['a']),
    });

    assert.deepEqual(result.missing, [], '`a` exists; `renamed` is a local name and is not an export');
    assert.equal(result.packages[0]?.checked, 1);
  });

  test('CommonJS `{ a: renamed }` checks `a` and never the alias', async () => {
    const files = { 'src/r2.js': "const { a: renamed } = require('pkg');\nmodule.exports = renamed;\n" };

    const result = await checkInstalled({
      index: indexOf(files),
      contents: contentsOf(files),
      installed: installed(),
      fetchSurface: async () => surface(['a']),
    });

    assert.deepEqual(result.missing, []);
  });

  test('a rename of a name that really is gone is still reported, under the upstream name', async () => {
    const files = { 'src/r3.ts': "import { gone as local } from 'pkg';\nexport default local;\n" };

    const result = await checkInstalled({
      index: indexOf(files),
      contents: contentsOf(files),
      installed: installed(),
      fetchSurface: async () => surface(['kept']),
    });

    assert.deepEqual(result.missing.map((m) => m.symbol), ['gone']);
  });

  test('two real names are both checked, and neither is mistaken for an alias', async () => {
    const files = { 'src/r4.ts': "import { a, b } from 'pkg';\nexport default [a, b];\n" };

    const result = await checkInstalled({
      index: indexOf(files),
      contents: contentsOf(files),
      installed: installed(),
      fetchSurface: async () => surface(['a']),
    });

    assert.deepEqual(result.missing.map((m) => m.symbol), ['b']);
    assert.equal(result.packages[0]?.checked, 2);
  });

  test('without the source, a multi-name import is unchecked rather than guessed', async () => {
    // The same ambiguity, with nothing to resolve it: `['a','renamed']` could
    // be one rename or two exports, and reporting either way would be a guess.
    const files = { 'src/r5.ts': "import { a as renamed } from 'pkg';\nexport default renamed;\n" };

    const result = await checkInstalled({
      index: indexOf(files),
      installed: installed(),
      // A surface that exports *something* — an empty one proves nothing at
      // all and is refused before ambiguity is ever reached.
      fetchSurface: async () => surface(['kept']),
    });

    assert.deepEqual(result.missing, []);
    assert.equal(result.packages[0]?.unchecked?.reason, 'ambiguous-bindings');
  });

  test('an import spread over several lines is refused, not read as empty', async () => {
    // `record.line` is the statement's first line, where the brace opens and
    // never closes. Reading that as "imports nothing" would check none of the
    // names and look exactly like a clean result.
    const files = {
      'src/r7.ts': "import {\n  a,\n  gone,\n} from 'pkg';\nexport default [a, gone];\n",
    };

    const result = await checkInstalled({
      index: indexOf(files),
      contents: new Map(Object.entries(files)),
      installed: installed(),
      fetchSurface: async () => surface(['a']),
    });

    assert.deepEqual(result.missing, [], 'nothing is claimed about an import that could not be read');
    assert.equal(result.packages[0]?.unchecked?.reason, 'ambiguous-bindings');
  });

  test('without the source, a single-name import is still checked', async () => {
    const files = { 'src/r6.ts': "import { gone } from 'pkg';\nexport default gone;\n" };

    const result = await checkInstalled({
      index: indexOf(files),
      installed: installed(),
      fetchSurface: async () => surface(['kept']),
    });

    assert.deepEqual(result.missing.map((m) => m.symbol), ['gone']);
  });
});

describe('scoping', () => {
  test('`only` restricts the check to one package', async () => {
    const index = indexOf({ 'src/n.ts': "import { gone } from 'pkg';\nimport { alsoGone } from 'other';\n" });

    const result = await checkInstalled({
      index,
      installed: new Map([
        ['pkg', { version: '2.0.0', ecosystem: 'npm' }],
        ['other', { version: '3.0.0', ecosystem: 'npm' }],
      ]),
      only: 'pkg',
      fetchSurface: async () => surface(['kept']),
    });

    assert.deepEqual(result.packages.map((p) => p.packageName), ['pkg']);
    assert.deepEqual(result.missing.map((m) => m.symbol), ['gone']);
  });
});

describe('a surface that cannot enumerate what it exports', () => {
  /** `declare namespace X { … } declare const X: X.Static; export = X` */
  const unenumerable = (dottedTypes: string[] = []) => {
    const api = new Map<string, unknown>();
    api.set('default', { name: 'default', kind: 'namespace', signature: '', members: [], requiredMembers: [] });
    for (const name of dottedTypes) {
      api.set(`default.${name}`, {
        name: `default.${name}`,
        kind: 'interface',
        signature: '',
        members: [],
        requiredMembers: [],
      });
    }
    return { api, entryPath: 'index.d.ts', viaDependencies: [], ownSymbols: api.size, subpaths: [], incomplete: false };
  };

  test('is refused rather than reporting every import as missing', async () => {
    // sinon's real shape: one exported const whose type is a namespace. The
    // values are never declared, so nothing can be concluded from their
    // absence — and concluding anyway reported `createSandbox` missing from
    // the package that defines it.
    const files = { 'src/s.ts': "import { createSandbox } from 'pkg';\nexport default createSandbox;\n" };

    const result = await checkInstalled({
      index: indexOf(files),
      contents: new Map(Object.entries(files)),
      installed: installed(),
      fetchSurface: async () => unenumerable(['MatchPartialArguments', 'DeepPartialOrMatcher']) as never,
    });

    assert.deepEqual(result.missing, []);
    assert.equal(result.packages[0]?.unchecked?.reason, 'unenumerable-surface');
  });

  test('dotted type keys are not evidence the values were read', async () => {
    // 46 `default.<Type>` keys and an empty member list is exactly sinon, and
    // counting those keys as enumeration is what let the refusal be skipped.
    const files = { 'src/t.ts': "import { alsoGone } from 'pkg';\nexport default alsoGone;\n" };

    const result = await checkInstalled({
      index: indexOf(files),
      contents: new Map(Object.entries(files)),
      installed: installed(),
      fetchSurface: async () => unenumerable(Array.from({ length: 46 }, (_, i) => `Type${i}`)) as never,
    });

    assert.deepEqual(result.missing, []);
    assert.equal(result.packages[0]?.unchecked?.reason, 'unenumerable-surface');
  });

  test('but an enumerated export object still answers', async () => {
    // undici's shape: `default` with real members. Absence there is real.
    const files = { 'src/u.ts': "import { Agent, nope } from 'pkg';\nexport default [Agent, nope];\n" };
    const withMembers = {
      api: new Map<string, unknown>([
        ['default', { name: 'default', kind: 'namespace', signature: '', members: ['Agent', 'Pool'], requiredMembers: [] }],
      ]),
      entryPath: 'index.d.ts',
      viaDependencies: [],
      ownSymbols: 1,
      subpaths: [],
      incomplete: false,
    };

    const result = await checkInstalled({
      index: indexOf(files),
      contents: new Map(Object.entries(files)),
      installed: installed(),
      fetchSurface: async () => withMembers as never,
    });

    assert.deepEqual(result.missing.map((m) => m.symbol), ['nope'], 'Agent resolves through default.members; nope does not exist');
  });
});

describe('an import of a subpath is checked against that entry point', () => {
  test('`pkg/config` is fetched as a subpath, not as the package root', async () => {
    // vitest's root surface has 140 symbols and no `defineConfig`;
    // `vitest/config` has it. Judging the import against the root reported the
    // most ordinary line in a vitest project as naming a missing export.
    const files = { 'src/v.ts': "import { defineConfig } from 'pkg/config';\nexport default defineConfig({});\n" };
    const asked: (string | undefined)[] = [];

    const result = await checkInstalled({
      index: indexOf(files),
      contents: new Map(Object.entries(files)),
      installed: installed(),
      fetchSurface: async (_name, _version, subpath) => {
        asked.push(subpath);
        return surface(subpath === 'config' ? ['defineConfig'] : ['somethingElse']) as never;
      },
    });

    assert.deepEqual(asked, ['config'], 'the subpath reached the fetch');
    assert.deepEqual(result.missing, []);
  });

  test('root and subpath imports of one package are judged separately', async () => {
    const files = {
      'src/w.ts': "import { rootThing } from 'pkg';\nimport { subThing } from 'pkg/config';\nexport default [rootThing, subThing];\n",
    };

    const result = await checkInstalled({
      index: indexOf(files),
      contents: new Map(Object.entries(files)),
      installed: installed(),
      fetchSurface: async (_name, _version, subpath) =>
        surface(subpath === 'config' ? ['subThing'] : ['rootThing']) as never,
    });

    assert.deepEqual(result.missing, [], 'each name exists in its own entry point');
  });
});
