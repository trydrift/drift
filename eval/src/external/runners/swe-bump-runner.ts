import {
  loadSweBump,
  predictSweBump,
  scoreSweBump,
  sweBumpSelectables,
  SweBumpUnavailable,
} from '../adapters/swe-bump.ts';
import type { RunnerContext, RunnerOutput } from '../cli.ts';
import { CaseTimeout, withDeadline } from '../deadline.ts';
import type { ExternalCaseResult } from '../record.ts';

/**
 * Drives swe-bump-bench's detection track.
 *
 * Sequential rather than parallel, and deliberately: each case clones a real
 * repository and drives the full Drift pipeline against the live npm registry
 * and jsDelivr, and running thirty of those at once measures the rate limiter.
 */
export async function runSweBump(context: RunnerContext): Promise<RunnerOutput> {
  const { tasks, datasetVersion, sourceHash } = await loadSweBump(context.datasetRoot);
  const selection = context.choose(sweBumpSelectables(tasks));
  const wanted = new Set(selection.ids);

  const results: ExternalCaseResult[] = [];
  // Recorded to disk as each case finishes, so an interrupted run still has
  // everything it got through. See `RunnerContext.checkpoint`.
  const recordCase = async (result: ExternalCaseResult): Promise<void> => {
    results.push(result);
    await context.checkpoint(result);
  };
  for (const task of tasks) {
    if (!wanted.has(task.id)) continue;
    // Recorded by an earlier attempt at this run id. See `--resume`.
    if (context.alreadyRecorded.has(task.id)) continue;
    const started = Date.now();
    try {
      const prediction = await withDeadline(() => predictSweBump(task));
      await recordCase({
        ...scoreSweBump({ task, prediction, excluded: null, datasetVersion, sourceHash, durationMs: Date.now() - started }),
      });
    } catch (err) {
      // A case that could not be set up, or that ran past its deadline, is
      // excluded with its reason, never scored as a Drift miss. `SweBumpUnavailable` carries the distinction
      // between "GitHub no longer has this commit" and "the manifest does not
      // declare this package"; anything else is an unexpected failure and says
      // so rather than being folded into one of those.
      const unavailable =
        err instanceof SweBumpUnavailable
          ? { kind: err.kind, reason: err.message, missingRequirement: err.missingRequirement }
          : err instanceof CaseTimeout
            ? { kind: 'reproduction-failed' as const, reason: `timed-out: ${err.message}`, missingRequirement: null }
            : { kind: 'reproduction-failed' as const, reason: `unexpected failure: ${(err as Error).message.slice(0, 500)}`, missingRequirement: null };
      await recordCase(
        scoreSweBump({ task, prediction: null, excluded: unavailable, datasetVersion, sourceHash, durationMs: Date.now() - started }),
      );
    }
  }

  return { results, available: tasks.length, datasetVersion, notes: NOTES };
}

const NOTES =
  'Detection only. Every task here is a known-breaking upgrade — the corpus was collected by bumping packages until ' +
  '`tsc` failed — so there is no negative population and no precision or false-positive rate can be computed from it. ' +
  'The questions it does answer are whether Drift sees the update, decides the repository is affected, points at ' +
  'consumer code, and above all whether it ever tells a developer with a broken build that they are fine.\n\n' +
  'Installation and the `tsc` oracle are not run in this track. These projects pin four different Node majors and ' +
  'three package managers against lockfiles from 2022–2024, and a `yarn install` that fails in 2026 is a fact about ' +
  'the registry and this machine rather than about Drift. Keeping the oracle separate lets an install failure ' +
  'exclude a case from repair questions without discarding the detection answer.'
