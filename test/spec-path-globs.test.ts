import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gatherEvidence } from '../dist/evidence/index.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { createLogger } from '../dist/util/logger.js';

/**
 * Path patterns in `evidence.*Specs`, and what happens when they cannot be
 * expanded.
 *
 * Contract documents are almost never a single file. A repository that vendors
 * protobuf has a directory of it, and the natural configuration is
 * `proto/**\/*.proto` — which Drift used to accept, skip, and say nothing
 * about. Every contract the pattern covered went uncompared, and the report
 * that came back was indistinguishable from one where all of them were read and
 * found clean. That is the worst output this pipeline can produce, so the two
 * halves of the behaviour are pinned here: a pattern that *can* be expanded is,
 * and one that cannot becomes a stated gap rather than a silence.
 */

const logger = createLogger('error');

const BEFORE = `type Query { user: User }
type User { id: ID!, email: String }
`;

const AFTER = `type Query { user: User }
type User { id: ID! }
`;

/** A repo whose files all changed the same way, so any match yields evidence. */
function repoWith(files: readonly string[]) {
  return {
    readRepoFile: async (path: string, ref: string): Promise<string | null> => {
      if (!files.includes(path)) return null;
      return ref === 'before' ? BEFORE : AFTER;
    },
    listRepoFiles: async (): Promise<string[]> => [...files],
  };
}

describe('expanding path patterns in configured contract documents', () => {
  const files = [
    'schema/api.graphql',
    'schema/internal/admin.graphql',
    'schema/notes.md',
    'src/app.ts',
  ];

  async function gather(patterns: string[], overrides: Record<string, unknown> = {}) {
    const gaps: { path: string; detail: string }[] = [];
    const records = await gatherEvidence([], {
      config: DriftConfigSchema.parse({ evidence: { graphql: true, graphqlSchemas: patterns } }),
      logger,
      ...repoWith(files),
      beforeSha: 'before',
      afterSha: 'after',
      onUnavailableSpec: (path: string, reason: { detail: string }) =>
        gaps.push({ path, detail: reason.detail }),
      ...overrides,
    });
    return { records, gaps };
  }

  test('a `**` pattern compares every document under the directory', async () => {
    const { records, gaps } = await gather(['schema/**/*.graphql']);

    assert.deepEqual(
      records.map((r) => r.dependency).sort(),
      ['schema/api.graphql', 'schema/internal/admin.graphql'],
      '`**/` must match zero segments as well as several',
    );
    assert.deepEqual(gaps, []);
  });

  test('a single star stops at a path separator', async () => {
    const { records } = await gather(['schema/*.graphql']);

    assert.deepEqual(records.map((r) => r.dependency), ['schema/api.graphql']);
  });

  test('files the provider does not handle are not diffed as if they were schemas', async () => {
    // `schema/**` matches the markdown file and the pattern is happy to; the
    // provider's own `handles` is what keeps it from being parsed as SDL.
    const { records } = await gather(['schema/**']);

    assert.deepEqual(
      records.map((r) => r.dependency).sort(),
      ['schema/api.graphql', 'schema/internal/admin.graphql'],
    );
  });

  test('literal paths still work, and mix with patterns without duplicating', async () => {
    const { records } = await gather(['schema/api.graphql', 'schema/**/*.graphql']);

    assert.deepEqual(
      records.map((r) => r.dependency).sort(),
      ['schema/api.graphql', 'schema/internal/admin.graphql'],
      'a document named twice must be compared once',
    );
  });

  test('the expansion is ordered, so two identical runs report identically', async () => {
    const shuffled = { ...repoWith(files), listRepoFiles: async () => [...files].reverse() };
    const { records } = await gather(['schema/**/*.graphql'], shuffled);

    assert.deepEqual(records.map((r) => r.dependency), [
      'schema/api.graphql',
      'schema/internal/admin.graphql',
    ]);
  });

  test('a pattern that cannot be expanded is a gap, never a clean result', async () => {
    // The listing failing and the repository being empty are opposite facts.
    // Expanding against `null` as if it were `[]` would match nothing, produce
    // no evidence and no gap, and read exactly like "all clear".
    const { records, gaps } = await gather(['schema/**/*.graphql'], {
      listRepoFiles: async () => null,
    });

    assert.deepEqual(records, []);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]?.path, 'schema/**/*.graphql');
    assert.match(gaps[0]?.detail ?? '', /could not/i);
  });

  test('a provider with no listing at all still reports the pattern as a gap', async () => {
    const { records, gaps } = await gather(['schema/**/*.graphql'], { listRepoFiles: undefined });

    assert.deepEqual(records, []);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]?.path, 'schema/**/*.graphql');
  });

  test('an unexpandable pattern does not stop the literal paths beside it', async () => {
    const { records, gaps } = await gather(['schema/api.graphql', 'schema/**/*.graphql'], {
      listRepoFiles: async () => null,
    });

    assert.deepEqual(records.map((r) => r.dependency), ['schema/api.graphql']);
    assert.equal(gaps.length, 1, 'the pattern is still reported, even though something was compared');
  });

  test('a pattern matching nothing is reported as expanded, not as a failure', async () => {
    // Different from an unexpandable pattern: the repository *was* listed, and
    // the honest answer is that the pattern covers no document. Nothing to
    // compare and nothing to warn about.
    const { records, gaps } = await gather(['proto/**/*.proto']);

    assert.deepEqual(records, []);
    assert.deepEqual(gaps, []);
  });
});
