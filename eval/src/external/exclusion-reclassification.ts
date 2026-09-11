import type { ExternalCaseResult } from './record.ts';

/**
 * Exclusions recorded under a kind that turned out to describe them wrongly.
 *
 * TimeMachine tasks whose checkout pins no dependency that actually moves were
 * excluded as `reproduction-failed` — the kind for "install failed, checkout
 * failed, the baseline did not behave as recorded". Nothing of the sort
 * happened: the task simply contained no dependency update for Drift to
 * analyse. On the published benchmark card that read as "32 excluded —
 * reproduction-failed", which says the harness could not rebuild a third of the
 * corpus, and #214 went looking for an environment problem on that basis.
 * Installing uv recovered none of them, because there was nothing to recover.
 *
 * The adapter now records `no-dependency-update` directly. Cases recorded
 * before that are corrected wherever they are read back — re-scoring, comparing
 * two runs, and carrying an earlier attempt's checkpoint into a `--resume` — so
 * a published figure never has to be re-captured to be labelled honestly, and a
 * resumed run cannot republish the old label for the cases it carries forward.
 *
 * The match is the adapter's exact message rather than a looser pattern: a
 * genuine reproduction failure — a timeout, a failed install — keeps its kind.
 * And only the category moves; the recorded reason, which is the observation,
 * is never rewritten.
 */
const NO_DEPENDENCY_UPDATE =
  /^no requirements file at [0-9a-f]{7,40} declares a package whose resolved version differs, so no dependency update could be constructed for this task$/;

export function reclassifyRecordedExclusion(result: ExternalCaseResult): ExternalCaseResult {
  const excluded = result.excluded;
  if (excluded?.kind === 'reproduction-failed' && NO_DEPENDENCY_UPDATE.test(excluded.reason)) {
    return { ...result, excluded: { ...excluded, kind: 'no-dependency-update' } };
  }
  return result;
}
