import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandTypesEntry,
  resolveRelative,
  typesFromExports,
} from '../dist/evidence/type-surface.js';
import { selectReleases } from '../dist/evidence/releases.js';
import { matchProse } from '../dist/analyze/rules.js';

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
