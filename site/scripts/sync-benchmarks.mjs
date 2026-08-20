#!/usr/bin/env node
/**
 * Generate the site's copy of the benchmark results.
 *
 * The rule this exists to enforce is that no percentage on the website was
 * typed by a human. Every number the `/benchmarks` page shows is read out of
 * an `eval/results/<run-id>/metrics.json` that an actual run produced, along
 * with the Drift commit, the dataset DOI or commit, the run date, and the
 * exact case accounting behind it.
 *
 * A page that hardcodes "93% accurate" is not wrong the day it ships. It goes
 * wrong six months later when nobody remembers which run it came from, and by
 * then there is no way to tell. Reading from the artifacts means a number
 * cannot outlive the evidence for it: delete the run and the build fails.
 *
 * Which runs may appear is `eval/results/published.json`, not a glob. A glob
 * would publish whatever was on disk, including a smoke run left over from
 * debugging.
 *
 * Run before every build, dev start and typecheck; the output is committed, so
 * a fresh checkout typechecks before anything runs.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const resultsRoot = join(repoRoot, 'eval', 'results');
// A subdirectory, not `src/data/benchmarks.json`. `src/data/` is the recordings
// directory: `test/real-repo-recordings.test.ts` reads every JSON file directly
// inside it and asserts there is exactly one per supported ecosystem. A
// generated file dropped in beside them fails that test, which is the test
// working — so the generated data gets its own directory rather than the test
// getting a new exception.
const target = join(here, '..', 'src', 'data', 'benchmarks', 'results.json');

const publishedPath = join(resultsRoot, 'published.json');
if (!existsSync(publishedPath)) {
  process.stderr.write('[sync-benchmarks] no eval/results/published.json; keeping the committed copy\n');
  process.exit(0);
}

const published = JSON.parse(await readFile(publishedPath, 'utf8'));

const datasets = [];
const skipped = [];

for (const entry of published.runs) {
  const dir = join(resultsRoot, entry.runId);
  if (!existsSync(join(dir, 'metrics.json'))) {
    // Recorded rather than silently dropped. A published row whose run is gone
    // is a broken provenance chain, and the page should say so out loud rather
    // than quietly showing one fewer dataset.
    skipped.push({ runId: entry.runId, reason: 'no metrics.json in eval/results/' + entry.runId });
    continue;
  }

  const metrics = JSON.parse(await readFile(join(dir, 'metrics.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const selection = JSON.parse(await readFile(join(dir, 'selection.json'), 'utf8'));
  const environment = JSON.parse(await readFile(join(dir, 'environment.json'), 'utf8'));
  const dataset = selection.dataset ?? {};

  datasets.push({
    runId: entry.runId,
    headline: entry.headline === true,
    why: entry.why,

    title: dataset.title ?? entry.runId,
    ecosystem: dataset.ecosystem ?? 'unknown',
    datasetClass: dataset.datasetClass ?? metrics.datasetClass,
    sourceUrl: dataset.source?.url ?? '',
    datasetVersion: manifest.datasetVersion,
    licence: dataset.licence ?? '',
    citation: dataset.citation ?? '',
    evaluationQuestion: dataset.evaluationQuestion ?? '',
    doesNotEstablish: dataset.doesNotEstablish ?? '',
    groundTruth: dataset.groundTruth ?? null,

    driftCommit: manifest.driftCommit,
    driftTreeDirty: manifest.driftTreeDirty === true,
    runDate: manifest.createdAt,
    // Disclosed rather than folded into the run date. Scoring may improve
    // after a run; what the run observed may not, and a reader checking
    // provenance is entitled to both dates.
    rescoredAt: manifest.rescoredAt ?? null,
    rescoredAtCommit: manifest.rescoredAtCommit ?? null,
    command: reproductionCommand(dataset, selection),
    platform: `${manifest.platform}/${manifest.arch}, Node ${manifest.node}`,
    notes: manifest.notes ?? '',

    available: metrics.available,
    selected: metrics.selected,
    scored: metrics.scored,
    excluded: metrics.excluded ?? {},
    missingRequirements: metrics.missingRequirements ?? {},
    negativeControls: metrics.negativeControls,
    selectionMode: selection.mode,
    selectionSeed: selection.seed,
    selectionLimit: selection.limit,

    rates: metrics.rates ?? {},
    confusion: metrics.confusion ?? null,
    classification: metrics.classification ?? null,
    baseline: metrics.baseline ?? null,
    refusals: metrics.refusals ?? [],
    mappingCoverage: metrics.mappingCoverage ?? {},
    breakdown: metrics.breakdown ?? {},
    intervals: metrics.intervals ?? {},

    // Which tools were present decides what several of these runs could even
    // attempt, so the page shows it rather than leaving a reader to guess why
    // a Java run has no repair number.
    tools: (environment.tools ?? []).map((tool) => ({
      tool: tool.tool,
      available: tool.available === true,
      version: tool.version,
      neededFor: tool.neededFor,
    })),
  });
}

/** The command that reproduces this exact run, rebuilt from what it recorded. */
function reproductionCommand(dataset, selection) {
  const parts = [`npm run eval:external -- ${dataset.id ?? '<dataset>'}`];
  if (selection.mode === 'stratified-sample') parts.push(`--limit ${selection.limit}`, `--seed ${selection.seed}`);
  return parts.join(' ');
}

const output = {
  $generated: 'site/scripts/sync-benchmarks.mjs — do not edit; every number here is read from eval/results/<run-id>/metrics.json',
  generatedAt: new Date().toISOString(),
  datasets,
  skipped,
};

await writeFile(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stderr.write(
  `[sync-benchmarks] wrote ${datasets.length} dataset(s)${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}\n`,
);
