import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { datasetOrThrow, type Dataset } from './dataset.ts';
import type { ExternalCaseResult } from './record.ts';
import { resultsDir, type RunManifest } from './results.ts';
import type { Selection } from './selection.ts';

const SAFE_EQUIVALENT = new Set([
  'clean',
  'no-incompatible-change-in-checked-surfaces',
  'detected-not-locally-reachable',
]);

export type CaseState = 'excluded' | 'cleanup-failed' | 'unknown' | 'safe-equivalent' | 'locally-affected';

export interface CaseTransition {
  caseId: string;
  from: CaseState;
  to: CaseState;
  oldResult: ExternalCaseResult;
  newResult: ExternalCaseResult;
}

export type ComparisonSelection = Selection & { dataset: Dataset };
export type RawComparisonSelection = Selection & { dataset?: Dataset };

export function normalizeComparisonSelection(
  selection: RawComparisonSelection,
  manifest: RunManifest,
): ComparisonSelection {
  return {
    ...selection,
    // Legacy selection artifacts predate the embedded dataset descriptor.
    // Their manifest still records the authoritative dataset id, matching the
    // backward-compatible rescore path in cli.ts.
    dataset: selection.dataset ?? datasetOrThrow(manifest.datasetId),
  };
}

export function caseState(result: ExternalCaseResult): CaseState {
  if (result.excluded) {
    return /ENOTEMPTY|cleanup|directory not empty/i.test(result.excluded.reason) ? 'cleanup-failed' : 'excluded';
  }
  const verdict = String(result.prediction['verdict'] ?? '');
  if (verdict === 'locally-affected') return 'locally-affected';
  if (SAFE_EQUIVALENT.has(verdict)) return 'safe-equivalent';
  return 'unknown';
}

export function compareCases(
  oldResults: readonly ExternalCaseResult[],
  newResults: readonly ExternalCaseResult[],
): CaseTransition[] {
  assertSameCasePopulation(
    'result',
    oldResults.map((result) => result.caseId),
    newResults.map((result) => result.caseId),
  );
  const oldById = new Map(oldResults.map((result) => [result.caseId, result]));
  return newResults
    .map((newResult) => {
      const oldResult = oldById.get(newResult.caseId)!;
      return { caseId: newResult.caseId, from: caseState(oldResult), to: caseState(newResult), oldResult, newResult };
    })
    .sort((a, b) => a.caseId.localeCompare(b.caseId));
}

export function validateRunCompatibility(
  oldManifest: RunManifest,
  newManifest: RunManifest,
  oldSelection: ComparisonSelection,
  newSelection: ComparisonSelection,
  oldResults: readonly ExternalCaseResult[],
  newResults: readonly ExternalCaseResult[],
): void {
  if (oldManifest.datasetId !== newManifest.datasetId) {
    throw new Error(`Cannot compare different datasets: ${oldManifest.datasetId} != ${newManifest.datasetId}.`);
  }
  if (oldManifest.datasetVersion !== newManifest.datasetVersion) {
    throw new Error(
      `Cannot compare different dataset versions: ${oldManifest.datasetVersion} != ${newManifest.datasetVersion}.`,
    );
  }
  if (oldSelection.dataset.id !== oldManifest.datasetId || newSelection.dataset.id !== newManifest.datasetId) {
    throw new Error('A selection dataset identity does not match its run manifest.');
  }

  const oldSource = sourceIdentity(oldSelection.dataset);
  const newSource = sourceIdentity(newSelection.dataset);
  if (oldSource !== newSource) {
    throw new Error(`Cannot compare different dataset sources: ${oldSource} != ${newSource}.`);
  }

  assertSameCasePopulation('selected', oldSelection.ids, newSelection.ids);
  assertSameCasePopulation(
    `old run results versus its selection`,
    oldSelection.ids,
    oldResults.map((result) => result.caseId),
  );
  assertSameCasePopulation(
    `new run results versus its selection`,
    newSelection.ids,
    newResults.map((result) => result.caseId),
  );
}

function sourceIdentity(dataset: Dataset): string {
  const { kind, url, version, conceptVersion } = dataset.source;
  return [kind, url, version, conceptVersion ?? ''].join('|');
}

function assertSameCasePopulation(label: string, oldIds: readonly string[], newIds: readonly string[]): void {
  const oldSet = uniqueCaseIds(`${label} old`, oldIds);
  const newSet = uniqueCaseIds(`${label} new`, newIds);
  const oldOnly = [...oldSet].filter((id) => !newSet.has(id)).sort();
  const newOnly = [...newSet].filter((id) => !oldSet.has(id)).sort();
  if (oldOnly.length > 0 || newOnly.length > 0) {
    throw new Error(
      `${label} case populations differ; old-only: ${oldOnly.join(', ') || 'none'}; new-only: ${newOnly.join(', ') || 'none'}.`,
    );
  }
}

function uniqueCaseIds(label: string, ids: readonly string[]): Set<string> {
  const unique = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (unique.has(id)) duplicates.add(id);
    unique.add(id);
  }
  if (duplicates.size > 0) throw new Error(`${label} contains duplicate case IDs: ${[...duplicates].sort().join(', ')}.`);
  return unique;
}

export function renderComparison(
  dataset: string,
  transitions: readonly CaseTransition[],
  adjudications: Readonly<Record<string, string>> = {},
): { text: string; unadjudicatedSafeTransitions: string[] } {
  const counts = new Map<string, number>();
  for (const transition of transitions) {
    const key = `${transition.from} → ${transition.to}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const safeTransitions = transitions.filter(
    (transition) => transition.newResult.truth.polarity === 'positive' && transition.from !== 'safe-equivalent' && transition.to === 'safe-equivalent',
  );
  const unadjudicatedSafeTransitions = safeTransitions
    .filter((transition) => !adjudications[transition.caseId]?.trim())
    .map((transition) => transition.caseId);

  const lines = [
    `# ${dataset} benchmark transitions`,
    '',
    '| Transition | Cases |',
    '| --- | ---: |',
    ...[...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([transition, count]) => `| ${transition} | ${count} |`),
    '',
  ];

  for (const transition of safeTransitions) {
    const oldPrediction = transition.oldResult.prediction;
    const newPrediction = transition.newResult.prediction;
    lines.push(
      `## ${transition.caseId}: ${transition.from} → ${transition.to}`,
      '',
      `- Dependency: ${transition.newResult.provenance.dependency ?? 'unknown'}`,
      `- Old verdict: ${String(oldPrediction['verdict'] ?? transition.from)}`,
      `- New verdict: ${String(newPrediction['verdict'] ?? transition.to)}`,
      `- Adjudication: ${adjudications[transition.caseId] ?? '**required**'}`,
      '',
      '```json',
      JSON.stringify(
        {
          old: evidenceSummary(transition.oldResult),
          new: evidenceSummary(transition.newResult),
        },
        null,
        2,
      ),
      '```',
      '',
    );
  }

  return { text: `${lines.join('\n')}\n`, unadjudicatedSafeTransitions };
}

function evidenceSummary(result: ExternalCaseResult): Record<string, unknown> {
  return {
    checkedSurfaces: result.prediction['checkedSurfaces'] ?? 'not recorded by this run',
    breakingChanges: result.prediction['breakingChanges'] ?? [],
    impactSites: result.prediction['impactSites'] ?? [],
  };
}

async function readCases(dir: string): Promise<ExternalCaseResult[]> {
  const finished = join(dir, 'cases.jsonl.gz');
  const partial = join(dir, 'cases.partial.jsonl');
  const path = existsSync(finished) ? finished : partial;
  if (!existsSync(path)) throw new Error(`No per-case results found in ${dir}.`);

  const results: ExternalCaseResult[] = [];
  const input = path === finished ? createReadStream(path).pipe(createGunzip()) : createReadStream(path);
  for await (const line of createInterface({ input })) {
    if (line.trim()) results.push(JSON.parse(line) as ExternalCaseResult);
  }
  return results;
}

async function main(argv: readonly string[]): Promise<void> {
  const [oldRun, newRun, ...flags] = argv;
  if (!oldRun || !newRun) {
    throw new Error('Usage: npm run eval:compare -- <old-run> <new-run> [--adjudications path.json]');
  }
  const adjudicationFlag = flags.indexOf('--adjudications');
  const adjudications =
    adjudicationFlag >= 0
      ? (JSON.parse(await readFile(flags[adjudicationFlag + 1]!, 'utf8')) as Record<string, string>)
      : {};
  const oldDir = resultsDir(oldRun);
  const newDir = resultsDir(newRun);
  const [oldResults, newResults, oldManifest, newManifest, oldRawSelection, newRawSelection] = await Promise.all([
    readCases(oldDir),
    readCases(newDir),
    readFile(join(oldDir, 'manifest.json'), 'utf8').then((text) => JSON.parse(text) as RunManifest),
    readFile(join(newDir, 'manifest.json'), 'utf8').then((text) => JSON.parse(text) as RunManifest),
    readFile(join(oldDir, 'selection.json'), 'utf8').then((text) => JSON.parse(text) as RawComparisonSelection),
    readFile(join(newDir, 'selection.json'), 'utf8').then((text) => JSON.parse(text) as RawComparisonSelection),
  ]);
  const oldSelection = normalizeComparisonSelection(oldRawSelection, oldManifest);
  const newSelection = normalizeComparisonSelection(newRawSelection, newManifest);
  validateRunCompatibility(oldManifest, newManifest, oldSelection, newSelection, oldResults, newResults);
  const comparison = renderComparison(newManifest.datasetId, compareCases(oldResults, newResults), adjudications);
  process.stdout.write(comparison.text);
  if (comparison.unadjudicatedSafeTransitions.length > 0) {
    process.stderr.write(
      `Positive-corpus non-safe → safe-equivalent transitions require adjudication: ${comparison.unadjudicatedSafeTransitions.join(', ')}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('compare.ts')) await main(process.argv.slice(2));
