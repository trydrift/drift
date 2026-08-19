import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPrivateTruth, privateCaseDir } from '../case/private.ts';
import type { HiddenCheck } from '../case/schema.ts';

/**
 * The one place hidden behavioural checks are read.
 *
 * Hidden checks are ground truth: they state what the consumer's behaviour
 * must still be after a correct migration, and a prediction that could read
 * them could be written to satisfy them rather than to migrate. So they live
 * in private truth, and this module — like every other module that touches
 * `case/private.ts` — is off-limits to Layer C. `eval/src/case/isolation.test.ts`
 * asserts no adapter or repair tier imports it.
 *
 * The benchmark runner *does* call this, and that is not a hole in the
 * boundary. The runner is the harness, not a prediction: it hands adapters a
 * `PublicCase` and an audited workspace, and hidden checks never enter either.
 * They are written into the throwaway consumer copy `runCaseStage` makes,
 * after the repair already exists, in exactly the same way the reproducibility
 * gate applies a gold patch to a throwaway copy without the gold patch ever
 * being visible to a prediction.
 */

export async function loadHiddenChecks(caseId: string, root?: string): Promise<HiddenCheck[]> {
  const truth = await loadPrivateTruth(caseId, root).catch(() => null);
  if (!truth) return [];

  const hiddenDir = join(privateCaseDir(caseId, root), 'hidden');
  const checks: HiddenCheck[] = [];

  for (const declaration of truth.hiddenChecks) {
    const files: Record<string, string> = {};
    for (const name of declaration.files) {
      // A declared file that is missing is a broken case, not a check that
      // quietly does nothing: a silently empty check would pass every state
      // and hand back the deletion attack this whole mechanism exists to stop.
      files[join('hidden', name)] = await readFile(join(hiddenDir, name), 'utf8');
    }
    checks.push({ ...declaration, files });
  }

  return checks;
}
