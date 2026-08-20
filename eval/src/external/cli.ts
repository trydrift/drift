import { createGunzip } from 'node:zlib';
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { datasetOrThrow, DATASETS, type Dataset } from './dataset.ts';
import { probeEnvironment } from './environment.ts';
import { computeMetrics, type BaselineSpec } from './metrics.ts';
import type { ExternalCaseResult } from './record.ts';
import { newRunId, resultsDir, writeRun, type RunManifest } from './results.ts';
import { select, type Selectable } from './selection.ts';
import { runKong } from './runners/kong-runner.ts';
import { runSweBump } from './runners/swe-bump-runner.ts';
import { runBump } from './runners/bump-runner.ts';
import { runRoseau } from './runners/roseau-runner.ts';
import { runTimemachine } from './runners/timemachine-runner.ts';

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
  /**
   * Recompute a past run's metrics and report from its own recorded per-case
   * results, without re-running anything.
   *
   * The same separation the case-based harness draws between `run` and
   * `evaluate`, and for the same reason: a run costs an hour of network and,
   * for the agent-bearing tracks, money, so a metric fix must not require
   * paying for the observations again. `cases.jsonl.gz` holds every
   * prediction and label, so everything downstream of it is re-derivable
   * offline.
   */
  rescore?: string;
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
  /**
   * Appends one finished case to `cases.partial.jsonl` before the run ends.
   *
   * A whole-corpus run of these adapters takes hours against the live network,
   * and a run that only writes at the end converts any interruption into zero
   * results. Two runs were lost that way — five hours each, stalled on a
   * network call, nothing on disk. A case that is finished is evidence, and it
   * should survive the case after it going wrong.
   *
   * The partial file is a sibling of the final artifacts and is exactly the
   * shape `--rescore` reads, so an interrupted run can be turned into a
   * reported one without re-running anything.
   */
  checkpoint: (result: ExternalCaseResult) => Promise<void>;
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
  timemachine: runTimemachine,
};

/**
 * Recompute a past run's metrics and report from its stored per-case results.
 *
 * Reads the run's own `manifest.json`, `selection.json` and `environment.json`
 * back and writes them out unchanged, so a re-score cannot quietly restate
 * which Drift commit or which machine produced the observations. Only the
 * derived files move.
 */
export async function rescoreExternal(options: ExternalRunOptions & { rescore: string }): Promise<string> {
  const dir = resultsDir(options.rescore, options.outRoot);
  const selection = JSON.parse(await readFile(join(dir, 'selection.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as RunManifest;
  const environment = JSON.parse(await readFile(join(dir, 'environment.json'), 'utf8'));
  const dataset = (selection.dataset ?? datasetOrThrow(manifest.datasetId)) as Dataset;

  /*
   * A finished run's `cases.jsonl.gz`, or an interrupted one's
   * `cases.partial.jsonl`.
   *
   * The fallback is the point of checkpointing: a run killed after fifty of
   * sixty cases has fifty real observations, and re-scoring them is strictly
   * better than discarding them and calling the ecosystem unevaluated. The
   * resulting artifacts say how many cases they are over, as every artifact
   * here does, so a partial run cannot be mistaken for a whole one.
   */
  const finished = join(dir, 'cases.jsonl.gz');
  const partial = join(dir, 'cases.partial.jsonl');
  const useFinished = existsSync(finished);
  if (!useFinished && !existsSync(partial)) {
    throw new Error(`No per-case results in ${dir}: neither cases.jsonl.gz nor cases.partial.jsonl is present.`);
  }

  const results: ExternalCaseResult[] = [];
  const input = useFinished ? createReadStream(finished).pipe(createGunzip()) : createReadStream(partial);
  const stream = createInterface({ input });
  for await (const line of stream) {
    if (line.trim().length > 0) results.push(JSON.parse(line) as ExternalCaseResult);
  }

  // `available` is a property of the corpus the run read, not of this
  // re-score, so it comes back from the stored metrics rather than being
  // recomputed from a corpus that may have moved on. An interrupted run never
  // wrote one, and falls back to the selection's own count — which is what
  // `available` meant for that run anyway.
  const priorMetrics = existsSync(join(dir, 'metrics.json'))
    ? JSON.parse(await readFile(join(dir, 'metrics.json'), 'utf8'))
    : null;

  const metrics = computeMetrics({
    dataset,
    available: priorMetrics?.available ?? selection.available ?? results.length,
    results,
    ...(rescoreBaseline(dataset) ? { baseline: rescoreBaseline(dataset)! } : {}),
  });

  return writeRun({
    runId: manifest.runId,
    dataset,
    datasetVersion: manifest.datasetVersion,
    selection,
    environment,
    results,
    metrics,
    notes: manifest.notes ?? '',
    // The run's own provenance, handed back so `writeRun` preserves it rather
    // than restamping the artifact with today's commit.
    priorManifest: manifest,
    root: options.outRoot,
  });
}

/**
 * A baseline a re-score can rebuild from what the cases already recorded.
 *
 * Only Kong has one, and it is recoverable because the adapter wrote the
 * marker's own prediction into each case's provenance at run time. A baseline
 * that could not be recomputed from the stored artifact would silently
 * disappear on re-score, which is worse than not having one.
 */
function rescoreBaseline(dataset: Dataset): BaselineSpec | null {
  if (dataset.id !== 'kong') return null;
  return {
    name: 'conventional-commits marker',
    description:
      'Predicts "breaking" whenever the commit message contains a literal BREAKING CHANGE annotation. Not Drift, and not presented as Drift — it is here so a reader can see how much of this task is reachable without reading the text.',
    predict: (result: ExternalCaseResult) => String(result.provenance.extra['markerBaselinePredictsBreaking']) === 'true',
  };
}

export async function runExternal(options: ExternalRunOptions): Promise<string> {
  const dataset = datasetOrThrow(options.datasetId);
  const runner = RUNNERS[dataset.id];
  if (!runner) throw new Error(`No runner is implemented for dataset "${dataset.id}".`);

  const datasetRoot = join(options.benchmarksRoot, dataset.localPath);
  const runId = options.runId ?? newRunId(dataset.id);

  const partialPath = join(resultsDir(runId, options.outRoot), 'cases.partial.jsonl');
  await mkdir(resultsDir(runId, options.outRoot), { recursive: true });

  let selection = select([], { seed: options.seed ?? 20260819 });
  const context: RunnerContext = {
    dataset,
    datasetRoot,
    options,
    checkpoint: async (result) => {
      await appendFile(partialPath, `${JSON.stringify(result)}\n`, 'utf8');
    },
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
  // `--rescore` reads the dataset out of the run's own `selection.json`, so
  // requiring a positional there would mean typing a name that is then
  // ignored — and a command whose arguments are ignored is a command that
  // eventually gets typed wrong without anyone noticing.
  const rescoring = argv.includes('--rescore');
  const [first, ...others] = argv;
  const datasetId = first && !first.startsWith('-') ? first : '';
  const rest = datasetId ? others : argv;

  if (!datasetId && !rescoring) {
    throw new Error(
      `Usage: npm run eval:external -- <dataset> [--ids a,b] [--limit N] [--seed N] [--experiment NAME]\n` +
        `       npm run eval:external -- --rescore <run-id>\n` +
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
      case '--rescore':
        options.rescore = value;
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
  const dir = options.rescore
    ? await rescoreExternal(options as ExternalRunOptions & { rescore: string })
    : await runExternal(options);
  process.stdout.write(`\nWrote ${dir}\n`);
}
