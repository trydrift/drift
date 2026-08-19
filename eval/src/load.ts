import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

/**
 * A fixture is evidence/scenario only — no expected findings, no repair
 * expectation, no review status. Ground truth lives in `reviews/` and
 * `adjudication.yml` (see `eval/src/review.ts`); a fixture cannot assert its
 * own correctness. This is the single Zod source of truth for fixture.yml's
 * shape; `eval/schema/fixture.schema.json` mirrors it for external tooling
 * but is not read at runtime, so keep them in sync by hand when this changes.
 */

const oracleStageSchema = z.object({
  command: z.string(),
  expect: z.enum(['pass', 'fail']),
});

export const fixtureSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    ecosystem: z.string(),
    dependency: z.string(),
    fromVersion: z.string(),
    toVersion: z.string(),
    /**
     * Informational/reporting label only. `drift-full-pipeline` never reads
     * this field — it discovers the change through the real production
     * pipeline. Only the `drift-component-localize-repair` component adapter
     * reads it, and is labelled accordingly wherever its results are shown.
     */
    scenarioLabel: z.string(),
    source: z.object({ repository: z.string(), licence: z.string() }),
    exposure: z.enum(['direct', 'transitive']),
    oracles: z.object({
      baseline: oracleStageSchema,
      broken: oracleStageSchema,
      repaired: oracleStageSchema,
    }),
    complexity: z.enum(['small', 'medium', 'large']),
    network: z.enum(['disabled', 'fixture-local', 'allowed']),
    /**
     * Workflow marker, not truth. A fixture only actually gates scoring as
     * benchmark-ready when `eval:review:validate` confirms it has a valid,
     * non-stale, accepted adjudication -- this field alone proves nothing.
     */
    readiness: z.enum(['draft', 'benchmark-ready']),
    provenance: z.object({
      kind: z.enum(['synthetic', 'historical']),
      createdAt: z.string(),
      author: z.string(),
      notes: z.string().optional(),
    }),
  })
  // `.strict()` is load-bearing: without it, Zod silently accepts an
  // unrecognised `expected:` block, which is exactly the "ground truth
  // sneaks back into fixture.yml" failure mode this rewrite exists to close.
  .strict();

export type EvalFixture = z.infer<typeof fixtureSchema>;

export async function loadFixtures(root = join(process.cwd(), 'eval', 'fixtures')): Promise<EvalFixture[]> {
  const dirs = await readdir(root, { withFileTypes: true });
  const fixtures: EvalFixture[] = [];

  for (const dir of dirs.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const body = await readFile(join(root, dir.name, 'fixture.yml'), 'utf8');
    const parsed = fixtureSchema.parse(YAML.parse(body));
    if (parsed.id !== dir.name) {
      throw new Error(`Fixture ${dir.name} declares id ${parsed.id}.`);
    }
    fixtures.push(parsed);
  }

  return fixtures;
}

export async function loadFixtureYamlBody(fixtureId: string, root = join(process.cwd(), 'eval', 'fixtures')): Promise<string> {
  return readFile(join(root, fixtureId, 'fixture.yml'), 'utf8');
}
