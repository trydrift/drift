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
 * A published row whose run directory is gone, or is missing one of its
 * canonical artifacts, is a broken provenance chain — not a smaller page. This
 * script fails the build in that case rather than quietly dropping the row:
 * see `requireRunArtifacts` below.
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

/** The canonical artifacts every published run must have. Checked before anything is read. */
const REQUIRED_ARTIFACTS = ['metrics.json', 'manifest.json', 'selection.json', 'environment.json'];

/**
 * Fail loudly, naming the run and the exact missing path, rather than
 * skip the row.
 *
 * `published.json` is an editorial decision that a run is fit to publish. If
 * its directory is deleted or moved after that decision, the page has lost
 * the evidence for numbers it would otherwise still show — the failure has to
 * be as visible as the build itself, not a line in a "runs not found" box
 * nobody scrolls to.
 */
function requireRunArtifacts(runId, dir) {
  const missing = REQUIRED_ARTIFACTS.filter((name) => !existsSync(join(dir, name)));
  if (missing.length > 0) {
    throw new Error(
      `[sync-benchmarks] published run "${runId}" is missing required artifact(s): ` +
        `${missing.map((name) => join(dir, name)).join(', ')}. ` +
        `Either restore the run's artifacts or remove its entry from eval/results/published.json.`,
    );
  }
}

const datasets = [];

for (const entry of published.runs) {
  const dir = join(resultsRoot, entry.runId);
  requireRunArtifacts(entry.runId, dir);

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
    attempted: metrics.attempted ?? metrics.selected,
    notRun: metrics.notRun ?? 0,
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
  /*
   * The newest run's date, not the build's.
   *
   * Two reasons, and the second is the one that matters. `new Date()` here
   * rewrote this file on every build, dev start and typecheck, so the
   * generated data showed up dirty in `git status` constantly and a real
   * change to a number was hidden in the noise. And "generated on" is a
   * question about the evidence rather than about the build machine: a reader
   * wants to know how old the newest result is, not when someone last ran
   * `next build`.
   */
  generatedAt: datasets.map((entry) => entry.runDate).sort().at(-1) ?? '',
  datasets,
};

await writeFile(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stderr.write(`[sync-benchmarks] wrote ${datasets.length} dataset(s)\n`);
