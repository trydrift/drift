import type { EvalFixture } from './load.ts';
import type { Adjudication, Review } from './review.ts';
import type { AdapterMetrics, FixtureScore } from './score.ts';
import { SCORING_VERSION } from './score.ts';

export interface FixtureComposition {
  total: number;
  benchmarkReady: number;
  draft: number;
  synthetic: number;
  historical: number;
  byEcosystem: Record<string, number>;
  aiReviewed: number;
  humanReviewed: number;
  multiReviewed: number;
  disputed: number;
  staleExcluded: string[];
}

export function computeComposition(
  fixtures: readonly EvalFixture[],
  reviewsByFixture: ReadonlyMap<string, readonly Review[]>,
  staleFixtureIds: readonly string[],
): FixtureComposition {
  const byEcosystem: Record<string, number> = {};
  for (const fixture of fixtures) byEcosystem[fixture.ecosystem] = (byEcosystem[fixture.ecosystem] ?? 0) + 1;

  let aiReviewed = 0;
  let humanReviewed = 0;
  let multiReviewed = 0;
  let disputed = 0;
  for (const fixture of fixtures) {
    const reviews = reviewsByFixture.get(fixture.id) ?? [];
    if (reviews.some((r) => r.reviewer.type === 'ai')) aiReviewed += 1;
    if (reviews.some((r) => r.reviewer.type === 'human')) humanReviewed += 1;
    if (reviews.length > 1) multiReviewed += 1;
    if (reviews.some((r) => r.status === 'disputed')) disputed += 1;
  }

  return {
    total: fixtures.length,
    benchmarkReady: fixtures.filter((f) => f.readiness === 'benchmark-ready').length,
    draft: fixtures.filter((f) => f.readiness === 'draft').length,
    synthetic: fixtures.filter((f) => f.provenance.kind === 'synthetic').length,
    historical: fixtures.filter((f) => f.provenance.kind === 'historical').length,
    byEcosystem,
    aiReviewed,
    humanReviewed,
    multiReviewed,
    disputed,
    staleExcluded: [...staleFixtureIds],
  };
}

export interface FixtureRow {
  fixture: EvalFixture;
  adjudication: Adjudication | null;
  score: FixtureScore | null;
  driftUpstreamFindings: string[];
  driftImpactSites: string[];
}

function fmt(value: number | 'not-applicable'): string {
  return value === 'not-applicable' ? 'n/a' : value.toFixed(3);
}

function fmtBool(value: boolean): string {
  return value ? 'yes' : 'no';
}

export function compositionSection(composition: FixtureComposition): string {
  const ecosystems = Object.entries(composition.byEcosystem)
    .map(([eco, count]) => `${eco}: ${count}`)
    .join(', ');
  return [
    '## Benchmark composition',
    '',
    `- Total fixtures: ${composition.total}`,
    `- Benchmark-ready: ${composition.benchmarkReady}`,
    `- Draft: ${composition.draft}`,
    `- Synthetic: ${composition.synthetic}`,
    `- Historical: ${composition.historical}`,
    `- Ecosystems: ${ecosystems || 'none'}`,
    `- AI-reviewed: ${composition.aiReviewed}`,
    `- Human-reviewed: ${composition.humanReviewed}`,
    `- Multi-reviewed: ${composition.multiReviewed}`,
    `- Disputed: ${composition.disputed}`,
    `- Excluded for stale review: ${composition.staleExcluded.length ? composition.staleExcluded.join(', ') : 'none'}`,
    '',
  ].join('\n');
}

export function adapterMetricsSection(metrics: readonly AdapterMetrics[]): string {
  const lines = [
    '## Detection metrics',
    '',
    'Raw counts first — a single F1 number is never reported without the TP/FP/FN behind it.',
    '',
  ];

  for (const m of metrics) {
    lines.push(
      `### ${m.adapter}`,
      '',
      `Fixtures: ${m.fixtures}`,
      '',
      '| | TP | FP | FN | Micro P | Micro R | Micro F1 | Macro P | Macro R | Macro F1 | Excluded (empty/empty) |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      row('Upstream findings', m.upstream),
      row('Impact sites', m.impact),
      row('Changed files', m.changedFiles),
      '',
      `Taxonomy accuracy: ${fmt(m.taxonomyAccuracy)} · Gap recall: ${fmt(m.gapRecall)}`,
      '',
      `**False-safe: ${m.falseSafeCount}** (accepted truth says unsafe, Drift's real user-facing verdict said safe) · ` +
        `Unsupported-safe: ${m.unsupportedSafeCount} (accepted truth uncertain, Drift said safe — a bad outcome, not a factual false-safe claim)`,
      '',
      '#### Repair',
      '',
      `Opportunities: ${m.repairOpportunities} · Attempts: ${m.repairAttempts} · Successful: ${m.successfulRepairs} · Failed: ${m.failedRepairs}`,
      `Expected abstentions: ${m.expectedAbstentions} · Correct: ${m.correctAbstentions} · Incorrect (unsafe attempt): ${m.incorrectAbstentions} · Missed repair opportunities: ${m.missedRepairOpportunities}`,
      `Repaired-oracle pass rate: ${fmt(m.repairedOraclePassRate)} · Gold-patch exact match rate (secondary): ${fmt(m.goldPatchExactRate)}`,
      `Regressions — failed-to-fix: ${m.regressionCounts['repair-failed-to-fix']}, introduced-regression: ${m.regressionCounts['repair-introduced-regression']}, oracle-unavailable: ${m.regressionCounts['oracle-unavailable']}`,
      `Out-of-scope edits: ${m.outOfScopeEditCount} (rate: ${fmt(m.outOfScopeEditRate)})`,
      '',
    );
  }

  return lines.join('\n');
}

function row(label: string, agg: AdapterMetrics['upstream']): string {
  return [
    `| ${label}`,
    agg.counts.tp,
    agg.counts.fp,
    agg.counts.fn,
    agg.micro.precision.toFixed(3),
    agg.micro.recall.toFixed(3),
    agg.micro.f1.toFixed(3),
    agg.macro === 'not-applicable' ? 'n/a' : agg.macro.precision.toFixed(3),
    agg.macro === 'not-applicable' ? 'n/a' : agg.macro.recall.toFixed(3),
    agg.macro === 'not-applicable' ? 'n/a' : agg.macro.f1.toFixed(3),
    agg.excludedFromMacro,
  ]
    .join(' | ')
    .concat(' |');
}

export function perFixtureSection(rows: readonly FixtureRow[]): string {
  const lines = [
    '## Per-fixture results',
    '',
    '| Fixture | Adapter | Scenario | Ecosystem | Provenance | Accepted reviews | Upstream TP/FP/FN | Impact TP/FP/FN | Verdict | False-safe | Repair expected | Repair actual | Baseline | Broken | Repaired | Regression | Gold patch | Result |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const r of rows) {
    const s = r.score;
    lines.push(
      [
        `| ${r.fixture.id}`,
        s?.adapter ?? 'n/a',
        r.fixture.scenarioLabel,
        r.fixture.ecosystem,
        r.fixture.provenance.kind,
        r.adjudication?.acceptedReviewIds.join(', ') ?? 'none',
        s ? `${s.upstream.tp}/${s.upstream.fp}/${s.upstream.fn}` : 'n/a',
        s ? `${s.impact.tp}/${s.impact.fp}/${s.impact.fn}` : 'n/a',
        s?.verdict ?? 'n/a',
        s ? fmtBool(s.falseSafe) : 'n/a',
        r.adjudication?.decision.repair.expectedAction ?? 'n/a',
        s ? (s.repairAttempted ? 'attempted' : 'abstained') : 'n/a',
        s ? oracleCell(s, 'baseline') : 'n/a',
        s ? oracleCell(s, 'broken') : 'n/a',
        s ? oracleCell(s, 'repaired') : 'n/a',
        s ? s.regressionReason : 'n/a',
        s ? (s.goldPatchExact === 'not-applicable' ? 'n/a' : fmtBool(s.goldPatchExact)) : 'n/a',
        s ? fixtureResultLabel(s) : 'not scored',
      ]
        .join(' | ')
        .concat(' |'),
    );
  }

  return lines.join('\n');
}

function oracleCell(s: FixtureScore, stage: 'baseline' | 'broken' | 'repaired'): string {
  const result = s.oracleStages.find((o) => o.stage === stage);
  if (!result) return 'n/a';
  return `${result.observed}${result.matchesExpectation ? '' : ' (unexpected)'}`;
}

function fixtureResultLabel(s: FixtureScore): string {
  if (s.falseSafe) return 'FAIL (false-safe)';
  if (s.incorrectRepairAttempt) return 'FAIL (unsafe repair attempt)';
  if (s.outOfScopeEditCount > 0) return 'FAIL (out-of-scope edit)';
  if (s.upstream.fp > 0 || s.impact.fp > 0) return 'FAIL (false positive)';
  if (s.upstream.fn > 0 || s.impact.fn > 0) return 'FAIL (false negative)';
  if (s.missedRepairOpportunity) return 'FAIL (missed repair)';
  if (s.repairAttempted && !s.successfulRepair) return 'FAIL (repair did not fix)';
  return 'PASS';
}

export function markdownReport(
  metrics: readonly AdapterMetrics[],
  composition: FixtureComposition,
  rows: readonly FixtureRow[],
): string {
  return [
    `<!-- scoring: ${SCORING_VERSION} -->`,
    '# Drift Accuracy Benchmark',
    '',
    'This is a harness-validation / initial benchmark, not a general accuracy claim.',
    'See eval/README.md for methodology, and the "Benchmark composition" section below for exactly',
    'what this run covers before reading any metric.',
    '',
    compositionSection(composition),
    adapterMetricsSection(metrics),
    perFixtureSection(rows),
  ].join('\n');
}

export interface JsonReport {
  metadata: { scoringVersion: string; generatedAt: string };
  composition: FixtureComposition;
  metrics: readonly AdapterMetrics[];
  fixtures: readonly {
    fixtureId: string;
    adapter: string;
    score: FixtureScore | null;
  }[];
}

export function jsonReport(metrics: readonly AdapterMetrics[], composition: FixtureComposition, rows: readonly FixtureRow[]): string {
  const report: JsonReport = {
    metadata: { scoringVersion: SCORING_VERSION, generatedAt: new Date(0).toISOString() },
    composition,
    metrics,
    fixtures: rows.map((r) => ({ fixtureId: r.fixture.id, adapter: r.score?.adapter ?? '', score: r.score })),
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}
