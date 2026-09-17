import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrap, contextReduction, median, type CaseTrials, type Interval } from './aggregate.ts';
import { compatibilityProblems, IncompatibleRunsError } from './compare.ts';
import { CONDITION_LABELS, type Condition, type RunManifest, type TrialArtifact } from './schema.ts';
import { readRunManifest, readTrials, reportsRoot, resultsRoot } from './store.ts';

/**
 * Raw autonomous agent vs generic orchestration vs Drift-controlled remediation.
 *
 * Two questions, answered separately:
 *
 *   user value     drift-orchestrated against baseline (the raw agent)
 *   attribution    drift-orchestrated against generic-orchestrated — what
 *                  Drift's analysis adds beyond moving verification out of the
 *                  agent and using fresh sessions, which any orchestrator can do
 *
 * Accuracy comes first and is reported as counts, never as "about the same".
 * Token figures are case-level medians of per-case median changes, as in the
 * canonical summary; every session of an orchestrated trial is in its total.
 * Pooling refuses runs that differ in any experiment setting (the same check
 * `compare` uses).
 */

export const THREE_WAY_CONDITIONS = ['baseline', 'generic-orchestrated', 'drift-orchestrated'] as const satisfies readonly Condition[];
type ThreeWay = (typeof THREE_WAY_CONDITIONS)[number];

export const LABELS: Record<ThreeWay, string> = {
  baseline: 'Raw',
  'generic-orchestrated': 'Generic orch.',
  'drift-orchestrated': 'Drift orch.',
};

export interface TrialMetrics {
  success: boolean;
  gross: number;
  uncached: number;
  output: number;
  modelCalls: number;
  agentSessions: number;
  toolCalls: number;
  agentBroadChecks: number;
  agentNarrowChecks: number;
  dependencyResearch: number;
  dependencySourceAccesses: number;
  changelogAccesses: number;
  registryQueries: number;
  uniqueFilesRead: number;
  controllerChecks: number;
  agentWallMs: number;
  controllerWallMs: number;
  endToEndMs: number;
  costUsd: number | null;
  grossBeforeFirstEdit: number | null;
  grossAfterFirstEdit: number | null;
  grossInRepairSessions: number;
  repairSessions: number;
  filesModified: number;
  medianFilesExposedPerSession: number | null;
  outOfScopeRejections: number;
  unitsTotal: number;
  unitsDeterministic: number;
  unitsSentToAgent: number;
  unitsRequiringRepair: number;
  unitsSkippedProtected: number;
  analysisMs: number;
  termination: string | null;
}

export function trialMetrics(trial: TrialArtifact): TrialMetrics {
  const o = trial.orchestration;
  const ctx = trial.agentContext;
  const research = ctx?.research ?? { dependencySourceAccesses: 0, changelogAccesses: 0, registryQueries: 0 };
  const repair = o?.sessions.filter((s) => s.kind === 'repair') ?? [];
  const exposed = o?.sessions.map((s) => s.allowedFiles?.length).filter((n): n is number => typeof n === 'number') ?? [];
  return {
    success: trial.validation.success,
    gross: trial.usage.grossInputTokens,
    uncached: trial.usage.uncachedInputTokens,
    output: trial.usage.outputTokens,
    modelCalls: trial.usage.modelCalls,
    agentSessions: o ? o.sessions.length : 1,
    toolCalls: trial.tools.toolCalls,
    agentBroadChecks: ctx?.agentVerification?.broad ?? 0,
    agentNarrowChecks: ctx?.agentVerification?.narrow ?? 0,
    dependencyResearch: research.dependencySourceAccesses + research.changelogAccesses + research.registryQueries,
    dependencySourceAccesses: research.dependencySourceAccesses,
    changelogAccesses: research.changelogAccesses,
    registryQueries: research.registryQueries,
    uniqueFilesRead: trial.tools.uniqueFilesRead,
    controllerChecks: o ? o.controller.verifications.reduce((sum, v) => sum + v.checks.length, 0) : 0,
    agentWallMs: o ? o.timing.agentMs : trial.agent.durationMs,
    controllerWallMs: o ? o.timing.controllerVerificationMs + o.timing.baselineMeasurementMs : 0,
    endToEndMs: o ? o.timing.endToEndMs : (ctx?.timing?.endToEndMs ?? trial.agent.durationMs),
    costUsd: trial.usage.costUsd,
    grossBeforeFirstEdit: ctx?.tokensBeforeFirstEdit?.grossInputTokens ?? null,
    grossAfterFirstEdit: ctx?.tokensAfterFirstEdit?.grossInputTokens ?? null,
    grossInRepairSessions: repair.reduce((sum, s) => sum + s.usage.grossInputTokens, 0),
    repairSessions: repair.length,
    filesModified: trial.patch.files,
    medianFilesExposedPerSession: median(exposed),
    outOfScopeRejections: o?.controller.outOfScopeRejections ?? 0,
    unitsTotal: o?.units.total ?? 0,
    unitsDeterministic: (o?.units.resolvedByCodemod ?? 0) + (o?.units.resolvedByFixPlan ?? 0),
    unitsSentToAgent: o?.units.sentToAgent ?? 0,
    unitsRequiringRepair: o?.units.requiringRepair ?? 0,
    unitsSkippedProtected: o?.units.skippedProtected ?? 0,
    analysisMs: o?.timing.analysisMs ?? 0,
    termination: o?.controller.termination ?? null,
  };
}

type NumericKey = { [K in keyof TrialMetrics]: TrialMetrics[K] extends number | null ? K : never }[keyof TrialMetrics];

export interface CellSummary {
  valid: number;
  successes: number;
  excluded: number;
  medians: Partial<Record<NumericKey, number | null>>;
}

export interface PairwiseComparison {
  label: string;
  reference: ThreeWay;
  treatment: ThreeWay;
  pairedCases: number;
  caseGrossChangesPct: { caseId: string; changePct: number | null }[];
  medianCaseGrossChangePct: number | null;
  medianCaseUncachedChangePct: number | null;
  medianCaseAfterFirstEditChangePct: number | null;
  medianCaseModelCallsChangePct: number | null;
  successes: { reference: number; treatment: number; valid: number };
  ci95MedianGrossChangePct: Interval | null;
}

export interface FailureEntry {
  trialId: string;
  caseId: string;
  condition: string;
  repetition: number;
  reasons: string[];
  details: string[];
  termination: string | null;
}

export interface ThreeWayComparison {
  name: string;
  generatedAt: string;
  runIds: string[];
  manifests: Pick<RunManifest, 'runId' | 'driftCommit' | 'requestedModel' | 'requestedEffort' | 'agentCliVersion' | 'runsPerCondition' | 'conditions' | 'cleanEnvironment'>[];
  environmentFingerprints: string[];
  caseIds: string[];
  cells: Record<string, Record<string, CellSummary>>;
  accuracy: { caseId: string; counts: Record<string, { successes: number; valid: number }> }[];
  accuracyTotals: Record<string, { successes: number; valid: number }>;
  failures: FailureEntry[];
  pairwise: PairwiseComparison[];
  exclusions: { trialId: string; reason: string; detail: string }[];
  setAsideAttempts: { runId: string; file: string; reason: string }[];
  positions: Record<string, number[]>;
  gate: {
    driftAccuracyNotBelowRaw: boolean;
    driftAccuracyNotBelowRawInAnyCase: boolean;
    driftMedianGrossReductionVsRawPct: number | null;
    meetsThirtyPercentTarget: boolean;
  };
  notes: string[];
}

const METRIC_KEYS: NumericKey[] = [
  'gross', 'uncached', 'output', 'modelCalls', 'agentSessions', 'toolCalls', 'agentBroadChecks', 'agentNarrowChecks', 'dependencyResearch',
  'dependencySourceAccesses', 'changelogAccesses', 'registryQueries', 'uniqueFilesRead', 'controllerChecks', 'agentWallMs', 'controllerWallMs',
  'endToEndMs', 'costUsd', 'grossBeforeFirstEdit', 'grossAfterFirstEdit', 'grossInRepairSessions', 'repairSessions', 'filesModified',
  'medianFilesExposedPerSession', 'outOfScopeRejections', 'unitsTotal', 'unitsDeterministic', 'unitsSentToAgent', 'unitsRequiringRepair',
  'unitsSkippedProtected', 'analysisMs',
];

const changePct = (reference: number | null | undefined, treatment: number | null | undefined): number | null => {
  const reduction = contextReduction(reference ?? null, treatment ?? null);
  return reduction === null ? null : -reduction * 100;
};
const med = (values: readonly (number | null | undefined)[]): number | null => median(values.filter((v): v is number => typeof v === 'number'));

export function threeWayFromTrials(
  trials: readonly TrialArtifact[],
  manifests: readonly RunManifest[],
  extras: { name: string; now?: Date; setAsideAttempts?: ThreeWayComparison['setAsideAttempts'] },
): ThreeWayComparison {
  const relevant = trials.filter((t) => (THREE_WAY_CONDITIONS as readonly string[]).includes(t.condition));
  const caseIds = [...new Set(relevant.map((t) => t.caseId))].sort();
  const valid = (caseId: string, condition: ThreeWay) => relevant.filter((t) => t.caseId === caseId && t.condition === condition && t.validity.valid);

  const cells: ThreeWayComparison['cells'] = {};
  for (const caseId of caseIds) {
    cells[caseId] = {};
    for (const condition of THREE_WAY_CONDITIONS) {
      const all = relevant.filter((t) => t.caseId === caseId && t.condition === condition);
      const ok = all.filter((t) => t.validity.valid);
      const metrics = ok.map(trialMetrics);
      const medians: CellSummary['medians'] = {};
      for (const key of METRIC_KEYS) medians[key] = med(metrics.map((m) => m[key]));
      cells[caseId]![condition] = { valid: ok.length, successes: ok.filter((t) => t.validation.success).length, excluded: all.length - ok.length, medians };
    }
  }

  const accuracy = caseIds.map((caseId) => ({
    caseId,
    counts: Object.fromEntries(THREE_WAY_CONDITIONS.map((c) => [c, { successes: cells[caseId]![c]!.successes, valid: cells[caseId]![c]!.valid }])),
  }));
  const accuracyTotals = Object.fromEntries(
    THREE_WAY_CONDITIONS.map((c) => [c, accuracy.reduce((sum, row) => ({ successes: sum.successes + row.counts[c]!.successes, valid: sum.valid + row.counts[c]!.valid }), { successes: 0, valid: 0 })]),
  );

  const pair = (reference: ThreeWay, treatment: ThreeWay, label: string): PairwiseComparison => {
    const groups: CaseTrials[] = caseIds.map((caseId) => ({ caseId, baseline: valid(caseId, reference), drift: valid(caseId, treatment) }));
    const paired = groups.filter((g) => g.baseline.length > 0 && g.drift.length > 0);
    const caseChange = (key: NumericKey) =>
      med(paired.map((g) => changePct(med(g.baseline.map((t) => trialMetrics(t)[key])), med(g.drift.map((t) => trialMetrics(t)[key])))));
    const boot = bootstrap(groups).medianReduction;
    return {
      label,
      reference,
      treatment,
      pairedCases: paired.length,
      caseGrossChangesPct: groups.map((g) => ({
        caseId: g.caseId,
        changePct: g.baseline.length && g.drift.length ? changePct(med(g.baseline.map((t) => t.usage.grossInputTokens)), med(g.drift.map((t) => t.usage.grossInputTokens))) : null,
      })),
      medianCaseGrossChangePct: caseChange('gross'),
      medianCaseUncachedChangePct: caseChange('uncached'),
      medianCaseAfterFirstEditChangePct: caseChange('grossAfterFirstEdit'),
      medianCaseModelCallsChangePct: caseChange('modelCalls'),
      successes: {
        reference: groups.reduce((sum, g) => sum + g.baseline.filter((t) => t.validation.success).length, 0),
        treatment: groups.reduce((sum, g) => sum + g.drift.filter((t) => t.validation.success).length, 0),
        valid: Math.min(groups.reduce((sum, g) => sum + g.baseline.length, 0), groups.reduce((sum, g) => sum + g.drift.length, 0)),
      },
      // The bootstrap reports reductions; flip them to changes so signs match the point estimate.
      ci95MedianGrossChangePct: boot ? { ...boot, low: -boot.high * 100, high: -boot.low * 100 } : null,
    };
  };

  const pairwise = [
    pair('baseline', 'generic-orchestrated', 'Generic vs Raw'),
    pair('baseline', 'drift-orchestrated', 'Drift vs Raw'),
    pair('generic-orchestrated', 'drift-orchestrated', 'Drift vs Generic'),
  ];

  const failures: FailureEntry[] = relevant
    .filter((t) => t.validity.valid && !t.validation.success)
    .sort((a, b) => a.caseId.localeCompare(b.caseId) || a.condition.localeCompare(b.condition) || a.repetition - b.repetition)
    .map((t) => ({
      trialId: t.trialId,
      caseId: t.caseId,
      condition: LABELS[t.condition as ThreeWay],
      repetition: t.repetition,
      reasons: t.validation.failureReasons,
      details: [
        ...t.validation.dependencyIntegrity.details.filter(() => !t.validation.dependencyIntegrity.passed),
        ...t.validation.checks.filter((c) => !c.passed).map((c) => `check failed: ${c.name}${c.timedOut ? ' (timed out)' : ''} — ${c.outputExcerpt.split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 240)}`),
        ...t.validation.hiddenTests.filter((h) => !h.passed).map((h) => `hidden test failed: ${h.id} — ${h.outputExcerpt.split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 240)}`),
        ...t.validation.forbidden.filter((f) => !f.passed).map((f) => `workaround rule: ${f.description} (${f.detail.slice(0, 160)})`),
      ],
      termination: t.orchestration?.controller.termination ?? null,
    }));

  const drift = pairwise[1]!;
  const rawTotal = accuracyTotals['baseline']!;
  const driftTotal = accuracyTotals['drift-orchestrated']!;
  const positions: Record<string, number[]> = {};
  for (const condition of THREE_WAY_CONDITIONS) {
    const counts = [0, 0, 0];
    for (const t of relevant.filter((x) => x.condition === condition && x.schedule)) counts[t.schedule!.position - 1] = (counts[t.schedule!.position - 1] ?? 0) + 1;
    positions[LABELS[condition]] = counts;
  }

  return {
    name: extras.name,
    generatedAt: (extras.now ?? new Date()).toISOString(),
    runIds: manifests.map((m) => m.runId),
    manifests: manifests.map((m) => ({
      runId: m.runId,
      driftCommit: m.driftCommit,
      requestedModel: m.requestedModel,
      requestedEffort: m.requestedEffort,
      agentCliVersion: m.agentCliVersion,
      runsPerCondition: m.runsPerCondition,
      conditions: m.conditions,
      cleanEnvironment: m.cleanEnvironment,
    })),
    environmentFingerprints: [...new Set(relevant.filter((t) => t.validity.valid).map((t) => t.metadata.agentConfiguration.environment?.fingerprint ?? 'unrecorded'))],
    caseIds,
    cells,
    accuracy,
    accuracyTotals,
    failures,
    pairwise,
    exclusions: relevant.filter((t) => !t.validity.valid).map((t) => ({ trialId: t.trialId, reason: t.validity.infrastructureFailure ?? 'unknown', detail: (t.validity.detail ?? '').split('\n')[0]!.slice(0, 200) })),
    setAsideAttempts: extras.setAsideAttempts ?? [],
    positions,
    gate: {
      driftAccuracyNotBelowRaw: rawTotal.valid > 0 && driftTotal.successes / Math.max(1, driftTotal.valid) >= rawTotal.successes / rawTotal.valid && driftTotal.successes >= rawTotal.successes * (driftTotal.valid / Math.max(1, rawTotal.valid)),
      driftAccuracyNotBelowRawInAnyCase: accuracy.every((row) => row.counts['drift-orchestrated']!.successes >= row.counts['baseline']!.successes),
      driftMedianGrossReductionVsRawPct: drift.medianCaseGrossChangePct === null ? null : -drift.medianCaseGrossChangePct,
      meetsThirtyPercentTarget: drift.medianCaseGrossChangePct !== null && drift.medianCaseGrossChangePct <= -30,
    },
    notes: [
      'Development cases only (they informed the architecture). Nothing here is held-out evidence or a public claim.',
      `Tiny sample: ${caseIds.length} case(s). Bootstrap intervals are shown but are wide by construction.`,
      'Tokens are provider-reported. For orchestrated conditions every session is summed (open, unit and repair sessions); controller verification is not model usage and is not in any token figure.',
      'Token changes are case-level medians: per case, treatment median / reference median - 1; then the median across cases. Negative is fewer tokens.',
      'Tokens before/after first edit: main-model usage up to and including the call that issued the first file edit across all sessions in order, and everything after it.',
      'Agent broad checks: whole-project build/typecheck/lint/test commands the agent ran itself (shell commands only), classified identically for every condition.',
      'Dependency research: Read/Grep/Glob/shell accesses to node_modules/<dependency>, changelog/migration files, and registry queries.',
      'Agent wall: time inside agent sessions. Controller wall: pre-upgrade baseline measurement + controller verification. End-to-end: from the start of Drift analysis (or the first session) to the end of the controller.',
    ],
  };
}

export async function buildThreeWay(args: { name: string; runIds: string[]; root: string; now?: Date }): Promise<ThreeWayComparison> {
  const runs = [];
  for (const runId of args.runIds) {
    const aborted = await readFile(join(resultsRoot(args.root), 'raw', runId, 'ABORTED.md'), 'utf8').then(() => true, () => false);
    runs.push({ manifest: await readRunManifest(runId, args.root), trials: await readTrials(runId, args.root), aborted });
  }
  const problems = compatibilityProblems(runs);
  if (problems.length > 0) throw new IncompatibleRunsError(problems);
  const setAside: ThreeWayComparison['setAsideAttempts'] = [];
  for (const runId of args.runIds) {
    const dir = join(resultsRoot(args.root), 'raw', runId, 'trials');
    for (const file of (await readdir(dir).catch(() => [] as string[])).filter((f) => /\.attempt-\d+\.json$/.test(f)).sort()) {
      const attempt = JSON.parse(await readFile(join(dir, file), 'utf8')) as TrialArtifact;
      setAside.push({ runId, file, reason: `${attempt.validity.infrastructureFailure ?? 'environment'}: ${(attempt.validity.detail ?? '').split('\n')[0]!.slice(0, 120)}` });
    }
  }
  return threeWayFromTrials(runs.flatMap((r) => r.trials), runs.map((r) => r.manifest), { name: args.name, now: args.now, setAsideAttempts: setAside });
}

export async function writeThreeWay(comparison: ThreeWayComparison, root: string): Promise<{ json: string; markdown: string }> {
  const jsonDir = join(resultsRoot(root), 'comparisons');
  await mkdir(jsonDir, { recursive: true });
  await mkdir(reportsRoot(root), { recursive: true });
  const json = join(jsonDir, `${comparison.name}.json`);
  const markdown = join(reportsRoot(root), `${comparison.name}.md`);
  await writeFile(json, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
  await writeFile(markdown, `${renderThreeWay(comparison)}\n`, 'utf8');
  return { json, markdown };
}

const int = (v: number | null | undefined) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-US'));
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const sec = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v / 1000)}s`);
const usd = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `$${v.toFixed(2)}`);

export function renderThreeWay(c: ThreeWayComparison): string {
  const out: string[] = [`# Controller-owned remediation: ${c.name}`, '', `Generated ${c.generatedAt}.`, ''];
  for (const note of c.notes) out.push(`- ${note}`);
  out.push('');
  for (const m of c.manifests) {
    out.push(`- Run \`${m.runId}\`: ${m.requestedModel}, effort ${m.requestedEffort}, ${m.agentCliVersion}, Drift ${m.driftCommit.slice(0, 12)}, ${m.cleanEnvironment ?? 'unrecorded'} sessions, ${m.runsPerCondition} repetition(s), conditions ${m.conditions.map((x) => CONDITION_LABELS[x]).join(', ')}.`);
  }
  out.push(`- Session environment fingerprint(s) across valid trials: ${c.environmentFingerprints.join(', ') || '—'}.`, '');

  out.push('## Accuracy', '');
  out.push(`| Case | ${THREE_WAY_CONDITIONS.map((x) => LABELS[x]).join(' | ')} |`, `| --- | ${THREE_WAY_CONDITIONS.map(() => '---:').join(' | ')} |`);
  for (const row of c.accuracy) out.push(`| ${row.caseId} | ${THREE_WAY_CONDITIONS.map((x) => `${row.counts[x]!.successes}/${row.counts[x]!.valid}`).join(' | ')} |`);
  out.push(`| **Total** | ${THREE_WAY_CONDITIONS.map((x) => `**${c.accuracyTotals[x]!.successes}/${c.accuracyTotals[x]!.valid}**`).join(' | ')} |`, '');
  out.push(
    `Drift accuracy not below raw overall: **${c.gate.driftAccuracyNotBelowRaw ? 'yes' : 'NO'}**; in every case: **${c.gate.driftAccuracyNotBelowRawInAnyCase ? 'yes' : 'NO'}**.`,
    '',
  );
  out.push('### Every failure', '');
  if (c.failures.length === 0) out.push('No valid trial failed.');
  for (const f of c.failures) {
    out.push(`- \`${f.trialId}\` (${f.condition}, rep ${f.repetition}): ${f.reasons.join(', ') || 'no reason recorded'}${f.termination ? `; controller ended ${f.termination}` : ''}`);
    for (const d of f.details) out.push(`  - ${d}`);
  }
  out.push('');

  out.push('## Tokens and activity by case (medians over valid trials)', '');
  const rows: [string, NumericKey, (v: number | null | undefined) => string][] = [
    ['Gross input', 'gross', int],
    ['Uncached input', 'uncached', int],
    ['Output', 'output', int],
    ['Model calls', 'modelCalls', int],
    ['Agent sessions', 'agentSessions', int],
    ['Agent tool calls', 'toolCalls', int],
    ['Agent broad checks', 'agentBroadChecks', int],
    ['Agent narrow checks', 'agentNarrowChecks', int],
    ['Dependency research', 'dependencyResearch', int],
    ['Gross before first edit', 'grossBeforeFirstEdit', int],
    ['Gross after first edit', 'grossAfterFirstEdit', int],
    ['Gross in repair sessions', 'grossInRepairSessions', int],
    ['Repair sessions', 'repairSessions', int],
    ['Files exposed per session', 'medianFilesExposedPerSession', int],
    ['Files modified', 'filesModified', int],
    ['Unique files read', 'uniqueFilesRead', int],
    ['Controller checks run', 'controllerChecks', int],
    ['Agent wall', 'agentWallMs', sec],
    ['Controller wall', 'controllerWallMs', sec],
    ['End-to-end wall', 'endToEndMs', sec],
    ['Drift analysis', 'analysisMs', sec],
    ['Cost', 'costUsd', usd],
    ['Units (plan)', 'unitsTotal', int],
    ['Units resolved deterministically', 'unitsDeterministic', int],
    ['Units sent to agent', 'unitsSentToAgent', int],
    ['Units skipped (protected)', 'unitsSkippedProtected', int],
    ['Units requiring repair', 'unitsRequiringRepair', int],
    ['Out-of-scope rejections', 'outOfScopeRejections', int],
  ];
  for (const caseId of c.caseIds) {
    out.push(`### ${caseId}`, '');
    out.push(`| | ${THREE_WAY_CONDITIONS.map((x) => LABELS[x]).join(' | ')} |`, `| --- | ${THREE_WAY_CONDITIONS.map(() => '---:').join(' | ')} |`);
    out.push(`| Success | ${THREE_WAY_CONDITIONS.map((x) => `${c.cells[caseId]![x]!.successes}/${c.cells[caseId]![x]!.valid}${c.cells[caseId]![x]!.excluded ? ` (+${c.cells[caseId]![x]!.excluded} excl.)` : ''}`).join(' | ')} |`);
    for (const [label, key, fmt] of rows) out.push(`| ${label} | ${THREE_WAY_CONDITIONS.map((x) => fmt(c.cells[caseId]![x]!.medians[key])).join(' | ')} |`);
    out.push('');
  }

  out.push('## Case-level median changes', '');
  out.push('| Comparison | Paired cases | Gross input | 95% CI | Uncached input | Gross after first edit | Model calls | Per case (gross) | Successes (reference → treatment) |');
  out.push('| --- | ---: | ---: | --- | ---: | ---: | ---: | --- | --- |');
  for (const p of c.pairwise) {
    const ci = p.ci95MedianGrossChangePct ? `[${p.ci95MedianGrossChangePct.low.toFixed(1)}, ${p.ci95MedianGrossChangePct.high.toFixed(1)}]` : '—';
    out.push(
      `| ${p.label} | ${p.pairedCases} | ${pct(p.medianCaseGrossChangePct)} | ${ci} | ${pct(p.medianCaseUncachedChangePct)} | ${pct(p.medianCaseAfterFirstEditChangePct)} | ${pct(p.medianCaseModelCallsChangePct)} | ${p.caseGrossChangesPct.map((x) => `${x.caseId.split('-').slice(-2).join('-')} ${pct(x.changePct)}`).join('; ')} | ${p.successes.reference} → ${p.successes.treatment} |`,
    );
  }
  out.push('');
  out.push(
    `≥30% median gross reduction vs raw: **${c.gate.meetsThirtyPercentTarget ? 'met' : 'not met'}** (${c.gate.driftMedianGrossReductionVsRawPct === null ? '—' : `${c.gate.driftMedianGrossReductionVsRawPct.toFixed(1)}% reduction`}).`,
    '',
  );

  out.push('## Schedule and exclusions', '');
  for (const [label, counts] of Object.entries(c.positions)) out.push(`- ${label}: positions ${counts.join(' / ')}`);
  out.push('');
  out.push(c.exclusions.length === 0 ? 'Every slot holds a valid trial.' : c.exclusions.map((e) => `- ${e.trialId}: ${e.reason} — ${e.detail}`).join('\n'));
  if (c.setAsideAttempts.length > 0) {
    out.push('', `Attempts set aside and rerun in the same slot (${c.setAsideAttempts.length}; never counted):`, '');
    for (const a of c.setAsideAttempts) out.push(`- ${a.runId}/${a.file}: ${a.reason}`);
  }
  return out.join('\n');
}
