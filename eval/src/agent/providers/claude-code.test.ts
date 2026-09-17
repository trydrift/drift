import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClaudeArgs, classifyStatus, parseClaudeStream, toolMetricsFromStream, usageFromStream } from './claude-code.ts';

const fixtures = join(import.meta.dirname, '..', 'fixtures');
const lines = (name: string) => readFileSync(join(fixtures, name), 'utf8').split('\n');

describe('Claude Code stream parsing', () => {
  test('deduplicates assistant events by message id so per-block re-emission is not double counted', () => {
    const parsed = parseClaudeStream(lines('claude-stream-complete.jsonl'));
    assert.equal(parsed.ledger.length, 6);
    assert.equal(parsed.init?.model, 'claude-sonnet-5');
    assert.equal(parsed.init?.claudeCodeVersion, '2.1.267');
    assert.equal(parsed.toolUses.length, 7);
    assert.equal(parsed.unparsedLines, 0);
  });

  test('cumulative gross input tokens come from the provider per-model record and include every model and cache field', () => {
    const usage = usageFromStream(parseClaudeStream(lines('claude-stream-complete.jsonl')));
    assert.equal(usage.source, 'result-model-usage');
    // primary 157 + 5600 + 22400 = 28157; auxiliary haiku 900 uncached input
    assert.equal(usage.grossInputTokens, 28157 + 900);
    assert.equal(usage.inputTokens, 157 + 900);
    assert.equal(usage.cacheCreationTokens, 5600);
    assert.equal(usage.cacheReadTokens, 22400);
    assert.equal(usage.uncachedInputTokens, 157 + 900 + 5600);
    assert.equal(usage.outputTokens, 329 + 12);
    assert.equal(usage.modelCalls, 6);
    assert.equal(usage.ledgerGrossInputTokens, 28157);
    assert.equal(usage.ledgerAgreesWithResult, true);
    assert.equal(usage.costUsd, 0.4321);
    assert.deepEqual(Object.keys(usage.byModel).sort(), ['claude-haiku-4-5-20251001', 'claude-sonnet-5']);
  });

  test('a session killed before its result event falls back to the deduplicated ledger and says so', () => {
    const parsed = parseClaudeStream(lines('claude-stream-timeout.jsonl'));
    assert.equal(parsed.result, null);
    assert.equal(parsed.unparsedLines, 1);
    const usage = usageFromStream(parsed);
    assert.equal(usage.source, 'event-ledger');
    assert.equal(usage.grossInputTokens, 28157);
    assert.equal(usage.ledgerAgreesWithResult, null);
    assert.equal(usage.costUsd, null);
  });

  test('tool metrics count tool_use blocks once and classify them', () => {
    const tools = toolMetricsFromStream(parseClaudeStream(lines('claude-stream-complete.jsonl')));
    assert.equal(tools.toolCalls, 7);
    assert.equal(tools.fileReads, 3);
    assert.equal(tools.uniqueFilesRead, 2);
    assert.equal(tools.searches, 1);
    assert.equal(tools.shellCommands, 1);
    assert.equal(tools.edits, 1);
    assert.equal(tools.webRequests, 1);
    assert.deepEqual(tools.byTool, { Read: 3, Grep: 1, Bash: 1, Edit: 1, WebFetch: 1 });
    assert.match(tools.counting, /counted once/);
  });

  test('status classification separates agent outcomes from infrastructure', () => {
    const complete = parseClaudeStream(lines('claude-stream-complete.jsonl'));
    assert.equal(classifyStatus({ code: 0, timedOut: false, launchError: null }, complete), 'completed');
    assert.equal(classifyStatus({ code: null, timedOut: true, launchError: null }, complete), 'timeout');
    assert.equal(classifyStatus({ code: 1, timedOut: false, launchError: null }, complete), 'error');
    assert.equal(classifyStatus({ code: null, timedOut: false, launchError: 'ENOENT' }, complete), 'launch-failure');
    const providerError = parseClaudeStream(lines('claude-stream-provider-error.jsonl'));
    assert.equal(classifyStatus({ code: 1, timedOut: false, launchError: null }, providerError), 'provider-error');
    const empty = parseClaudeStream(['{"type":"system","subtype":"init","model":"m"}']);
    assert.equal(classifyStatus({ code: 1, timedOut: false, launchError: null }, empty), 'launch-failure');
  });

  test('the argv is the product launch plus observability and a clean environment, identical for both conditions', () => {
    const built = buildClaudeArgs({ model: 'claude-sonnet-5', effort: 'high', webTools: 'disabled', maxBudgetUsd: null, maxTurns: null }, {});
    assert.deepEqual(built.disallowedTools, ['WebFetch', 'WebSearch', 'ArtifactComments', 'ArtifactData']);
    assert.equal(built.cleanEnvironment, 'safe-mode');
    for (const expected of ['-p', '--output-format', 'stream-json', '--verbose', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--model', 'claude-sonnet-5', '--effort', 'high', '--disallowedTools', 'WebFetch', 'WebSearch']) {
      assert.ok(built.argv.includes(expected), `argv should include ${expected}`);
    }
    assert.ok(!built.argv.includes('--max-budget-usd'));
    const open = buildClaudeArgs({ model: 'sonnet', effort: 'low', webTools: 'allowed', maxBudgetUsd: 5, maxTurns: 40 }, { cleanEnvironment: 'none' });
    assert.deepEqual(open.disallowedTools, ['ArtifactComments', 'ArtifactData']);
    assert.ok(!open.argv.includes('--safe-mode'));
    assert.ok(open.argv.includes('--max-budget-usd') && open.argv.includes('5'));
    assert.ok(open.argv.includes('--max-turns') && open.argv.includes('40'));
  });
});
