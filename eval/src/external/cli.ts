import { join } from 'node:path';
import { datasetOrThrow, DATASETS, type Dataset } from './dataset.ts';
import { probeEnvironment } from './environment.ts';
import { computeMetrics, type BaselineSpec } from './metrics.ts';
import type { ExternalCaseResult } from './record.ts';
import { newRunId, writeRun } from './results.ts';
import { select, type Selectable } from './selection.ts';
import { runKong } from './runners/kong-runner.ts';
import { runSweBump } from './runners/swe-bump-runner.ts';
import { runBump } from './runners/bump-runner.ts';
import { runRoseau } from './runners/roseau-runner.ts';

/**
 * `npm run eval:external -- <dataset> [options]`.
 *
 * Separate from `eval:bench` on purpose. `eval:bench` runs the five synthetic
 * npm capsules — the harness's own regression suite, which must stay fast,
 * offline and runnable in CI. These corpora are other people's data, are
 * fetched on demand, and some of them cannot run at all without a container
 * runtime. Putting them behind the same command would either make CI download
 * gigabytes or make the regression suite silently skip.
 *
 * Nothing here scores anything. Each runner produces `ExternalCaseResult`s and
 * this file writes them out; the metrics are computed from the results file,
 * so re-scoring a past run after a metric fix costs nothing and needs no
 * network.
 */

export interface ExternalRunOptions {
  datasetId: string;
  ids?: string[];
  limit?: number;
  seed?: number;
  /** Some datasets have more than one experiment. Kong has two; they answer different questions. */
  experiment?: string;
  benchmarksRoot: string;
  outRoot: string;
  runId?: string;
  notes?: string;
}

export interface RunnerOutput {
  results: ExternalCaseResult[];
  /** Cases the dataset contains, before selection. The denominator a reader needs for "N of what?". */
  available: number;
  /** The version string actually confirmed for this corpus — a DOI, a commit. Never the one we hoped for. */
  datasetVersion: string;
  /** A trivial baseline on the same cases, where one is meaningful. */
  baseline?: BaselineSpec;
  /** Prepended to the report, for a dataset that needs something said before its numbers. */
  notes?: string;
}

export interface RunnerContext {
  dataset: Dataset;
  /** Absolute path to this dataset's local copy under `benchmarks/`. */
  datasetRoot: string;
  options: ExternalRunOptions;
  /** Applies the run's `--ids` / `--limit` / `--seed` to a candidate list, and records the choice. */
  choose: (candidates: readonly Selectable[]) => ReturnType<typeof select>;
}

type Runner = (context: RunnerContext) => Promise<RunnerOutput>;

/**
 * Registered runners.
 *
 * A dataset described in `dataset.ts` with no entry here is a dataset this
 * harness can name but not run, and asking for it says so rather than
 * producing an empty result set that would read as "Drift scored nothing".
 */
const RUNNERS: Record<string, Runner> = {
  kong: runKong,
  'swe-bump': runSweBump,
  bump: runBump,
  roseau: runRoseau,
};

export async function runExternal(options: ExternalRunOptions): Promise<string> {
  const dataset = datasetOrThrow(options.datasetId);
  const runner = RUNNERS[dataset.id];
  if (!runner) throw new Error(`No runner is implemented for dataset "${dataset.id}".`);

  const datasetRoot = join(options.benchmarksRoot, dataset.localPath);
  const runId = options.runId ?? newRunId(dataset.id);

  let selection = select([], { seed: options.seed ?? 20260819 });
  const context: RunnerContext = {
    dataset,
    datasetRoot,
    options,
    choose: (candidates) => {
      selection = select(candidates, {
        ...(options.ids ? { ids: options.ids } : {}),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.seed === undefined ? {} : { seed: options.seed }),
      });
      return selection;
    },
  };

  const [environment, output] = await Promise.all([probeEnvironment(), runner(context)]);

  const metrics = computeMetrics({
    dataset,
    available: output.available,
    results: output.results,
    ...(output.baseline ? { baseline: output.baseline } : {}),
  });

  return writeRun({
    runId,
    dataset,
    datasetVersion: output.datasetVersion,
    selection,
    environment,
    results: output.results,
    metrics,
    notes: [options.notes, output.notes].filter(Boolean).join('\n\n'),
    root: options.outRoot,
  });
}

export function parseArgs(argv: readonly string[]): ExternalRunOptions {
  const [datasetId, ...rest] = argv;
  if (!datasetId || datasetId.startsWith('-')) {
    throw new Error(
      `Usage: npm run eval:external -- <dataset> [--ids a,b] [--limit N] [--seed N] [--experiment NAME]\n` +
        `Datasets: ${Object.keys(DATASETS).sort().join(', ')}`,
    );
  }

  const options: ExternalRunOptions = {
    datasetId,
    benchmarksRoot: join(process.cwd(), 'benchmarks'),
    outRoot: process.cwd(),
  };

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    const value = rest[index + 1];
    switch (flag) {
      case '--ids':
        options.ids = (value ?? '').split(',').map((id) => id.trim()).filter(Boolean);
        index += 1;
        break;
      case '--limit':
        options.limit = Number(value);
        index += 1;
        break;
      case '--seed':
        options.seed = Number(value);
        index += 1;
        break;
      case '--experiment':
        options.experiment = value;
        index += 1;
        break;
      case '--run-id':
        options.runId = value;
        index += 1;
        break;
      case '--benchmarks':
        options.benchmarksRoot = value ?? options.benchmarksRoot;
        index += 1;
        break;
      case '--out':
        options.outRoot = value ?? options.outRoot;
        index += 1;
        break;
      case '--notes':
        options.notes = value;
        index += 1;
        break;
      default:
        throw new Error(`Unknown flag "${flag}".`);
    }
  }

  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    throw new Error(`--limit must be a positive integer, got "${options.limit}".`);
  }
  return options;
}

if (process.argv[1]?.endsWith('cli.ts')) {
  const options = parseArgs(process.argv.slice(2));
  const dir = await runExternal(options);
  process.stdout.write(`\nWrote ${dir}\n`);
}
