import { join } from 'node:path';
import {
  buildJars,
  loadRoseau,
  roseauSelectables,
  RoseauUnavailable,
  runRoseauDiff,
  scoreRoseau,
} from '../adapters/roseau.ts';
import type { RunnerContext, RunnerOutput } from '../cli.ts';
import type { ExternalCaseResult } from '../record.ts';

/**
 * Drives the Roseau accuracy dataset.
 *
 * One compile and one japicmp invocation for the whole corpus, then per-case
 * attribution — so running all 267 cases costs about what running one would,
 * and there is no reason to sample. `--limit` still works, and still records
 * what it chose, for a reader who wants a smaller artifact.
 */
export async function runRoseau(context: RunnerContext): Promise<RunnerOutput> {
  const corpus = await loadRoseau(context.datasetRoot);
  const selection = context.choose(roseauSelectables(corpus.cases));
  const wanted = new Set(selection.ids);
  const selected = corpus.cases.filter((entry) => wanted.has(entry.name));

  const started = Date.now();
  let jars: { from: string; to: string };
  try {
    jars = await buildJars(corpus, join(context.datasetRoot, 'build'));
  } catch (err) {
    // The whole corpus shares one build, so a build failure excludes every
    // case — each with the same recorded reason, rather than the run
    // vanishing.
    const unavailable =
      err instanceof RoseauUnavailable
        ? { reason: 'tool-missing', detail: err.message }
        : { reason: 'build-failed', detail: (err as Error).message.slice(0, 500) };
    return {
      results: selected.map((entry) =>
        scoreRoseau({
          entry,
          changes: [],
          diffUnavailable: unavailable,
          datasetVersion: corpus.datasetVersion,
          sourceHash: corpus.sourceHash,
          toolLocator: 'unavailable',
          durationMs: 0,
        }),
      ),
      available: corpus.cases.length,
      datasetVersion: corpus.datasetVersion,
      notes: NOTES,
    };
  }

  const diff = await runRoseauDiff(
    jars,
    corpus.cases.map((entry) => entry.name),
    corpus.sourcePackages,
  );
  const durationMs = Date.now() - started;

  const results: ExternalCaseResult[] = selected.map((entry) =>
    scoreRoseau({
      entry,
      changes: diff.byCase.get(entry.name) ?? [],
      diffUnavailable: diff.unavailable,
      datasetVersion: corpus.datasetVersion,
      sourceHash: corpus.sourceHash,
      toolLocator: diff.toolLocator,
      // One diff serves every case, so a per-case duration would be a
      // fabrication. The whole-run figure is divided evenly and labelled as
      // such by being identical across cases.
      durationMs: Math.round(durationMs / Math.max(1, selected.length)),
    }),
  );

  const unexplained = diff.unmatched.filter((change) => change.classification === 'unknown');
  return {
    results,
    available: corpus.cases.length,
    datasetVersion: corpus.datasetVersion,
    notes:
      diff.unmatched.length > 0
        ? `${NOTES}\n\n${unattributedNote(diff.unmatched.length, unexplained.length, diff.unmatched)}`
        : NOTES,
  };
}

const NOTES =
  'The one corpus here with real negatives. 267 hand-built Java version pairs, each labelled by hand for whether the ' +
  'change is binary-breaking, and roughly half labelled *not* breaking — which is what makes precision, a ' +
  'false-positive rate and F1 defined here and nowhere else in this benchmark.\n\n' +
  "Drift runs its real Java surface diff: `computeSurfaceDiff` from the shipped build, routed to the japicmp " +
  'provider, shelling out to the japicmp binary. The dataset ships source rather than jars, so both trees are ' +
  'compiled with `javac` and served to production\'s own `fetchArchive` as though Maven Central had them. The ' +
  'substitution is transport; every line of analysis between the download and the result is production\'s.\n\n' +
  'Scored against the `isBinaryBreaking` column, because japicmp compares classfiles and binary compatibility is the ' +
  'question it answers. The source-compatibility label is carried in every case artifact for anyone who wants to ' +
  'score it the other way.\n\n' +
  "The replication kit's own recorded labels for Roseau, Japicmp and Revapi travel in each artifact. They are " +
  'labels **as recorded in the kit**, produced on the authors\' machines with their tool versions — not re-run here — ' +
  'and any comparison drawn from them should say so.';

const unattributedNote = (
  count: number,
  unexplained: number,
  changes: readonly { symbol: string; classification: string; reason: string }[],
): string => {
  const lines = [
    `**${count} reported change(s) did not belong to any of the 267 labelled case packages; ${unexplained} are unexplained.**`,
    'Each remaining unmatched change is classified below rather than silently discarded:',
    '',
    ...changes.map((change) => `- \`${change.symbol}\` — ${change.classification}: ${change.reason}`),
  ];
  return lines.join('\n');
};
