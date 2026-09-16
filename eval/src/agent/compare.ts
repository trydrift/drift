import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { agentContextDiagnostics } from './agent-context.ts';
import { parseClaudeStream } from './providers/claude-code.ts';
import { join } from 'node:path';
import {
  bootstrap,
  caseLevelSummary,
  caseMetrics,
  conditionAggregate,
  contextReduction,
  groupByCase,
  median,
  percentagePointDifference,
  type ConditionAggregate,
  type Interval,
} from './aggregate.ts';
import { CONDITION_LABELS, DRIFT_CONDITIONS, type Condition, type RunManifest, type TrialArtifact } from './schema.ts';
import { readRunManifest, readTrials, reportsRoot, resultsRoot } from './store.ts';

/**
 * Every Drift condition against the baseline, from the same runs.
 *
 * `latest.json` stays what it was published as: baseline against the full
 * report. This is the development comparison the agent-interface work needs —
 * the full report, the agent brief and MCP side by side on the same cases,
 * with where each one's tokens went.
 *
 * Nothing is pooled across runs recorded under different session settings or
 * Drift commits. Reference runs (the first result, #320) are summarised with
 * the same code in a separate section and labelled as history.
 *
 * Statistics are the canonical summary's: per case, medians over valid
 * trials; the headline token figure is the median of case-level changes
 * (`driftMedian / baselineMedian - 1`), never a ratio of totals; success is
 * pooled over valid trials with a percentage-point difference; intervals are
 * the same seeded two-level bootstrap. With three cases they are wide, and the
 * report says so.
 */

export interface ConditionRow {
  condition: Condition;
  label: string;
  aggregate: ConditionAggregate;
  medianCostUsd: number | null;
  medianModelCalls: number | null;
  medianUniqueFilesRead: number | null;
  medianInitialDriftContextTokens: number | null;
  medianDriftToolCalls: number | null;
  medianDriftToolReturnedTokens: number | null;
  medianFindingsRetrievedOnDemand: number | null;
  medianFindingsInInitialBrief: number | null;
  driftToolCallsByName: Record<string, number>;
  medianTokensBeforeFirstEdit: number | null;
  medianTokensAfterFirstEdit: number | null;
  trialsWithoutEdit: number;
  medianDependencySourceAccesses: number | null;
  medianRegistryQueries: number | null;
  medianChangelogAccesses: number | null;
  medianDriftAnalysisMs: number | null;
  /** Wall-clock decomposition medians; see `agentContext.timing`. */
  medianEndToEndMs: number | null;
  medianSessionMs: number | null;
  medianPreSessionDriftMs: number | null;
  medianDriftToolMs: number | null;
  /** Median of case-level changes in end-to-end wall time against the baseline. */
  medianCaseEndToEndChangePct?: number | null;
  /** Against the baseline in the same runs. `null` for the baseline itself. */
  vsBaseline: {
    pairedCases: number;
    medianCaseGrossChangePct: number | null;
    medianCaseUncachedChangePct: number | null;
    caseGrossChangesPct: { caseId: string; changePct: number | null }[];
    successDifferencePp: number | null;
    caseLevel: ReturnType<typeof caseLevelSummary>;
    ci95: { medianGrossReduction: Interval | null; successDifferencePp: Interval | null };
  } | null;
}

export interface CaseCell {
  valid: number;
  successes: number;
  medianGrossInputTokens: number | null;
  medianUncachedInputTokens: number | null;
  medianCostUsd: number | null;
  medianWallClockMs: number | null;
  medianEndToEndMs: number | null;
  medianToolCalls: number | null;
  medianUniqueFilesRead: number | null;
  medianInitialDriftContextTokens: number | null;
  medianDriftToolReturnedTokens: number | null;
  grossChangeVsBaselinePct: number | null;
  uncachedChangeVsBaselinePct: number | null;
  failureReasons: Record<string, number>;
  excluded: number;
}

export interface ComparisonSection {
  runIds: string[];
  manifests: Pick<RunManifest, 'runId' | 'driftCommit' | 'requestedModel' | 'requestedEffort' | 'agentCliVersion' | 'runsPerCondition' | 'conditions'>[];
  cleanEnvironments: string[];
  conditions: ConditionRow[];
  cases: { caseId: string; cells: Record<string, CaseCell> }[];
  exclusions: { trialId: string; condition: string; reason: string; detail: string }[];
  /**
   * Attempts moved aside before their slot was run again (`*.attempt-N.json`):
   * provider limits, other infrastructure failures, and sessions excluded for
   * a mismatched environment. Never counted in any rate; listed so nothing is
   * hidden. Filled by `buildComparisonSection`, empty when built from trials alone.
   */
  setAsideAttempts: { runId: string; file: string; condition: string; reason: string; recordedOutcome: string }[];
  /** How many times each condition ran in each schedule position (1-based index). */
  positions: Record<string, number[]>;
}

export interface Comparison {
  name: string;
  generatedAt: string;
  current: ComparisonSection;
  /** Earlier runs shown for context, each labelled, never pooled into `current`. */
  history: { label: string; section: ComparisonSection }[];
  notes: string[];
}

const changePct = (baseline: number | null, treatment: number | null): number | null => {
  const reduction = contextReduction(baseline, treatment);
  return reduction === null ? null : -reduction * 100;
};
const med = (values: (number | null | undefined)[]): number | null => median(values.filter((v): v is number => typeof v === 'number'));

export class IncompatibleRunsError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`These runs cannot be pooled into one comparison:\n  - ${problems.join('\n  - ')}`);
    this.name = 'IncompatibleRunsError';
    this.problems = problems;
  }
}

/**
 * Why a set of runs cannot be pooled as one experiment. Empty means they can.
 *
 * Runs may cover different cases — one case per process is how a parallel
 * experiment is run — but everything that defines the experiment must agree:
 * the agent and its settings, the Drift build, the session isolation and what
 * the sessions actually loaded, and, for every case, its content, starting
 * tree and task. A slot recorded twice would be counted twice, so that is
 * refused too, as is a run marked aborted.
 */
export function compatibilityProblems(
  runs: readonly { manifest: RunManifest; trials: readonly TrialArtifact[]; aborted: boolean }[],
): string[] {
  const problems: string[] = [];
  const differ = (label: string, values: (string | number | boolean | null | undefined)[]) => {
    const distinct = [...new Set(values.map((v) => JSON.stringify(v ?? null)))];
    if (distinct.length > 1) problems.push(`${label} differs: ${distinct.join(' vs ')}`);
  };
  for (const run of runs) if (run.aborted) problems.push(`run ${run.manifest.runId} is marked aborted (ABORTED.md) and is exploratory only`);

  const manifests = runs.map((run) => run.manifest);
  const trials = runs.flatMap((run) => run.trials);
  differ('suite', manifests.map((m) => m.suite));
  differ('provider', manifests.map((m) => m.provider));
  differ('requested model', manifests.map((m) => m.requestedModel));
  differ('requested effort', manifests.map((m) => m.requestedEffort));
  differ('agent CLI version', manifests.map((m) => m.agentCliVersion));
  differ('Drift commit', manifests.map((m) => m.driftCommit));
  for (const m of manifests) if (m.driftTreeDirty) problems.push(`run ${m.runId} was built from a Drift tree with uncommitted changes`);
  differ('schedule design', manifests.map((m) => m.scheduleDesign));
  differ('web tools', manifests.map((m) => m.webTools));
  differ('budget (USD)', manifests.map((m) => m.maxBudgetUsd));
  differ('turn cap', manifests.map((m) => m.maxTurns));
  differ('Drift --verify', manifests.map((m) => m.driftVerify));
  differ('runs per condition', manifests.map((m) => m.runsPerCondition));
  differ('conditions', manifests.map((m) => [...m.conditions].sort().join(',')));
  differ('trial schema', trials.map((t) => t.schemaVersion));
  const environments: (string | undefined)[] = [
    ...trials.map((t) => t.metadata.agentConfiguration.cleanEnvironment),
    ...manifests.map((m) => m.cleanEnvironment ?? trials.find((t) => t.runId === m.runId)?.metadata.agentConfiguration.cleanEnvironment),
  ];
  differ('clean environment', environments);
  differ('network policy', trials.map((t) => t.metadata.networkPolicy));

  const sessions = trials.filter((t) => t.validity.valid || t.validity.infrastructureFailure === 'environment_mismatch');
  const unrecorded = sessions.filter((t) => !t.metadata.agentConfiguration.environment);
  if (unrecorded.length > 0) problems.push(`${unrecorded.length} trial(s) did not record the session environment (e.g. ${unrecorded[0]!.trialId})`);
  differ('session environment (excluding Drift MCP)', sessions.map((t) => t.metadata.agentConfiguration.environment?.fingerprint));

  const byCase = new Map<string, TrialArtifact[]>();
  for (const trial of trials) byCase.set(trial.caseId, [...(byCase.get(trial.caseId) ?? []), trial]);
  for (const [caseId, caseTrials] of byCase) {
    differ(`case ${caseId} content hash`, caseTrials.map((t) => t.caseHash));
    differ(`case ${caseId} start tree`, caseTrials.map((t) => t.metadata.startTreeHash));
    differ(`case ${caseId} task`, caseTrials.map((t) => t.metadata.taskHash));
    differ(`case ${caseId} timeout`, caseTrials.map((t) => t.metadata.timeoutSeconds));
    const seen = new Map<string, string>();
    for (const t of caseTrials) {
      const slot = `${t.condition}#${t.repetition}`;
      if (seen.has(slot)) problems.push(`case ${caseId} ${slot} is recorded by both ${seen.get(slot)} and ${t.runId}`);
      else seen.set(slot, t.runId);
    }
  }
  return problems;
}

export async function buildComparisonSection(
  runIds: readonly string[],
  root: string,
  options: { pooled?: boolean } = {},
): Promise<ComparisonSection & { derivedDiagnostics: number }> {
  if (options.pooled ?? true) {
    const runs = [];
    for (const runId of runIds) {
      const aborted = await readFile(join(resultsRoot(root), 'raw', runId, 'ABORTED.md'), 'utf8').then(() => true, () => false);
      runs.push({ manifest: await readRunManifest(runId, root), trials: await readTrials(runId, root), aborted });
    }
    const problems = compatibilityProblems(runs);
    if (problems.length > 0) throw new IncompatibleRunsError(problems);
  }
  const manifests: RunManifest[] = [];
  const trials: TrialArtifact[] = [];
  let derivedDiagnostics = 0;
  for (const runId of runIds) {
    manifests.push(await readRunManifest(runId, root));
    for (const trial of await readTrials(runId, root)) {
      // Artifacts recorded before `agentContext` existed are not rewritten.
      // Their diagnostics are derived here, from the session stream kept
      // beside them and the preamble the artifact itself recorded.
      if (!trial.agentContext) {
        const derived = await deriveAgentContext(trial, root);
        if (derived) {
          derivedDiagnostics += 1;
          trials.push({ ...trial, agentContext: derived });
          continue;
        }
      }
      trials.push(trial);
    }
  }
  const models = new Set(manifests.map((m) => m.requestedModel));
  if (models.size > 1) throw new Error(`Runs span several requested models (${[...models].join(', ')}); never compare across models.`);
  const section = comparisonFromTrials(trials, manifests);
  for (const runId of runIds) {
    const dir = join(resultsRoot(root), 'raw', runId, 'trials');
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => /\.attempt-\d+\.json$/.test(f)).sort();
    for (const file of files) {
      const attempt = JSON.parse(await readFile(join(dir, file), 'utf8')) as TrialArtifact;
      const env = attempt.metadata.agentConfiguration.environment?.fingerprint;
      const reason = attempt.validity.valid
        ? `environment fingerprint ${env ?? 'unrecorded'} differed from the experiment's (see ENVIRONMENT-EXCLUSIONS.md)`
        : `${attempt.validity.infrastructureFailure ?? 'invalid'}: ${(attempt.validity.detail ?? '').split('\n')[0]!.slice(0, 120)}`;
      section.setAsideAttempts.push({
        runId,
        file,
        condition: CONDITION_LABELS[attempt.condition],
        reason,
        recordedOutcome: attempt.validity.valid ? (attempt.validation.success ? 'success' : `failure (${attempt.validation.failureReasons.join(', ')})`) : 'not scored',
      });
    }
  }
  return { ...section, derivedDiagnostics };
}

async function deriveAgentContext(trial: TrialArtifact, root: string): Promise<TrialArtifact['agentContext'] | null> {
  const base = `${trial.caseId}__${trial.condition}__rep-${String(trial.repetition).padStart(2, '0')}`;
  let lines: string[];
  try {
    lines = gunzipSync(await readFile(join(resultsRoot(root), 'raw', trial.runId, 'trials', `${base}.stream.jsonl.gz`))).toString('utf8').split('\n');
  } catch {
    return null;
  }
  return agentContextDiagnostics({
    condition: trial.condition,
    parsed: parseClaudeStream(lines),
    preamble: trial.context.preamble,
    brief: null,
    findingsInPlan: trial.context.driftPlan?.breakingChanges ?? null,
    dependency: trial.metadata.dependency.name,
  });
}

export function comparisonFromTrials(trials: readonly TrialArtifact[], manifests: readonly RunManifest[]): ComparisonSection {
  const present = new Set(trials.map((t) => t.condition));
  const conditions: Condition[] = (['baseline', ...DRIFT_CONDITIONS] as Condition[]).filter((c) => present.has(c));

  const rows: ConditionRow[] = conditions.map((condition) => {
    const valid = trials.filter((t) => t.condition === condition && t.validity.valid);
    const ctx = valid.map((t) => t.agentContext).filter((c): c is NonNullable<typeof c> => Boolean(c));
    const byName: Record<string, number> = {};
    for (const c of ctx) for (const [name, count] of Object.entries(c.driftToolCallsByName)) byName[name] = (byName[name] ?? 0) + count;

    let vsBaseline: ConditionRow['vsBaseline'] = null;
    if (condition !== 'baseline' && present.has('baseline')) {
      const groups = groupByCase(trials, condition);
      const cases = groups.map(caseMetrics);
      const paired = cases.filter((c) => c.inputTokenReduction !== null);
      const boot = bootstrap(groups);
      const baselineAgg = conditionAggregate('baseline', trials);
      const treatmentAgg = conditionAggregate(condition, trials);
      vsBaseline = {
        pairedCases: paired.length,
        medianCaseGrossChangePct: med(paired.map((c) => changePct(c.medianBaselineInputTokens, c.medianDriftInputTokens))),
        medianCaseUncachedChangePct: med(paired.map((c) => changePct(c.medianBaselineUncachedInputTokens, c.medianDriftUncachedInputTokens))),
        caseGrossChangesPct: cases.map((c) => ({ caseId: c.caseId, changePct: changePct(c.medianBaselineInputTokens, c.medianDriftInputTokens) })),
        successDifferencePp: percentagePointDifference(baselineAgg.successRate, treatmentAgg.successRate),
        caseLevel: caseLevelSummary(cases),
        ci95: {
          // The bootstrap reports reductions; flip to the change so the sign reads the same as the point estimate.
          medianGrossReduction: boot.medianReduction,
          successDifferencePp: boot.successDifferencePp,
        },
      };
    }

    return {
      condition,
      label: CONDITION_LABELS[condition],
      aggregate: conditionAggregate(condition, trials),
      medianCostUsd: med(valid.map((t) => t.usage.costUsd)),
      medianModelCalls: med(valid.map((t) => t.usage.modelCalls)),
      medianUniqueFilesRead: med(valid.map((t) => t.tools.uniqueFilesRead)),
      medianInitialDriftContextTokens: med(ctx.map((c) => c.initialDriftContextEstimatedTokens)),
      medianDriftToolCalls: med(ctx.map((c) => c.driftToolCalls)),
      medianDriftToolReturnedTokens: med(ctx.map((c) => c.driftToolReturnedEstimatedTokens)),
      medianFindingsRetrievedOnDemand: med(ctx.map((c) => c.findingsRetrievedOnDemand)),
      medianFindingsInInitialBrief: med(ctx.map((c) => c.findingsInInitialBrief)),
      driftToolCallsByName: byName,
      medianTokensBeforeFirstEdit: med(ctx.map((c) => c.tokensBeforeFirstEdit?.grossInputTokens)),
      medianTokensAfterFirstEdit: med(ctx.map((c) => c.tokensAfterFirstEdit?.grossInputTokens)),
      trialsWithoutEdit: ctx.filter((c) => c.tokensBeforeFirstEdit === null).length,
      medianDependencySourceAccesses: med(ctx.map((c) => c.research.dependencySourceAccesses)),
      medianRegistryQueries: med(ctx.map((c) => c.research.registryQueries)),
      medianChangelogAccesses: med(ctx.map((c) => c.research.changelogAccesses)),
      medianDriftAnalysisMs: med(valid.map((t) => (t.context.driftStatus === 'not-applicable' ? null : t.context.driftAnalysisMs))),
      medianEndToEndMs: med(ctx.map((c) => c.timing?.endToEndMs)),
      medianSessionMs: med(ctx.map((c) => c.timing?.sessionMs)),
      medianPreSessionDriftMs: med(ctx.map((c) => c.timing?.preSessionDriftMs)),
      medianDriftToolMs: med(ctx.map((c) => c.timing?.driftToolMs)),
      medianCaseEndToEndChangePct:
        condition === 'baseline'
          ? null
          : med(
              [...new Set(valid.map((t) => t.caseId))].map((caseId) => {
                const endToEnd = (cond: Condition) =>
                  med(trials.filter((t) => t.caseId === caseId && t.condition === cond && t.validity.valid).map((t) => t.agentContext?.timing?.endToEndMs));
                return changePct(endToEnd('baseline'), endToEnd(condition));
              }),
            ),
      vsBaseline,
    };
  });

  const caseIds = [...new Set(trials.map((t) => t.caseId))].sort();
  const cases = caseIds.map((caseId) => {
    const cells: Record<string, CaseCell> = {};
    const baselineValid = trials.filter((t) => t.caseId === caseId && t.condition === 'baseline' && t.validity.valid);
    const baselineGross = med(baselineValid.map((t) => t.usage.grossInputTokens));
    const baselineUncached = med(baselineValid.map((t) => t.usage.uncachedInputTokens));
    for (const condition of conditions) {
      const all = trials.filter((t) => t.caseId === caseId && t.condition === condition);
      const valid = all.filter((t) => t.validity.valid);
      const gross = med(valid.map((t) => t.usage.grossInputTokens));
      const uncached = med(valid.map((t) => t.usage.uncachedInputTokens));
      const reasons: Record<string, number> = {};
      for (const t of valid) for (const r of t.validation.failureReasons) reasons[r] = (reasons[r] ?? 0) + 1;
      cells[CONDITION_LABELS[condition]] = {
        valid: valid.length,
        successes: valid.filter((t) => t.validation.success).length,
        medianGrossInputTokens: gross,
        medianUncachedInputTokens: uncached,
        medianCostUsd: med(valid.map((t) => t.usage.costUsd)),
        medianWallClockMs: med(valid.map((t) => t.agent.durationMs)),
        medianEndToEndMs: med(valid.map((t) => t.agentContext?.timing?.endToEndMs)),
        medianToolCalls: med(valid.map((t) => t.tools.toolCalls)),
        medianUniqueFilesRead: med(valid.map((t) => t.tools.uniqueFilesRead)),
        medianInitialDriftContextTokens: med(valid.map((t) => t.agentContext?.initialDriftContextEstimatedTokens)),
        medianDriftToolReturnedTokens: med(valid.map((t) => t.agentContext?.driftToolReturnedEstimatedTokens)),
        grossChangeVsBaselinePct: condition === 'baseline' ? null : changePct(baselineGross, gross),
        uncachedChangeVsBaselinePct: condition === 'baseline' ? null : changePct(baselineUncached, uncached),
        failureReasons: reasons,
        excluded: all.length - valid.length,
      };
    }
    return { caseId, cells };
  });

  return {
    runIds: manifests.map((m) => m.runId),
    manifests: manifests.map((m) => ({
      runId: m.runId,
      driftCommit: m.driftCommit,
      requestedModel: m.requestedModel,
      requestedEffort: m.requestedEffort,
      agentCliVersion: m.agentCliVersion,
      runsPerCondition: m.runsPerCondition,
      conditions: m.conditions,
    })),
    cleanEnvironments: [...new Set(trials.map((t) => t.metadata.agentConfiguration.cleanEnvironment))].sort(),
    conditions: rows,
    cases,
    setAsideAttempts: [],
    exclusions: trials
      .filter((t) => !t.validity.valid)
      .map((t) => ({ trialId: t.trialId, condition: CONDITION_LABELS[t.condition], reason: t.validity.infrastructureFailure ?? 'unknown', detail: (t.validity.detail ?? '').split('\n')[0]!.slice(0, 200) })),
    positions: Object.fromEntries(
      conditions.map((condition) => {
        const counts = conditions.map(() => 0);
        for (const t of trials.filter((x) => x.condition === condition && x.schedule)) counts[t.schedule!.position - 1] = (counts[t.schedule!.position - 1] ?? 0) + 1;
        return [CONDITION_LABELS[condition], counts];
      }),
    ),
  };
}

export async function buildComparison(args: {
  name: string;
  runIds: string[];
  history?: { label: string; runIds: string[] }[];
  root: string;
  now?: Date;
}): Promise<Comparison> {
  const { derivedDiagnostics: derivedCurrent, ...current } = await buildComparisonSection(args.runIds, args.root);
  let derived = derivedCurrent;
  const history: Comparison['history'] = [];
  for (const entry of args.history ?? []) {
    if (entry.runIds.length === 0) continue;
    // History is shown, never pooled, so its runs are not held to one configuration.
    const { derivedDiagnostics, ...section } = await buildComparisonSection(entry.runIds, args.root, { pooled: false });
    derived += derivedDiagnostics;
    history.push({ label: entry.label, section });
  }
  const notes = [
    'Development cases only. These cases were used to select the agent interface and are not held-out evidence.',
    'Diagnostic, not publishable: the canonical publication gates (10+ cases, frozen suite, 30+ valid trials per condition) are not met.',
    'Every Drift condition is compared with the baseline trials of the same experiment. The runs in the current section passed the compatibility check (same agent, settings, Drift build, isolation, loaded environment, case content, start trees and tasks).',
    'Token changes are case-level medians: (condition median / baseline median - 1) per case, then the median across cases. Negative is fewer tokens.',
    'Drift context and tool sizes are estimated at 3 bytes per token (the production brief estimator), not provider counts. Every other token figure is provider-reported.',
    'Tokens before/after the first edit come from the per-message usage ledger of the main model and exclude the CLI auxiliary model.',
    'End-to-end wall = Drift analysis before the session + the agent session. For drift-mcp, Drift runs inside the session and is already in the session time; Drift tool time is shown as a part of it, not added.',
  ];
  if (derived > 0) {
    notes.push(
      `${derived} trial(s) predate the agentContext diagnostics; theirs were derived from the session stream stored beside the artifact (gitignored, kept locally) and the preamble the artifact recorded. The artifacts were not modified.`,
    );
  }
  for (const entry of history) {
    notes.push(`History section "${entry.label}" (${entry.section.runIds.join(', ')}) is shown for context only and never pooled into the current estimates.`);
  }
  return { name: args.name, generatedAt: (args.now ?? new Date()).toISOString(), current, history, notes };
}

export async function writeComparison(comparison: Comparison, root: string): Promise<{ json: string; markdown: string }> {
  const jsonDir = join(resultsRoot(root), 'comparisons');
  await mkdir(jsonDir, { recursive: true });
  await mkdir(reportsRoot(root), { recursive: true });
  const json = join(jsonDir, `${comparison.name}.json`);
  const markdown = join(reportsRoot(root), `${comparison.name}.md`);
  await writeFile(json, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
  await writeFile(markdown, `${renderComparison(comparison)}\n`, 'utf8');
  return { json, markdown };
}

const fmtInt = (value: number | null): string => (value === null ? '—' : Math.round(value).toLocaleString('en-US'));
const fmtPct = (value: number | null): string => (value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(1)}%`);
const fmtPp = (value: number | null): string => (value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(1)} pp`);
const fmtUsd = (value: number | null): string => (value === null ? '—' : `$${value.toFixed(2)}`);
const fmtSec = (ms: number | null): string => (ms === null ? '—' : `${Math.round(ms / 1000)}s`);
const fmtCi = (interval: Interval | null, flip = false): string => {
  if (!interval) return '—';
  const [low, high] = flip ? [-interval.high * 100, -interval.low * 100] : [interval.low, interval.high];
  return `[${low.toFixed(1)}, ${high.toFixed(1)}]`;
};

export function renderComparison(comparison: Comparison): string {
  const out: string[] = [`# Agent interface comparison: ${comparison.name}`, '', `Generated ${comparison.generatedAt}.`, ''];
  for (const note of comparison.notes) out.push(`- ${note}`);
  out.push('');
  out.push(...renderSection('Current runs', comparison.current));
  for (const entry of comparison.history) {
    out.push('', '---', '');
    out.push(...renderSection(`History, not pooled: ${entry.label}`, entry.section));
  }
  return out.join('\n');
}

function renderSection(title: string, section: ComparisonSection): string[] {
  const out: string[] = [`## ${title}`, ''];
  for (const m of section.manifests) {
    out.push(`- Run \`${m.runId}\`: ${m.requestedModel} at effort ${m.requestedEffort}, ${m.agentCliVersion}, Drift ${m.driftCommit.slice(0, 12)}, ${m.runsPerCondition} run(s) per condition (${m.conditions.map((c) => CONDITION_LABELS[c]).join(', ')}).`);
  }
  out.push(`- Session isolation: ${section.cleanEnvironments.join(', ')}.`, '');

  if (Object.values(section.positions).some((counts) => counts.some((n) => n > 0))) {
    out.push('### Schedule positions (trials per position, 1 = first in its block)', '');
    for (const [label, counts] of Object.entries(section.positions)) out.push(`- ${label}: ${counts.join(' / ')}`);
    out.push('');
  }
  out.push('### By condition', '');
  out.push('| Condition | Successes / valid | Median gross input | Median uncached input | Median model calls | Median cost | Median end-to-end wall | Median session wall | Median tool calls | Median unique files read | Median Drift context (est.) | Median Drift tool returns (est.) |');
  out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of section.conditions) {
    const a = row.aggregate;
    out.push(
      `| ${row.label} | ${a.successfulTrials}/${a.validTrials}${a.invalidTrials ? ` (${a.invalidTrials} excluded)` : ''} | ${fmtInt(a.medianInputTokens)} | ${fmtInt(a.medianUncachedInputTokens)} | ${fmtInt(row.medianModelCalls)} | ${fmtUsd(row.medianCostUsd)} | ${fmtSec(row.medianEndToEndMs)} | ${fmtSec(row.medianSessionMs ?? a.medianWallClockMs)} | ${fmtInt(a.medianToolCalls)} | ${fmtInt(row.medianUniqueFilesRead)} | ${fmtInt(row.medianInitialDriftContextTokens)} | ${fmtInt(row.medianDriftToolReturnedTokens)} |`,
    );
  }
  out.push('');
  out.push('### Wall-clock decomposition', '');
  out.push('End-to-end = Drift analysis before the session + session. Drift tool time is inside the session (MCP), not added to it.', '');
  out.push('| Condition | Median end-to-end | Median Drift before session | Median session | Median Drift tool time (in session) | Median case change in end-to-end vs baseline |');
  out.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const row of section.conditions) {
    out.push(`| ${row.label} | ${fmtSec(row.medianEndToEndMs)} | ${fmtSec(row.medianPreSessionDriftMs)} | ${fmtSec(row.medianSessionMs)} | ${fmtSec(row.medianDriftToolMs)} | ${fmtPct(row.medianCaseEndToEndChangePct ?? null)} |`);
  }
  out.push('');

  out.push('### Against the baseline (case-level medians)', '');
  out.push('| Condition | Paired cases | Median case change, gross | 95% CI | Median case change, uncached | Success difference | 95% CI | Cases better / tied / worse on success |');
  out.push('| --- | ---: | ---: | --- | ---: | ---: | --- | --- |');
  for (const row of section.conditions) {
    const v = row.vsBaseline;
    if (!v) continue;
    out.push(
      `| ${row.label} | ${v.pairedCases} | ${fmtPct(v.medianCaseGrossChangePct)} | ${fmtCi(v.ci95.medianGrossReduction, true)} | ${fmtPct(v.medianCaseUncachedChangePct)} | ${fmtPp(v.successDifferencePp)} | ${fmtCi(v.ci95.successDifferencePp)} | ${v.caseLevel.improved} / ${v.caseLevel.tied} / ${v.caseLevel.baselineBetter} |`,
    );
  }
  out.push('');

  const labels = section.conditions.map((r) => r.label);
  out.push('### By case', '');
  out.push('| Case | Condition | Successes / valid | Median gross input | Change vs baseline | Median uncached | Change vs baseline | Median cost | Median end-to-end wall | Tool calls | Unique files read | Drift context (est.) | Drift tool returns (est.) | Failure reasons |');
  out.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const { caseId, cells } of section.cases) {
    for (const label of labels) {
      const c = cells[label];
      if (!c) continue;
      const reasons = Object.entries(c.failureReasons).map(([r, n]) => `${r} ×${n}`).join(', ') || '—';
      out.push(
        `| ${caseId} | ${label} | ${c.successes}/${c.valid}${c.excluded ? ` (+${c.excluded} excl.)` : ''} | ${fmtInt(c.medianGrossInputTokens)} | ${fmtPct(c.grossChangeVsBaselinePct)} | ${fmtInt(c.medianUncachedInputTokens)} | ${fmtPct(c.uncachedChangeVsBaselinePct)} | ${fmtUsd(c.medianCostUsd)} | ${fmtSec(c.medianEndToEndMs ?? c.medianWallClockMs)} | ${fmtInt(c.medianToolCalls)} | ${fmtInt(c.medianUniqueFilesRead)} | ${fmtInt(c.medianInitialDriftContextTokens)} | ${fmtInt(c.medianDriftToolReturnedTokens)} | ${reasons} |`,
      );
    }
  }
  out.push('');

  out.push('### Where the tokens went', '');
  out.push('| Condition | Median model calls | Median gross before first edit | Median gross after first edit | Trials with no edit | Median output tokens | Drift analysis before session |');
  out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of section.conditions) {
    out.push(
      `| ${row.label} | ${fmtInt(row.medianModelCalls)} | ${fmtInt(row.medianTokensBeforeFirstEdit)} | ${fmtInt(row.medianTokensAfterFirstEdit)} | ${row.trialsWithoutEdit} | ${fmtInt(row.aggregate.medianOutputTokens)} | ${fmtSec(row.medianDriftAnalysisMs)} |`,
    );
  }
  out.push('');

  out.push('### Drift tools and independent research', '');
  out.push('| Condition | Median findings supplied up front | Median Drift tool calls | Calls by tool (all trials) | Median findings pulled on demand | Median dependency-source accesses | Median registry queries | Median changelog accesses |');
  out.push('| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |');
  for (const row of section.conditions) {
    const calls = Object.entries(row.driftToolCallsByName).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ×${c}`).join(', ') || '—';
    out.push(
      `| ${row.label} | ${fmtInt(row.medianFindingsInInitialBrief)} | ${fmtInt(row.medianDriftToolCalls)} | ${calls} | ${fmtInt(row.medianFindingsRetrievedOnDemand)} | ${fmtInt(row.medianDependencySourceAccesses)} | ${fmtInt(row.medianRegistryQueries)} | ${fmtInt(row.medianChangelogAccesses)} |`,
    );
  }
  out.push('');
  out.push('### Exclusions', '');
  const excluded = section.exclusions;
  out.push(excluded.length === 0 ? 'Every slot in this section holds a valid trial.' : excluded.map((e) => `- ${e.trialId}: ${e.reason} — ${e.detail}`).join('\n'));
  if (section.setAsideAttempts.length > 0) {
    out.push('', `Attempts set aside before their slot was run again (${section.setAsideAttempts.length}; never counted):`, '');
    const grouped = new Map<string, number>();
    for (const a of section.setAsideAttempts) {
      const key = a.reason.startsWith('environment') ? 'environment mismatch' : a.reason.replace(/ · resets.*$/, '').slice(0, 80);
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    for (const [reason, count] of grouped) out.push(`- ${count} × ${reason}`);
    for (const a of section.setAsideAttempts.filter((x) => x.reason.startsWith('environment'))) {
      out.push(`- ${a.runId}/${a.file} (${a.condition}): ${a.reason}; it had recorded ${a.recordedOutcome}.`);
    }
  }
  return out;
}

