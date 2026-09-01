import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { ExternalCaseResult } from './record.ts';
import { resultsDir, type RunManifest } from './results.ts';

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
  const oldById = new Map(oldResults.map((result) => [result.caseId, result]));
  return newResults
    .flatMap((newResult) => {
      const oldResult = oldById.get(newResult.caseId);
      return oldResult
        ? [{ caseId: newResult.caseId, from: caseState(oldResult), to: caseState(newResult), oldResult, newResult }]
        : [];
    })
    .sort((a, b) => a.caseId.localeCompare(b.caseId));
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
  const [oldResults, newResults, manifest] = await Promise.all([
    readCases(oldDir),
    readCases(newDir),
    readFile(join(newDir, 'manifest.json'), 'utf8').then((text) => JSON.parse(text) as RunManifest),
  ]);
  const comparison = renderComparison(manifest.datasetId, compareCases(oldResults, newResults), adjudications);
  process.stdout.write(comparison.text);
  if (comparison.unadjudicatedSafeTransitions.length > 0) {
    process.stderr.write(
      `Positive-corpus non-safe → safe-equivalent transitions require adjudication: ${comparison.unadjudicatedSafeTransitions.join(', ')}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('compare.ts')) await main(process.argv.slice(2));
