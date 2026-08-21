import { bumpSelectables, BumpUnavailable, loadBump, predictBump, scoreBump } from '../adapters/bump.ts';
import type { RunnerContext, RunnerOutput } from '../cli.ts';
import { CaseTimeout, withDeadline } from '../deadline.ts';
import { safeEvidenceCaseId, withEvidenceSnapshot, type EvidenceRunMetadata } from '../evidence-snapshot.ts';
import { missing, probeEnvironment } from '../environment.ts';
import type { ExternalCaseResult } from '../record.ts';

/**
 * Drives BUMP's detection track.
 *
 * The environment probe runs first and its result is reported rather than
 * acted on. A missing container runtime does not stop the run — detection
 * needs only the historical commit pair — but it does decide which questions
 * this run is entitled to answer, and the note below says so before any number
 * appears.
 */
export async function runBump(context: RunnerContext): Promise<RunnerOutput> {
  const { records, datasetVersion, sourceHash } = await loadBump(context.datasetRoot);
  const selection = context.choose(bumpSelectables(records));
  const wanted = new Set(selection.ids);

  const environment = await probeEnvironment();
  const withoutDocker = missing(environment, ['docker']).length > 0;

  const results: ExternalCaseResult[] = [];
  // Recorded to disk as each case finishes, so an interrupted run still has
  // everything it got through. See `RunnerContext.checkpoint`.
  const recordCase = async (result: ExternalCaseResult): Promise<void> => {
    results.push(result);
    await context.checkpoint(result);
  };
  for (const record of records) {
    if (!wanted.has(record.breakingCommit)) continue;
    // Recorded by an earlier attempt at this run id. See `--resume`.
    if (context.alreadyRecorded.has(record.breakingCommit)) continue;
    const started = Date.now();
    try {
      const { value: prediction, evidence } = await withDeadline(() =>
        withEvidenceSnapshot(
          {
            mode: context.evidenceMode,
            caseId: record.breakingCommit,
            caseDir: `${context.evidenceRoot}/${safeEvidenceCaseId(record.breakingCommit)}`,
            blobDir: `${context.evidenceRoot}/blobs`,
          },
          () => predictBump(record),
        ),
      );
      await recordCase(
        withEvidenceMetadata(scoreBump({ record, prediction, excluded: null, datasetVersion, sourceHash, durationMs: Date.now() - started }), evidence),
      );
    } catch (err) {
      const unavailable =
        err instanceof BumpUnavailable
          ? { kind: err.kind, reason: err.message, missingRequirement: err.missingRequirement }
          : err instanceof CaseTimeout
          ? { kind: 'reproduction-failed' as const, reason: `timed-out: ${err.message}`, missingRequirement: null }
          : {
              kind: 'reproduction-failed' as const,
              reason: `unexpected failure: ${(err as Error).message.slice(0, 500)}`,
              missingRequirement: null,
            };
      await recordCase(
        scoreBump({ record, prediction: null, excluded: unavailable, datasetVersion, sourceHash, durationMs: Date.now() - started }),
      );
    }
  }

  return {
    results,
    available: records.length,
    datasetVersion,
    notes: withoutDocker ? `${NOTES}\n\n${NO_DOCKER}` : NOTES,
  };
}

function withEvidenceMetadata(result: ExternalCaseResult, evidence: EvidenceRunMetadata): ExternalCaseResult {
  return {
    ...result,
    provenance: {
      ...result.provenance,
      extra: {
        ...result.provenance.extra,
        evidenceMode: evidence.mode,
        evidenceSnapshotHash: evidence.snapshotHash ?? '',
        evidenceSnapshotPath: evidence.snapshotPath ?? '',
        evidenceRequestCount: String(evidence.requestCount),
      },
    },
  };
}

const NOTES =
  'Detection only, and the commit pair is real. BUMP records the commit that changed the version in `pom.xml`, so its ' +
  "parent is the pre-update state — this run diffs the two revisions a developer actually received rather than a bump " +
  'the harness applied. Drift reads `pom.xml` directly, so nothing has to be built for the manifest diff, evidence ' +
  'retrieval and localization to run exactly as they do for a user.\n\n' +
  'No precision and no false-positive rate: every record is a reproduced *breaking* update, and the corpus contains no ' +
  'non-breaking control updates to measure one against.';

const NO_DOCKER =
  '**No container runtime is available on the machine that produced this run.** BUMP\'s authority on whether a build ' +
  'fails is its published `<sha>-pre` and `<sha>-breaking` images, so the Maven oracle was not run and no repair ' +
  'question was asked. Those outcomes are absent from every case record rather than recorded as failures — an absent ' +
  'key means the question was not asked, where `false` would mean Drift tried and did not manage it. Each case ' +
  'artifact carries both image references so a reader with Docker can run the authoritative reproduction from it.';
