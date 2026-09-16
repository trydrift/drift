import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { agentContextDiagnostics, interfaceFor, researchSignals } from './agent-context.ts';
import { comparisonFromTrials, renderComparison } from './compare.ts';
import { buildDriftContext, DRIFT_CLI } from './drift-context.ts';
import { buildClaudeArgs, ISOLATED_ENVIRONMENT, parseClaudeStream } from './providers/claude-code.ts';
import { CONDITION_LABELS, parseCondition, type RunManifest } from './schema.ts';
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
    assert.deepEqual(argv.slice(argv.indexOf('--setting-sources'), argv.indexOf('--setting-sources') + 2), ['--setting-sources', 'local']);
    assert.ok(argv.includes('--strict-mcp-config'));
    const config = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!);
    assert.deepEqual(config, { mcpServers: { drift: { command: 'node', args: ['dist/cli.js', 'mcp'] } } });
    assert.deepEqual(env, { ...ISOLATED_ENVIRONMENT });
    assert.equal(env['CLAUDE_CODE_DISABLE_CLAUDE_MDS'], '1');
    assert.equal(env['CLAUDE_CODE_DISABLE_AUTO_MEMORY'], '1');
    // TodoWrite exists in an isolated session and not under --safe-mode; disallowing it keeps the tool lists equal.
    assert.deepEqual(disallowedTools, ['WebFetch', 'WebSearch', 'TodoWrite']);
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
    assert.deepEqual(parsed.toolResults.get('t1'), { chars: 4200, isError: false });
    assert.deepEqual(parsed.toolResults.get('t2'), { chars: 39, isError: true });
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
    const markdown = renderComparison({ name: 't', generatedAt: 'now', current: section, reference: null, notes: ['Development cases only.'] });
    assert.match(markdown, /\| b \| drift-agent-brief \| 1\/1 \(\+1 excl\.\) \|/);
    assert.match(markdown, /\| drift-agent-brief \| 2 \| -36\.4% \|/);
  });
});
