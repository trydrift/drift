import {
  loadTimemachine,
  predictTimemachine,
  scoreTimemachine,
  timemachineSelectables,
  TimemachineUnavailable,
  type TimemachineSubset,
} from '../adapters/timemachine.ts';
import type { RunnerContext, RunnerOutput } from '../cli.ts';
import { CaseTimeout, withDeadline } from '../deadline.ts';
import { missing, probeEnvironment } from '../environment.ts';
import type { ExternalCaseResult } from '../record.ts';

/**
 * Drives TimeMachine's detection track.
 *
 * `--experiment verified` is the default and is the human-verified 100-task
 * subset the dataset's own README says to start from. The full 1,145-task
 * corpus is reachable with `--experiment full`, and should not be the first
 * thing anyone runs.
 */
export async function runTimemachine(context: RunnerContext): Promise<RunnerOutput> {
  const subset = (context.options.experiment ?? 'verified') as TimemachineSubset;
  if (!['verified', 'random', 'full'].includes(subset)) {
    throw new Error(`Unknown TimeMachine subset "${subset}". Use verified, random or full.`);
  }

  const { tasks, datasetVersion, sourceHash } = await loadTimemachine(context.datasetRoot, subset);
  const selection = context.choose(timemachineSelectables(tasks));
  const wanted = new Set(selection.ids);

  const environment = await probeEnvironment();
  const absent = missing(environment, ['docker', 'uv']);

  const results: ExternalCaseResult[] = [];
  // Recorded to disk as each case finishes, so an interrupted run still has
  // everything it got through. See `RunnerContext.checkpoint`.
  const recordCase = async (result: ExternalCaseResult): Promise<void> => {
    results.push(result);
    await context.checkpoint(result);
  };
  for (const task of tasks) {
    const id = `${task.repo_name}@${task.commit_hash.slice(0, 12)}`;
    if (!wanted.has(id)) continue;
    // Recorded by an earlier attempt at this run id. See `--resume`.
    if (context.alreadyRecorded.has(id)) continue;
    const started = Date.now();
    try {
      const prediction = await withDeadline(() => predictTimemachine(task));
      await recordCase(
        scoreTimemachine({ task, subset, prediction, excluded: null, datasetVersion, sourceHash, durationMs: Date.now() - started }),
      );
    } catch (err) {
      const unavailable =
        err instanceof TimemachineUnavailable
          ? { kind: err.kind, reason: err.message, missingRequirement: err.missingRequirement }
          : err instanceof CaseTimeout
          ? { kind: 'reproduction-failed' as const, reason: `timed-out: ${err.message}`, missingRequirement: null }
          : {
              kind: 'reproduction-failed' as const,
              reason: `unexpected failure: ${(err as Error).message.slice(0, 500)}`,
              missingRequirement: null,
            };
      await recordCase(
        scoreTimemachine({ task, subset, prediction: null, excluded: unavailable, datasetVersion, sourceHash, durationMs: Date.now() - started }),
      );
    }
  }

  return {
    results,
    available: tasks.length,
    datasetVersion,
    notes: absent.length > 0 ? `${NOTES}\n\n${missingNote(absent)}` : NOTES,
  };
}

const NOTES =
  'Detection only, on a manifest pair this harness assembles — and that construction is the weakest in this ' +
  'benchmark, so it is stated on every case rather than left to be inferred. The repository is fetched at its exact ' +
  "historical commit; the after-state repins the requirements the project itself declares to the versions the " +
  "dataset records as resolving at the migration date. It is *not* built from `patch` or `gold_patch`, which are the " +
  'developer\'s migration and are ground truth — reading the upgrade out of the fix would hand Drift the answer and ' +
  'call the result detection. Only declared requirements are repinned; the rest of the resolved set is the transitive ' +
  'closure, and writing it into a manifest would invent declarations the project never made.\n\n' +
  'No precision and no false-positive rate: every task is a migration that fails, and the corpus contains no ' +
  'migrations that succeed.';

const missingNote = (absent: readonly string[]): string =>
  `**Not installed here: ${absent.map((tool) => `\`${tool}\``).join(', ')}.** TimeMachine's own reproduction is a ` +
  'container per task built against a date-filtered PyPI index, which is what preserves the historical resolution ' +
  'each task depends on. Without it the oracle was not run and no repair question was asked — those outcomes are ' +
  'absent from every case record rather than recorded as failures, because Drift was never asked and did not fail.';
