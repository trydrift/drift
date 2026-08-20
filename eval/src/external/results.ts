import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import type { Dataset } from './dataset.ts';
import type { EnvironmentRecord } from './environment.ts';
import { formatRate, type DatasetMetrics } from './metrics.ts';
import type { ExternalCaseResult } from './record.ts';
import type { Selection } from './selection.ts';

const execFile = promisify(execFileCallback);
const gzip = promisify(gzipCallback);

/**
 * The canonical artifacts a run leaves behind.
 *
 * The rule this exists to enforce is that no number reaches a human — a
 * report, a README, the website — except by being read out of a file a run
 * produced. Typing a percentage into a component is how a site ends up
 * claiming something no run ever measured, and the only durable defence is
 * that the number physically lives in an artifact with a run id and a commit
 * next to it.
 *
 *   manifest.json     what ran, at which Drift commit, with which command
 *   selection.json    exactly which cases, and how they were chosen
 *   environment.json  what this machine could and could not run
 *   cases.jsonl.gz    one line per case: provenance, truth, prediction, outcome
 *   metrics.json      the rates, their numerators and denominators, and the refusals
 *   exclusions.json   every case that produced no result, with its reason
 *   report.md         the human-readable rendering of exactly the above
 *
 * The per-case file is gzipped because it is the one that scales with the
 * corpus: a 16,000-commit run writes 18MB of it uncompressed and 1.4MB
 * compressed. Dropping it instead would have been the easy fix and the wrong
 * one — it is the file that lets somebody check a number rather than believe
 * it, and a benchmark whose per-case evidence is too big to keep has an
 * auditability problem, not a storage problem.
 */

export const RUN_MANIFEST_VERSION = 'drift-external-run-v1';

export interface RunManifest {
  version: string;
  runId: string;
  datasetId: string;
  /** When the *observations* were produced. Never moved by a re-score. */
  createdAt: string;
  /** The build that produced the observations. Never moved by a re-score. */
  driftCommit: string;
  driftTreeDirty: boolean;
  /** The benchmark harness's own revision. Identical to `driftCommit` in this repository, and recorded separately so it stays true if that stops being so. */
  harnessVersion: string;
  datasetVersion: string;
  command: string;
  node: string;
  platform: string;
  arch: string;
  notes: string;
  /**
   * When the metrics were last recomputed from those observations, and by
   * which build — present only when a re-score actually happened.
   *
   * Kept strictly apart from `createdAt`/`driftCommit`, which describe the
   * run. The first version of the re-score path rebuilt the whole manifest,
   * so re-scoring a run silently restamped it with today's date and today's
   * commit: the artifact then claimed observations had been produced by a
   * build that never saw them. Scoring may improve after a run; what the run
   * observed may not.
   */
  rescoredAt?: string;
  rescoredAtCommit?: string;
}

export interface WriteRunInput {
  runId: string;
  /**
   * The manifest a previous run wrote, when this is a re-score.
   *
   * Passing it is what keeps the run's own provenance intact; its absence is
   * what marks a genuine run.
   */
  priorManifest?: RunManifest;
  dataset: Dataset;
  datasetVersion: string;
  selection: Selection;
  environment: EnvironmentRecord;
  results: readonly ExternalCaseResult[];
  metrics: DatasetMetrics;
  notes?: string;
  root?: string;
  /**
   * The commit and dirty state to stamp, captured by the caller before this
   * run wrote anything.
   *
   * `writeRun` itself writes into `eval/results/<runId>/` — a tracked
   * directory a republished run id already has committed contents in — so a
   * `git status` taken at this point would see this run's own provisional
   * manifest and environment snapshot as uncommitted changes and report
   * `dirty: true` regardless of how clean the checkout was when the run
   * started. Falling back to a fresh `driftRevision()` keeps this optional
   * for callers, such as a re-score, that write nothing beforehand.
   */
  revision?: { commit: string; dirty: boolean };
}

export function resultsDir(runId: string, root = process.cwd()): string {
  return join(root, 'eval', 'results', runId);
}

export async function writeRun(input: WriteRunInput): Promise<string> {
  const dir = resultsDir(input.runId, input.root);
  await mkdir(dir, { recursive: true });

  const revision = input.revision ?? (await driftRevision());
  const manifest: RunManifest = input.priorManifest
    ? {
        // Everything about *how the observations were produced* comes back
        // untouched. Only the re-score's own footprint is added.
        ...input.priorManifest,
        notes: input.notes ?? input.priorManifest.notes,
        rescoredAt: new Date().toISOString(),
        rescoredAtCommit: revision.commit,
      }
    : {
        version: RUN_MANIFEST_VERSION,
        runId: input.runId,
        datasetId: input.dataset.id,
        createdAt: new Date().toISOString(),
        driftCommit: revision.commit,
        driftTreeDirty: revision.dirty,
        harnessVersion: revision.commit,
        datasetVersion: input.datasetVersion,
        command: process.argv.join(' '),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        notes: input.notes ?? '',
      };

  await writeJson(join(dir, 'manifest.json'), manifest);
  await writeJson(join(dir, 'selection.json'), {
    ...input.selection,
    // A whole-corpus run's id list is every case in the corpus, and writing it
    // out is a megabyte restating what `mode: 'all'` already says. A *sample's*
    // id list is the thing a published subset figure has to be checkable
    // against, so it is always kept.
    ...(input.selection.mode === 'all'
      ? {
          ids: [],
          idsOmitted:
            'mode is "all": every available case was selected, and each one appears in cases.jsonl.gz. The list is omitted rather than restating the corpus.',
        }
      : {}),
    dataset: input.dataset,
  });
  await writeJson(join(dir, 'environment.json'), input.environment);
  await writeJson(join(dir, 'metrics.json'), input.metrics);
  await writeJson(
    join(dir, 'exclusions.json'),
    input.results
      .filter((result) => result.excluded !== null)
      .map((result) => ({ caseId: result.caseId, ...result.excluded, provenance: result.provenance })),
  );
  await writeFile(
    join(dir, 'cases.jsonl.gz'),
    await gzip(`${input.results.map((result) => JSON.stringify(result)).join('\n')}\n`),
  );
  await writeFile(join(dir, 'report.md'), renderExternalReport({ manifest, ...input }), 'utf8');

  return dir;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * A manifest written before the first case, so an interrupted run is
 * re-scorable rather than merely recoverable.
 *
 * It records what is already true — the run id, the dataset, the build about
 * to do the work — and nothing about an outcome. `writeRun` overwrites it when
 * the run finishes; if the run never finishes, this is what lets `--rescore`
 * turn the checkpointed observations into a report.
 */
export async function writeProvisionalManifest(input: {
  runId: string;
  datasetId: string;
  datasetVersion: string;
  notes: string;
  root?: string;
  /** See {@link WriteRunInput.revision}: captured by the caller before this or any other write. */
  revision?: { commit: string; dirty: boolean };
}): Promise<void> {
  const dir = resultsDir(input.runId, input.root);
  await mkdir(dir, { recursive: true });
  const revision = input.revision ?? (await driftRevision());
  const manifest: RunManifest = {
    version: RUN_MANIFEST_VERSION,
    runId: input.runId,
    datasetId: input.datasetId,
    createdAt: new Date().toISOString(),
    driftCommit: revision.commit,
    driftTreeDirty: revision.dirty,
    harnessVersion: revision.commit,
    datasetVersion: input.datasetVersion,
    command: process.argv.join(' '),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    notes: input.notes,
  };
  await writeJson(join(dir, 'manifest.json'), manifest);
}

export async function driftRevision(): Promise<{ commit: string; dirty: boolean }> {
  try {
    const { stdout: commit } = await execFile('git', ['rev-parse', 'HEAD']);
    const { stdout: status } = await execFile('git', ['status', '--porcelain']);
    return { commit: commit.trim(), dirty: status.trim().length > 0 };
  } catch {
    return { commit: 'unavailable', dirty: true };
  }
}

export function newRunId(datasetId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${datasetId}-${stamp}`;
}

/**
 * The report, rendered from the artifacts and from nothing else.
 *
 * Composition first, always: a reader who sees a percentage before they see
 * how many cases it is over has already formed an impression that no caveat
 * further down undoes.
 */
export function renderExternalReport(input: WriteRunInput & { manifest: RunManifest }): string {
  const { dataset, metrics, selection, environment, manifest } = input;
  const lines: string[] = [];

  lines.push(
    `# ${dataset.title} — run \`${manifest.runId}\``,
    '',
    `**${dataset.evaluationQuestion}**`,
    '',
    `What a good result here does *not* establish: ${dataset.doesNotEstablish}`,
    '',
    '## Provenance',
    '',
    '| | |',
    '| --- | --- |',
    `| Dataset | ${dataset.title} |`,
    `| Source | ${dataset.source.url} |`,
    `| Dataset version | \`${manifest.datasetVersion}\` |`,
    `| Licence | ${dataset.licence} |`,
    `| Citation | ${dataset.citation} |`,
    `| Ecosystem | ${dataset.ecosystem} |`,
    `| Benchmark class | ${dataset.datasetClass} |`,
    `| Drift commit | \`${manifest.driftCommit}\`${manifest.driftTreeDirty ? ' (working tree dirty)' : ''} |`,
    `| Run date | ${manifest.createdAt} |`,
    ...(manifest.rescoredAt
      ? [
          `| Re-scored | ${manifest.rescoredAt} at \`${(manifest.rescoredAtCommit ?? '').slice(0, 10)}\` — metrics recomputed from the recorded per-case results; the observations above are unchanged |`,
        ]
      : []),
    `| Command | \`${manifest.command}\` |`,
    `| Platform | ${manifest.platform}/${manifest.arch}, Node ${manifest.node} |`,
    '',
    '## Case accounting',
    '',
    'Read this before any rate below.',
    '',
    '| | Cases |',
    '| --- | --- |',
    `| Available in the dataset | ${metrics.available} |`,
    `| Selected for this run (${selection.mode}${selection.limit === null ? '' : `, limit ${selection.limit}, seed ${selection.seed}`}) | ${metrics.selected} |`,
    ...(metrics.notRun > 0
      ? [`| **Attempted** (this run was interrupted and has not covered its whole selection) | **${metrics.attempted}** |`]
      : []),
    `| Scored | ${metrics.scored} |`,
    `| Excluded | ${metrics.attempted - metrics.scored} |`,
    ...(metrics.notRun > 0 ? [`| Not yet run | ${metrics.notRun} |`] : []),
    `| Negative/control cases among the scored | ${metrics.negativeControls} |`,
    '',
  );

  if (Object.keys(metrics.excluded).length > 0) {
    lines.push('Every exclusion, with its reason:', '', '| Reason | Cases |', '| --- | --- |');
    for (const [reason, count] of Object.entries(metrics.excluded).sort()) lines.push(`| \`${reason}\` | ${count} |`);
    lines.push('');
  }

  if (Object.keys(metrics.missingRequirements).length > 0) {
    lines.push(
      'Exactly what was missing, for the cases the environment could not run:',
      '',
      '| Missing requirement | Cases |',
      '| --- | --- |',
    );
    for (const [need, count] of Object.entries(metrics.missingRequirements).sort()) lines.push(`| \`${need}\` | ${count} |`);
    lines.push(
      '',
      'These are facts about this machine, not results about Drift. They are excluded from every rate rather than',
      'counted as failures, and they are listed here so the exclusion cannot be mistaken for a measurement.',
      '',
    );
  }

  lines.push('## Results', '');
  if (Object.keys(metrics.rates).length === 0) {
    lines.push('No rate was computed: no case produced a scored outcome. See the exclusions above.', '');
  } else {
    lines.push('| Question | Result | 95% interval |', '| --- | --- | --- |');
    for (const [label, value] of Object.entries(metrics.rates).sort()) {
      const interval = metrics.intervals[label];
      lines.push(
        `| ${label} | ${formatRate(value)} | ${
          interval ? `${(interval.low * 100).toFixed(1)}–${(interval.high * 100).toFixed(1)}%` : 'not reported (under 20 cases)'
        } |`,
      );
    }
    lines.push(
      '',
      'Intervals are a case-level bootstrap, resampled over cases rather than trials, and are omitted below twenty',
      'cases — an interval from four cases is arithmetically valid and rhetorically dishonest.',
      '',
    );
  }

  if (metrics.classification && metrics.confusion) {
    lines.push(
      '### Classification',
      '',
      'Computed because this corpus supplies real negatives, so a false positive has a population to be measured over.',
      '',
      '| | |',
      '| --- | --- |',
      `| True positives | ${metrics.confusion.tp} |`,
      `| False positives | ${metrics.confusion.fp} |`,
      `| True negatives | ${metrics.confusion.tn} |`,
      `| False negatives | ${metrics.confusion.fn} |`,
      `| Precision | ${formatRate(metrics.classification.precision)} |`,
      `| Recall | ${formatRate(metrics.classification.recall)} |`,
      `| F1 | ${metrics.classification.f1 === null ? 'n/a' : metrics.classification.f1.toFixed(3)} |`,
      '',
    );
  }

  if (metrics.baseline) {
    lines.push(
      '### Trivial baseline on the same cases',
      '',
      metrics.baseline.description,
      '',
      '| | Precision | Recall |',
      '| --- | --- | --- |',
      `| ${metrics.baseline.name} | ${formatRate(metrics.baseline.precision)} | ${formatRate(metrics.baseline.recall)} |`,
      '',
      'Read this next to the result above. Where the baseline scores close to Drift, the task is not measuring much.',
      '',
    );
  }

  if (Object.keys(metrics.breakdown).length > 0) {
    lines.push(
      '### Breakdown',
      '',
      'Every rate again, split by the dataset\'s own label and by the strata the adapter recorded. A pooled figure',
      'hides both directions of the interesting result, so it is never the only number available here.',
      '',
    );
    const columns = [...new Set(Object.values(metrics.breakdown).flatMap((row) => Object.keys(row)))].sort();
    lines.push(`| Slice | ${columns.join(' | ')} |`, `| --- | ${columns.map(() => '---').join(' | ')} |`);
    for (const [slice, row] of Object.entries(metrics.breakdown).sort()) {
      lines.push(`| ${slice} | ${columns.map((column) => (row[column] ? formatRate(row[column]!) : '—')).join(' | ')} |`);
    }
    lines.push('');
  }

  if (metrics.refusals.length > 0) {
    lines.push(
      '## What is deliberately not reported',
      '',
      'These metrics are not omitted for space. The data cannot support them, and computing them anyway would',
      'produce a number that describes the arithmetic rather than the tool.',
      '',
      '| Metric | Why not |',
      '| --- | --- |',
    );
    for (const refusal of metrics.refusals) lines.push(`| ${refusal.metric} | ${refusal.reason} |`);
    lines.push('');
  }

  if (Object.keys(metrics.mappingCoverage).length > 0) {
    lines.push(
      '## Label mapping coverage',
      '',
      "This corpus's vocabulary is not Drift's, so every label carries a mapping and a confidence. Only `exact` and",
      '`compatible` mappings are scored for category correctness; `ambiguous` and `unsupported` ones are counted here',
      'rather than forced into the nearest Drift kind, which would make the resulting accuracy partly a measurement of',
      'how generously the mapping was written.',
      '',
      '| Mapping status | Cases |',
      '| --- | --- |',
    );
    for (const [status, count] of Object.entries(metrics.mappingCoverage).sort()) lines.push(`| \`${status}\` | ${count} |`);
    lines.push('');
  }

  lines.push(
    '## Ground truth',
    '',
    `- Granularity: **${dataset.groundTruth.granularity}**`,
    `- Exhaustive at that granularity: **${dataset.groundTruth.exhaustive ? 'yes' : 'no'}**`,
    `- Basis: ${dataset.groundTruth.basis}`,
    `- Metrics this annotation can support: ${dataset.groundTruth.supports.join(', ') || 'none'}`,
    '',
    '## Environment',
    '',
    '| Tool | Version | Needed for |',
    '| --- | --- | --- |',
  );
  for (const tool of environment.tools) {
    lines.push(`| \`${tool.tool}\` | ${tool.available ? tool.version : '**not installed**'} | ${tool.neededFor} |`);
  }
  lines.push(
    '',
    '## Reproduction',
    '',
    '```sh',
    `npm run eval:external -- ${dataset.id}${selection.limit === null ? '' : ` --limit ${selection.limit} --seed ${selection.seed}`}`,
    '```',
    '',
    'Every per-case prediction, label and outcome is beside this file:',
    '',
    '```sh',
    'gunzip -c cases.jsonl.gz | jq .',
    '```',
    '',
    'How the cases were chosen is in `selection.json`. No number above was typed by hand; each is read out of',
    '`metrics.json`, which this file is a rendering of.',
    '',
  );

  return lines.join('\n');
}
