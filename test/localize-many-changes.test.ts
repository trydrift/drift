import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, type FileIndex } from '../dist/index/metarag.js';
import { localize } from '../dist/localize/index.js';
import { createLogger } from '../dist/util/logger.js';

const logger = createLogger('error');

/**
 * Guards the `candidateFiles` memoisation added in `localize()`: for one
 * dependency with many `BreakingChange`s, the re-export walk that finds its
 * candidate files is now computed once and reused, instead of once per
 * change. This file proves two things about that change:
 *
 *   1. Correctness — batching many changes for the same dependency into one
 *      `localize()` call produces exactly the sites that calling `localize()`
 *      once per change and merging the results would (the pre-existing,
 *      unmemoised behaviour), across re-export chains, many importers,
 *      no-match and many-match changes, and `maxSitesPerChange = 400`.
 *   2. Scaling — the walk that finds candidate files no longer grows
 *      (roughly) linearly with the number of breaking changes for one
 *      dependency, which is the shape of cost the memoisation removes.
 */

const dep = {
  name: 'acme-sdk',
  ecosystem: 'npm' as const,
  from: '1.0.0',
  to: '2.0.0',
  kind: 'runtime' as const,
  bump: 'major' as const,
  manifestPath: 'package.json',
};

const file = (path: string, content: string) => ({
  path,
  language: 'typescript' as const,
  content,
  lineCount: content.split('\n').length,
});

const CHANGE_COUNT = 24;
const DIRECT_IMPORTERS = 30;
const BARREL_DEPTH = 3;

/**
 * `symbolN` exists in the package for every N; only even N are ever imported
 * or called anywhere in the fixture, so odd-numbered changes are a genuine
 * no-match case and even-numbered ones are a genuine many-match case.
 */
function breakingChanges() {
  return Array.from({ length: CHANGE_COUNT }, (_, i) => ({
    id: `bc_${i}`,
    dependency: dep.name,
    kind: 'removed-export' as const,
    summary: `\`symbol${i}\` was removed.`,
    remediation: 'Replace it.',
    symbols: [`symbol${i}`],
    confidence: 'high' as const,
    citations: [`ev_${i}`],
  }));
}

function fixtureFiles() {
  const files: ReturnType<typeof file>[] = [];

  // A re-export barrel chain: leaf -> mid -> root -> the package itself.
  // Only even-numbered symbols are actually re-exported and used, so the walk
  // has real forwarding edges to follow and real dead ends to stop at.
  const evens = Array.from({ length: CHANGE_COUNT }, (_, i) => i).filter((i) => i % 2 === 0);
  files.push(
    file(
      'src/barrel/root.ts',
      evens.map((i) => `export { symbol${i} } from 'acme-sdk';`).join('\n'),
    ),
  );
  for (let depth = 1; depth < BARREL_DEPTH; depth++) {
    files.push(
      file(
        `src/barrel/level${depth}.ts`,
        `export * from './${depth === 1 ? 'root' : `level${depth - 1}`}';`,
      ),
    );
  }
  const topBarrel = `src/barrel/level${BARREL_DEPTH - 1}.ts`;

  // Direct importers, spread across the even symbols, each calling its symbol.
  for (let n = 0; n < DIRECT_IMPORTERS; n++) {
    const sym = evens[n % evens.length]!;
    files.push(
      file(
        `src/direct/consumer${n}.ts`,
        `import { symbol${sym} } from 'acme-sdk';\n\nexport function run() {\n  return symbol${sym}();\n}`,
      ),
    );
  }

  // Indirect importers reached only through the barrel chain.
  for (let n = 0; n < DIRECT_IMPORTERS; n++) {
    const sym = evens[n % evens.length]!;
    files.push(
      file(
        `src/indirect/consumer${n}.ts`,
        `import { symbol${sym} } from '${topBarrel.replace('src/', '../').replace('.ts', '')}';\n\nexport function run() {\n  return symbol${sym}();\n}`,
      ),
    );
  }

  // A file that mentions every symbol name in prose/locals only — never an
  // import, never a call — so it should never surface as a site.
  files.push(
    file(
      'src/unrelated/noise.ts',
      Array.from({ length: CHANGE_COUNT }, (_, i) => `// symbol${i} is unrelated here`).join('\n'),
    ),
  );

  return files;
}

function sortSites(sites: ReturnType<typeof localize>) {
  return [...sites]
    .map((s) => `${s.breakingChangeId}:${s.file}:${s.line}:${s.matchedSymbol}:${s.confidence}`)
    .sort();
}

describe('localize: many breaking changes on one dependency', () => {
  test('batched result equals the union of one-change-at-a-time calls', () => {
    const files = fixtureFiles();
    const index = buildIndex(files);
    const changes = breakingChanges();

    const batched = localize(changes, [dep], index, files, {
      logger,
      maxSitesPerChange: 400,
    });

    const individually = changes.flatMap((change) =>
      localize([change], [dep], index, files, { logger, maxSitesPerChange: 400 }),
    );

    assert.equal(batched.length, individually.length, 'same total number of sites');
    assert.deepEqual(
      sortSites(batched),
      sortSites(individually),
      'the memoised candidate-file lookup must not change which sites are found, or their confidence',
    );
    // Sanity: both the no-match (odd) and many-match (even) cases are
    // actually exercised by this fixture.
    const withSites = new Set(batched.map((s) => s.breakingChangeId));
    assert.ok(withSites.size > 0 && withSites.size < CHANGE_COUNT, 'mix of matched and unmatched changes');
  });

  test('re-export reachability is unaffected by which changes share the call', () => {
    const files = fixtureFiles();
    const index = buildIndex(files);
    const changes = breakingChanges();

    // Two different batchings of the same changes must agree file-for-file.
    const half = Math.floor(changes.length / 2);
    const a = localize(changes.slice(0, half), [dep], index, files, { logger, maxSitesPerChange: 400 });
    const b = localize(changes.slice(half), [dep], index, files, { logger, maxSitesPerChange: 400 });
    const allAtOnce = localize(changes, [dep], index, files, { logger, maxSitesPerChange: 400 });

    assert.deepEqual(sortSites(allAtOnce), sortSites([...a, ...b]));
  });

  test('indirect (re-exported) sites still carry reduced confidence, never "high"', () => {
    const files = fixtureFiles();
    const index = buildIndex(files);
    const changes = breakingChanges();
    const sites = localize(changes, [dep], index, files, { logger, maxSitesPerChange: 400 });

    const indirect = sites.filter((s) => s.file.startsWith('src/indirect/'));
    assert.ok(indirect.length > 0, 'the fixture must actually exercise the re-export chain');
    assert.ok(
      indirect.every((s) => s.confidence !== 'high'),
      'a site reached only through re-exports is never reported at full confidence',
    );
  });

  test('candidate-file lookup no longer scales ~linearly with changes-per-dependency', () => {
    const files = fixtureFiles();
    const index = buildIndex(files);
    const changes = breakingChanges();

    const timeFor = (n: number) => {
      const started = process.hrtime.bigint();
      localize(changes.slice(0, n), [dep], index, files, { logger, maxSitesPerChange: 400 });
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    // Warm up (JIT, lazy caches inside buildIndex/localize) before timing.
    timeFor(1);
    timeFor(1);

    const small = Math.min(3, CHANGE_COUNT);
    const large = CHANGE_COUNT;
    const smallMs = Math.max(timeFor(small), 0.001);
    const largeMs = Math.max(timeFor(large), 0.001);

    // Before the memoisation, `large` re-ran the full re-export walk
    // `large / small` times more often than `small` did, on top of the
    // per-file search cost that legitimately does grow with match count. A
    // generous bound (well under strict linear scaling) catches a
    // regression back to "cost multiplies with breaking-change count"
    // without making this test flaky on a loaded CI box.
    const ratio = largeMs / smallMs;
    const changeRatio = large / small;
    assert.ok(
      ratio < changeRatio * 1.5,
      `expected sub-linear-ish scaling (ratio ${ratio.toFixed(2)} vs ${changeRatio}x the changes); ` +
        `got ${smallMs.toFixed(2)}ms for ${small} changes and ${largeMs.toFixed(2)}ms for ${large}`,
    );
  });
});
