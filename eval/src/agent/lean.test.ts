import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compatibilityProblems } from './compare.ts';
import { threeWayFromTrials } from './orchestration-compare.ts';
import { buildClaudeArgs, environmentProblems, sessionEnvironmentFrom } from './providers/claude-code.ts';
import { CONDITIONS, isLean, parseCondition, trialSchema, type RunManifest, type TrialArtifact } from './schema.ts';
import { contextKindFor } from './task.ts';
import { interfaceFor } from './agent-context.ts';
import { makeTrial } from './test-helpers.ts';
import { CLAUDE_CODE_LEAN_SESSION_ARGS, CLAUDE_CODE_LEAN_TOOLS } from '../../../dist/index.js';

/**
 * The lean conditions: the raw task in one autonomous session, started with the
 * product's lean launch profile. Everything else about the session must match
 * the baseline, and the tool set must be exactly the declared one.
 */

const request = { model: 'claude-sonnet-5', effort: 'high', webTools: 'disabled' as const, maxBudgetUsd: null, maxTurns: null, mcpServers: {} };

describe('lean conditions', () => {
  test('are defined, carry no Drift context (lean) or the brief (lean-brief)', () => {
    assert.ok(CONDITIONS.includes('drift-lean') && CONDITIONS.includes('drift-lean-brief'));
    assert.equal(parseCondition('drift-lean'), 'drift-lean');
    assert.equal(isLean('drift-lean'), true);
    assert.equal(isLean('baseline'), false);
    assert.equal(contextKindFor('drift-lean'), 'none');
    assert.equal(contextKindFor('drift-lean-brief'), 'drift');
    assert.equal(interfaceFor('drift-lean-brief'), 'lean-brief');
  });

  test('the launch appends exactly the product profile, and the baseline gets none of it', () => {
    const lean = buildClaudeArgs({ ...request, extraArgs: CLAUDE_CODE_LEAN_SESSION_ARGS }, { cleanEnvironment: 'isolated' }).argv;
    const raw = buildClaudeArgs(request, { cleanEnvironment: 'isolated' }).argv;
    assert.deepEqual(lean.slice(raw.length), [...CLAUDE_CODE_LEAN_SESSION_ARGS]);
    assert.deepEqual(lean.slice(0, raw.length), raw, 'every other argument is identical');
    assert.equal(raw.includes('--tools'), false);
  });

  test('a lean session that loaded any other tool, or skills, is an environment mismatch', () => {
    const base = { type: 'system', subtype: 'init', mcp_servers: [], plugins: [], agents: ['claude'], output_style: 'default', apiKeySource: 'none' };
    const ok = sessionEnvironmentFrom({ ...base, tools: [...CLAUDE_CODE_LEAN_TOOLS], skills: [], slash_commands: [] });
    assert.deepEqual(environmentProblems(ok, [], { tools: CLAUDE_CODE_LEAN_TOOLS, noSkills: true }), []);
    const extra = sessionEnvironmentFrom({ ...base, tools: [...CLAUDE_CODE_LEAN_TOOLS, 'Artifact'], skills: ['design'], slash_commands: ['design'] });
    const problems = environmentProblems(extra, [], { tools: CLAUDE_CODE_LEAN_TOOLS, noSkills: true }).join('\n');
    assert.match(problems, /tools .*Artifact/);
    assert.match(problems, /skills or slash commands loaded/);
    // Same non-tool environment: the base fingerprints agree; the tool fingerprints do not.
    assert.equal(ok.baseFingerprint, extra.baseFingerprint);
    assert.notEqual(ok.toolsFingerprint, extra.toolsFingerprint);
  });

  test('pooling: tools may differ between conditions, never within one; the rest must match everywhere', () => {
    const env = (base: string, tools: string) => ({ tools: [], mcpServers: [], skills: [], slashCommands: [], agents: [], plugins: [], memoryPaths: [], outputStyle: null, apiKeySource: null, fingerprint: `${base}-${tools}`, baseFingerprint: base, toolsFingerprint: tools });
    const withEnv = (t: TrialArtifact, e: ReturnType<typeof env>) => trialSchema.parse({ ...t, metadata: { ...t.metadata, agentConfiguration: { ...t.metadata.agentConfiguration, cleanEnvironment: 'isolated', environment: e } } });
    const manifest = { runId: 'run-1', suite: 's', provider: 'claude-code', requestedModel: 'm', requestedEffort: 'high', agentCliVersion: 'x', driftCommit: 'd'.repeat(40), driftTreeDirty: false, runsPerCondition: 3, conditions: ['baseline', 'drift-lean'], cleanEnvironment: 'isolated' } as unknown as RunManifest;
    const good = [
      withEnv(makeTrial({ caseId: 'c', condition: 'baseline', repetition: 1, gross: 1, success: true }), env('B', 'default')),
      withEnv(makeTrial({ caseId: 'c', condition: 'baseline', repetition: 2, gross: 1, success: true }), env('B', 'default')),
      withEnv(makeTrial({ caseId: 'c', condition: 'drift-lean', repetition: 1, gross: 1, success: true }), env('B', 'lean')),
    ];
    assert.deepEqual(compatibilityProblems([{ manifest, trials: good, aborted: false }]), []);
    const flicker = [...good, withEnv(makeTrial({ caseId: 'c', condition: 'drift-lean', repetition: 2, gross: 1, success: true }), env('B', 'lean+Artifact'))];
    assert.ok(compatibilityProblems([{ manifest, trials: flicker, aborted: false }]).some((p) => /session tools within drift-lean/.test(p)));
    const otherBase = [...good, withEnv(makeTrial({ caseId: 'c', condition: 'drift-lean', repetition: 3, gross: 1, success: true }), env('OTHER', 'lean'))];
    assert.ok(compatibilityProblems([{ manifest, trials: otherBase, aborted: false }]).some((p) => /excluding Drift MCP, tools/.test(p)));
  });

  test('the comparison gates every condition against the first', () => {
    const trials: TrialArtifact[] = [];
    for (const rep of [1, 2, 3]) {
      trials.push(makeTrial({ caseId: 'a', condition: 'baseline', repetition: rep, gross: 1000, success: true }));
      trials.push(makeTrial({ caseId: 'a', condition: 'drift-lean', repetition: rep, gross: 600, success: true }));
      trials.push(makeTrial({ caseId: 'a', condition: 'drift-lean-brief', repetition: rep, gross: 500, success: rep !== 3 }));
    }
    const manifest = { runId: 'run-1', driftCommit: 'd', requestedModel: 'm', requestedEffort: 'high', agentCliVersion: 'x', runsPerCondition: 3, conditions: ['baseline', 'drift-lean', 'drift-lean-brief'] } as unknown as RunManifest;
    const c = threeWayFromTrials(trials, [manifest], { name: 'lean', conditions: ['baseline', 'drift-lean', 'drift-lean-brief'] });
    assert.deepEqual(c.conditions, ['baseline', 'drift-lean', 'drift-lean-brief']);
    const lean = c.gates.find((g) => g.condition === 'Drift lean')!;
    assert.equal(lean.accuracyNotBelowReference, true);
    assert.ok(Math.abs(lean.medianGrossReductionPct! - 40) < 1e-9);
    const brief = c.gates.find((g) => g.condition === 'Drift lean + brief')!;
    assert.equal(brief.accuracyNotBelowReference, false);
  });
});
