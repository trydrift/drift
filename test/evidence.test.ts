import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffSurfaces,
  entryPointMoved,
  conventionalTypeEntries,
  expandTypesEntry,
  extractExports,
  externalReferences,
  resolveRelative,
  typesFromExports,
  type SurfaceApi,
  type SurfaceEntry,
} from '../dist/evidence/type-surface.js';
import { gatherEvidence } from '../dist/evidence/index.js';
import { changelogIndexLinks, parseChangelogSections } from '../dist/evidence/changelog.js';
import { selectReleases } from '../dist/evidence/releases.js';
import { matchProse } from '../dist/analyze/rules.js';
import { DEFAULT_CONFIG } from '../dist/config/schema.js';
import { createLogger } from '../dist/util/logger.js';

/**
 * Regression tests for a scan that lied.
 *
 * Drift checked this repository, reported "no breaking changes found" for
 * zod 3 → 4, typescript 5 → 7 and @octokit/rest 21 → 22, and all three were
 * installed on the strength of that. Two of them broke the build immediately.
 *
 * Not one of those verdicts came from a wrong judgement about a real breaking
 * change. Every one came from evidence that was never gathered: an entry point
 * that would not resolve, a release window that dropped the major, a prose
 * pattern that required the verb to touch the symbol. Each of those is pinned
 * here against the exact shape that defeated it.
 */

describe('locating a package’s declarations', () => {
  test('reads .d.cts and .d.mts as declarations, not as extensionless paths', () => {
    // zod 4 ships `"types": "./index.d.cts"`. Stripping `.cts` as if it were a
    // JS extension produced `index.d.d.ts`, and the entry point was lost.
    const candidates = expandTypesEntry('index.d.cts');
    assert.ok(candidates.includes('index.d.cts'), 'must try the declared path itself');
    assert.ok(candidates.includes('index.d.ts'), 'must try the .d.ts sibling');
    assert.ok(!candidates.includes('index.d.d.ts'), 'must never probe index.d.d.ts');
  });

  test('still expands a types field that points at a directory or a JS file', () => {
    assert.deepEqual(expandTypesEntry('dist/source'), [
      'dist/source.d.ts',
      'dist/source.d.cts',
      'dist/source.d.mts',
      'dist/source/index.d.ts',
      'dist/source',
    ]);
    assert.ok(expandTypesEntry('lib/index.js').includes('lib/index.d.ts'));
  });

  test('follows re-exports written with .cjs and .mjs specifiers', () => {
    // zod 4's CJS entry is a barrel of `export * from "./v4/classic/external.cjs"`.
    // Leaving `.cjs` on the path probed `external.cjs.d.ts` and resolved nothing,
    // so the entry contributed no symbols and the surface came back empty.
    const resolved = resolveRelative('index.d.cts', './v4/classic/external.cjs');
    assert.ok(resolved.includes('v4/classic/external.d.ts'));
    assert.ok(resolved.includes('v4/classic/external.d.cts'));
    assert.ok(!resolved.some((path) => path.includes('.cjs.d.ts')));

    assert.ok(resolveRelative('index.d.ts', './external.mjs').includes('external.d.ts'));
    assert.ok(resolveRelative('index.d.ts', './external.js').includes('external.d.ts'));
  });

  test('reads the shorthand exports form, where a subpath is just a file', () => {
    // typescript 7 publishes `"exports": { ".": "./lib/version.cjs" }` and no
    // `types` field at all. Walking only for a `types` condition found nothing,
    // so the package looked as though it published no declarations.
    assert.equal(typesFromExports({ '.': './lib/version.cjs' }), './lib/version.cjs');
    assert.equal(
      typesFromExports({ '.': { types: './dist/index.d.ts', import: './dist/index.js' } }),
      './dist/index.d.ts',
    );
    assert.equal(typesFromExports(null), null);
    assert.equal(typesFromExports('./index.js'), './index.js');
  });

  test('tries the package-named declarations under types', () => {
    assert.ok(conventionalTypeEntries('phaser').includes('types/phaser.d.ts'));
    assert.ok(conventionalTypeEntries('@scope/client').includes('types/client.d.ts'));
  });

  test('treats export-assigned namespaces as module API', () => {
    const api = new Map();
    extractExports(
      [
        'declare namespace Phaser {',
        '  namespace Actions {',
        '    function AddEffectBloom(items: unknown): unknown;',
        '  }',
        '  class Game {',
        '    destroy(): void;',
        '  }',
        '}',
        'declare module "phaser" {',
        '  export = Phaser;',
        '}',
      ].join('\n'),
      'types/phaser.d.ts',
      api,
    );

    assert.equal(api.get('Phaser')?.kind, 'namespace');
    assert.equal(api.get('Phaser.Actions')?.kind, 'namespace');
    assert.equal(api.get('Phaser.Actions.AddEffectBloom')?.kind, 'function');
    assert.deepEqual(api.get('Phaser.Game')?.members, ['destroy']);
  });
});

describe('a package whose API is declared somewhere else', () => {
  const surface = (entries: Array<[string, Partial<SurfaceEntry> & { name: string }]>): SurfaceApi =>
    new Map(
      entries.map(([key, entry]) => [
        key,
        { kind: 'interface', signature: entry.name, members: [], requiredMembers: [], ...entry },
      ]),
    ) as SurfaceApi;

  test('follows the bindings an entry declaration pulls out of its dependencies', () => {
    // @octokit/rest's entry file, verbatim in shape: one import it composes
    // into its only export, one type re-export, and nothing else. Every API a
    // developer calls lives in the three packages named here.
    const content = [
      'import { Octokit as Core } from "@octokit/core";',
      'import { type PaginateInterface } from "@octokit/plugin-paginate-rest";',
      'import { legacyRestEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";',
      'export type { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";',
      'export declare const Octokit: typeof Core & Constructor<ReturnType<typeof legacyRestEndpointMethods> & { paginate: PaginateInterface }>;',
    ].join('\n');

    const api = surface([['Octokit', { name: 'Octokit', kind: 'variable', signature: content }]]);
    const refs = externalReferences([{ path: 'index.d.ts', content }], api);

    assert.deepEqual(
      [...refs.get('@octokit/core')!.named],
      [['Octokit', 'Octokit']],
      'an import used by an exported declaration is part of the contract',
    );
    assert.ok(refs.get('@octokit/plugin-paginate-rest')!.named.has('PaginateInterface'));

    const plugin = refs.get('@octokit/plugin-rest-endpoint-methods')!;
    assert.ok(plugin.named.has('legacyRestEndpointMethods'));
    assert.ok(
      plugin.reExported.has('RestEndpointMethodTypes'),
      're-exported names are this package’s own exports, not qualified ones',
    );
  });

  test('ignores an import no exported declaration mentions', () => {
    // Following it would attribute an unrelated dependency's churn to this
    // upgrade — a false positive is worse here than a missing symbol.
    const content = [
      'import { Internal } from "helper";',
      'export declare const value: string;',
    ].join('\n');
    const api = surface([['value', { name: 'value', kind: 'variable', signature: 'declare const value: string' }]]);

    assert.equal(externalReferences([{ path: 'index.d.ts', content }], api).get('helper')?.named.size, 0);
  });

  test('never follows a relative specifier as if it were a package', () => {
    const content = 'export { a } from "./local";';
    assert.equal(externalReferences([{ path: 'index.d.ts', content }], new Map()).size, 0);
  });

  test('says which dependency a finding is really about', () => {
    const before = surface([['@octokit/core#Octokit', { name: 'Octokit', via: '@octokit/core' }]]);
    const changes = diffSurfaces(before, new Map());
    assert.equal(changes[0]?.symbol, 'Octokit');
    assert.match(changes[0]!.detail, /declared in @octokit\/core/);
  });
});

describe('an empty diff that was never a comparison', () => {
  test('a DefinitelyTyped fallback is the same file on both sides', async () => {
    // `@types/semver` carries no version corresponding to `semver@7.7.1`, so
    // both sides of the diff are fetched at `latest` — the same file twice.
    // The empty result was being reported as a clean comparison, which is the
    // exact shape of "no breaking changes found" that this repository trusted
    // and should not have.
    const gaps: string[] = [];
    await gatherEvidence(
      [
        {
          name: 'semver',
          ecosystem: 'npm',
          from: '7.7.1',
          to: '7.7.4',
          kind: 'runtime',
          bump: 'patch',
          manifestPath: 'package.json',
        },
      ],
      {
        config: DEFAULT_CONFIG,
        logger: createLogger('error'),
        onUnavailableSurface: (_change, reason) => gaps.push(reason.detail),
      },
    );

    assert.ok(
      gaps.some(
        (gap) =>
          (gap.includes('@types/semver') || /semver@7\.7\.[14]/.test(gap)) &&
          /[Nn]othing was compared/.test(gap),
      ),
      `an unfetchable comparison must be reported as one; got ${JSON.stringify(gaps)}`,
    );
  });
});

describe('an upgrade that moved the API instead of removing it', () => {
  const bulk = (count: number, offset = 0): SurfaceApi =>
    new Map(
      Array.from({ length: count }, (_, i) => [
        `symbol${i + offset}`,
        {
          name: `symbol${i + offset}`,
          kind: 'interface' as const,
          signature: `interface symbol${i + offset}`,
          members: [],
          requiredMembers: [],
        },
      ]),
    );

  const asSurface = (api: SurfaceApi, entryPath: string, subpaths: string[] = []) => ({
    api,
    entryPath,
    subpaths,
    viaDependencies: [],
    ownSymbols: api.size,
  });

  test('names the relocation, and the entry points that now carry the API', () => {
    // typescript 7: the root entry publishes `version` and nothing else, and
    // the compiler API moved to `typescript/unstable/*`. Reported as 326
    // separate removals it reads as "replace each symbol", which cannot be
    // done — there is no replacement, only a different import path.
    const moved = entryPointMoved(
      'typescript',
      asSurface(bulk(326), 'lib/typescript.d.ts'),
      asSurface(bulk(2, 1000), 'lib/version.d.cts', ['./unstable/ast', './unstable/sync']),
    );

    assert.ok(moved, 'a wholesale relocation must be reported as one change');
    assert.equal(moved.kind, 'entry-point-moved');
    assert.match(moved.detail, /\.\/unstable\/ast/);
    assert.match(moved.detail, /rather than replacing the symbols individually/);
  });

  test('stays quiet when the package merely changed a lot', () => {
    const before = bulk(40);
    const after = new Map([...bulk(30), ...bulk(20, 500)]);
    assert.equal(entryPointMoved('pkg', asSurface(before, 'a.d.ts'), asSurface(after, 'a.d.ts')), null);
  });

  test('stays quiet for a package too small to be sure about', () => {
    assert.equal(
      entryPointMoved('pkg', asSurface(bulk(4), 'a.d.ts'), asSurface(bulk(1, 900), 'b.d.ts')),
      null,
    );
  });
});

describe('a signature that only changed how it is spelled', () => {
  const fn = (name: string, signature: string): SurfaceApi =>
    new Map([[name, { name, kind: 'function' as const, signature, members: [], requiredMembers: [] }]]);

  test('a return type qualified by its import path in one release and not the other is not a signature change', () => {
    // @sveltejs/vite-plugin-svelte: the same exported function, the same
    // parameter, and a return type TypeScript printed two different ways
    // across releases because the second one re-exports `PreprocessorGroup`
    // locally instead of pointing back through `svelte/compiler`. Nothing a
    // caller does with `vitePreprocess` changed.
    const before = fn(
      'vitePreprocess',
      'export function vitePreprocess(opts?: VitePreprocessOptions): import("svelte/compiler").PreprocessorGroup;',
    );
    const after = fn(
      'vitePreprocess',
      'export function vitePreprocess(opts?: VitePreprocessOptions): PreprocessorGroup;',
    );

    assert.deepEqual(diffSurfaces(before, after), []);
  });

  test('a genuine return type change is still reported even when one side carries an import qualifier', () => {
    const before = fn('run', 'export function run(): import("./types").Result;');
    const after = fn('run', 'export function run(): Outcome;');

    const changes = diffSurfaces(before, after);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.kind, 'signature-changed');
  });
});

describe('choosing which releases to read', () => {
  const release = (version: string) => ({
    tag: `v${version}`,
    version,
    name: null,
    body: '',
    url: `https://example.test/${version}`,
    publishedAt: null,
  });

  test('keeps the major boundary rather than the newest patches', () => {
    // The shape that lost zod's 4.0.0 notes: one major, then a long tail of
    // patches. Sorting newest-first and slicing kept only the tail.
    const releases = [
      ...['4.4.3', '4.4.2', '4.4.1', '4.3.1', '4.2.0', '4.1.0'].map(release),
      release('4.0.0'),
      release('3.25.0'),
    ];

    const kept = selectReleases(releases, 3).map((r) => r.version);
    assert.ok(kept.includes('4.0.0'), 'the major release must survive the cap');
    assert.equal(kept.length, 3);
  });

  test('spends what is left of the budget on the newest releases', () => {
    const releases = ['2.0.0', '1.9.3', '1.9.2', '1.9.1'].map(release);
    const kept = selectReleases(releases, 3).map((r) => r.version);
    assert.deepEqual(kept, ['2.0.0', '1.9.3', '1.9.2']);
  });

  test('returns everything, newest first, when it all fits', () => {
    const releases = ['1.1.0', '1.0.0'].map(release);
    assert.deepEqual(
      selectReleases(releases, 10).map((r) => r.version),
      ['1.1.0', '1.0.0'],
    );
  });
});

describe('reading what a maintainer actually wrote', () => {
  test('finds the change when a noun phrase sits between symbol and verb', () => {
    // Both lines are verbatim from zod's own release notes, and both produced
    // nothing: the patterns required the verb to follow the symbol directly.
    const a = matchProse('`$defs` entries no longer include a redundant `id`.');
    assert.equal(a.length, 1);
    assert.equal(a[0]?.symbols[0], '$defs');

    const b = matchProse('Empty `z.union([])` and discriminated unions no longer crash at construction time.');
    assert.equal(b.length, 1);
    assert.equal(b[0]?.symbols[0], 'z.union');
  });

  test('still reads the plain form', () => {
    const matches = matchProse('`parse` no longer accepts a string.');
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.symbols[0], 'parse');
  });

  test('reads the other voice too', () => {
    const matches = matchProse('`options.retries` is now required.');
    assert.ok(matches.some((m) => m.symbols[0] === 'options.retries'));
  });

  test('does not invent a finding out of ordinary prose', () => {
    assert.deepEqual(matchProse('We rewrote the internals for speed.'), []);
    assert.deepEqual(matchProse('Thanks to everyone who contributed to this release.'), []);
  });
});

describe('a changelog that is an index of other changelogs', () => {
  // Verbatim in shape from Phaser's root CHANGELOG.md, which is the case that
  // exposed this: a table of links, and not one heading that names a version.
  const index = `# Phaser Change Logs

## Phaser 4

| Document | Description |
| -------- | ----------- |
| [4.2.0 Changelog](changelog/v4/4.2/CHANGELOG-v4.2.0.md) | Full changelog for Phaser 4.2.0 |
| [Migration Guide](changelog/v4/4.0/MIGRATION-GUIDE.md) | Guide for upgrading from Phaser 3 to Phaser 4 |

## Phaser 3

| Version | Name |
| ------- | ---- |
| [3.90](changelog/v3/3.90/CHANGELOG-v3.90.md) | Tsugumi |
| [3.60](changelog/v3/3.60/CHANGELOG-v3.60.md) | Miku |
`;

  test('parses no version sections from it, which is why it must be followed', () => {
    // The bug in one line: this is what Drift used to report as "no changelog".
    assert.deepEqual(parseChangelogSections(index), []);
  });

  test('finds the per-version documents it links to', () => {
    const links = changelogIndexLinks(index);
    const paths = links.map((l) => l.path);

    assert.ok(paths.includes('changelog/v3/3.90/CHANGELOG-v3.90.md'));
    assert.ok(paths.includes('changelog/v4/4.2/CHANGELOG-v4.2.0.md'));
    assert.equal(links.find((l) => l.path.includes('3.90'))?.version, '3.90.0');
  });

  test('reads the version out of the path when the link text has none', () => {
    const links = changelogIndexLinks('[Full changelog](changelog/v3/3.85.2/CHANGELOG-v3.85.2.md)');
    assert.equal(links.length, 1);
    assert.equal(links[0]?.version, '3.85.2');
  });

  test('ignores links that are not same-repository markdown', () => {
    const links = changelogIndexLinks(`
      [3.90 on the site](https://phaser.io/changelog/3.90.md)
      [3.90 bundle](dist/phaser-3.90.0.js)
      [3.90 anchor](#3900)
    `);
    assert.deepEqual(links, []);
  });
});
