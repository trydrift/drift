import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runRemediationController, planRepairs, prepareAgentUnits, renderFailures } from '../dist/remediation/controller.js';
import { applyDeterministicCommits } from '../dist/remediation/worktree-runner.js';
import { createProjectVerifier, detectRemediationChecks, extractFailures, resultFor } from '../dist/remediation/verifier.js';
import { composeAgentPrompt, parseScopeRequests } from '../dist/agents/types.js';
import { upgradedDependencyFindings, workaroundFindings } from '../dist/agents/scope.js';
import { DriftConfigSchema } from '../dist/config/schema.js';

const config = DriftConfigSchema.parse({});
const silent = { debug() {}, info() {}, warn() {}, error() {}, group: async (_: string, fn: () => Promise<unknown>) => fn() };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

async function repoWith(files: Record<string, string>): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'drift-controller-'));
  git(root, 'init', '--quiet', '--initial-branch=main');
  // The product commits with plain `git commit`; a CI runner has no global identity.
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'start');
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function unit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'unit_1',
    order: 1,
    message: 'fix(acme-sdk): migrate',
    body: '',
    breakingChangeIds: ['bc_1'],
    files: ['src/app.ts'],
    allowedFiles: ['src/app.ts'],
    instructions: 'Migrate.',
    dependsOn: [],
    dependencyReasons: [],
    executionLayer: 0,
    expectedChecks: [],
    invalidationTriggers: [],
    ...overrides,
  };
}

function plan(commits: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: 'plan_1',
    branchName: 'drift/acme',
    baseBranch: 'main',
    changes: [{ name: 'acme-sdk', from: '1.0.0', to: '2.0.0', ecosystem: 'npm' }],
    breakingChanges: [
      {
        id: 'bc_1',
        dependency: 'acme-sdk',
        kind: 'renamed-export',
        summary: '`gone` was renamed to `arrived`.',
        remediation: 'Call `arrived` instead of `gone`.',
        symbols: ['gone'],
        replacementSymbols: ['arrived'],
        before: 'export function gone(): void',
        after: 'export function arrived(): void',
        confidence: 'high',
        citations: [],
      },
      {
        id: 'bc_other',
        dependency: 'acme-sdk',
        kind: 'removed-export',
        summary: '`unrelated` was removed.',
        remediation: 'Stop using `unrelated`.',
        symbols: ['unrelated'],
        confidence: 'high',
        citations: [],
      },
    ],
    evidence: [],
    impactSites: [],
    commits,
    blockers: [],
    ...extra,
  } as never;
}

/** A fake agent: each call runs the next scripted edit and records the task it was given. */
function scriptedAgent(root: string, script: Array<(task: any) => Promise<Partial<{ status: string; message: string; scopeRequests: unknown[] }> | void>>) {
  const tasks: any[] = [];
  return {
    tasks,
    agent: {
      id: 'fake',
      label: 'Fake',
      description: '',
      kind: 'cli',
      capabilities: { execution: 'workspace', canAwaitCompletion: false, canInspectResult: true },
      detect: async () => ({ available: true }),
      run: async (task: any) => {
        tasks.push(task);
        const step = script[tasks.length - 1];
        const result = step ? await step(task) : undefined;
        return { status: 'applied', message: 'done', ...(result ?? {}) };
      },
    } as never,
    write: (path: string, content: string) => writeFile(join(root, path), content),
  };
}

/** A verifier that replays scripted runs, counting calls. */
function scriptedVerifier(
  runs: Array<{ passed: boolean; failures?: Array<{ file?: string; message: string; signature?: string }>; tail?: string }>,
  touched: (string | null)[] = [],
) {
  let calls = 0;
  let reinstalls = 0;
  return {
    get calls() {
      return calls;
    },
    get reinstalls() {
      return reinstalls;
    },
    verifier: {
      checks: [],
      markInstalled: async () => undefined,
      watchDependencies: async () => async () => touched.shift() ?? null,
      reinstallClean: async () => {
        reinstalls += 1;
        return undefined;
      },
      run: async () => {
        const scripted = runs[Math.min(calls, runs.length - 1)]!;
        calls += 1;
        const failures = (scripted.failures ?? []).map((failure) => ({ check: 'npm test', signature: failure.signature ?? `npm test|${failure.message}`, ...failure }));
        return {
          passed: scripted.passed,
          checks: [{ label: 'npm test', kind: 'test', status: scripted.passed ? 'passed' : 'failed', durationMs: 5, failures, preexisting: 0, tail: scripted.tail ?? '', mentionedFiles: [] }],
          failures,
          fingerprint: scripted.passed ? 'pass' : failures.map((failure) => failure.signature).sort().join(','),
          durationMs: 5,
          installed: false,
          sideEffectsReverted: [],
        };
      },
    } as never,
  };
}

describe('deterministic work never reaches an agent', () => {
  test('a codemod-resolved unit is committed and leaves nothing for the controller', async () => {
    const { root, cleanup } = await repoWith({ 'src/app.ts': 'gone();\n' });
    try {
      const commit = unit({
        codemod: [{ ruleId: 'rename-identifier', from: 'gone', to: 'arrived', files: ['src/app.ts'], anchors: [{ file: 'src/app.ts', line: 'gone();', lineNumber: 1 }] }],
      });
      const deterministic = await applyDeterministicCommits({ worktree: root, plan: plan([commit]), config, logger: silent, nonInteractive: true });
      assert.equal(deterministic.builtinResolved, 1);
      assert.deepEqual(deterministic.needsAgent, []);
      assert.equal(await readFile(join(root, 'src/app.ts'), 'utf8'), 'arrived();\n');

      const fake = scriptedAgent(root, []);
      const verify = scriptedVerifier([{ passed: true }]);
      const record = await runRemediationController({ root, plan: plan([commit]), config, agent: fake.agent, verifier: verify.verifier, logger: silent, commits: deterministic.needsAgent });
      assert.equal(fake.tasks.length, 0);
      assert.equal(record.agentSessions, 0);
      assert.equal(record.termination, 'verified');
    } finally {
      await cleanup();
    }
  });

  test('a fully covering fix plan is applied without an agent', async () => {
    const { root, cleanup } = await repoWith({ 'src/app.ts': 'gone();\n' });
    try {
      const commit = unit({
        fixPlan: {
          plan: {
            schemaVersion: 2, id: 'fp_1', breakingChangeId: 'bc_1', dependency: 'acme-sdk', fromVersion: '1.0.0', toVersion: '2.0.0',
            changeKind: 'renamed-export', migration: '`gone` became `arrived`.', rationale: '', ops: [{ kind: 'rename-identifier', from: 'gone', to: 'arrived' }],
            citations: [], provenance: { author: 'model', authoredAt: '2026-01-01T00:00:00Z' },
          },
          assurance: 'proven', files: ['src/app.ts'],
          anchors: [{ file: 'src/app.ts', line: 'gone();', lineNumber: 1, column: 0, matchedText: 'gone(' }],
          covered: 1, residual: 0, residualSites: [],
        },
      });
      // The defaults propose every fix plan to a human; auto mode with `autoApply: proven` applies one.
      const auto = DriftConfigSchema.parse({ mode: 'auto', remediation: { fixPlans: { autoApply: 'proven' } } });
      const deterministic = await applyDeterministicCommits({ worktree: root, plan: plan([commit], { verification: { status: 'passed' } }), config: auto, logger: silent, nonInteractive: true });
      assert.equal(deterministic.fixPlanResolved, 1);
      assert.deepEqual(deterministic.needsAgent, []);
      assert.equal(await readFile(join(root, 'src/app.ts'), 'utf8'), 'arrived();\n');
    } finally {
      await cleanup();
    }
  });

  test('residual work goes to exactly one agent session per unit', async () => {
    const { root, cleanup } = await repoWith({ 'src/app.ts': 'gone();\n', 'src/b.ts': 'gone();\n' });
    try {
      const fake = scriptedAgent(root, [
        async () => fake.write('src/app.ts', 'arrived();\n'),
        async () => fake.write('src/b.ts', 'arrived();\n'),
      ]);
      const verify = scriptedVerifier([{ passed: false, failures: [{ file: 'src/app.ts', message: 'src/app.ts:1 TS2305 gone' }] }, { passed: true }]);
      const commits = [unit(), unit({ id: 'unit_2', files: ['src/b.ts'], allowedFiles: ['src/b.ts'] })];
      const record = await runRemediationController({ root, plan: plan(commits), config, agent: fake.agent, verifier: verify.verifier, logger: silent });
      assert.equal(fake.tasks.length, 2);
      assert.deepEqual(fake.tasks.map((task) => task.commit.id), ['unit_1', 'unit_2']);
      assert.deepEqual(fake.tasks[0].commit.allowedFiles, ['src/app.ts']);
      assert.match(fake.tasks[0].diagnostics, /TS2305/);
      assert.equal(fake.tasks[1].diagnostics, undefined, 'a failure on another unit\'s file is not this unit\'s diagnostic');
      assert.equal(record.termination, 'verified');
      assert.equal(record.sessions.filter((session) => session.status === 'accepted').length, 2);
    } finally {
      await cleanup();
    }
  });
});

describe('commits', () => {
  test('a repository commit hook cannot refuse an accepted edit', async () => {
    const { root, cleanup } = await repoWith({ 'src/app.ts': 'gone();\n' });
    try {
      await writeFile(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho lint failed >&2\nexit 1\n', { mode: 0o755 });
      const fake = scriptedAgent(root, [async () => fake.write('src/app.ts', 'arrived();\n')]);
      const record = await runRemediationController({ root, plan: plan([unit()]), config, agent: fake.agent, verifier: null, logger: silent });
      assert.equal(record.sessions[0]!.status, 'accepted');
    } finally {
      await cleanup();
    }
  });
});

describe('unit scoping', () => {
  test('an edit outside the unit is rejected and reset, and counted', async () => {
    const { root, cleanup } = await repoWith({ 'src/app.ts': 'gone();\n', 'src/other.ts': 'x\n' });
    try {
      const fake = scriptedAgent(root, [async () => {
        await fake.write('src/app.ts', 'arrived();\n');
        await fake.write('src/other.ts', 'y\n');
      }]);
      const record = await runRemediationController({ root, plan: plan([unit()]), config, agent: fake.agent, verifier: null, logger: silent });
      assert.equal(record.sessions[0]!.status, 'rejected');
      assert.equal(record.outOfScopeRejections, 1);
      assert.equal(await readFile(join(root, 'src/app.ts'), 'utf8'), 'gone();\n', 'the whole attempt is reset');
      assert.equal(record.termination, 'unverified');
    } finally {
      await cleanup();
    }
  });

  test('a unit whose every file is protected is never dispatched', () => {
    const record = { units: [] as any[], needsHuman: [] as any[] };
    const units = prepareAgentUnits([unit({ id: 'ci', files: ['.github/workflows/build.yml'], allowedFiles: ['.github/workflows/build.yml'] })] as never, record);
    assert.equal(units.length, 0);
    assert.equal(record.units[0].resolution, 'skipped-protected');
    assert.equal(record.needsHuman.length, 1);
  });

  test('units over the same files are one session', () => {
    const record = { units: [] as any[], needsHuman: [] as any[] };
    const units = prepareAgentUnits([unit({ id: 'a', breakingChangeIds: ['bc_1'] }), unit({ id: 'b', breakingChangeIds: ['bc_2'] })] as never, record);
    assert.equal(units.length, 1);
    assert.deepEqual(units[0]!.commit.breakingChangeIds, ['bc_1', 'bc_2']);
    assert.equal(record.units[1].resolution, 'merged');
  });

  test('changing the upgraded dependency is rejected even inside scope', async () => {
    const { root, cleanup } = await repoWith({ 'package.json': '{\n  "dependencies": {\n    "acme-sdk": "^2.0.0"\n  }\n}\n' });
    try {
      const fake = scriptedAgent(root, [async () => fake.write('package.json', '{\n  "dependencies": {\n    "acme-sdk": "^1.0.0"\n  }\n}\n')]);
      const record = await runRemediationController({ root, plan: plan([unit({ files: ['package.json'], allowedFiles: ['package.json'] })]), config, agent: fake.agent, verifier: null, logger: silent });
      assert.equal(record.sessions[0]!.status, 'rejected');
      assert.match(record.sessions[0]!.reasons.join('\n'), /upgraded dependency acme-sdk/);
      assert.equal(record.workaroundRejections, 1);
    } finally {
      await cleanup();
    }
  });

  test('a companion dependency may move when the manifest is in scope', () => {
    const patch = [
      'diff --git a/package.json b/package.json',
      '-    "typescript-eslint": "^6.0.0",',
      '+    "typescript-eslint": "^8.0.0",',
      '     "eslint": "^10.0.0",',
    ].join('\n');
    assert.deepEqual(upgradedDependencyFindings(patch, ['eslint']), []);
    assert.equal(upgradedDependencyFindings(patch, ['typescript-eslint']).length, 1);
  });
});

describe('verification guard', () => {
  test('refuses whole-project checks and allows targeted ones', async () => {
    const { guardDecision, verificationGuardSettings } = await import('../dist/agents/verification-guard.js');
    const call = (command: string) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
    for (const command of ['npm test', 'npx tsc --noEmit -p tsconfig.json 2>&1 | head -80', 'corepack yarn build', 'npx eslint src']) {
      assert.equal(guardDecision(call(command)).block, true, command);
    }
    for (const command of ['npx jest src/ledger-keyring.test.ts', 'node eslint-rules/no-unsafe-execa.test.js', 'cat package.json', 'npm install typescript-eslint@8']) {
      assert.equal(guardDecision(call(command)).block, false, command);
    }
    assert.equal(guardDecision(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'x' } })).block, false);
    const settings = verificationGuardSettings('/usr/bin/node') as { hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } };
    assert.equal(settings.hooks.PreToolUse[0]!.matcher, 'Bash');
    assert.match(settings.hooks.PreToolUse[0]!.hooks[0]!.command, /verification-guard-hook\.js/);
  });

  test('the hook script exits 2 with the reason on stderr for a broad command', async () => {
    const { spawnSync } = await import('node:child_process');
    const script = new URL('../dist/agents/verification-guard-hook.js', import.meta.url).pathname;
    const broad = spawnSync(process.execPath, [script], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' } }), encoding: 'utf8' });
    assert.equal(broad.status, 2);
    assert.match(broad.stderr, /Drift runs this repository's full build/);
    const narrow = spawnSync(process.execPath, [script], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npx jest src/a.test.ts' } }), encoding: 'utf8' });
    assert.equal(narrow.status, 0);
  });

  test('controller sessions are marked as controller-verified', async () => {
    const { root, cleanup } = await repoWith({ 'src/app.ts': 'gone();\n' });
    try {
      const fake = scriptedAgent(root, [async () => fake.write('src/app.ts', 'arrived();\n')]);
      await runRemediationController({ root, plan: plan([unit()]), config, agent: fake.agent, verifier: scriptedVerifier([{ passed: true }]).verifier, logger: silent });
      assert.equal(fake.tasks[0].verificationOwner, 'controller');
      const unverified = scriptedAgent(root, [async () => undefined]);
      await runRemediationController({ root, plan: plan([unit()]), config, agent: unverified.agent, verifier: null, logger: silent });
      assert.equal(unverified.tasks[0].verificationOwner, undefined);
    } finally {
      await cleanup();
    }
  });
});

describe('installed dependencies', () => {
  test('an agent that patches node_modules without a manifest change is rejected, and the tree is reinstalled', async () => {
    const { root, cleanup } = await repoWith({ 'src/app.ts': 'gone();\n' });
    try {
      const fake = scriptedAgent(root, [async () => fake.write('src/app.ts', 'arrived();\n')]);
      const verify = scriptedVerifier([{ passed: true }], ['node_modules/logform/index.d.ts']);
      const record = await runRemediationController({ root, plan: plan([unit()]), config, agent: fake.agent, verifier: verify.verifier, logger: silent });
      assert.equal(record.sessions[0]!.status, 'rejected');
      assert.match(record.sessions[0]!.reasons.join('\n'), /installed dependency files \(node_modules\/logform\/index\.d\.ts\)/);
      assert.equal(verify.reinstalls, 1);
      assert.equal(await readFile(join(root, 'src/app.ts'), 'utf8'), 'gone();\n');
    } finally {
      await cleanup();
    }
  });

  test('a dependency write that comes with a manifest change is kept, and still reinstalled clean', async () => {
    const { root, cleanup } = await repoWith({ 'package.json': '{"devDependencies":{"typescript-eslint":"^6.0.0"}}\n' });
    try {
      const fake = scriptedAgent(root, [async () => fake.write('package.json', '{"devDependencies":{"typescript-eslint":"^8.0.0"}}\n')]);
      const verify = scriptedVerifier([{ passed: true }], ['node_modules/typescript-eslint/package.json']);
      const record = await runRemediationController({ root, plan: plan([unit({ files: ['package.json'], allowedFiles: ['package.json'] })]), config, agent: fake.agent, verifier: verify.verifier, logger: silent });
      assert.equal(record.sessions[0]!.status, 'accepted');
      assert.equal(verify.reinstalls, 1);
    } finally {
      await cleanup();
    }
  });

  test('protected paths guard every depth, not only the first level', async () => {
    const { isProtectedPath } = await import('../dist/agents/scope.js');
    assert.equal(isProtectedPath('node_modules/logform/index.d.ts'), true);
    assert.equal(isProtectedPath('.github/workflows/nested/ci.yml'), true);
    assert.equal(isProtectedPath('packages/a/secrets/key.pem'), true);
    assert.equal(isProtectedPath('src/node_modules_helper.ts'), false);
  });
});

describe('workaround detection', () => {
  test('a lowered coverage threshold is rejected', () => {
    const patch = ['diff --git a/jest.config.js b/jest.config.js', '-      lines: 81.93,', '+      lines: 73,'].join('\n');
    assert.match(workaroundFindings(patch, []).join('\n'), /lowered the lines coverage threshold/);
  });

  test('a raised coverage threshold is fine', () => {
    const patch = ['diff --git a/jest.config.js b/jest.config.js', '-      lines: 70,', '+      lines: 80,'].join('\n');
    assert.deepEqual(workaroundFindings(patch, []), []);
  });

  test('relaxed compiler strictness and a deleted test file are rejected', () => {
    const patch = ['diff --git a/tsconfig.json b/tsconfig.json', '-    "strict": true,', '+    "strict": false,'].join('\n');
    const errors = workaroundFindings(patch, [{ path: 'src/a.test.ts', status: 'deleted' }]);
    assert.match(errors.join('\n'), /relaxed `strict`/);
    assert.match(errors.join('\n'), /deleted test file src\/a.test.ts/);
  });

  test('adding skipLibCheck is not a strictness workaround', () => {
    const patch = ['diff --git a/tsconfig.json b/tsconfig.json', '+    "skipLibCheck": true,'].join('\n');
    assert.deepEqual(workaroundFindings(patch, []), []);
  });
});

describe('accuracy fixes from the development run', () => {
  test('eslint stylish output with warnings before errors still yields the errors', () => {
    const output = [
      '/repo/src/cli.ts',
      '   13:24  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any',
      '   91:21  error    \'x\' is defined but never used            @typescript-eslint/no-unused-vars',
      '',
    ].join('\n');
    const failures = extractFailures('npm run lint', output, '/repo');
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.line, 91);
  });

  test('a rewritten assertion is not weakening; a removed one is', async () => {
    const { testWeakeningFindings } = await import('../dist/agents/scope.js');
    const changed = [{ path: 'src/a.test.ts', status: 'modified' }];
    const rewritten = ['diff --git a/src/a.test.ts b/src/a.test.ts', "-    expect(tx.getMessageToSign(false)).toBe(x);", "+    expect(tx.getMessageToSign()).toBe(x);"].join('\n');
    assert.deepEqual(testWeakeningFindings(rewritten, changed as never).errors, []);
    const removed = ['diff --git a/src/a.test.ts b/src/a.test.ts', "-    expect(a).toBe(1);", "-    expect(b).toBe(2);", "+    expect(a).toBe(1);"].join('\n');
    assert.match(testWeakeningFindings(removed, changed as never).errors.join(' '), /removed an assertion/);
  });

  test('a rejected session earns one more round, told why', async () => {
    const { root, cleanup } = await repoWith({ 'src/app.ts': 'a\n', 'src/app.test.ts': 'expect(a).toBe(1);\nexpect(b).toBe(2);\n' });
    try {
      const fake = scriptedAgent(root, [
        async () => fake.write('src/app.test.ts', 'expect(a).toBe(1);\n'),
        async (task) => {
          assert.match(task.repair.previousRejection, /removed an assertion/);
          await fake.write('src/app.ts', 'b\n');
        },
      ]);
      const failing = { passed: false, failures: [{ message: 'boom' }] };
      const verify = scriptedVerifier([failing, failing, { passed: true }]);
      const record = await runRemediationController({ root, plan: plan([]), config, agent: fake.agent, verifier: verify.verifier, logger: silent });
      assert.equal(record.sessions[0]!.status, 'rejected');
      assert.equal(record.termination, 'verified');
    } finally {
      await cleanup();
    }
  });
});

describe('the agent prompt', () => {
  const task = (overrides: Record<string, unknown> = {}) => ({
    plan: plan([unit()]),
    commit: unit(),
    workspaceRoot: '/tmp/x',
    files: [{ path: 'src/app.ts', content: 'gone();\n' }],
    ...overrides,
  });

  test('carries the replacement and both signatures, and nothing about unrelated findings', () => {
    const prompt = composeAgentPrompt(task() as never);
    assert.match(prompt, /Replacement: arrived/);
    assert.match(prompt, /export function gone\(\): void/);
    assert.match(prompt, /export function arrived\(\): void/);
    assert.doesNotMatch(prompt, /unrelated/);
  });

  test('says outright when no replacement is known', () => {
    const scoped = plan([unit({ breakingChangeIds: ['bc_other'] })]);
    const prompt = composeAgentPrompt(task({ plan: scoped, commit: unit({ breakingChangeIds: ['bc_other'] }) }) as never);
    assert.match(prompt, /Replacement: none established by the evidence\. Do not invent one/);
  });

  test('forbids broad verification and re-research, and explains scope requests', () => {
    const prompt = composeAgentPrompt(task() as never);
    assert.match(prompt, /Do not run the full\s+test suite/);
    assert.match(prompt, /Do not re-derive it from the\s+dependency's changelog/);
    assert.match(prompt, /=== DRIFT SCOPE REQUEST: <path> \| <why>/);
    assert.match(prompt, /Do NOT change, revert, or downgrade the upgraded dependency \(acme-sdk\)/);
  });

  test('lists a file the unit may create even though it has no snapshot yet', () => {
    const prompt = composeAgentPrompt(task({ commit: unit({ allowedFiles: ['src/app.ts', 'eslint.config.mjs'] }) }) as never);
    assert.match(prompt, /In scope: src\/app\.ts, eslint\.config\.mjs/);
  });

  test('includes measured diagnostics and a repair section only when given', () => {
    const plain = composeAgentPrompt(task() as never);
    assert.doesNotMatch(plain, /What still fails/);
    const repair = composeAgentPrompt(task({ diagnostics: 'TS2305 gone', repair: { round: 2, failures: '- src/app.ts:1 boom', previousDiff: '-gone\n+arrived' } }) as never);
    assert.match(repair, /TS2305 gone/);
    assert.match(repair, /What still fails \(repair round 2\)/);
    assert.match(repair, /- src\/app.ts:1 boom/);
    assert.match(repair, /\+arrived/);
  });

  test('scope requests are parsed from anywhere in the output', () => {
    const requests = parseScopeRequests('did some work\n=== DRIFT SCOPE REQUEST: eslint.config.mjs | flat config required\n=== DRIFT SCOPE REQUEST: `package.json` | typescript-eslint 8\n=== DRIFT SCOPE REQUEST: eslint.config.mjs | dup');
    assert.deepEqual(requests, [
      { path: 'eslint.config.mjs', reason: 'flat config required' },
      { path: 'package.json', reason: 'typescript-eslint 8' },
    ]);
  });
});

describe('verification and repair', () => {
  test('a failure after the planned units starts a fresh repair session with only that failure', async () => {
    const { root, cleanup } = await repoWith({ 'src/app.ts': 'gone();\n' });
    try {
      const fake = scriptedAgent(root, [
        async () => fake.write('src/app.ts', 'arrived(1);\n'),
        async () => fake.write('src/app.ts', 'arrived();\n'),
      ]);
      const verify = scriptedVerifier([
        { passed: false, failures: [{ file: 'src/app.ts', message: 'src/app.ts:1 TS2305 gone' }] },
        { passed: false, failures: [{ file: 'src/app.ts', message: 'src/app.ts:1 TS2554 Expected 0 arguments' }] },
        { passed: true },
      ]);
      const record = await runRemediationController({ root, plan: plan([unit()]), config, agent: fake.agent, verifier: verify.verifier, logger: silent });
      assert.equal(record.termination, 'verified');
      assert.equal(verify.calls, 3, 'Drift, not the agent, ran verification each time');
      assert.equal(fake.tasks.length, 2);
      const repair = fake.tasks[1];
      assert.equal(repair.repair.round, 1);
      assert.match(repair.repair.failures, /TS2554/);
      assert.doesNotMatch(repair.repair.failures, /TS2305/, 'the earlier, fixed failure is not carried forward');
      assert.match(repair.repair.previousDiff, /\+arrived\(1\);/);
      assert.equal(repair.diagnostics, undefined);
      assert.deepEqual(record.sessions.map((session) => session.round), [0, 1]);
      assert.equal(record.repairRounds, 1);
    } finally {
      await cleanup();
    }
  });

  test('the same failure after a repair that changed nothing ends the run', async () => {
    const { root, cleanup } = await repoWith({ 'src/app.ts': 'gone();\n' });
    try {
      const fake = scriptedAgent(root, [async () => fake.write('src/app.ts', 'arrived();\n'), async () => undefined, async () => undefined]);
      const stuck = { passed: false, failures: [{ file: 'src/app.ts', message: 'src/app.ts:1 still broken' }] };
      const verify = scriptedVerifier([stuck, stuck, stuck, stuck]);
      const record = await runRemediationController({ root, plan: plan([unit()]), config, agent: fake.agent, verifier: verify.verifier, logger: silent });
      assert.equal(record.termination, 'no-progress');
      assert.equal(fake.tasks.length, 2, 'one plan session, one repair, then stop');
    } finally {
      await cleanup();
    }
  });

  test('a repair that changes the failure earns another round', async () => {
    const { root, cleanup } = await repoWith({ 'src/app.ts': 'a\n' });
    try {
      const fake = scriptedAgent(root, [
        async () => fake.write('src/app.ts', 'b\n'),
        async () => fake.write('src/app.ts', 'c\n'),
        async () => fake.write('src/app.ts', 'd\n'),
        async () => fake.write('src/app.ts', 'e\n'),
      ]);
      const verify = scriptedVerifier([
        { passed: false, failures: [{ file: 'src/app.ts', message: 'one' }] },
        { passed: false, failures: [{ file: 'src/app.ts', message: 'two' }] },
        { passed: false, failures: [{ file: 'src/app.ts', message: 'three' }] },
        { passed: false, failures: [{ file: 'src/app.ts', message: 'four' }] },
        { passed: true },
      ]);
      const record = await runRemediationController({ root, plan: plan([unit()]), config, agent: fake.agent, verifier: verify.verifier, logger: silent });
      assert.equal(record.termination, 'verified');
      assert.equal(record.repairRounds, 3);
    } finally {
      await cleanup();
    }
  });

  test('a scope request is granted to the next session, never taken', async () => {
    const { root, cleanup } = await repoWith({ 'src/app.ts': 'a\n' });
    try {
      const fake = scriptedAgent(root, [
        async () => ({ message: 'needs config', scopeRequests: [{ path: 'eslint.config.mjs', reason: 'flat config' }, { path: '.github/workflows/ci.yml', reason: 'node' }] }),
        async (task) => {
          assert.ok(task.commit.allowedFiles.includes('eslint.config.mjs'));
          await fake.write('eslint.config.mjs', 'export default [];\n');
        },
      ]);
      const verify = scriptedVerifier([
        { passed: false, failures: [{ message: "ESLint couldn't find an eslint.config file" }] },
        { passed: false, failures: [{ message: "ESLint couldn't find an eslint.config file" }] },
        { passed: true },
      ]);
      const record = await runRemediationController({ root, plan: plan([unit()]), config, agent: fake.agent, verifier: verify.verifier, logger: silent });
      assert.equal(record.termination, 'verified');
      assert.deepEqual(record.grantedFiles, ['eslint.config.mjs']);
      assert.deepEqual(record.deniedScopeRequests.map((request) => request.path), ['.github/workflows/ci.yml']);
    } finally {
      await cleanup();
    }
  });

  test('with no agent session since the last measurement, the checks are not run again', async () => {
    const { root, cleanup } = await repoWith({ 'src/app.ts': 'a\n' });
    try {
      const fake = scriptedAgent(root, [async () => fake.write('src/app.ts', 'b\n')]);
      const verify = scriptedVerifier([{ passed: false, failures: [{ file: 'src/app.ts', message: 'boom' }] }, { passed: true }]);
      const record = await runRemediationController({ root, plan: plan([]), config, agent: fake.agent, verifier: verify.verifier, logger: silent });
      assert.equal(record.termination, 'verified');
      assert.equal(verify.calls, 2, 'one measurement before the repair, one after');
    } finally {
      await cleanup();
    }
  });

  test('a repository that already passes with no agent work makes no agent call', async () => {
    const { root, cleanup } = await repoWith({ 'src/app.ts': 'a\n' });
    try {
      const fake = scriptedAgent(root, []);
      const verify = scriptedVerifier([{ passed: true }]);
      const record = await runRemediationController({ root, plan: plan([]), config, agent: fake.agent, verifier: verify.verifier, logger: silent });
      assert.equal(record.termination, 'verified');
      assert.equal(fake.tasks.length, 0);
    } finally {
      await cleanup();
    }
  });

  test('unowned failures become one residual repair with only the findings they mention', () => {
    const run = {
      passed: false,
      failures: [{ check: 'npm test', signature: 's', file: 'src/new.ts', message: 'src/new.ts:3 `gone` is not a function' }],
      checks: [{ label: 'npm test', kind: 'test', status: 'failed', durationMs: 1, failures: [], preexisting: 0, tail: '', mentionedFiles: ['src/helper.ts'] }],
      fingerprint: 'f', durationMs: 1, installed: false, sideEffectsReverted: [],
    };
    const units = [{ commit: unit(), origin: 'plan' }];
    const repairs = planRepairs(run as never, units as never, new Map(), new Set(['src/app.ts']), plan([unit()]));
    assert.equal(repairs.length, 1);
    assert.equal(repairs[0]!.commit.id, 'residual');
    assert.deepEqual(repairs[0]!.commit.allowedFiles, ['src/app.ts', 'src/helper.ts', 'src/new.ts']);
    assert.deepEqual(repairs[0]!.commit.breakingChangeIds, ['bc_1']);
  });

  test('paths read from check output must be real repository files', () => {
    const run = {
      passed: false,
      failures: [
        { check: 'npm test', signature: 'a', file: 'Node.js', message: 'x' },
        { check: 'npm test', signature: 'b', file: 'at runRuleForItem (/tmp/x/rule-tester.js', message: 'y' },
        { check: 'npm test', signature: 'c', file: 'src/real.ts', message: 'z' },
      ],
      checks: [{ label: 'npm test', kind: 'test', status: 'failed', durationMs: 1, failures: [], preexisting: 0, tail: '', mentionedFiles: ['ledger-keyring.ts'] }],
      fingerprint: 'f', durationMs: 1, installed: false, sideEffectsReverted: [],
    };
    const repairs = planRepairs(run as never, [] as never, new Map([['residual', new Set(['eslint.config.mjs'])]]), new Set(['src/edited.ts']), plan([]), (path: string) => path === 'src/real.ts');
    assert.deepEqual(repairs[0]!.commit.allowedFiles, ['eslint.config.mjs', 'src/edited.ts', 'src/real.ts']);
  });

  test('a failure that names only installed dependencies still gets a session that can request scope', async () => {
    const { root, cleanup } = await repoWith({ 'src/app.ts': 'a\n', 'tsconfig.json': '{}\n' });
    try {
      const fake = scriptedAgent(root, [
        async (task) => {
          assert.deepEqual(task.commit.allowedFiles, []);
          assert.match(task.commit.instructions, /Do not edit anything in this session/);
          return { message: 'needs tsconfig', scopeRequests: [{ path: 'tsconfig.json', reason: 'skipLibCheck for logform declarations' }] };
        },
        async (task) => {
          assert.ok(task.commit.allowedFiles.includes('tsconfig.json'));
          await fake.write('tsconfig.json', '{"compilerOptions":{"skipLibCheck":true}}\n');
        },
      ]);
      const failing = { passed: false, failures: [{ file: 'node_modules/logform/index.d.ts', message: 'node_modules/logform/index.d.ts:14 TS1023' }] };
      const verify = scriptedVerifier([failing, failing, { passed: true }]);
      const record = await runRemediationController({ root, plan: plan([]), config, agent: fake.agent, verifier: verify.verifier, logger: silent });
      assert.equal(record.termination, 'verified');
      assert.deepEqual(record.grantedFiles, ['tsconfig.json']);
    } finally {
      await cleanup();
    }
  });

  test('rendered failures are bounded', () => {
    const failures = Array.from({ length: 80 }, (_, index) => ({ check: 'tsc', signature: String(index), file: 'src/a.ts', message: `src/a.ts:${index} boom` }));
    const text = renderFailures(failures, { checks: [{ label: 'tsc', preexisting: 2, tail: '' }] } as never, { unitFiles: [] });
    assert.match(text, /…and 50 more/);
    assert.match(text, /2 other failures in this check already happened before the upgrade/);
    assert.ok(text.split('\n').length < 40);
  });
});

describe('the project verifier', () => {
  test('parses compiler errors, failing tests, coverage and tool errors', () => {
    const output = [
      'src/ledger.ts(12,5): error TS2339: Property \'v\' does not exist on type \'TxData\'.',
      '  ● keyring › signs a transaction',
      '      at Object.<anonymous> (src/ledger.test.ts:40:7)',
      'Jest: "global" coverage threshold for lines (81.93%) not met: 73.33%',
      "Oops! Something went wrong! :(",
      'ESLint couldn\'t find an eslint.config.(js|mjs|cjs) file.',
    ].join('\n');
    const failures = extractFailures('yarn test', output, '/repo');
    assert.ok(failures.some((failure) => failure.file === 'src/ledger.ts' && /TS2339/.test(failure.message)));
    assert.ok(failures.some((failure) => failure.file === 'src/ledger.test.ts' && /signs a transaction/.test(failure.message)));
    assert.ok(failures.some((failure) => /coverage threshold for lines/.test(failure.message)));
    assert.ok(failures.some((failure) => /ESLint couldn't find/.test(failure.message)));
  });

  test('parses eslint stylish output', () => {
    const output = ['/repo/src/cli.ts', '  12:7  error  \'x\' is assigned a value but never used  @typescript-eslint/no-unused-vars', ''].join('\n');
    const failures = extractFailures('npm run lint', output, '/repo');
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.file, 'src/cli.ts');
    assert.equal(failures[0]!.line, 12);
  });

  test('failures that already happened before the upgrade are subtracted', () => {
    const before = { kind: 'test', label: 'npm test', compileCapable: false, status: 'failed', durationMs: 1, output: '', fullOutput: '  ● docker-manager › home is /root\n' };
    const after = { ...before, fullOutput: '  ● docker-manager › home is /root\n  ● logger › prints errors\n' };
    const result = resultFor(after as never, before as never, '/repo');
    assert.equal(result.preexisting, 1);
    assert.deepEqual(result.failures.map((failure) => failure.message), ['Test failed: logger › prints errors']);
  });

  test('a check that fails only as it already did before is not a failure', () => {
    const before = { kind: 'test', label: 'npm test', compileCapable: false, status: 'failed', durationMs: 1, output: '', fullOutput: 'segfault somewhere\n' };
    const result = resultFor(before as never, before as never, '/repo');
    assert.deepEqual(result.failures, []);
  });

  test('a failed check with nothing parseable still fails', () => {
    const outcome = { kind: 'build', label: 'npm run build', compileCapable: false, status: 'failed', durationMs: 1, output: '', fullOutput: 'something odd\n' };
    const result = resultFor(outcome as never, undefined, '/repo');
    assert.equal(result.failures.length, 1);
  });

  test('files a check rewrote are restored and reported', async () => {
    const { root, cleanup } = await repoWith({ 'jest.config.js': 'lines: 80\n' });
    try {
      const verifier = createProjectVerifier({
        root,
        checks: [{ kind: 'test', label: 'yarn test', command: { command: 'yarn', args: ['test'] }, source: '', commandOrigin: { kind: 'host', command: 'yarn' }, compileCapable: false }] as never,
        install: 'never',
        runChecks: (async () => {
          await writeFile(join(root, 'jest.config.js'), 'lines: 95\n');
          await writeFile(join(root, 'coverage.txt'), 'x');
          return [{ kind: 'test', label: 'yarn test', compileCapable: false, status: 'passed', durationMs: 1, output: '' }];
        }) as never,
      });
      const run = await verifier.run();
      assert.equal(run.passed, true);
      assert.deepEqual(run.sideEffectsReverted, ['coverage.txt', 'jest.config.js']);
      assert.equal(await readFile(join(root, 'jest.config.js'), 'utf8'), 'lines: 80\n');
    } finally {
      await cleanup();
    }
  });

  test('a dependency change made after markInstalled is installed before the checks', async () => {
    const { root, cleanup } = await repoWith({ 'package.json': '{"dependencies":{"a":"1"}}', 'package-lock.json': '{}' });
    try {
      const commands: string[] = [];
      const verifier = createProjectVerifier({
        root,
        checks: [],
        exec: (async (command: string, args: readonly string[]) => {
          commands.push([command, ...args].join(' '));
          return { code: 0, stdout: '', stderr: '' };
        }) as never,
        runChecks: (async () => []) as never,
      });
      await verifier.markInstalled();
      await writeFile(join(root, 'package.json'), '{"dependencies":{"a":"1","b":"2"}}');
      const run = await verifier.run();
      assert.equal(run.installed, true);
      assert.ok(commands.includes('npm install'));
    } finally {
      await cleanup();
    }
  });

  test('a write inside installed dependencies is detected on the real filesystem', async () => {
    const { root, cleanup } = await repoWith({ '.gitignore': 'node_modules/\n', 'package.json': '{}' });
    try {
      await mkdir(join(root, 'node_modules', 'logform'), { recursive: true });
      await writeFile(join(root, 'node_modules', 'logform', 'index.d.ts'), 'before');
      const verifier = createProjectVerifier({ root, checks: [], install: 'never', runChecks: (async () => []) as never });
      const quiet = await verifier.watchDependencies();
      assert.equal(await quiet(), null);
      const noisy = await verifier.watchDependencies();
      await writeFile(join(root, 'node_modules', 'logform', 'index.d.ts'), 'patched');
      assert.equal(await noisy(), 'node_modules/logform/index.d.ts');
    } finally {
      await cleanup();
    }
  });

  test('the pre-upgrade baseline is measured outside the repository and removed afterwards', async () => {
    const { measureBaseline } = await import('../dist/remediation/verifier.js');
    const { existsSync } = await import('node:fs');
    const { root, cleanup } = await repoWith({ 'a.txt': 'a' });
    try {
      let measuredIn = '';
      const result = await measureBaseline({
        root,
        ref: 'HEAD',
        checks: [],
        exec: (async (command: string, args: readonly string[], opts?: { cwd?: string }) => {
          if (command === 'git') return (await import('../dist/util/exec.js')).execCommand(command, args, opts);
          return { code: 0, stdout: '', stderr: '' };
        }) as never,
        runChecks: (async (options: { root: string }) => {
          measuredIn = options.root;
          assert.ok(existsSync(join(options.root, 'a.txt')));
          return [];
        }) as never,
      });
      assert.equal(result.outcomes.length, 0);
      assert.ok(measuredIn, 'the checks ran');
      assert.ok(!measuredIn.includes('/.git/'), `baseline worktree ${measuredIn} must not be under .git`);
      assert.ok(!measuredIn.startsWith(root), 'baseline worktree must be outside the repository');
      assert.equal(existsSync(measuredIn), false);
    } finally {
      await cleanup();
    }
  });

  test('an npm peer-dependency conflict is retried with --legacy-peer-deps', async () => {
    const { root, cleanup } = await repoWith({ 'package.json': '{"dependencies":{"a":"1"}}', 'package-lock.json': '{}' });
    try {
      const commands: string[] = [];
      const verifier = createProjectVerifier({
        root,
        checks: [],
        installFirst: true,
        exec: (async (command: string, args: readonly string[]) => {
          commands.push([command, ...args].join(' '));
          if (command === 'npm' && !args.includes('--legacy-peer-deps')) return { code: 1, stdout: '', stderr: 'npm error code ERESOLVE' };
          return { code: 0, stdout: '', stderr: '' };
        }) as never,
        runChecks: (async () => []) as never,
      });
      const run = await verifier.run();
      assert.equal(run.installFailure, undefined);
      assert.ok(commands.includes('npm install --legacy-peer-deps'));
    } finally {
      await cleanup();
    }
  });

  test('remediation checks add lint and narrow test scripts, but not watch, fix or integration', async () => {
    const { root, cleanup } = await repoWith({
      'package-lock.json': '{}',
      'package.json': JSON.stringify({
        scripts: {
          build: 'tsc', test: 'jest', 'test:watch': 'jest --watch', 'test:integration': 'jest -c int', 'test:lint-rules': 'node rules.test.js',
          lint: 'npm run lint:eslint', 'lint:eslint': 'eslint .', 'lint:fix': 'eslint --fix .',
        },
      }),
    });
    try {
      const labels = (await detectRemediationChecks(root)).map((check) => check.label);
      assert.deepEqual(labels, ['npm test', 'npm run build', 'npm run lint', 'npm run test:lint-rules']);
    } finally {
      await cleanup();
    }
  });
});
