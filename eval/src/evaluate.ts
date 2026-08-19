import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadPublicCase } from './case/load.ts';
import { loadPrivateTruth, privateCaseDir } from './case/private.ts';
import { loadAdjudication, type Conclusion } from './review.ts';
import { readArtifacts } from './runs/store.ts';
import { hashPublicCapsule } from './runs/capsule.ts';
import { scoreDetection, type DetectionScore } from './evaluator/detection.ts';
import { scoreRepair, type RepairScore } from './evaluator/repair.ts';
import { UNAVAILABLE, type PredictionArtifact, type Track } from './artifacts/prediction.ts';
import type { PublicCase } from './case/schema.ts';

/**
 * Layer D. The only module that loads private ground truth, and therefore the
 * only one that may score anything.
 *
 * It reads prediction artifacts from disk rather than running Drift, which is
 * what lets it be fixed and re-run over every past trial — including paid
 * ones — without spending anything, and what lets ordinary CI validate the
 * evaluator with zero model calls.
 */

export interface CaseEvaluation {
  caseId: string;
  track: Track;
  trial: number;
  /** True when the case has changed since the prediction was made; the result is reported as stale, never re-scored. */
  stale: boolean;
  detection: DetectionScore | null;
  repair: RepairScore | null;
  /** Carried through so a report can show what was requested against what the agent confirmed. */
  provenance: PredictionArtifact['provenance'];
  experimentMode: PredictionArtifact['experimentMode'];
  /**
   * Content hash of the accepted adjudication this result was scored against.
   *
   * Deliberately a *separate* concept from capsule staleness. What a prediction
   * saw and what the reviewers later decided are different things, and truth is
   * allowed to improve after a trial was paid for — that is why adjudications
   * are append-only and the evaluator re-reads them. Pinning it here means a
   * report can always say which revision of truth produced a number, without
   * that revision invalidating the trial.
   */
  adjudicationRevision: string;
  /** Integrity problems that make a result uninterpretable rather than merely bad. */
  integrityFailures: string[];
}

export interface EvaluationResult {
  runId: string;
  evaluations: CaseEvaluation[];
  /** Cases present in the corpus that this run produced no artifact for, with why. */
  missing: { caseId: string; reason: string }[];
  integrityFailures: string[];
}

export async function evaluateRun(runId: string, root = process.cwd()): Promise<EvaluationResult> {
  const artifacts = await readArtifacts(runId, root);
  const evaluations: CaseEvaluation[] = [];
  const integrityFailures: string[] = [];
  const missing: { caseId: string; reason: string }[] = [];

  const cases = new Map<string, PublicCase>();
  const truths = new Map<string, Conclusion | null>();
  const adjudicationRevisions = new Map<string, string>();
  const developerPatches = new Map<string, string | null>();
  const hashes = new Map<string, string>();

  for (const artifact of artifacts) {
    if (!cases.has(artifact.caseId)) {
      const publicCase = await loadPublicCase(artifact.caseId, root);
      cases.set(artifact.caseId, publicCase);
      // Recomputed from the corpus as it stands now, and compared against what
      // the trial recorded seeing. Any public artifact that could change a
      // prediction is in it; nothing private is.
      hashes.set(artifact.caseId, await hashPublicCapsule(artifact.caseId, root));

      // Truth is resolved through the adjudication, never through a review
      // directly and never through the case's own metadata. A case whose
      // adjudication is missing or unresolved is not scored at all — the
      // alternative is inventing an expectation.
      const adjudication = await loadAdjudication(artifact.caseId, privateCasesRootFor(root));
      adjudicationRevisions.set(
        artifact.caseId,
        adjudication
          ? createHash('sha256').update(JSON.stringify(adjudication.decision)).digest('hex').slice(0, 16)
          : UNAVAILABLE,
      );
      if (!adjudication || adjudication.status !== 'accepted') {
        truths.set(artifact.caseId, null);
        missing.push({ caseId: artifact.caseId, reason: 'no accepted adjudication' });
      } else {
        truths.set(artifact.caseId, adjudication.decision);
      }

      const truth = await loadPrivateTruth(artifact.caseId, root).catch(() => null);
      developerPatches.set(artifact.caseId, truth?.developerPatch ?? null);
    }

    const truth = truths.get(artifact.caseId) ?? null;
    const failures: string[] = [];
    // An artifact predating the capsule hash records `unavailable`, which is
    // not a match and must not be treated as one: it means the evaluator
    // cannot establish what that trial saw, which is exactly the state
    // staleness exists to refuse.
    const stale = artifact.publicCapsuleHash !== hashes.get(artifact.caseId);

    // A case the reproducibility gate has since disqualified stops
    // contributing, even though its artifacts are still on disk. This is not
    // hypothetical: the gate's first real run moved a case to
    // `oracle-insufficient` *after* three live agent runs had already scored
    // against it, and without this those trials would keep counting against a
    // case the harness has stated it cannot interpret.
    const publicCase = cases.get(artifact.caseId)!;
    if (publicCase.status !== 'benchmark-ready') {
      missing.push({ caseId: artifact.caseId, reason: `case status is ${publicCase.status}: ${publicCase.statusReason ?? ''}` });
      evaluations.push({
        caseId: artifact.caseId,
        track: artifact.track,
        trial: artifact.provenance.trial,
        stale,
        detection: null,
        repair: null,
        provenance: artifact.provenance,
        experimentMode: artifact.experimentMode,
        adjudicationRevision: adjudicationRevisions.get(artifact.caseId) ?? UNAVAILABLE,
        integrityFailures: [],
      });
      continue;
    }

    if (stale) {
      failures.push(
        artifact.publicCapsuleHash === UNAVAILABLE
          ? `${artifact.caseId}: this artifact records no public-capsule hash, so what it saw cannot be established; reported stale rather than re-scored.`
          : `${artifact.caseId}: the public case capsule has changed since this prediction was made (recorded ${artifact.publicCapsuleHash.slice(0, 12)}, now ${(hashes.get(artifact.caseId) ?? '').slice(0, 12)}); the artifact is reported stale rather than re-scored against evidence it never saw.`,
      );
    }
    if (artifact.error) failures.push(`${artifact.caseId} [${artifact.track}]: adapter error — ${artifact.error}`);
    if (!artifact.isolation.audited) {
      failures.push(`${artifact.caseId} [${artifact.track}]: workspace isolation was not audited for this prediction.`);
    }

    const detection = !stale && truth && artifact.detection ? scoreDetection({ caseId: artifact.caseId, detection: artifact.detection, truth }) : null;
    const repair =
      !stale && truth && artifact.repair
        ? scoreRepair({
            caseId: artifact.caseId,
            track: artifact.track,
            repair: artifact.repair,
            oracleStages: artifact.oracleStages,
            truth,
            developerPatch: developerPatches.get(artifact.caseId) ?? null,
          })
        : null;

    // The two CI-blocking product signals. Everything else -- a missed
    // detection, a failed repair -- is a reportable metric, because failing CI
    // on a genuine product miss is how a benchmark starts being tuned away
    // from measuring the product.
    if (detection?.d4.falseSafe) {
      failures.push(
        `false-safe: ${artifact.caseId} [${artifact.track}] — accepted truth is unsafe and Drift's verdict (${detection.d4.verdict}) is safe-equivalent.`,
      );
    }
    if (repair && repair.productionScopeEscapes.length > 0) {
      failures.push(
        `production scope escape: ${artifact.caseId} [${artifact.track}] changed ${repair.productionScopeEscapes.length} file(s) outside its own plan's allowed scope: ${repair.productionScopeEscapes.join(', ')}`,
      );
    }

    integrityFailures.push(...failures);
    evaluations.push({
      caseId: artifact.caseId,
      track: artifact.track,
      trial: artifact.provenance.trial,
      stale,
      detection,
      repair,
      provenance: artifact.provenance,
      experimentMode: artifact.experimentMode,
      adjudicationRevision: adjudicationRevisions.get(artifact.caseId) ?? UNAVAILABLE,
      integrityFailures: failures,
    });
  }

  return { runId, evaluations, missing, integrityFailures };
}

/**
 * The private cases root, in the shape `loadAdjudication` expects (it takes
 * the directory *containing* per-case directories). Kept as a one-liner rather
 * than inlined so the private path appears exactly once in this file.
 */
function privateCasesRootFor(root: string): string {
  return join(privateCaseDir('', root));
}

/**
 * The results that may enter a headline number.
 *
 * Filtering on the artifact's own `experimentMode` rather than on a track-name
 * check, because that is what the field is for: a capability track measures a
 * mechanism's ceiling given that Drift routed work to it, and an ablation
 * deliberately removes part of the pipeline. Pooling either into an end-to-end
 * figure reports something the run did not measure. Anything that would ever
 * compute a corpus-wide rate goes through here.
 */
export function endToEndOnly(evaluations: readonly CaseEvaluation[]): CaseEvaluation[] {
  return evaluations.filter((entry) => entry.experimentMode === 'end-to-end');
}

export { readArtifacts };
export type { PredictionArtifact };
