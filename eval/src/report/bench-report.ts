import { endToEndOnly, type CaseEvaluation, type EvaluationResult } from '../evaluate.ts';
import type { PublicCase } from '../case/schema.ts';
import { aggregateLevel, aggregateRepair, prf, trialReliability, type Rate } from '../evaluator/aggregate.ts';
import { isPolicyScoped } from '../evaluator/repair.ts';
import type { LevelScore } from '../evaluator/detection.ts';
import { isolationClaim } from '../case/isolation-level.ts';

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
  // End-to-end only. A conditional or ablation artifact carries a detection
  // too, and folding one in would put a diagnostic's numbers under a headline.
  for (const entry of endToEndOnly(result.evaluations)) {
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
      `| ${id} | ${label} | ${aggregate.scoredCases} | ${aggregate.notAdjudicatedCases} | ${aggregate.micro.tp} | ${aggregate.micro.fp} | ${aggregate.micro.fn} | ${triple(aggregate.micro, aggregate.scoredCases)} | ${triple(aggregate.macro, aggregate.macro.cases)} (n=${aggregate.macro.cases}) |`,
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
    `- Safe but inconclusive: ${d4.filter((entry) => entry.safeButInconclusive).length} (truth is safe and Drift's verdict was not a safety claim at all). Neither a success nor a safety failure, and never counted as either.`,
    '',
    'A verdict is safe-equivalent when it tells the user their repository is unaffected:',
    '`no-incompatible-change-in-checked-surfaces` and `clean`. `detected-not-locally-reachable`',
    'is not one — a completed localization with no hits is not affirmative evidence the repository',
    'is unaffected. Every other verdict describes an incomplete or non-safety check and is never',
    'read as a safety claim in either direction.',
    '',
    '| Verdict | Cases |',
    '| --- | --- |',
  );
  const verdicts = new Map<string, number>();
  for (const entry of d4) verdicts.set(entry.verdict, (verdicts.get(entry.verdict) ?? 0) + 1);
  for (const [verdict, count] of [...verdicts.entries()].sort()) lines.push(`| \`${verdict}\` | ${count} |`);
  lines.push('');

  const taxonomyScored = scored.filter((entry) => entry.detection!.taxonomy.status === 'scored');
  const taxonomyUnattributable = scored.filter((entry) => entry.detection!.taxonomy.status === 'not-attributable');
  lines.push(
    `Taxonomy: ${taxonomyScored.filter((entry) => entry.detection!.taxonomy.correct).length}/${taxonomyScored.length} correct,` +
      ' credited only against breaking changes that matched adjudicated truth at D2.' +
      ` · ${scored.length - taxonomyScored.length - taxonomyUnattributable.length} case(s) had no adjudicated taxonomy.` +
      ` · ${taxonomyUnattributable.length} case(s) stated one taxonomy over several adjudicated findings, so it could not be attributed to one and scored nothing.`,
    '',
  );

  lines.push(
    '### Per-case detection',
    '',
    'The adjudication column pins *which revision of truth* produced the row. It is deliberately separate from',
    'capsule staleness: a corrected adjudication re-scores a past trial, where a changed public capsule cannot.',
    '',
    '| Case | Track | Verdict | D2 TP/FP/FN | D3s TP/FP/FN | Adjudication | Missed |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const entry of scored) {
    const detection = entry.detection!;
    lines.push(
      `| \`${entry.caseId}\` | ${entry.track} | \`${detection.d4.verdict}\` | ${counts(detection.d2BreakingChanges)} | ${counts(detection.d3LocalizationSymbol)} | \`${entry.adjudicationRevision}\` | ${detection.d2BreakingChanges.falseNegatives.map((id) => `\`${id}\``).join(', ') || '—'} |`,
    );
  }
  lines.push('');
  return lines;
}

function repairSection(result: EvaluationResult): string[] {
  const scored = result.evaluations.filter((entry) => entry.repair !== null);
  if (scored.length === 0) return ['## Repair', '', 'No repair track ran in this run.', ''];

  const headlineTracks = [...new Set(endToEndOnly(scored).map((entry) => entry.track))].sort();
  const lines = [
    '## Repair',
    '',
    'One section per production mechanism. These are never pooled — they fail for different reasons and need',
    'different fixes, and only the end-to-end track answers the question a user asks.',
    '',
    headlineTracks.length > 0
      ? `Headline (\`experimentMode: end-to-end\`): ${headlineTracks.map((track) => `\`${track}\``).join(', ')}. Every other section below is a capability or ablation result.`
      : 'No end-to-end repair track ran, so this run supports no headline repair figure — only capability results.',
    '',
  ];

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
      '',
      // The denominator, spelled out. A reader should never have to reconstruct
      // what a percentage was taken over, and the line that used to stand here
      // ("excluded: N — operational failures and no-trigger cases") pooled two
      // exclusions that mean opposite things with a product outcome that is not
      // an exclusion at all.
      '| Accounting | Trials |',
      '| --- | --- |',
      `| Trials this track produced | ${aggregate.attempted} |`,
      `| **Denominator** — valid cases Drift was judged on | **${aggregate.delivery.denominator}** |`,
      `| **Numerator** — successful repairs | **${aggregate.delivery.successful}** |`,
      `| Unsuccessful product outcomes | ${aggregate.delivery.unsuccessful} |`,
      `| …of which Drift began the case and could not finish it | ${aggregate.delivery.deliveryFailures} |`,
      `| Excluded — benchmark or environment, never Drift | ${aggregate.excluded} |`,
      '',
    );

    if (aggregate.excluded > 0) {
      lines.push('Every exclusion, with its reason:', '', '| Exclusion reason | Trials |', '| --- | --- |');
      for (const [reason, count] of Object.entries(aggregate.exclusionReasons).sort()) {
        lines.push(`| ${reason} | ${count} |`);
      }
      lines.push('');
    }

    if (aggregate.delivery.deliveryFailures > 0) {
      lines.push(
        `${aggregate.delivery.deliveryFailures} trial(s) are counted as unsuccessful because Drift started on a valid`,
        'case and could not finish: the agent errored, timed out or was not there when the hierarchy reached it, a',
        'patch would not apply, or a remediation-time install failed. They are product outcomes and stay in the',
        'denominator — dropping them would let this rate improve by failing in a different way.',
        '',
      );
    }

    lines.push('| Outcome | Cases |', '| --- | --- |');
    for (const [outcome, count] of Object.entries(aggregate.outcomes).sort()) lines.push(`| ${outcome} | ${count} |`);
    lines.push('');

    const mode = forTrack[0]?.experimentMode ?? 'conditional';
    if (mode !== 'end-to-end') {
      lines.push(
        `This track is marked \`experimentMode: ${mode}\` in every artifact it produced, and the evaluator refuses to`,
        'fold it into an end-to-end figure. It answers a **capability** question — given Drift routed the work here,',
        'could the mechanism repair it? — because the harness pointed it at commits the planner had already chosen.',
        'The product question, "does Drift produce a valid migration", is answered by `repair-full-remediation`.',
        '',
      );
    }
    if (!isPolicyScoped(track as Parameters<typeof isPolicyScoped>[0])) {
      lines.push(
        'It is also not scored against the adjudicated abstain/repair policy: the decision to act here was made',
        'upstream by the planner, not by this mechanism.',
        '',
      );
    }

    // Reliability covers only cases where a repair was actually called for.
    // A control case whose correct outcome is `no-repair-needed` has nothing
    // to succeed at, and listing it as 0 successes of 3 would read as a
    // failure of the mechanism rather than as the mechanism being right.
    const repairable = forTrack.filter((entry) => entry.repair!.outcome !== 'no-repair-needed');
    const reliability = trialReliability(repairable.map((entry) => ({ ...entry.repair!, trial: entry.trial })));
    if (reliability.some((entry) => entry.trials > 1)) {
      lines.push(
        '**Reliability across independent trials**, over the cases where a repair was called for. First-attempt',
        'success is the headline; the rest of the distribution is here beside it, never instead of it. No',
        'best-of-k figure is computed.',
        '',
        '| Case | Trials | Successes | First attempt | All trials |',
        '| --- | --- | --- | --- | --- |',
      );
      for (const entry of reliability) {
        lines.push(
          `| \`${entry.caseId}\` | ${entry.trials} | ${entry.successes} | ${entry.firstAttemptSuccess ? 'pass' : 'fail'} | ${entry.allTrialsSucceeded ? 'all passed' : 'not all'} |`,
        );
      }
      lines.push('');

      const firstAttempt = reliability.filter((entry) => entry.firstAttemptSuccess).length;
      const allTrials = reliability.filter((entry) => entry.allTrialsSucceeded).length;
      lines.push(
        `First-attempt success: ${firstAttempt}/${reliability.length} case(s) · all-trials success: ${allTrials}/${reliability.length}.`,
        '',
      );
    }

    if (Object.keys(aggregate.resolvedByTier).length > 0) {
      lines.push('Resolved by tier: ' + Object.entries(aggregate.resolvedByTier).sort().map(([tier, count]) => `${tier} ${count}`).join(' · '), '');
    }

    lines.push(...provenanceLines(forTrack));

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

/**
 * What the run asked the agent for, against what the agent confirmed.
 *
 * Printed only when a live trial happened, and printed as two columns rather
 * than one, because they are different claims. A CLI agent resolves its own
 * model and reasoning effort from its own configuration when the flags are
 * absent, so a run can legitimately request one model and be answered by
 * another — and an artifact that showed a single `model` column could not tell
 * a reader which of the two they were looking at.
 */
function provenanceLines(entries: readonly CaseEvaluation[]): string[] {
  const live = entries.filter((entry) => entry.provenance.requestedAgentId !== 'unavailable' || entry.provenance.agentId !== 'unavailable');
  if (live.length === 0) return [];

  const rows = new Map<string, string>();
  for (const entry of live) {
    const p = entry.provenance;
    rows.set(
      `${p.requestedAgentId}|${p.requestedModel}|${p.requestedEffort}|${p.model}|${p.effort}|${p.agentCliVersion}`,
      `| \`${p.requestedAgentId}\` | \`${p.requestedModel}\` | \`${p.requestedEffort}\` | \`${p.model}\` | \`${p.effort}\` | \`${p.agentCliVersion}\` |`,
    );
  }

  return [
    '**Agent selection: requested vs confirmed.** `unavailable` in a confirmed column means the provider did not',
    'report it — never that the requested value was used.',
    '',
    '| Requested agent | Requested model | Requested effort | Confirmed model | Confirmed effort | Agent CLI |',
    '| --- | --- | --- | --- | --- | --- |',
    ...[...rows.values()].sort(),
    '',
  ];
}

function integritySection(result: EvaluationResult): string[] {
  const lines = ['## Harness integrity', '', ...isolationSection(result)];
  if (result.integrityFailures.length === 0) {
    lines.push('No integrity failure. A detection or repair miss above is a product result, not an integrity break — CI does not fail on one.', '');
    return lines;
  }
  lines.push('These are failures of the benchmark or of a production safety guarantee, not product misses:', '');
  for (const failure of result.integrityFailures) lines.push(`- ${failure}`);
  lines.push('');
  return lines;
}

/**
 * P/R/F1, or `n/a` when nothing was scored.
 *
 * `0.000/0.000/0.000` over an empty denominator reads as "Drift scored zero"
 * and means "no adjudication ruled on this level", which is the same mistake
 * as printing `0%` for a rate over nothing.
 */
function triple(value: { precision: number; recall: number; f1: number }, cases: number): string {
  if (cases === 0) return 'n/a';
  return `${value.precision.toFixed(3)}/${value.recall.toFixed(3)}/${value.f1.toFixed(3)}`;
}

function counts(level: LevelScore): string {
  return level.status === 'not-adjudicated' ? 'not adjudicated' : `${level.confusion.tp}/${level.confusion.fp}/${level.confusion.fn}`;
}

function formatRate(value: Rate): string {
  return value.value === null ? `n/a (0/0)` : `${(value.value * 100).toFixed(1)}% (${value.numerator}/${value.denominator})`;
}

export { prf };

/**
 * What "isolated" actually meant, printed as a claim rather than implied by an
 * `audited: true`.
 *
 * The workspace audit is real and it is not the same property as "ground truth
 * is unreachable". A reader deciding whether to trust these numbers is
 * entitled to the difference stated in the report rather than inferred from
 * the source, so the exact level every trial ran under is a table.
 */
function isolationSection(result: EvaluationResult): string[] {
  if (result.evaluations.length === 0) return [];

  const byClaim = new Map<string, number>();
  for (const entry of result.evaluations) {
    const claim = isolationClaim(entry.isolation);
    byClaim.set(claim, (byClaim.get(claim) ?? 0) + 1);
  }

  const lines = ['### Ground-truth isolation', '', '| Trials | What was enforced |', '| --- | --- |'];
  for (const [claim, count] of [...byClaim.entries()].sort()) lines.push(`| ${count} | ${claim} |`);
  lines.push('');
  return lines;
}
