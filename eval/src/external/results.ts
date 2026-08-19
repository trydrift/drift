import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Dataset } from './dataset.ts';
import type { EnvironmentRecord } from './environment.ts';
import { formatRate, type DatasetMetrics } from './metrics.ts';
import type { ExternalCaseResult } from './record.ts';
import type { Selection } from './selection.ts';

const execFile = promisify(execFileCallback);

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
 *   cases.jsonl       one line per case: provenance, truth, prediction, outcome
 *   metrics.json      the rates, their numerators and denominators, and the refusals
 *   exclusions.json   every case that produced no result, with its reason
 *   report.md         the human-readable rendering of exactly the above
 */

export const RUN_MANIFEST_VERSION = 'drift-external-run-v1';

export interface RunManifest {
  version: string;
  runId: string;
  datasetId: string;
  createdAt: string;
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
}

export interface WriteRunInput {
  runId: string;
  dataset: Dataset;
  datasetVersion: string;
  selection: Selection;
  environment: EnvironmentRecord;
  results: readonly ExternalCaseResult[];
  metrics: DatasetMetrics;
  notes?: string;
  root?: string;
}

export function resultsDir(runId: string, root = process.cwd()): string {
  return join(root, 'eval', 'results', runId);
}

export async function writeRun(input: WriteRunInput): Promise<string> {
  const dir = resultsDir(input.runId, input.root);
  await mkdir(dir, { recursive: true });

  const revision = await driftRevision();
  const manifest: RunManifest = {
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
  await writeJson(join(dir, 'selection.json'), { ...input.selection, dataset: input.dataset });
  await writeJson(join(dir, 'environment.json'), input.environment);
  await writeJson(join(dir, 'metrics.json'), input.metrics);
  await writeJson(
    join(dir, 'exclusions.json'),
    input.results
      .filter((result) => result.excluded !== null)
      .map((result) => ({ caseId: result.caseId, ...result.excluded, provenance: result.provenance })),
  );
  await writeFile(
    join(dir, 'cases.jsonl'),
    `${input.results.map((result) => JSON.stringify(result)).join('\n')}\n`,
    'utf8',
  );
  await writeFile(join(dir, 'report.md'), renderExternalReport({ manifest, ...input }), 'utf8');

  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
    `| Scored | ${metrics.scored} |`,
    `| Excluded | ${metrics.selected - metrics.scored} |`,
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
    lines.push('| Question | Result |', '| --- | --- |');
    for (const [label, value] of Object.entries(metrics.rates).sort()) {
      lines.push(`| ${label} | ${formatRate(value)} |`);
    }
    lines.push('');
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
    `Every case evaluated is listed in \`selection.json\`, and every per-case prediction and outcome in \`cases.jsonl\`,`,
    'both beside this file. No number above was typed by hand; each is read out of `metrics.json`.',
    '',
  );

  return lines.join('\n');
}
