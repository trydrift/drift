import type { AgentBenchmarkSummary } from './summary.ts';

/**
 * Renderings of the canonical summary: the markdown report, the README block,
 * and the public copy. Every number in each of them is read from the summary;
 * none is typed here.
 */

const pct = (value: number | null, digits = 1): string => (value === null ? 'n/a' : `${value.toFixed(digits)}%`);
const pp = (value: number | null): string => (value === null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(1)} pp`);
const int = (value: number | null): string => (value === null ? 'n/a' : Math.round(value).toLocaleString('en-US'));
const ratePct = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const interval = (i: { low: number; high: number } | null, scale = 1, unit = '%'): string =>
  i === null ? 'n/a' : `${(i.low * scale).toFixed(1)}${unit} to ${(i.high * scale).toFixed(1)}${unit}`;
const ms = (value: number | null): string => (value === null ? 'n/a' : `${(value / 1000).toFixed(0)}s`);

export function renderReport(summary: AgentBenchmarkSummary): string {
  const e = summary.efficiency;
  const f = summary.effectiveness;
  const lines: string[] = [];

  lines.push('# Dependency Upgrade Agent Benchmark', '');
  lines.push('```');
  lines.push(`Suite:              ${summary.suite} (${summary.suiteStatus})`);
  lines.push(`Cases:              ${summary.caseCount}`);
  lines.push(`Runs per condition: ${summary.runsPerCondition}`);
  lines.push(`Model:              ${summary.requestedModel} (confirmed: ${Object.keys(summary.confirmedModels).join(', ') || 'none'})`);
  lines.push(`Effort:             ${summary.requestedEffort}`);
  lines.push(`Agent:              ${summary.provider} ${summary.agentCliVersion}`);
  lines.push(`Drift commit:       ${summary.driftCommit}${summary.driftTreeDirty ? ' (dirty tree)' : ''} (v${summary.driftVersion})`);
  lines.push(`Generated:          ${summary.generatedAt}`);
  lines.push('');
  lines.push('EFFECTIVENESS');
  lines.push('');
  lines.push('Successful dependency remediations');
  lines.push('');
  lines.push(`Without Drift     ${ratePct(f.baselineSuccessRate).padStart(6)}   (${f.successfulBaselineTrials}/${f.validBaselineTrials} valid trials)`);
  lines.push(`With Drift        ${ratePct(f.driftSuccessRate).padStart(6)}   (${f.successfulDriftTrials}/${f.validDriftTrials} valid trials)`);
  lines.push(`Difference        ${pp(f.differencePercentagePoints)}`);
  lines.push('');
  lines.push('EFFICIENCY');
  lines.push('');
  lines.push('Median agent input tokens (gross, all turns, cache reads included)');
  lines.push('');
  lines.push(`Without Drift     ${int(e.medianBaselineInputTokens)}`);
  lines.push(`With Drift        ${int(e.medianDriftInputTokens)}`);
  lines.push('');
  lines.push(`Median case-level reduction: ${pct(e.medianInputTokenReductionPct)}  (${e.pairedCaseCount} paired cases)`);
  lines.push('');
  lines.push('QUALITY CONTROLS');
  lines.push('');
  lines.push(`Same model                    ${Object.keys(summary.confirmedModels).filter((m) => m !== 'unavailable').length === 1 ? 'yes' : 'NO'}`);
  lines.push(`Same task                     ${summary.task.identicalAcrossConditions ? 'yes' : 'NO'}`);
  lines.push('Same starting commits         yes (start tree hash recorded per trial)');
  lines.push('Hidden compatibility tests    yes (staged after the agent exits)');
  lines.push('Known-good validation         yes (reference fix must pass every layer at admission)');
  lines.push('Dependency must remain new    yes (manifest, fresh install, installed version)');
  lines.push(`Publication gates             ${summary.publication.eligible ? 'PASS' : 'NOT MET'}`);
  lines.push('```', '');

  lines.push('## Confidence intervals (95%, bootstrap)', '');
  lines.push(`- Median input-token reduction: ${interval(e.confidenceInterval95.medianReduction, 100)}`);
  lines.push(`- Mean input-token reduction: ${interval(e.confidenceInterval95.meanReduction, 100)}`);
  lines.push(`- Success-rate difference: ${interval(f.confidenceInterval95.differencePercentagePoints, 1, ' pp')}`);
  lines.push(`- Baseline success rate: ${interval(f.confidenceInterval95.baselineSuccessRate, 100)}`);
  lines.push(`- Drift success rate: ${interval(f.confidenceInterval95.driftSuccessRate, 100)}`);
  lines.push(`- Method: ${summary.methodology.bootstrap}; seed ${e.confidenceInterval95.medianReduction?.seed ?? f.confidenceInterval95.differencePercentagePoints?.seed ?? 'n/a'}, ${e.confidenceInterval95.medianReduction?.iterations ?? f.confidenceInterval95.differencePercentagePoints?.iterations ?? 'n/a'} iterations.`);
  if (summary.caseCount < 20) lines.push(`- With ${summary.caseCount} case(s) these intervals are wide by construction; read them as such.`);
  lines.push('');

  lines.push('## Secondary metrics', '');
  lines.push('| Metric | Without Drift | With Drift |');
  lines.push('| --- | ---: | ---: |');
  lines.push(`| Median uncached input tokens | ${int(e.medianBaselineUncachedInputTokens)} | ${int(e.medianDriftUncachedInputTokens)} |`);
  lines.push(`| Median case-level uncached reduction | | ${pct(e.medianUncachedReductionPct)} |`);
  lines.push(`| Mean case-level gross reduction | | ${pct(e.meanInputTokenReductionPct)} |`);
  lines.push(`| Reduction IQR (case level) | | ${e.reductionIqrPct ? `${e.reductionIqrPct.q1.toFixed(1)}% to ${e.reductionIqrPct.q3.toFixed(1)}%` : 'n/a'} |`);
  lines.push(`| Median wall-clock change (agent session) | | ${pct(e.medianWallClockChangePct)} |`);
  lines.push(`| Median unique-files-read change | | ${pct(e.medianFilesReadChangePct)} |`);
  lines.push(`| Median tool-call change | | ${pct(e.medianToolCallChangePct)} |`);
  lines.push(`| Median Drift analysis time (not agent time) | | ${ms(e.medianDriftAnalysisMs)} |`);
  lines.push(`| Relative success difference | | ${summary.effectiveness.relativeDifference === null ? 'n/a' : pct(summary.effectiveness.relativeDifference * 100)} |`);
  lines.push(`| Input tokens per successful fix | ${int(summary.secondary.baselineInputTokensPerSuccessfulFix)} | ${int(summary.secondary.driftInputTokensPerSuccessfulFix)} |`);
  lines.push(`| Median input tokens among successes | ${int(summary.secondary.baselineMedianInputTokensAmongSuccesses)} | ${int(summary.secondary.driftMedianInputTokensAmongSuccesses)} |`);
  lines.push('');
  lines.push(`_${summary.secondary.note}_`, '');

  for (const c of summary.conditions) {
    lines.push(`### Condition: ${c.condition}`, '');
    lines.push(`- Trials: ${c.trials} (${c.validTrials} valid, ${c.invalidTrials} excluded as infrastructure failures${Object.keys(c.infrastructureFailures).length ? `: ${Object.entries(c.infrastructureFailures).map(([k, v]) => `${k} ×${v}`).join(', ')}` : ''})`);
    lines.push(`- Successful: ${c.successfulTrials}/${c.validTrials} (${ratePct(c.successRate)})`);
    lines.push(`- Median gross input tokens: ${int(c.medianInputTokens)}; median output tokens: ${int(c.medianOutputTokens)}`);
    lines.push(`- Median wall clock: ${ms(c.medianWallClockMs)}; median tool calls: ${int(c.medianToolCalls)}; median unique files read: ${int(c.medianFilesRead)}; median shell commands: ${int(c.medianShellCommands)}; median files changed: ${int(c.medianFilesChanged)}`);
    lines.push(`- Agent session outcomes: ${Object.entries(c.agentStatuses).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}`);
    lines.push(`- Failure reasons (a trial can carry several): ${Object.entries(c.failureReasons).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}`);
    lines.push(`- Total provider-reported cost: ${c.totalCostUsd === null ? 'not reported for every trial' : `$${c.totalCostUsd.toFixed(2)}`}`);
    lines.push('');
  }

  lines.push('## Per-case results', '');
  lines.push('| Case | Baseline success | Drift success | Δ success | Baseline median tokens | Drift median tokens | Token Δ | Drift found change | Drift found code |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const c of summary.cases) {
    lines.push(
      `| ${c.caseId} | ${c.baselineSuccesses}/${c.validBaselineTrials} (${ratePct(c.baselineSuccessRate)}) | ${c.driftSuccesses}/${c.validDriftTrials} (${ratePct(c.driftSuccessRate)}) | ${pp(c.successDifferencePp)} | ${int(c.medianBaselineInputTokens)} | ${int(c.medianDriftInputTokens)} | ${c.inputTokenReduction === null ? 'n/a' : `${c.inputTokenReduction >= 0 ? '-' : '+'}${Math.abs(c.inputTokenReduction * 100).toFixed(1)}%`} | ${ratePct(c.driftIdentifiedBreakingChange)} | ${ratePct(c.driftIdentifiedLocalCode)} |`,
    );
  }
  lines.push('');
  lines.push(`Case level: Drift improved ${f.caseLevel.improved}, tied ${f.caseLevel.tied}, baseline better ${f.caseLevel.baselineBetter}; median difference ${pp(f.caseLevel.medianDifferencePp)}, mean ${pp(f.caseLevel.meanDifferencePp)}.`, '');

  lines.push('## Failure categories', '');
  lines.push('| Reason | Baseline | Drift |');
  lines.push('| --- | ---: | ---: |');
  const reasons = new Set([...Object.keys(summary.conditions[0]?.failureReasons ?? {}), ...Object.keys(summary.conditions[1]?.failureReasons ?? {})]);
  for (const reason of [...reasons].sort()) {
    lines.push(`| ${reason} | ${summary.conditions[0]?.failureReasons[reason] ?? 0} | ${summary.conditions[1]?.failureReasons[reason] ?? 0} |`);
  }
  if (reasons.size === 0) lines.push('| (none) | 0 | 0 |');
  lines.push('');

  lines.push('## Pipeline diagnostics (Drift condition)', '');
  lines.push(`- Drift analysis outcomes: ${Object.entries(summary.pipelineDiagnostics.driftAnalysisStatuses).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}`);
  lines.push(`- Drift named the relevant breaking change: ${ratePct(summary.pipelineDiagnostics.driftIdentifiedBreakingChangeRate)} of trials with expected symbols declared`);
  lines.push(`- Drift located a file the reference fix touches: ${ratePct(summary.pipelineDiagnostics.driftIdentifiedLocalCodeRate)}`);
  lines.push('');

  lines.push('## Excluded trials', '');
  if (summary.exclusions.length === 0) lines.push('None.');
  else for (const x of summary.exclusions) lines.push(`- ${x.trialId}: ${x.reason} — ${x.detail.replace(/\s+/g, ' ')}`);
  lines.push('');

  lines.push('## Publication gates', '');
  lines.push(`Eligible for public claims: **${summary.publication.eligible ? 'yes' : 'no'}**`, '');
  for (const gate of summary.publication.gates) lines.push(`- ${gate.passed ? '✅' : '❌'} ${gate.name}: ${gate.detail}`);
  lines.push('');

  lines.push('## Methodology', '');
  lines.push(`- Conditions: identical task text (hashes ${summary.task.taskHashes.map((h) => h.slice(0, 10)).join(', ')}), identical model, effort, permissions, tools, network policy and time limit; the Drift condition appends Drift's production report (\`drift analyze --markdown${summary.configuration.driftVerify ? ' --verify' : ''}\`) to the same task.`);
  lines.push(`- Input tokens: ${summary.methodology.inputTokenDefinition}`);
  lines.push(`- Success: ${summary.methodology.successDefinition}`);
  lines.push(`- Isolation: ${summary.methodology.isolation}`);
  lines.push(`- Tool counting: ${summary.methodology.toolCounting}`);
  lines.push(`- Agent configuration: permission modes ${summary.configuration.permissionModes.join(', ') || 'n/a'}; clean environment ${summary.configuration.cleanEnvironments.join(', ') || 'n/a'}; disallowed tools ${summary.configuration.disallowedTools.join(', ') || 'none'}; network ${summary.configuration.networkPolicies.join(' | ')}; timeouts ${summary.configuration.timeoutSeconds.join(', ')}s.`);
  lines.push(`- Case provenance: ${Object.entries(summary.caseProvenance).map(([k, v]) => `${k} ×${v}`).join(', ')}; roles: ${Object.entries(summary.caseRoles).map(([k, v]) => `${k} ×${v}`).join(', ')}; ecosystems: ${Object.entries(summary.ecosystems).map(([k, v]) => `${k} ×${v}`).join(', ')}.`);
  lines.push('');

  lines.push('## Limitations', '');
  for (const item of LIMITATIONS) lines.push(`- ${item}`);
  lines.push('');

  lines.push('## Reproduction', '');
  lines.push('```sh');
  lines.push('npm run benchmark:agent:validate -- --suite ' + summary.suite);
  lines.push(`npm run benchmark:agent -- --suite ${summary.suite} --runs ${summary.runsPerCondition} --model ${summary.requestedModel} --effort ${summary.requestedEffort}`);
  lines.push(`npm run benchmark:agent:aggregate -- --runs ${summary.runIds.join(',')}`);
  lines.push('npm run benchmark:agent:report');
  lines.push('npm run benchmark:agent:verify');
  lines.push('```', '');
  lines.push(`Raw trial artifacts: \`eval/results/agent/raw/<run-id>/trials/\` for ${summary.runIds.map((r) => `\`${r}\``).join(', ')}.`);

  return lines.join('\n');
}

export const LIMITATIONS = [
  'Coding agents are stochastic; repeated trials and bootstrap intervals bound but do not remove that variance.',
  'Results are specific to the model, agent CLI version and effort setting recorded here, and can change when the provider updates any of them.',
  'The cases are dependency migrations, which is what Drift is for; they say nothing about other coding tasks.',
  'Gross input tokens count cache reads at full size; the provider\'s cache behaviour therefore affects the headline, and the uncached figure is reported beside it.',
  'Wall-clock figures include provider latency and network conditions on the machine that ran the trials.',
  'Tool-activity counts are per tool invocation; a single shell command can read many files and is counted once.',
  'Ground-truth isolation is a workspace audit, not an OS sandbox; hidden material was not mounted but was readable elsewhere on the host.',
  'The held-out share of the suite is recorded per result; a suite with few or no held-out cases supports a weaker generalisation claim.',
  'Passing every check, including the hidden tests, cannot prove the absence of every regression.',
  'Hidden-test quality varies by case; each case\'s tests and rules are in its private directory for review.',
  'The Drift condition appends a production report to the task; a reader should check the report is the product\'s own output (it is rendered by the same code as `drift analyze --markdown`) and not a benchmark-tuned prompt.',
];

/** The README block. Generated only when the gates pass; otherwise the placeholder that says why. */
export const README_BLOCK_BEGIN = '<!-- agent-benchmark:begin -->';
export const README_BLOCK_END = '<!-- agent-benchmark:end -->';

export function renderReadmeBlock(summary: AgentBenchmarkSummary | null): string {
  const lines = [README_BLOCK_BEGIN];
  if (!summary || !summary.publication.eligible) {
    lines.push(
      '**Agent benchmark.** A paired benchmark — the same coding agent, task, model and starting repositories, with and without Drift\'s analysis — is implemented in [`eval/agent/`](eval/agent/README.md). ' +
        (summary
          ? `The latest run (${summary.caseCount} case(s), ${summary.runsPerCondition} run(s) per condition, suite \`${summary.suite}\`) does not yet meet the publication gates (${summary.publication.gates.filter((g) => !g.passed).map((g) => g.name).join(', ')}), so no headline figure is published from it.`
          : 'No result has been generated yet, so no figure is published.') +
        ' The methodology page is at [trydrift.github.io/drift/benchmarks/agent](https://trydrift.github.io/drift/benchmarks/agent/).',
    );
    lines.push(README_BLOCK_END);
    return lines.join('\n');
  }
  const e = summary.efficiency;
  const f = summary.effectiveness;
  lines.push(`Measured across ${summary.caseCount} dependency-upgrade cases using ${summary.requestedModel} (${summary.runsPerCondition} runs per condition):`, '');
  lines.push(`**${pct(e.medianInputTokenReductionPct)} fewer agent input tokens** (median case-level reduction)`);
  lines.push(`**${ratePct(f.baselineSuccessRate)} → ${ratePct(f.driftSuccessRate)} successful dependency remediations** (${pp(f.differencePercentagePoints)})`, '');
  lines.push('| | Without Drift | With Drift |');
  lines.push('|---|---:|---:|');
  lines.push(`| Successful fixes | ${ratePct(f.baselineSuccessRate)} | ${ratePct(f.driftSuccessRate)} |`);
  lines.push(`| Median input tokens | ${int(e.medianBaselineInputTokens)} | ${int(e.medianDriftInputTokens)} |`);
  lines.push(`| Median files read | ${int(summary.conditions[0]?.medianFilesRead ?? null)} | ${int(summary.conditions[1]?.medianFilesRead ?? null)} |`, '');
  lines.push('Same starting repositories, model, task, tools, permissions, and success criteria. Suite `' + summary.suite + '`, Drift `' + summary.driftCommit.slice(0, 10) + '`, ' + summary.generatedAt.slice(0, 10) + '.', '');
  lines.push('[Methodology](https://trydrift.github.io/drift/benchmarks/agent/) · [Per-case results](eval/reports/agent/latest.md) · [Raw data](eval/results/agent/) · [Reproduce](eval/agent/README.md#reproduce)');
  lines.push(README_BLOCK_END);
  return lines.join('\n');
}

/** Launch copy, generated from the result. Empty until the gates pass. */
export function renderPublicCopy(summary: AgentBenchmarkSummary | null): string {
  if (!summary || !summary.publication.eligible) {
    return [
      '# Public copy',
      '',
      'Not generated: the latest result does not meet the publication gates. Nothing below may be quoted.',
      '',
      summary ? summary.publication.gates.filter((g) => !g.passed).map((g) => `- ${g.name}: ${g.detail}`).join('\n') : '- no result exists',
    ].join('\n');
  }
  const e = summary.efficiency;
  const f = summary.effectiveness;
  return [
    '# Public copy (generated from eval/results/agent/latest.json)',
    '',
    '## Positioning',
    '',
    'Drift researches what changed in a dependency and traces those changes into your code before the coding agent starts remediation.',
    'Instead of forcing the agent to rediscover the migration from scratch, Drift gives it targeted evidence and affected code locations.',
    '',
    '## Product Hunt',
    '',
    'Drift researches dependency changes, traces their impact into your codebase, and hands your coding agent a focused remediation task.',
    '',
    `Across ${summary.caseCount} dependency-upgrade cases, Drift reduced agent input tokens by a median ${pct(e.medianInputTokenReductionPct)} while successful remediations increased from ${ratePct(f.baselineSuccessRate)} to ${ratePct(f.driftSuccessRate)}.`,
    '',
    '## Hacker News',
    '',
    `Measured on ${summary.caseCount} real dependency upgrades with ${summary.requestedModel}: the same agent, task and starting repositories, with and without Drift's analysis. Median ${pct(e.medianInputTokenReductionPct)} fewer agent input tokens; successful remediations ${ratePct(f.baselineSuccessRate)} → ${ratePct(f.driftSuccessRate)} (${pp(f.differencePercentagePoints)}). ${summary.runsPerCondition} runs per condition, hidden compatibility tests, dependency must stay upgraded. Methodology and every per-case result: https://trydrift.github.io/drift/benchmarks/agent/`,
    '',
    '## Allowed sentences',
    '',
    `- Drift used ${pct(e.medianInputTokenReductionPct)} fewer agent input tokens while achieving a higher remediation success rate.`,
    `- Median ${pct(e.medianInputTokenReductionPct)} reduction in agent input tokens across ${summary.caseCount} dependency-upgrade cases.`,
    `- Successful remediations increased from ${ratePct(f.baselineSuccessRate)} to ${ratePct(f.driftSuccessRate)} across the benchmark.`,
    '',
    '## Not allowed',
    '',
    '- "X% smaller context window", "X% cheaper", "X% faster", "X% more accurate", any best-case figure as the headline, and the paper\'s 79.9% as a Drift result.',
  ].join('\n');
}
