import type { CaseEvaluation, EvaluationResult } from '../evaluate.ts';
import type { PublicCase } from '../case/schema.ts';
import { aggregateLevel, aggregateRepair, prf, type LevelAggregate, type Rate } from '../evaluator/aggregate.ts';
import type { LevelScore } from '../evaluator/detection.ts';

/**
 * The report.
 *
 * Two rules govern everything below, and both exist because a benchmark's
 * report is where honesty is actually won or lost.
 *
 * Composition comes first, always. A reader who sees "F1 0.83" before they see
 * "4 cases, all synthetic, one ecosystem" has already formed the wrong
 * impression, and no caveat further down undoes it. So the first section is
 * always what the corpus is, and the second is always what was excluded and
 * why.
 *
 * No percentage without its numerator and denominator. `null` rates print as
 * `n/a (0/0)` rather than `0%`, because a rate over nothing is undefined and
 * printing zero is a claim the data does not make.
 */

export interface ReportInput {
  result: EvaluationResult;
  cases: readonly PublicCase[];
  runNotes?: string;
}

export function renderReport(input: ReportInput): string {
  const { result, cases } = input;
  const lines: string[] = [];

  lines.push(`# Drift benchmark — run \`${result.runId}\``, '');
  if (input.runNotes) lines.push(input.runNotes, '');

  lines.push(...composition(cases));
  lines.push(...exclusions(cases, result));
  lines.push(...detectionSection(result));
  lines.push(...repairSection(result));
  lines.push(...integritySection(result));

  return lines.join('\n');
}

function composition(cases: readonly PublicCase[]): string[] {
  const ready = cases.filter((entry) => entry.status === 'benchmark-ready');
  const byKey = (pick: (entry: PublicCase) => string): string => {
    const counts = new Map<string, number>();
    for (const entry of ready) counts.set(pick(entry), (counts.get(pick(entry)) ?? 0) + 1);
    return [...counts.entries()].sort().map(([key, count]) => `${key} ${count}`).join(' · ') || 'none';
  };

  return [
    '## Benchmark composition',
    '',
    `Read this before any number below. **${ready.length} benchmark-ready case(s)** of ${cases.length} in the corpus.`,
    '',
    `- Provenance: ${byKey((entry) => entry.provenanceKind)}`,
    `- Ecosystem: ${byKey((entry) => entry.ecosystem)}`,
    `- Repositories: ${new Set(ready.map((entry) => entry.consumer.repository)).size}`,
    `- Dependencies: ${new Set(ready.map((entry) => entry.dependency.name)).size}`,
    `- Failure category: ${byKey((entry) => entry.failureCategory)}`,
    `- Migration complexity: ${byKey((entry) => entry.migrationComplexity)}`,
    `- Update class: ${byKey((entry) => entry.dependency.updateClass)}`,
    `- Negative/control cases (nothing should break): ${ready.filter((entry) => entry.failureCategory === 'none').length}`,
    '',
  ];
}

function exclusions(cases: readonly PublicCase[], result: EvaluationResult): string[] {
  const excluded = cases.filter((entry) => entry.status !== 'benchmark-ready');
  const lines = ['## Exclusions', '', 'Nothing is silently dropped. Every case not scored is here with its reason.', ''];

  if (excluded.length === 0 && result.missing.length === 0) {
    lines.push('No case was excluded.', '');
    return lines;
  }

  lines.push('| Case | Status | Reason |', '| --- | --- | --- |');
  for (const entry of excluded) {
    lines.push(`| \`${entry.id}\` | ${entry.status} | ${entry.statusReason ?? ''} |`);
  }
  for (const entry of result.missing) {
    lines.push(`| \`${entry.caseId}\` | not-scored | ${entry.reason} |`);
  }
  lines.push('');
  return lines;
}

/**
 * Detection is scored once per case, from the authoritative track.
 *
 * Every repair track also runs detection, because a repair result is only
 * meaningful as a statement about the whole chain that produced it — but those
 * detections are the *same* prediction, not additional evidence. Counting them
 * all would multiply every detection denominator by the number of repair
 * tracks in the run and make the corpus look larger than it is.
 */
function authoritativeDetections(result: EvaluationResult): CaseEvaluation[] {
  const byCase = new Map<string, CaseEvaluation>();
  for (const entry of result.evaluations) {
    if (!entry.detection) continue;
    const existing = byCase.get(entry.caseId);
    if (!existing || (entry.track === 'detect-end-to-end' && existing.track !== 'detect-end-to-end')) {
      byCase.set(entry.caseId, entry);
    }
  }
  return [...byCase.values()].sort((a, b) => a.caseId.localeCompare(b.caseId));
}

function detectionSection(result: EvaluationResult): string[] {
  const scored = authoritativeDetections(result);
  if (scored.length === 0) return ['## Detection', '', 'No detection prediction was scored in this run.', ''];

  const lines = ['## Detection', '', 'Five independent levels. A pooled figure would make a miss undiagnosable.', ''];

  const levels: [string, string, (entry: CaseEvaluation) => LevelScore][] = [
    ['D0', 'dependency-update detection (manifest diff)', (entry) => entry.detection!.d0DependencyDetection],
    ['D1', 'upstream fact discovery (evidence)', (entry) => entry.detection!.d1UpstreamFacts],
    ['D2', 'breaking-change interpretation', (entry) => entry.detection!.d2BreakingChanges],
    ['D3s', 'consumer localization — symbol view', (entry) => entry.detection!.d3LocalizationSymbol],
    ['D3f', 'consumer localization — file view', (entry) => entry.detection!.d3LocalizationFile],
  ];

  lines.push('| Level | What it measures | Cases scored | Not adjudicated | TP | FP | FN | Micro P/R/F1 | Macro P/R/F1 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [id, label, pick] of levels) {
    const aggregate = aggregateLevel(scored.map(pick));
    lines.push(
      `| ${id} | ${label} | ${aggregate.scoredCases} | ${aggregate.notAdjudicatedCases} | ${aggregate.micro.tp} | ${aggregate.micro.fp} | ${aggregate.micro.fn} | ${triple(aggregate.micro)} | ${triple(aggregate.macro)} (n=${aggregate.macro.cases}) |`,
    );
  }
  lines.push('');

  const d4 = scored.map((entry) => entry.detection!.d4);
  lines.push(
    '### D4 — verdict and safety',
    '',
    `- **False-safe: ${d4.filter((entry) => entry.falseSafe).length}** (adjudicated truth is unsafe and Drift's verdict was safe-equivalent). CI-blocking.`,
    `- Unsupported-safe: ${d4.filter((entry) => entry.unsupportedSafe).length} (truth was uncertain and Drift still claimed safe). Reported separately — calling it a false-safe would overstate what the benchmark established.`,
    `- Correct "affected": ${d4.filter((entry) => entry.correctAffected).length} · correct "safe": ${d4.filter((entry) => entry.correctSafe).length}`,
    '',
    '| Verdict | Cases |',
    '| --- | --- |',
  );
  const verdicts = new Map<string, number>();
  for (const entry of d4) verdicts.set(entry.verdict, (verdicts.get(entry.verdict) ?? 0) + 1);
  for (const [verdict, count] of [...verdicts.entries()].sort()) lines.push(`| \`${verdict}\` | ${count} |`);
  lines.push('');

  const taxonomyScored = scored.filter((entry) => entry.detection!.taxonomy.status === 'scored');
  lines.push(
    `Taxonomy: ${taxonomyScored.filter((entry) => entry.detection!.taxonomy.correct).length}/${taxonomyScored.length} correct` +
      ` · ${scored.length - taxonomyScored.length} case(s) had no adjudicated taxonomy.`,
    '',
  );

  lines.push('### Per-case detection', '', '| Case | Track | Verdict | D2 TP/FP/FN | D3s TP/FP/FN | Missed |', '| --- | --- | --- | --- | --- | --- |');
  for (const entry of scored) {
    const detection = entry.detection!;
    lines.push(
      `| \`${entry.caseId}\` | ${entry.track} | \`${detection.d4.verdict}\` | ${counts(detection.d2BreakingChanges)} | ${counts(detection.d3LocalizationSymbol)} | ${detection.d2BreakingChanges.falseNegatives.map((id) => `\`${id}\``).join(', ') || '—'} |`,
    );
  }
  lines.push('');
  return lines;
}

function repairSection(result: EvaluationResult): string[] {
  const scored = result.evaluations.filter((entry) => entry.repair !== null);
  if (scored.length === 0) return ['## Repair', '', 'No repair track ran in this run.', ''];

  const lines = ['## Repair', '', 'One section per production mechanism. These are never pooled — they fail for different reasons and need different fixes.', ''];

  const tracks = [...new Set(scored.map((entry) => entry.track))].sort();
  for (const track of tracks) {
    const forTrack = scored.filter((entry) => entry.track === track);
    const aggregate = aggregateRepair(track, forTrack.map((entry) => entry.repair!));

    lines.push(
      `### \`${track}\``,
      '',
      `- Repair success: ${formatRate(aggregate.repairSuccess)} of scorable outcomes`,
      `- Correct decision (repaired, correctly abstained, or nothing needed): ${formatRate(aggregate.correctDecision)}`,
      `- **Production scope escapes: ${aggregate.productionScopeEscapes}** (CI-blocking) · unexpected in-scope changed files: ${aggregate.unexpectedChangedFiles} (quality signal, never CI-blocking)`,
      `- Gold-patch exact match: ${formatRate(aggregate.goldPatchExactOf)} — diagnostic only, never a gate`,
      `- Excluded from every rate: ${aggregate.excluded} (operational failures and no-trigger cases)`,
      '',
      '| Outcome | Cases |',
      '| --- | --- |',
    );
    for (const [outcome, count] of Object.entries(aggregate.outcomes).sort()) lines.push(`| ${outcome} | ${count} |`);
    lines.push('');

    if (Object.keys(aggregate.resolvedByTier).length > 0) {
      lines.push('Resolved by tier: ' + Object.entries(aggregate.resolvedByTier).sort().map(([tier, count]) => `${tier} ${count}`).join(' · '), '');
    }

    lines.push('| Case | Outcome | Trigger failures | Resolved | New failures | Files | Patch |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const entry of forTrack) {
      const repair = entry.repair!;
      lines.push(
        `| \`${entry.caseId}\` | ${repair.outcome} | ${repair.failToPass.triggerFailures.length} | ${repair.failToPass.resolvedTriggers.length} | ${repair.failToPass.newFailures.length} | ${repair.changedFiles.tp}/${repair.changedFiles.fp}/${repair.changedFiles.fn} | +${repair.patchStats.addedLines}/-${repair.patchStats.removedLines} |`,
      );
    }
    lines.push('');
  }

  return lines;
}

function integritySection(result: EvaluationResult): string[] {
  const lines = ['## Harness integrity', ''];
  if (result.integrityFailures.length === 0) {
    lines.push('No integrity failure. A detection or repair miss above is a product result, not an integrity break — CI does not fail on one.', '');
    return lines;
  }
  lines.push('These are failures of the benchmark or of a production safety guarantee, not product misses:', '');
  for (const failure of result.integrityFailures) lines.push(`- ${failure}`);
  lines.push('');
  return lines;
}

function triple(value: { precision: number; recall: number; f1: number }): string {
  return `${value.precision.toFixed(3)}/${value.recall.toFixed(3)}/${value.f1.toFixed(3)}`;
}

function counts(level: LevelScore): string {
  return level.status === 'not-adjudicated' ? 'not adjudicated' : `${level.confusion.tp}/${level.confusion.fp}/${level.confusion.fn}`;
}

function formatRate(value: Rate): string {
  return value.value === null ? `n/a (0/0)` : `${(value.value * 100).toFixed(1)}% (${value.numerator}/${value.denominator})`;
}

export { prf };
