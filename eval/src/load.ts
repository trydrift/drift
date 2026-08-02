import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

export const taxonomySchema = z.object({
  nature: z.string(),
  detectability: z.array(z.string()),
  scope: z.string(),
  visibility: z.array(z.string()),
});

export const fixtureSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  ecosystem: z.string(),
  dependency: z.string(),
  fromVersion: z.string(),
  toVersion: z.string(),
  source: z.object({ repository: z.string(), licence: z.string() }),
  taxonomy: taxonomySchema,
  exposure: z.enum(['direct', 'transitive']),
  expected: z.object({
    upstreamFindings: z.array(z.string()),
    impactSites: z.array(z.string()),
    gaps: z.array(z.string()),
    planNodes: z.array(z.string()),
    edges: z.array(z.object({ from: z.string(), to: z.string(), reason: z.string() })),
    goldPatch: z.string(),
  }),
  oracles: z.object({ negative: z.string(), positive: z.string() }),
  complexity: z.enum(['small', 'medium', 'large']),
  network: z.enum(['disabled', 'fixture-local', 'allowed']),
  provenance: z.object({
    reviewStatus: z.enum(['draft', 'reviewed', 'archived']),
    notes: z.string().optional(),
  }),
});

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
