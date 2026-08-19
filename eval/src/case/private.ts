import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { privateTruthSchema, type PrivateTruth } from './schema.ts';
import { markPrivate, type Private } from './layers.ts';

/**
 * Layer D only.
 *
 * Importing this module is the explicit act that gives a file access to
 * benchmark ground truth, and `eval/src/case/isolation.test.ts` asserts that
 * no adapter under `eval/src/adapters/` or `eval/src/tiers/` does so. The
 * returned value is branded `Private<>`, so it cannot be passed to anything in
 * Layer C even where the call would otherwise typecheck structurally.
 */

export function privateCasesRoot(root = process.cwd()): string {
  return join(root, 'eval', 'cases', 'private');
}

export function privateCaseDir(caseId: string, root?: string): string {
  return join(privateCasesRoot(root), caseId);
}

export async function loadPrivateTruth(caseId: string, root?: string): Promise<Private<PrivateTruth>> {
  const dir = privateCaseDir(caseId, root);
  const body = await readFile(join(dir, 'truth.yml'), 'utf8');
  const parsed = privateTruthSchema.parse(YAML.parse(body));
  if (parsed.caseId !== caseId) {
    throw new Error(`Private truth in ${caseId} declares caseId ${parsed.caseId}.`);
  }

  // `expected/gold.patch` is the single source of truth for the developer
  // patch. It was previously also inlined into `truth.yml`, and the two
  // silently diverged the first time the patch was corrected -- the gate then
  // applied a stale copy and reported every repair-bearing case as
  // environment-unavailable. The file wins; the field remains only as a
  // fallback for a case that has no patch file.
  const goldPatch = await readFile(join(dir, 'expected', 'gold.patch'), 'utf8').catch(() => null);
  return markPrivate(goldPatch === null ? parsed : { ...parsed, developerPatch: goldPatch });
}
