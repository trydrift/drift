import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compatibilityProblems } from './compare.ts';
import { aggregateAgentResult, neutralPlan, runOrchestrated, sumUsage, type CapturedSession } from './orchestrated.ts';
import { threeWayFromTrials, renderThreeWay, trialMetrics } from './orchestration-compare.ts';
import { parseClaudeStream, toolMetricsFromStream, usageFromStream } from './providers/claude-code.ts';
import type { AgentProvider, AgentRunRequest, AgentRunResult } from './providers/types.ts';
import { blockOrder, positionCounts } from './schedule.ts';
import { CONDITIONS, CONDITION_LABELS, isOrchestrated, parseCondition, trialSchema, type AgentCase, type RunManifest, type TrialArtifact } from './schema.ts';
import { setAsideInfrastructureFailure, writeTrial } from './store.ts';
import { contextKindFor, renderGenericOrchestratedTask, renderTask } from './task.ts';
import { makeTrial } from './test-helpers.ts';
import { classifyVerificationCommand } from './verification-commands.ts';
import type { Workspace } from './workspace.ts';
import { DriftConfigSchema } from '../../../dist/config/schema.js';

/**
 * The orchestrated conditions. What has to hold for raw vs generic vs Drift to
 * mean anything: each condition gets exactly its own capabilities (generic
 * never sees Drift's analysis, Drift runs the production controller), every
 * session's tokens are counted, controller verification is not, and a
 * provider failure anywhere excludes the trial rather than scoring it.
 */

const agentCase = {
  id: 'fixture-case',
  dependency: { name: 'acme-sdk', fromVersion: '1.0.0', toVersion: '2.0.0', updateClass: 'major', category: 'library', section: 'dependencies' },
  ecosystem: 'npm',
  workspaceDir: '',
  environment: { timezone: 'UTC', locale: 'C', runtime: 'node', packageManager: 'npm' },
  agent: { timeoutSeconds: 1800 },
} as unknown as AgentCase;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

async function workspaceWith(files: Record<string, string>): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'drift-orchestrated-'));
  const repo = join(root, 'repo');
  await mkdir(repo);
  git(repo, 'init', '--quiet', '--initial-branch=main');
  // The product commits with plain `git commit`; a CI runner has no global identity.
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'commit.gpgsign', 'false');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'start');
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  return { root, repo, project: repo, baseCommit: head, startCommit: head, startTreeHash: 't', auditedPaths: 0, teardown: () => rm(root, { recursive: true, force: true }) };
}

interface Step {
  edits?: Record<string, string>;
  gross: [input: number, cacheRead: number, cacheCreation: number];
  output?: number;
  bash?: string[];
  reads?: string[];
  status?: AgentRunResult['status'];
  finalMessage?: string;
  fingerprint?: string;
  cost?: number;
}

/** A provider that plays scripted sessions and emits the stream a real session would. */
function scriptedProvider(repo: string, steps: Step[]): AgentProvider & { requests: AgentRunRequest[] } {
  const requests: AgentRunRequest[] = [];
  return {
    id: 'claude-code',
    label: 'Claude Code',
    requests,
    detect: async () => ({ available: true, version: 'test', detail: 'test' }),
    run: async (request) => {
      const step = steps[requests.length] ?? { gross: [0, 0, 0] };
      requests.push(request);
      for (const [path, content] of Object.entries(step.edits ?? {})) {
        await mkdir(dirname(join(repo, path)), { recursive: true });
        await writeFile(join(repo, path), content);
      }
      const n = requests.length;
      const [input, read, created] = step.gross;
      const usage = { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: created, output_tokens: step.output ?? 100 };
      const toolBlocks = [
        ...(step.reads ?? []).map((path, i) => ({ type: 'tool_use', id: `r${n}-${i}`, name: 'Read', input: { file_path: path } })),
        ...(step.bash ?? []).map((command, i) => ({ type: 'tool_use', id: `b${n}-${i}`, name: 'Bash', input: { command } })),
        ...Object.keys(step.edits ?? {}).map((path, i) => ({ type: 'tool_use', id: `e${n}-${i}`, name: 'Edit', input: { file_path: path } })),
      ];
      const lines = [
        JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5', claude_code_version: '2.1.267', permissionMode: 'bypassPermissions', tools: ['Bash', 'Read', 'Edit'], mcp_servers: [], ...(step.fingerprint ? { skills: [step.fingerprint] } : {}) }),
        JSON.stringify({ type: 'assistant', message: { id: `m${n}`, model: 'claude-sonnet-5', usage, content: toolBlocks } }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          num_turns: 1,
          result: step.finalMessage ?? `session ${n} done`,
          total_cost_usd: step.cost ?? 0.1,
          ...(step.status === 'provider-error' ? { api_error_status: 429 } : {}),
          modelUsage: { 'claude-sonnet-5': { inputTokens: input, cacheReadInputTokens: read, cacheCreationInputTokens: created, outputTokens: step.output ?? 100 } },
        }),
      ];
      for (const line of lines) request.onEventLine?.(line);
      const parsed = parseClaudeStream(lines);
      return {
        status: step.status ?? 'completed',
        exitCode: 0,
        terminalReason: 'completed',
        resultSubtype: 'success',
        apiErrorStatus: step.status === 'provider-error' ? 429 : null,
        numTurns: 1,
        durationMs: 1000,
        apiDurationMs: 900,
        finalMessage: step.finalMessage ?? `session ${n} done`,
        permissionDenials: 0,
        usage: usageFromStream(parsed),
        tools: toolMetricsFromStream(parsed),
        session: {
          agentCliVersion: '2.1.267',
          confirmedModel: 'claude-sonnet-5',
          permissionMode: 'bypassPermissions',
          tools: ['Bash', 'Read', 'Edit'],
          mcpServers: [],
          environment: parsed.init!.environment,
          argv: ['claude', '-p'],
          disallowedTools: ['WebFetch', 'WebSearch'],
          cleanEnvironment: 'isolated',
        },
        assistantMessages: 1,
        stderr: '',
      };
    },
  };
}

/** A verifier that replays scripted outcomes. */
function scriptedVerifier(runs: { passed: boolean; failures?: { file?: string; message: string }[] }[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    seam: async () => ({
      checks: ['npm test'],
      baselineMs: 5,
      verifier: {
        checks: [],
        markInstalled: async () => undefined,
        watchDependencies: async () => async () => null,
        reinstallClean: async () => undefined,
        run: async () => {
          const scripted = runs[Math.min(calls, runs.length - 1)]!;
          calls += 1;
          const failures = (scripted.failures ?? []).map((f) => ({ check: 'npm test', signature: `npm test|${f.message}`, ...f }));
          return {
            passed: scripted.passed,
            checks: [{ label: 'npm test', kind: 'test', status: scripted.passed ? 'passed' : 'failed', durationMs: 2000, failures, preexisting: 0, tail: '', mentionedFiles: [] }],
            failures,
            fingerprint: scripted.passed ? 'pass' : failures.map((f) => f.signature).join(','),
            durationMs: 2000,
            installed: false,
            sideEffectsReverted: [],
          };
        },
      } as never,
    }),
  };
}

const driftPlan = () =>
  ({
    id: 'plan_1',
    branchName: 'drift/acme',
    baseBranch: 'main',
    changes: [{ name: 'acme-sdk', from: '1.0.0', to: '2.0.0', ecosystem: 'npm' }],
    breakingChanges: [
      {
        id: 'bc_1',
        dependency: 'acme-sdk',
        kind: 'renamed-export',
        summary: '`gone` was renamed to `arrived` (DRIFT-ONLY-FACT).',
        remediation: 'Call `arrived`.',
        symbols: ['gone'],
        replacementSymbols: ['arrived'],
        confidence: 'high',
        citations: [],
      },
    ],
    evidence: [],
    impactSites: [{ breakingChangeId: 'bc_1', file: 'src/app.ts', line: 1, excerpt: 'gone()', matchedSymbol: 'gone', confidence: 'high' }],
    commits: [
      {
        id: 'unit_1', order: 1, message: 'fix(acme-sdk): migrate', body: '', breakingChangeIds: ['bc_1'], files: ['src/app.ts'], allowedFiles: ['src/app.ts'],
        instructions: 'Migrate.', dependsOn: [], dependencyReasons: [], executionLayer: 0, expectedChecks: [], invalidationTriggers: [],
      },
    ],
    blockers: [],
  }) as never;

const baseOptions = (workspace: Workspace, provider: AgentProvider) => ({
  agentCase,
  workspace,
  provider,
  model: 'claude-sonnet-5',
  effort: 'high',
  webTools: 'disabled' as const,
  env: {},
  driftVerify: true,
});

describe('three conditions', () => {
  test('raw, generic and Drift orchestration are distinct conditions with stable labels', () => {
    assert.ok(CONDITIONS.includes('generic-orchestrated'));
    assert.ok(CONDITIONS.includes('drift-orchestrated'));
    assert.equal(parseCondition('generic-orchestrated'), 'generic-orchestrated');
    assert.equal(CONDITION_LABELS['drift-orchestrated'], 'drift-orchestrated');
    assert.equal(isOrchestrated('baseline'), false);
    assert.equal(isOrchestrated('generic-orchestrated'), true);
    assert.equal(contextKindFor('generic-orchestrated'), 'none');
    assert.equal(contextKindFor('drift-orchestrated'), 'drift');
  });

  test('the generic task keeps the raw task but hands verification to the orchestrator', () => {
    const raw = renderTask(agentCase);
    const generic = renderGenericOrchestratedTask(agentCase);
    assert.match(raw, /Run the appropriate tests\/build\/typecheck/);
    assert.doesNotMatch(generic, /Run the appropriate tests/);
    assert.match(generic, /An orchestrator runs this repository's build, typecheck, lint and tests/);
    for (const line of raw.split('\n').filter((l) => l && !l.startsWith('Run the appropriate'))) assert.ok(generic.includes(line));
  });

  test('scheduling: three conditions are counterbalanced and a slot does not depend on which process runs it', () => {
    const conditions = ['baseline', 'generic-orchestrated', 'drift-orchestrated'] as const;
    const counts = positionCounts([...conditions], 3, 3);
    for (const condition of conditions) {
      assert.equal(counts[condition]!.reduce((a, b) => a + b, 0), 9);
      assert.ok(counts[condition]!.every((n) => n >= 2 && n <= 4), `${condition}: ${counts[condition]}`);
    }
    assert.deepEqual(blockOrder([...conditions], 1, 2, 3).order, blockOrder([...conditions], 1, 2, 3).order);
  });
});

describe('generic orchestration gets no Drift intelligence', () => {
  test('no analysis runs, and no session prompt carries a finding, a replacement or a unit', async () => {
    const workspace = await workspaceWith({ 'src/app.ts': 'gone();\n' });
    try {
      let analyzed = 0;
      const provider = scriptedProvider(workspace.repo, [
        { gross: [10, 1000, 200], edits: { 'src/app.ts': 'arrived(1);\n' } },
        { gross: [5, 800, 100], edits: { 'src/app.ts': 'arrived();\n' } },
      ]);
      const verify = scriptedVerifier([{ passed: false, failures: [{ file: 'src/app.ts', message: 'src/app.ts:1 TS2554 Expected 0 arguments' }] }, { passed: true }]);
      const result = await runOrchestrated({
        ...baseOptions(workspace, provider),
        condition: 'generic-orchestrated',
        seams: {
          analyze: async () => {
            analyzed += 1;
            return { config: DriftConfigSchema.parse({}), plan: driftPlan(), failure: null };
          },
          verifier: verify.seam,
        },
      });
      assert.equal(analyzed, 0);
      assert.equal(result.orchestration.kind, 'generic');
      assert.equal(result.orchestration.units.total, 0);
      assert.deepEqual(result.sessions.map((s) => s.kind), ['open', 'repair']);
      for (const prompt of result.prompts) {
        assert.doesNotMatch(prompt, /DRIFT-ONLY-FACT|Replacement:|renamed-export|unit_1/);
      }
      assert.equal(result.prompts[0], renderGenericOrchestratedTask(agentCase));
      assert.match(result.prompts[1]!, /What still fails \(repair round 1\)/);
      assert.equal(result.orchestration.controller.termination, 'verified');
      assert.equal(result.driftStatus, 'not-applicable');
    } finally {
      await workspace.teardown();
    }
  });

  test('the neutral plan is the dependency change and nothing else', () => {
    const plan = neutralPlan(agentCase) as unknown as Record<string, unknown[]>;
    assert.equal(plan['breakingChanges']!.length, 0);
    assert.equal(plan['impactSites']!.length, 0);
    assert.equal(plan['evidence']!.length, 0);
    assert.equal(plan['commits']!.length, 0);
  });

  test('a workaround in the open session is rejected like any controller edit', async () => {
    const workspace = await workspaceWith({ 'jest.config.js': 'lines: 80,\n', 'src/app.ts': 'gone();\n' });
    try {
      const provider = scriptedProvider(workspace.repo, [{ gross: [1, 1, 1], edits: { 'jest.config.js': 'lines: 50,\n', 'src/app.ts': 'arrived();\n' } }]);
      const verify = scriptedVerifier([{ passed: true }]);
      const result = await runOrchestrated({ ...baseOptions(workspace, provider), condition: 'generic-orchestrated', seams: { verifier: verify.seam } });
      assert.equal(result.orchestration.sessions[0]!.outcome, 'rejected');
      assert.match(result.orchestration.sessions[0]!.reasons.join(' '), /lowered the lines coverage threshold/);
      assert.equal(git(workspace.repo, 'status', '--porcelain'), '');
    } finally {
      await workspace.teardown();
    }
  });
});

describe('Drift orchestration uses the production controller', () => {
  test('units carry Drift facts; repairs are fresh sessions that do not inherit the conversation', async () => {
    const workspace = await workspaceWith({ 'src/app.ts': 'gone();\n' });
    try {
      const provider = scriptedProvider(workspace.repo, [
        { gross: [10, 2000, 300], edits: { 'src/app.ts': 'arrived(1);\n' }, finalMessage: 'PREVIOUS-CONVERSATION-MARKER', bash: ['npm test'] },
        { gross: [7, 500, 50], edits: { 'src/app.ts': 'arrived();\n' }, bash: ['npx jest src/app.test.ts'] },
      ]);
      const verify = scriptedVerifier([
        { passed: false, failures: [{ file: 'src/app.ts', message: 'src/app.ts:1 TS2305 gone' }] },
        { passed: false, failures: [{ file: 'src/app.ts', message: 'src/app.ts:1 TS2554 Expected 0 arguments' }] },
        { passed: true },
      ]);
      const result = await runOrchestrated({
        ...baseOptions(workspace, provider),
        condition: 'drift-orchestrated',
        seams: { analyze: async () => ({ config: DriftConfigSchema.parse({}), plan: driftPlan(), failure: null }), verifier: verify.seam },
      });
      assert.equal(result.orchestration.kind, 'drift');
      assert.deepEqual(result.sessions.map((s) => [s.kind, s.round]), [['unit', 0], ['repair', 1]]);
      assert.match(result.prompts[0]!, /Replacement: arrived/);
      assert.match(result.prompts[0]!, /In scope: src\/app\.ts/);
      assert.doesNotMatch(result.prompts[1]!, /PREVIOUS-CONVERSATION-MARKER/);
      assert.match(result.prompts[1]!, /TS2554/);
      assert.equal(result.orchestration.controller.termination, 'verified');
      assert.equal(result.orchestration.units.total, 1);
      assert.equal(result.orchestration.units.sentToAgent, 1);
      assert.equal(result.orchestration.units.requiringRepair, 1);
      assert.equal(verify.calls, 3);
      assert.equal(result.driftStatus, 'completed');

      // Every session's tokens are in the total; controller verification contributes none.
      assert.equal(result.agent.usage.grossInputTokens, 10 + 2000 + 300 + 7 + 500 + 50);
      assert.equal(result.agent.usage.uncachedInputTokens, 10 + 300 + 7 + 50);
      assert.equal(result.agent.usage.modelCalls, 2);
      assert.ok(Math.abs((result.agent.usage.costUsd ?? 0) - 0.2) < 1e-9);
      assert.equal(result.orchestration.sessions[1]!.usage.grossInputTokens, 557);
      assert.equal(result.orchestration.timing.controllerVerificationMs, 6000);
      assert.equal(result.orchestration.timing.agentMs, 2000);
      assert.ok(result.orchestration.timing.endToEndMs >= 0);

      // Verification the agent ran itself is detected per session.
      assert.equal(result.orchestration.sessions[0]!.agentVerification.broad, 1);
      assert.equal(result.orchestration.sessions[1]!.agentVerification.narrow, 1);
      assert.equal(result.orchestration.sessions[0]!.allowedFiles!.length, 1);
    } finally {
      await workspace.teardown();
    }
  });

  test('a unit resolved deterministically never starts a session', async () => {
    const workspace = await workspaceWith({ 'src/app.ts': 'gone();\n' });
    try {
      const plan = driftPlan() as { commits: Record<string, unknown>[] };
      plan.commits[0]!['codemod'] = [{ ruleId: 'rename-identifier', from: 'gone', to: 'arrived', files: ['src/app.ts'], anchors: [{ file: 'src/app.ts', line: 'gone();', lineNumber: 1 }] }];
      const provider = scriptedProvider(workspace.repo, []);
      const verify = scriptedVerifier([{ passed: true }]);
      const result = await runOrchestrated({
        ...baseOptions(workspace, provider),
        condition: 'drift-orchestrated',
        seams: { analyze: async () => ({ config: DriftConfigSchema.parse({}), plan: plan as never, failure: null }), verifier: verify.seam },
      });
      assert.equal(provider.requests.length, 0);
      assert.equal(result.orchestration.units.resolvedByCodemod, 1);
      assert.equal(result.agent.usage.grossInputTokens, 0);
      assert.equal(result.orchestration.controller.termination, 'verified');
    } finally {
      await workspace.teardown();
    }
  });

  test('a provider error in any session excludes the trial as infrastructure and stops the loop', async () => {
    const workspace = await workspaceWith({ 'src/app.ts': 'gone();\n' });
    try {
      const provider = scriptedProvider(workspace.repo, [{ gross: [1, 1, 1], status: 'provider-error' }]);
      const verify = scriptedVerifier([{ passed: false, failures: [{ file: 'src/app.ts', message: 'x' }] }]);
      const result = await runOrchestrated({
        ...baseOptions(workspace, provider),
        condition: 'drift-orchestrated',
        seams: { analyze: async () => ({ config: DriftConfigSchema.parse({}), plan: driftPlan(), failure: null }), verifier: verify.seam },
      });
      assert.equal(result.infrastructure?.failure, 'provider_error');
      assert.equal(result.agent.status, 'provider-error');
      assert.equal(provider.requests.length, 1);
    } finally {
      await workspace.teardown();
    }
  });
});

describe('usage and environment aggregation', () => {
  const session = (gross: [number, number, number], fingerprint = 'fp', status: AgentRunResult['status'] = 'completed'): CapturedSession => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { id: `m${gross.join('-')}`, model: 'claude-sonnet-5', usage: { input_tokens: gross[0], cache_read_input_tokens: gross[1], cache_creation_input_tokens: gross[2], output_tokens: 3 }, content: [] } }),
    ];
    const parsed = parseClaudeStream(lines);
    return {
      index: 1, kind: 'repair', unitId: null, round: 1, prompt: 'p', lines, parsed,
      result: {
        status, exitCode: 0, terminalReason: null, resultSubtype: null, apiErrorStatus: null, numTurns: 2, durationMs: 100, apiDurationMs: 90, finalMessage: '', permissionDenials: 0,
        usage: usageFromStream(parsed), tools: toolMetricsFromStream(parsed),
        session: { agentCliVersion: 'x', confirmedModel: 'm', permissionMode: 'p', tools: [], mcpServers: [], environment: { tools: [], mcpServers: [], skills: [], slashCommands: [], agents: [], plugins: [], memoryPaths: [], outputStyle: null, apiKeySource: null, fingerprint }, argv: [], disallowedTools: [], cleanEnvironment: 'isolated' },
        assistantMessages: 1, stderr: '',
      },
    };
  };

  test('sums every session exactly', () => {
    const total = sumUsage([session([1, 2, 3]).result.usage, session([10, 20, 30]).result.usage, session([100, 200, 300]).result.usage]);
    assert.equal(total.grossInputTokens, 666);
    assert.equal(total.uncachedInputTokens, 444);
    assert.equal(total.outputTokens, 9);
    assert.equal(total.modelCalls, 3);
  });

  test('sessions that loaded different environments are visible as a mismatch', () => {
    const aggregate = aggregateAgentResult([session([1, 1, 1], 'a'), session([2, 2, 2], 'b')], { budgetExhausted: false, record: null, infrastructure: null });
    assert.match(aggregate.session.environment!.fingerprint, /^mixed:/);
    assert.equal(aggregate.numTurns, 4);
    assert.equal(aggregate.durationMs, 200);
  });

  test('an exhausted agent budget is a timeout, a valid failure', () => {
    const aggregate = aggregateAgentResult([session([1, 1, 1])], { budgetExhausted: true, record: null, infrastructure: null });
    assert.equal(aggregate.status, 'timeout');
  });
});

describe('agent verification commands', () => {
  test('whole-project checks are broad, targeted ones narrow, everything else neither', () => {
    for (const cmd of ['npm test', 'yarn build', 'corepack yarn jest', 'npx tsc --noEmit', 'npm run lint', 'npx eslint src', 'cd repo && npm run type-check', 'npx jest --config jest.config.js']) {
      assert.equal(classifyVerificationCommand(cmd), 'broad', cmd);
    }
    for (const cmd of ['npx jest src/ledger.test.ts', 'npm test -- src/a.test.ts', 'node eslint-rules/no-unsafe-execa.test.js', 'npx eslint src/cli.ts', 'npx jest -t "signs"']) {
      assert.equal(classifyVerificationCommand(cmd), 'narrow', cmd);
    }
    for (const cmd of ['npm install', 'npm view eslint versions', 'cat package.json', 'git diff', 'ls node_modules']) {
      assert.equal(classifyVerificationCommand(cmd), null, cmd);
    }
  });
});

describe('verification guard', () => {
  test('every orchestrated session carries the product guard; the raw provider call does not', async () => {
    const workspace = await workspaceWith({ 'src/app.ts': 'gone();\n' });
    try {
      const provider = scriptedProvider(workspace.repo, [{ gross: [1, 1, 1], edits: { 'src/app.ts': 'arrived();\n' } }]);
      const verify = scriptedVerifier([{ passed: true }]);
      const result = await runOrchestrated({ ...baseOptions(workspace, provider), condition: 'generic-orchestrated', seams: { verifier: verify.seam } });
      const hooks = (provider.requests[0]!.settings as { hooks: { PreToolUse: { matcher: string }[] } }).hooks;
      assert.equal(hooks.PreToolUse[0]!.matcher, 'Bash');
      assert.equal(result.orchestration.sessions[0]!.verificationGuard, true);
    } finally {
      await workspace.teardown();
    }
  });

  test('--settings reaches argv only when a settings document is given', async () => {
    const { buildClaudeArgs } = await import('./providers/claude-code.ts');
    const base = { model: 'claude-sonnet-5', effort: 'high', webTools: 'disabled' as const, maxBudgetUsd: null, maxTurns: null, mcpServers: {} };
    assert.equal(buildClaudeArgs(base, { cleanEnvironment: 'isolated' }).argv.includes('--settings'), false);
    const argv = buildClaudeArgs({ ...base, settings: { hooks: {} } }, { cleanEnvironment: 'isolated' }).argv;
    assert.deepEqual(JSON.parse(argv[argv.indexOf('--settings') + 1]!), { hooks: {} });
  });

  test('a refused broad command is counted from the event stream', async () => {
    const { agentVerificationCommands } = await import('./verification-commands.ts');
    const parsed = parseClaudeStream([
      JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'x', usage: {}, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npx jest src/a.test.ts' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: "PreToolUse:Bash hook error: Drift runs this repository's full build, typecheck, lint and tests itself" }, { type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } }),
    ]);
    assert.deepEqual(agentVerificationCommands(parsed), { broad: 1, narrow: 1, blocked: 1, broadCommands: ['npm test'] });
  });
});

describe('three-way comparison', () => {
  const orchestration = (sessions: number, repairGross: number) => ({
    kind: 'drift' as const,
    sessions: Array.from({ length: sessions }, (_, i) => ({
      index: i + 1, kind: i === 0 ? ('unit' as const) : ('repair' as const), unitId: 'u', round: i, allowedFiles: ['a'], changedFiles: ['a'], outcome: 'accepted', reasons: [], scopeRequests: [],
      agentStatus: 'completed', promptChars: 10, promptHash: 'h', durationMs: 10,
      usage: makeTrial({ caseId: 'x', condition: 'baseline', repetition: 1, gross: i === 0 ? 0 : repairGross, success: true }).usage,
      toolCalls: 1, tokensBeforeFirstEdit: null, tokensAfterFirstEdit: null, agentVerification: { broad: 0, narrow: 0, broadCommands: [] },
      research: { dependencySourceAccesses: 0, registryQueries: 0, changelogAccesses: 0 }, environmentFingerprint: 'fp',
    })),
    controller: { termination: 'verified', terminationDetail: '', repairRounds: sessions - 1, outOfScopeRejections: 0, workaroundRejections: 0, grantedFiles: [], deniedScopeRequests: [], needsHuman: [], verifications: [] },
    checks: ['npm test'],
    units: { total: 1, resolvedByCodemod: 0, resolvedByFixPlan: 0, sentToAgent: 1, skippedProtected: 0, merged: 0, requiringRepair: sessions > 1 ? 1 : 0 },
    analysis: null,
    timing: { analysisMs: 1, deterministicMs: 0, baselineMeasurementMs: 2, agentMs: 10, controllerVerificationMs: 3, endToEndMs: 20 },
    agentBudgetMs: 1_800_000,
    budgetExhausted: false,
  });

  const trial = (caseId: string, condition: 'baseline' | 'generic-orchestrated' | 'drift-orchestrated', repetition: number, gross: number, success: boolean) => {
    const t = makeTrial({ caseId, condition, repetition, gross, success });
    return condition === 'baseline' ? t : trialSchema.parse({ ...t, orchestration: orchestration(2, 100) });
  };

  const manifest = { runId: 'run-1', driftCommit: 'd'.repeat(40), requestedModel: 'claude-sonnet-5', requestedEffort: 'high', agentCliVersion: 'x', runsPerCondition: 3, conditions: ['baseline', 'generic-orchestrated', 'drift-orchestrated'] } as unknown as RunManifest;

  test('case-level medians, accuracy counts, every failure, and the gate', () => {
    const trials: TrialArtifact[] = [];
    // Case A: raw 1000/1100/1200 → median 1100; generic 800s; drift 500s.
    for (const [rep, g] of [[1, 1000], [2, 1100], [3, 1200]] as const) trials.push(trial('case-a', 'baseline', rep, g, true));
    for (const [rep, g] of [[1, 800], [2, 880], [3, 960]] as const) trials.push(trial('case-a', 'generic-orchestrated', rep, g, true));
    for (const [rep, g] of [[1, 500], [2, 550], [3, 600]] as const) trials.push(trial('case-a', 'drift-orchestrated', rep, g, rep !== 3));
    // Case B: raw 2000 median; drift 1000.
    for (const rep of [1, 2, 3]) trials.push(trial('case-b', 'baseline', rep, 2000, true));
    for (const rep of [1, 2, 3]) trials.push(trial('case-b', 'generic-orchestrated', rep, 1800, true));
    for (const rep of [1, 2, 3]) trials.push(trial('case-b', 'drift-orchestrated', rep, 1000, true));

    const comparison = threeWayFromTrials(trials, [manifest], { name: 'fixture', now: new Date(0) });
    assert.deepEqual(comparison.accuracyTotals['baseline'], { successes: 6, valid: 6 });
    assert.deepEqual(comparison.accuracyTotals['drift-orchestrated'], { successes: 5, valid: 6 });
    const drift = comparison.pairwise.find((p) => p.label === 'Drift vs Raw')!;
    // Case A: 550/1100 - 1 = -50%; case B: 1000/2000 - 1 = -50%.
    assert.ok(Math.abs(drift.medianCaseGrossChangePct! + 50) < 1e-9);
    const generic = comparison.pairwise.find((p) => p.label === 'Generic vs Raw')!;
    assert.ok(Math.abs(generic.caseGrossChangesPct.find((c) => c.caseId === 'case-a')!.changePct! + 20) < 1e-9);
    assert.ok(Math.abs(generic.caseGrossChangesPct.find((c) => c.caseId === 'case-b')!.changePct! + 10) < 1e-9);
    const vsGeneric = comparison.pairwise.find((p) => p.label === 'Drift vs Generic')!;
    assert.equal(vsGeneric.caseGrossChangesPct.find((c) => c.caseId === 'case-b')!.changePct!.toFixed(4), (-(1 - 1000 / 1800) * 100).toFixed(4));
    assert.equal(comparison.failures.length, 1);
    assert.equal(comparison.failures[0]!.condition, 'Drift orch.');
    assert.equal(comparison.gate.driftAccuracyNotBelowRaw, false, 'one fewer success is a regression, whatever the tokens');
    assert.equal(comparison.gate.driftAccuracyNotBelowRawInAnyCase, false);
    assert.equal(comparison.gate.meetsThirtyPercentTarget, true);
    const text = renderThreeWay(comparison);
    assert.match(text, /\| \*\*Total\*\* \| \*\*6\/6\*\* \| \*\*6\/6\*\* \| \*\*5\/6\*\* \|/);
    assert.match(text, /Drift accuracy not below raw overall: \*\*NO\*\*/);
  });

  test('orchestrated trial metrics count sessions, repair tokens and controller time', () => {
    const m = trialMetrics(trial('c', 'drift-orchestrated', 1, 900, true));
    assert.equal(m.agentSessions, 2);
    assert.equal(m.repairSessions, 1);
    assert.equal(m.grossInRepairSessions, 100);
    assert.equal(m.controllerWallMs, 5);
    assert.equal(m.endToEndMs, 20);
    const raw = trialMetrics(trial('c', 'baseline', 1, 900, true));
    assert.equal(raw.agentSessions, 1);
    assert.equal(raw.controllerChecks, 0);
  });

  test('runs from different Drift builds are refused for pooling', () => {
    const a = { manifest: { ...manifest, runId: 'a', suite: 's', provider: 'p', cleanEnvironment: 'isolated' } as RunManifest, trials: [trial('case-a', 'baseline', 1, 1, true)], aborted: false };
    const b = { manifest: { ...manifest, runId: 'b', suite: 's', provider: 'p', cleanEnvironment: 'isolated', driftCommit: 'e'.repeat(40) } as RunManifest, trials: [trial('case-b', 'baseline', 1, 1, true)], aborted: false };
    assert.ok(compatibilityProblems([a, b]).some((problem) => /Drift commit differs/.test(problem)));
  });
});

describe('retries', () => {
  test('a valid failed trial is never set aside for a retry; an infrastructure exclusion is', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-retry-'));
    try {
      const failed = makeTrial({ caseId: 'c', condition: 'drift-orchestrated', repetition: 1, gross: 5, success: false, runId: 'r' });
      await writeTrial(failed, { diff: '', streamLines: [] }, root);
      assert.equal((await setAsideInfrastructureFailure('r', 'c', 'drift-orchestrated', 1, root)).setAside, false);
      const excluded = makeTrial({ caseId: 'c', condition: 'generic-orchestrated', repetition: 1, gross: 5, success: false, valid: false, infrastructureFailure: 'provider_error', runId: 'r' });
      await writeTrial(excluded, { diff: '', streamLines: [] }, root);
      assert.equal((await setAsideInfrastructureFailure('r', 'c', 'generic-orchestrated', 1, root)).setAside, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
