import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { agentContextDiagnostics, interfaceFor, researchSignals } from './agent-context.ts';
import { compatibilityProblems, comparisonFromTrials, renderComparison } from './compare.ts';
import { buildDriftContext, DRIFT_CLI } from './drift-context.ts';
import { buildClaudeArgs, environmentProblems, ISOLATED_ENVIRONMENT, parseClaudeStream, sessionEnvironmentFrom } from './providers/claude-code.ts';
import { CONDITION_LABELS, parseCondition, type RunManifest, type TrialArtifact } from './schema.ts';
import { DRIFT_MCP_PREAMBLE } from './task.ts';
import { makeTrial } from './test-helpers.ts';
import type { Workspace } from './workspace.ts';

/**
 * The second round of the agent benchmark compares three ways of giving an
 * agent Drift's analysis. What has to hold for that comparison to mean
 * anything: every condition runs in the same kind of session, the MCP
 * condition actually gets the server and nothing else does, and the numbers
 * about Drift's share of the context are measured from the session itself.
 */

const request = { model: 'claude-sonnet-5', effort: 'high', webTools: 'disabled' as const, maxBudgetUsd: null, maxTurns: null };

describe('isolated sessions', () => {
  test('reproduce safe mode without disabling MCP: no CLAUDE.md, no memory, local settings only, explicit servers', () => {
    const { argv, env, disallowedTools, cleanEnvironment } = buildClaudeArgs(
      { ...request, mcpServers: { drift: { command: 'node', args: ['dist/cli.js', 'mcp'] } } },
      { cleanEnvironment: 'isolated' },
    );
    assert.equal(cleanEnvironment, 'isolated');
    assert.equal(argv.includes('--safe-mode'), false);
    // No user, project or local settings at all: `local` still applied .claude/settings.local.json env.
    assert.deepEqual(argv.slice(argv.indexOf('--setting-sources'), argv.indexOf('--setting-sources') + 2), ['--setting-sources', '']);
    assert.ok(argv.includes('--strict-mcp-config'));
    const config = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!);
    assert.deepEqual(config, { mcpServers: { drift: { command: 'node', args: ['dist/cli.js', 'mcp'] } } });
    assert.deepEqual(env, { ...ISOLATED_ENVIRONMENT });
    assert.equal(env['CLAUDE_CODE_DISABLE_CLAUDE_MDS'], '1');
    assert.equal(env['CLAUDE_CODE_DISABLE_AUTO_MEMORY'], '1');
    // Only the browsing tools; every other ordinary tool is left as the CLI provides it, in every condition.
    assert.deepEqual(disallowedTools, ['WebFetch', 'WebSearch', 'ArtifactComments', 'ArtifactData']);
  });

  test('a condition without Drift tools gets an explicitly empty server list, not the machine’s', () => {
    const { argv } = buildClaudeArgs({ ...request, mcpServers: {} }, { cleanEnvironment: 'isolated' });
    assert.deepEqual(JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!), { mcpServers: {} });
  });

  test('safe mode refuses to start an MCP session instead of silently running without the server', () => {
    assert.throws(
      () => buildClaudeArgs({ ...request, mcpServers: { drift: { command: 'node', args: [] } } }, { cleanEnvironment: 'safe-mode' }),
      /--safe-mode disables every MCP server/,
    );
  });
});

describe('conditions', () => {
  test('the full-report condition keeps its stored id and is addressed by its label', () => {
    assert.equal(CONDITION_LABELS.drift, 'drift-full-report');
    assert.equal(parseCondition('drift-full-report'), 'drift');
    assert.equal(parseCondition('drift'), 'drift');
    assert.equal(parseCondition('drift-agent-brief'), 'drift-agent-brief');
    assert.throws(() => parseCondition('drift-brief'), /Unknown condition/);
    assert.equal(interfaceFor('drift'), 'full-report');
    assert.equal(interfaceFor('drift-mcp'), 'mcp');
  });

  test('the MCP condition analyses nothing before the session and connects the production server', async () => {
    const workspace = { repo: '/nonexistent', project: '/nonexistent', baseCommit: 'a'.repeat(40), startCommit: 'b'.repeat(40) } as Workspace;
    const context = await buildDriftContext('drift-mcp', workspace, { verify: true });
    assert.equal(context.preamble, DRIFT_MCP_PREAMBLE);
    assert.ok(context.preamble.length < 80, 'one sentence');
    assert.equal(context.status, 'not-applicable');
    assert.equal(context.plan, null);
    assert.deepEqual(context.mcpServers, { drift: { command: process.execPath, args: [DRIFT_CLI, 'mcp'] } });
    assert.match(DRIFT_CLI, /dist\/cli\.js$/);
  });
});

/** A small stream: one Drift plan call, a get_finding, a Read into node_modules, an edit, then a test run. */
function stream(): string[] {
  const assistant = (id: string, usage: Record<string, number>, content: unknown[]) =>
    JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5', usage, content } });
  const result = (toolUseId: string, content: unknown, isError = false) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] } });
  return [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5', tools: [], mcp_servers: [{ name: 'drift' }] }),
    assistant('m1', { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0 }, [{ type: 'tool_use', id: 't1', name: 'mcp__drift__plan_upgrade', input: {} }]),
    result('t1', [{ type: 'text', text: 'x'.repeat(4200) }]),
    // The CLI re-emits an assistant event per content block with the same id and usage.
    assistant('m2', { input_tokens: 5, cache_creation_input_tokens: 1400, cache_read_input_tokens: 1000 }, [{ type: 'text', text: 'thinking' }]),
    assistant('m2', { input_tokens: 5, cache_creation_input_tokens: 1400, cache_read_input_tokens: 1000 }, [
      { type: 'tool_use', id: 't2', name: 'mcp__drift__get_finding', input: { id: 'bc_1' } },
      { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/repo/node_modules/eslint/lib/api.js' } },
    ]),
    result('t2', 'No finding with id "bc_1" in this plan.', true),
    result('t3', 'module.exports = {}'),
    assistant('m3', { input_tokens: 3, cache_creation_input_tokens: 200, cache_read_input_tokens: 2400 }, [{ type: 'tool_use', id: 't4', name: 'Edit', input: { file_path: '/repo/src/a.ts' } }]),
    result('t4', 'ok'),
    assistant('m4', { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 2600 }, [
      { type: 'tool_use', id: 't5', name: 'Bash', input: { command: 'npm view eslint versions && cat node_modules/eslint/CHANGELOG.md' } },
    ]),
    result('t5', 'done'),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, modelUsage: {} }),
  ];
}

describe('agent-context diagnostics from the session stream', () => {
  test('tool results are recorded by tool_use id, and each tool use knows which model call issued it', () => {
    const parsed = parseClaudeStream(stream());
    assert.equal(parsed.ledger.length, 4);
    assert.deepEqual(parsed.toolUses.map((u) => [u.id, u.ledgerIndex]), [['t1', 0], ['t2', 1], ['t3', 1], ['t4', 2], ['t5', 3]]);
    assert.deepEqual(parsed.toolResults.get('t1'), { chars: 4200, isError: false, at: null });
    assert.deepEqual(parsed.toolResults.get('t2'), { chars: 39, isError: true, at: null });
  });

  test('Drift tool calls, what they returned, errors, and the findings pulled on demand', () => {
    const d = agentContextDiagnostics({ condition: 'drift-mcp', parsed: parseClaudeStream(stream()), preamble: DRIFT_MCP_PREAMBLE, brief: null, findingsInPlan: null, dependency: 'eslint' });
    assert.equal(d.interface, 'mcp');
    assert.equal(d.driftToolCalls, 2);
    assert.deepEqual(d.driftToolCallsByName, { plan_upgrade: 1, get_finding: 1 });
    assert.equal(d.driftToolReturnedChars, 4200 + 39);
    assert.equal(d.driftToolReturnedEstimatedTokens, Math.ceil((4200 + 39) / 3));
    assert.equal(d.driftToolErrors, 1);
    assert.equal(d.findingsRetrievedOnDemand, 1);
    assert.equal(d.initialDriftContextChars, DRIFT_MCP_PREAMBLE.length);
    assert.equal(d.findingsInInitialBrief, null);
  });

  test('provider usage splits at the model call that made the first edit', () => {
    const d = agentContextDiagnostics({ condition: 'baseline', parsed: parseClaudeStream(stream()), preamble: '', brief: null, findingsInPlan: null, dependency: 'eslint' });
    // m1 + m2 + m3 (the call that issued Edit), each message counted once.
    assert.deepEqual(d.tokensBeforeFirstEdit, { grossInputTokens: 1010 + 2405 + 2603, uncachedInputTokens: 1010 + 1405 + 203, modelCalls: 3 });
    assert.deepEqual(d.tokensAfterFirstEdit, { grossInputTokens: 2702, uncachedInputTokens: 102, modelCalls: 1 });
    assert.equal(d.initialDriftContextEstimatedTokens, 0);
  });

  test('a session that never edits has no split, rather than a misleading one', () => {
    const lines = stream().filter((line) => !line.includes('"Edit"'));
    const d = agentContextDiagnostics({ condition: 'baseline', parsed: parseClaudeStream(lines), preamble: '', brief: null, findingsInPlan: null, dependency: 'eslint' });
    assert.equal(d.tokensBeforeFirstEdit, null);
    assert.equal(d.tokensAfterFirstEdit, null);
  });

  test('independent research is counted literally: package source, registry queries, changelogs', () => {
    assert.deepEqual(researchSignals(parseClaudeStream(stream()), 'eslint'), {
      dependencySourceAccesses: 2,
      registryQueries: 1,
      changelogAccesses: 1,
    });
    // A different package's name is not research into this one.
    assert.equal(researchSignals(parseClaudeStream(stream()), 'winston').dependencySourceAccesses, 0);
  });

  test('brief statistics are carried through when the brief was built before the session', () => {
    const brief = { findingsInPlan: 293, findingsInInitialBrief: 5, nonLocalFindingsOmitted: 288, deterministicSitesCovered: 0, residualSitesSentToAgent: 47 };
    const d = agentContextDiagnostics({ condition: 'drift-agent-brief', parsed: parseClaudeStream([]), preamble: 'y'.repeat(4500), brief, findingsInPlan: 293, dependency: 'eslint' });
    assert.equal(d.interface, 'agent-brief');
    assert.equal(d.initialDriftContextEstimatedTokens, 1500);
    assert.equal(d.findingsInInitialBrief, 5);
    assert.equal(d.nonLocalFindingsOmitted, 288);
  });
});

describe('comparing Drift conditions against the baseline', () => {
  const manifest: RunManifest = {
    version: 'drift-agent-run-v1',
    runId: 'run-1',
    suite: 'test-suite',
    suiteStatus: 'draft',
    createdAt: '2026-09-16T00:00:00.000Z',
    command: 'test',
    driftCommit: 'd'.repeat(40),
    driftTreeDirty: false,
    provider: 'claude-code',
    requestedModel: 'claude-sonnet-5',
    requestedEffort: 'high',
    agentCliVersion: '2.1.267 (Claude Code)',
    runsPerCondition: 2,
    conditions: ['baseline', 'drift', 'drift-agent-brief'],
    caseIds: ['a', 'b'],
    node: 'v24',
    platform: 'darwin',
    arch: 'x64',
    notes: '',
  };

  const trials = [
    makeTrial({ caseId: 'a', condition: 'baseline', repetition: 1, gross: 1000, success: true }),
    makeTrial({ caseId: 'a', condition: 'baseline', repetition: 2, gross: 1200, success: true }),
    makeTrial({ caseId: 'a', condition: 'drift', repetition: 1, gross: 3000, success: true }),
    makeTrial({ caseId: 'a', condition: 'drift', repetition: 2, gross: 3200, success: false, reasons: ['hidden_regression_failure'] }),
    makeTrial({ caseId: 'a', condition: 'drift-agent-brief', repetition: 1, gross: 800, success: true }),
    makeTrial({ caseId: 'a', condition: 'drift-agent-brief', repetition: 2, gross: 900, success: true }),
    makeTrial({ caseId: 'b', condition: 'baseline', repetition: 1, gross: 2000, success: false, reasons: ['existing_test_failure'] }),
    makeTrial({ caseId: 'b', condition: 'baseline', repetition: 2, gross: 2000, success: true }),
    makeTrial({ caseId: 'b', condition: 'drift', repetition: 1, gross: 2500, success: true }),
    makeTrial({ caseId: 'b', condition: 'drift', repetition: 2, gross: 2500, success: true }),
    makeTrial({ caseId: 'b', condition: 'drift-agent-brief', repetition: 1, gross: 1000, success: true }),
    makeTrial({ caseId: 'b', condition: 'drift-agent-brief', repetition: 2, gross: 1000, success: true, valid: false, infrastructureFailure: 'provider_error' }),
  ];

  test('each Drift condition is paired with the baseline case by case, never pooled with another', () => {
    const section = comparisonFromTrials(trials, [manifest]);
    assert.deepEqual(section.conditions.map((c) => c.label), ['baseline', 'drift-full-report', 'drift-agent-brief']);
    const full = section.conditions.find((c) => c.condition === 'drift')!.vsBaseline!;
    const brief = section.conditions.find((c) => c.condition === 'drift-agent-brief')!.vsBaseline!;
    // Case a: 3100/1100 - 1 = +181.8%; case b: 2500/2000 - 1 = +25%. Median of two: +103.4%.
    assert.ok(Math.abs(full.medianCaseGrossChangePct! - (((3100 / 1100 - 1) + 0.25) / 2) * 100) < 1e-9);
    // Case a: 850/1100 - 1 = -22.7%; case b: 1000/2000 - 1 = -50% (the excluded trial is not counted).
    assert.ok(Math.abs(brief.medianCaseGrossChangePct! - (((850 / 1100 - 1) - 0.5) / 2) * 100) < 1e-9);
    assert.equal(brief.pairedCases, 2);
    // Success: baseline 3/4, brief 3/3 → +25 pp; full report 3/4 → 0 pp.
    assert.equal(brief.successDifferencePp, 25);
    assert.equal(full.successDifferencePp, 0);
  });

  test('the per-case table reports exclusions and failure reasons beside each condition', () => {
    const section = comparisonFromTrials(trials, [manifest]);
    const b = section.cases.find((c) => c.caseId === 'b')!;
    assert.deepEqual({ valid: b.cells['drift-agent-brief']!.valid, excluded: b.cells['drift-agent-brief']!.excluded }, { valid: 1, excluded: 1 });
    assert.deepEqual(b.cells['baseline']!.failureReasons, { existing_test_failure: 1 });
    const markdown = renderComparison({ name: 't', generatedAt: 'now', current: section, history: [], notes: ['Development cases only.'] });
    assert.match(markdown, /\| b \| drift-agent-brief \| 1\/1 \(\+1 excl\.\) \|/);
    assert.match(markdown, /\| drift-agent-brief \| 2 \| -36\.4% \|/);
  });
});

describe('session environment audit', () => {
  const init = (overrides: Record<string, unknown> = {}) => ({
    type: 'system',
    subtype: 'init',
    tools: ['Bash', 'Edit', 'Read', 'TodoWrite', 'ToolSearch', 'Write'],
    mcp_servers: [],
    skills: ['debug', 'verify'],
    slash_commands: ['compact', 'debug'],
    agents: ['Explore', 'Plan'],
    plugins: [],
    output_style: 'default',
    apiKeySource: 'none',
    ...overrides,
  });

  test('conditions without Drift and the MCP condition share one fingerprint when they differ only by the Drift server', () => {
    const plain = sessionEnvironmentFrom(init());
    const mcp = sessionEnvironmentFrom(init({ tools: [...init().tools, 'mcp__drift__plan_upgrade', 'mcp__drift__get_finding'], mcp_servers: [{ name: 'drift', status: 'connected' }] }));
    assert.equal(plain.fingerprint, mcp.fingerprint);
    assert.deepEqual(environmentProblems(plain, []), []);
    assert.deepEqual(environmentProblems(mcp, ['drift']), []);
  });

  test('any other difference changes the fingerprint', () => {
    const base = sessionEnvironmentFrom(init()).fingerprint;
    for (const change of [{ skills: ['debug', 'verify', 'canary-skill'] }, { agents: ['Explore', 'Plan', 'canary-agent'] }, { tools: ['Bash', 'Read'] }, { output_style: 'explanatory' }]) {
      assert.notEqual(sessionEnvironmentFrom(init(change)).fingerprint, base, JSON.stringify(change));
    }
  });

  test('a session that loaded the wrong servers, plugins or memory is reported, not scored', () => {
    assert.match(environmentProblems(sessionEnvironmentFrom(init({ mcp_servers: [{ name: 'claude.ai Gmail', status: 'connected' }] })), []).join(), /MCP servers \["claude.ai Gmail"\], expected \[\]/);
    assert.match(environmentProblems(sessionEnvironmentFrom(init()), ['drift']).join(), /expected \["drift"\]/);
    assert.match(environmentProblems(sessionEnvironmentFrom(init({ mcp_servers: [{ name: 'drift', status: 'failed' }] })), ['drift']).join(), /drift is failed/);
    assert.match(environmentProblems(sessionEnvironmentFrom(init({ plugins: [{ name: 'x' }] })), []).join(), /plugins loaded: x/);
    assert.match(environmentProblems(sessionEnvironmentFrom(init({ memory_paths: { auto: '/m' } })), []).join(), /memory loaded/);
    assert.deepEqual(environmentProblems(null, []), ['the session reported no init record']);
  });
});

describe('Drift tool timing and the wall-clock decomposition', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 8, 16, 0, 0, s)).toISOString();
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5', tools: [], mcp_servers: [{ name: 'drift', status: 'connected' }] }),
    JSON.stringify({ type: 'assistant', timestamp: at(10), message: { id: 'm1', model: 'claude-sonnet-5', usage: {}, content: [{ type: 'tool_use', id: 't1', name: 'mcp__drift__plan_upgrade', input: {} }] } }),
    JSON.stringify({ type: 'user', timestamp: at(70), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'plan' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: at(71), message: { id: 'm2', model: 'claude-sonnet-5', usage: {}, content: [{ type: 'tool_use', id: 't2', name: 'mcp__drift__get_finding', input: { id: 'bc_1' } }] } }),
    JSON.stringify({ type: 'user', timestamp: at(72), message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'finding' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: at(73), message: { id: 'm3', model: 'claude-sonnet-5', usage: {}, content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test' } }] } }),
    JSON.stringify({ type: 'user', timestamp: at(173), message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'ok' }] } }),
  ];

  test('MCP: Drift runs inside the session, so end-to-end is the session and Drift tool time is a part of it', () => {
    const d = agentContextDiagnostics({ condition: 'drift-mcp', parsed: parseClaudeStream(lines), preamble: DRIFT_MCP_PREAMBLE, brief: null, findingsInPlan: null, dependency: 'x', preSessionDriftMs: 0, sessionMs: 300_000 });
    assert.deepEqual(d.timing, { preSessionDriftMs: 0, sessionMs: 300_000, driftToolMs: 61_000, endToEndMs: 300_000 });
  });

  test('brief and full report: Drift ran before the session and is added once', () => {
    const d = agentContextDiagnostics({ condition: 'drift-agent-brief', parsed: parseClaudeStream([]), preamble: 'brief', brief: null, findingsInPlan: 3, dependency: 'x', preSessionDriftMs: 45_000, sessionMs: 200_000 });
    assert.deepEqual(d.timing, { preSessionDriftMs: 45_000, sessionMs: 200_000, driftToolMs: 0, endToEndMs: 245_000 });
  });

  test('baseline: end-to-end is the session alone', () => {
    const d = agentContextDiagnostics({ condition: 'baseline', parsed: parseClaudeStream([]), preamble: '', brief: null, findingsInPlan: null, dependency: 'x', preSessionDriftMs: 0, sessionMs: 180_000 });
    assert.equal(d.timing!.endToEndMs, 180_000);
  });
});

describe('pooling runs into one comparison', () => {
  const manifest = (runId: string, caseIds: string[], overrides: Partial<RunManifest> = {}): RunManifest => ({
    version: 'drift-agent-run-v1',
    runId,
    suite: 'agent-upgrade-v1',
    suiteStatus: 'draft',
    createdAt: '2026-09-16T00:00:00.000Z',
    command: 'test',
    driftCommit: 'd'.repeat(40),
    driftTreeDirty: false,
    provider: 'claude-code',
    requestedModel: 'claude-sonnet-5',
    requestedEffort: 'high',
    agentCliVersion: '2.1.267 (Claude Code)',
    runsPerCondition: 1,
    conditions: ['baseline', 'drift-agent-brief'],
    caseIds,
    node: 'v24',
    platform: 'darwin',
    arch: 'x64',
    notes: '',
    scheduleDesign: 'williams-v1',
    cleanEnvironment: 'isolated',
    webTools: 'disabled',
    maxBudgetUsd: null,
    maxTurns: null,
    driftVerify: true,
    ...overrides,
  });
  const env = (fingerprint = 'env-1') => ({ tools: [], mcpServers: [], skills: [], slashCommands: [], agents: [], plugins: [], memoryPaths: [], outputStyle: 'default', apiKeySource: 'none', fingerprint });
  const trial = (runId: string, caseId: string, condition: 'baseline' | 'drift-agent-brief', edit: (t: ReturnType<typeof makeTrial>) => void = () => undefined) => {
    const t = makeTrial({ runId, caseId, condition, repetition: 1, gross: 1000, success: true });
    t.metadata.agentConfiguration.cleanEnvironment = 'isolated';
    t.metadata.agentConfiguration.environment = env();
    edit(t);
    return t;
  };
  const perCase = (runId: string, caseId: string, edit?: (t: ReturnType<typeof makeTrial>) => void) => ({
    manifest: manifest(runId, [caseId]),
    trials: [trial(runId, caseId, 'baseline', edit), trial(runId, caseId, 'drift-agent-brief', edit)],
    aborted: false,
  });

  test('one case per run is pooled when the experiment is the same', () => {
    assert.deepEqual(compatibilityProblems([perCase('v3-dev-winston', 'a'), perCase('v3-dev-ethereum', 'b'), perCase('v3-dev-eslint', 'c')]), []);
  });

  test('every setting that defines the experiment must agree, and each difference is named', () => {
    const variants: [string, Partial<RunManifest>, RegExp][] = [
      ['model', { requestedModel: 'claude-opus-5' }, /requested model differs/],
      ['effort', { requestedEffort: 'medium' }, /requested effort differs/],
      ['cli', { agentCliVersion: '2.1.300' }, /agent CLI version differs/],
      ['commit', { driftCommit: 'e'.repeat(40) }, /Drift commit differs/],
      ['dirty', { driftTreeDirty: true }, /uncommitted changes/],
      ['isolation', { cleanEnvironment: 'safe-mode' }, /clean environment differs/],
      ['web', { webTools: 'allowed' }, /web tools differs/],
      ['budget', { maxBudgetUsd: 5 }, /budget \(USD\) differs/],
      ['turns', { maxTurns: 40 }, /turn cap differs/],
      ['schedule', { scheduleDesign: 'alternating' }, /schedule design differs/],
      ['conditions', { conditions: ['baseline', 'drift-mcp'] }, /conditions differs/],
    ];
    for (const [label, overrides, pattern] of variants) {
      const other = { ...perCase('b-run', 'b'), manifest: manifest('b-run', ['b'], overrides) };
      assert.match(compatibilityProblems([perCase('a-run', 'a'), other]).join('\n'), pattern, label);
    }
  });

  test('a case must have the same content, start tree and task wherever it appears', () => {
    const a = perCase('run-1', 'shared');
    for (const [field, pattern] of [
      [(t: TrialArtifact) => (t.caseHash = 'other'), /case shared content hash differs/],
      [(t: TrialArtifact) => (t.metadata.startTreeHash = 'other'), /case shared start tree differs/],
      [(t: TrialArtifact) => (t.metadata.taskHash = 'other'), /case shared task differs/],
    ] as const) {
      const b = { manifest: manifest('run-2', ['shared']), trials: [trial('run-2', 'shared', 'baseline', field)], aborted: false };
      b.trials[0]!.repetition = 2;
      assert.match(compatibilityProblems([a, b]).join('\n'), pattern);
    }
  });

  test('sessions that loaded different environments are not pooled, and a slot recorded twice is refused', () => {
    const differentEnvironment = perCase('run-2', 'b', (t) => (t.metadata.agentConfiguration.environment = env('env-2')));
    assert.match(compatibilityProblems([perCase('run-1', 'a'), differentEnvironment]).join('\n'), /session environment \(excluding Drift MCP\) differs/);
    assert.match(compatibilityProblems([perCase('run-1', 'a'), perCase('run-2', 'a')]).join('\n'), /case a baseline#1 is recorded by both run-1 and run-2/);
    const unrecorded = perCase('run-2', 'b', (t) => delete t.metadata.agentConfiguration.environment);
    assert.match(compatibilityProblems([perCase('run-1', 'a'), unrecorded]).join('\n'), /did not record the session environment/);
  });

  test('an aborted run is never pooled', () => {
    assert.match(compatibilityProblems([{ ...perCase('v2-dev-1', 'a'), aborted: true }]).join('\n'), /v2-dev-1 is marked aborted/);
  });
});
