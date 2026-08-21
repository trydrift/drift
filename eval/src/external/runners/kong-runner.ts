import { kongSelectables, loadKong, MARKER_BASELINE, predictKong, scoreKong, type KongExperiment } from '../adapters/kong.ts';
import type { RunnerContext, RunnerOutput } from '../cli.ts';
import type { ExternalCaseResult } from '../record.ts';

/**
 * Drives Kong's two experiments.
 *
 * They are separate runs rather than one, because they answer separate
 * questions over different case sets and pooling them would produce a figure
 * that is neither. `--experiment rq2-category` is the default: it is the one
 * whose labels are not recoverable from a regular expression, and therefore
 * the one that carries information about Drift.
 */
export async function runKong(context: RunnerContext): Promise<RunnerOutput> {
  const experiment = (context.options.experiment ?? 'rq2-category') as KongExperiment;
  if (experiment !== 'rq1-documented' && experiment !== 'rq2-category') {
    throw new Error(`Unknown Kong experiment "${experiment}". Use rq1-documented or rq2-category.`);
  }

  const corpus = await loadKong(context.datasetRoot, experiment);
  const selection = context.choose(kongSelectables(corpus));
  const wanted = new Set(selection.ids);
  const sourceHash = Object.entries(corpus.sourceHashes)
    .sort()
    .map(([file, hash]) => `${file}=${hash}`)
    .join(' ');

  const results: ExternalCaseResult[] = [];
  for (const record of corpus.records) {
    if (!wanted.has(record.id)) continue;
    // Recorded by an earlier attempt at this run id. See `--resume`.
    if (context.alreadyRecorded.has(record.id)) continue;
    const started = Date.now();
    const prediction = await predictKong(record);
    results.push(
      scoreKong({
        record,
        experiment,
        prediction,
        datasetVersion: context.dataset.source.version,
        sourceHash,
        durationMs: Date.now() - started,
      }),
    );
  }

  // The binary experiment only. On the category experiment every case already
  // carries the marker, so a marker baseline would score 100% by construction
  // and would say nothing about anything.
  const baseline =
    experiment === 'rq1-documented'
      ? {
          name: 'conventional-commits marker',
          description:
            'Predicts "breaking" whenever the commit message contains a literal BREAKING CHANGE annotation. Not Drift, and not presented as Drift — it is here so a reader can see how much of this task is reachable without reading the text.',
          predict: (result: ExternalCaseResult) =>
            String(result.provenance.extra['markerBaselinePredictsBreaking']) === 'true',
        }
      : undefined;

  return {
    results,
    available: corpus.records.length,
    datasetVersion: context.dataset.source.version,
    ...(baseline ? { baseline } : {}),
    notes: NOTES[experiment],
  };
}

const NOTES: Record<KongExperiment, string> = {
  'rq2-category':
    'This is a **conditional** experiment on one production stage: Drift\'s prose interpreter ' +
    '(`extractBreakingPassages` + `analyze`, imported from the shipped build). The corpus is commit messages — ' +
    'it contains no consumer repositories, no version pairs and no build oracles — so it establishes nothing ' +
    'about detection in a repository, localization, or repair.',
  'rq1-documented':
    'This is a **conditional** experiment on one production stage, and its labels are close to trivially ' +
    'recoverable: Kong collected breaking commits by looking for a conventional-commits `BREAKING CHANGE` ' +
    'annotation, so 164 of the 165 positives contain that literal marker and so do 29 of the negatives. ' +
    'The marker baseline is reported beside Drift\'s result for exactly that reason. Read the two together; ' +
    'a score a regular expression also achieves is not evidence about a tool.',
};

export { MARKER_BASELINE };
