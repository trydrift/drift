import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentUpgradeFix, upgradeProtectedPaths } from '../dist/remediation/worktree-runner.js';
import { renderCommitAgentPrompt } from '../dist/agents/types.js';
import { DriftConfigSchema } from '../dist/config/schema.js';

/**
 * "Fix with AI" for a local agent. Measured on ten real upgrades against the
 * same agent with no Drift around it, the commit-by-commit pipeline fixed
 * none and the plain agent fixed nearly all, for four reasons each pinned
 * below: an upgrade with a measured failure but no localized site was never
 * attempted; a session could edit only the files its unit named; one
 * forbidden edit discarded every correct one beside it; and the agent was told
 * not to run the checks nothing else then ran.
 */

const execFile = promisify(execFileCb);
const git = (cwd: string, ...args: string[]) => execFile('git', args, { cwd });

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'drift-upgrade-fix-'));
  await git(root, 'init', '--quiet');
  await git(root, 'config', 'user.email', 't@t');
  await git(root, 'config', 'user.name', 't');
  await git(root, 'config', 'commit.gpgsign', 'false');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
  }
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', 'start');
  return root;
}

/** A plan with no commit units: what a measured failure with no localized site produced. */
const plan = (overrides: Record<string, unknown> = {}) =>
  ({
    changes: [{ name: 'lru-cache', from: '7.18.3', to: '10.4.3', ecosystem: 'npm' }],
    commits: [],
    breakingChanges: [],
    impactSites: [],
    evidence: [],
    verification: { status: 'failed', checks: [], failedFiles: ['src/cache.ts'], diagnostics: "src/cache.ts(3,14): error TS2351: This expression is not constructable." },
    ...overrides,
  }) as never;

function agent(edit: (root: string) => Promise<void>) {
  const tasks: unknown[] = [];
  return {
    tasks,
    agent: {
      id: 'fake',
      label: 'Fake agent',
      description: '',
      kind: 'cli',
      capabilities: { execution: 'workspace', canAwaitCompletion: true, canInspectResult: true },
      detect: async () => ({ available: true, detail: '' }),
      run: async (task: { workspaceRoot: string }) => {
        tasks.push(task);
        await edit(task.workspaceRoot);
        return { status: 'applied', message: 'done' };
      },
    } as never,
  };
}

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
const config = DriftConfigSchema.parse({});

describe('fixing an upgrade with a local agent', () => {
  test('runs when Drift planned no unit, handing the agent the measured failure', async () => {
    const root = await repo({ 'src/cache.ts': "import LRU from 'lru-cache';\nexport const c = new LRU({ maxSize: 1 });\n" });
    const { agent: fake, tasks } = agent(async (dir) => {
      await writeFile(join(dir, 'src/cache.ts'), "import { LRUCache } from 'lru-cache';\nexport const c = new LRUCache({ max: 1 });\n", 'utf8');
    });
    try {
      const result = await runAgentUpgradeFix({ plan: plan(), config, worktree: root, agent: fake, logger });
      assert.equal(tasks.length, 1, 'the agent must run even though the plan has no units');
      const task = tasks[0] as { mode: string; diagnostics: string };
      assert.equal(task.mode, 'upgrade');
      assert.match(task.diagnostics, /TS2351/);
      assert.equal(result.status, 'committed');
      assert.deepEqual(result.kept, ['src/cache.ts']);
      assert.match(await readFile(join(root, 'src/cache.ts'), 'utf8'), /LRUCache/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('may edit any file the migration needs, including a config file and a companion manifest entry', async () => {
    const root = await repo({
      'src/main.ts': 'new Vue({});\n',
      'vite.config.ts': "import vue from '@vitejs/plugin-vue2';\n",
      'package.json': '{\n  "dependencies": { "vue": "3.5.43" },\n  "devDependencies": { "@vitejs/plugin-vue2": "^1" }\n}\n',
      'yarn.lock': 'plugin-vue2@1\n',
    });
    const { agent: fake } = agent(async (dir) => {
      await writeFile(join(dir, 'src/main.ts'), 'createApp(App).mount("#app");\n', 'utf8');
      await writeFile(join(dir, 'vite.config.ts'), "import vue from '@vitejs/plugin-vue';\n", 'utf8');
      await writeFile(join(dir, 'package.json'), '{\n  "dependencies": { "vue": "3.5.43" },\n  "devDependencies": { "@vitejs/plugin-vue": "^3" }\n}\n', 'utf8');
      await writeFile(join(dir, 'yarn.lock'), 'plugin-vue@3\n', 'utf8');
    });
    try {
      const result = await runAgentUpgradeFix({ plan: plan({ changes: [{ name: 'vue', from: '2.7.16', to: '3.5.43', ecosystem: 'npm' }] }), config, worktree: root, agent: fake, logger });
      assert.equal(result.status, 'committed');
      assert.deepEqual(result.reverted, [], 'nothing about a plugin swap breaks a rule');
      assert.match(await readFile(join(root, 'vite.config.ts'), 'utf8'), /plugin-vue'/);
      assert.match(await readFile(join(root, 'yarn.lock'), 'utf8'), /plugin-vue@3/, 'the lockfile moves with the manifest');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reverts only the file that breaks a rule, and keeps every correct edit beside it', async () => {
    const root = await repo({
      'src/keyring.ts': 'const tx = TransactionFactory.fromTxData(data);\n',
      '.github/workflows/build.yml': 'node-version: 18\n',
      'jest.config.js': 'module.exports = { coverageThreshold: { global: {\n      lines: 81.93,\n  } } };\n',
    });
    const { agent: fake } = agent(async (dir) => {
      await writeFile(join(dir, 'src/keyring.ts'), 'const tx = createTx(data);\n', 'utf8');
      await writeFile(join(dir, '.github/workflows/build.yml'), 'node-version: 20\n', 'utf8');
      await writeFile(join(dir, 'jest.config.js'), 'module.exports = { coverageThreshold: { global: {\n      lines: 73,\n  } } };\n', 'utf8');
    });
    try {
      const result = await runAgentUpgradeFix({ plan: plan(), config, worktree: root, agent: fake, logger });
      assert.equal(result.status, 'committed');
      assert.deepEqual(result.reverted.map((r: { path: string }) => r.path).sort(), ['.github/workflows/build.yml', 'jest.config.js']);
      assert.match(await readFile(join(root, 'src/keyring.ts'), 'utf8'), /createTx/, 'the source fix survives');
      assert.match(await readFile(join(root, '.github/workflows/build.yml'), 'utf8'), /node-version: 18/, 'the workflow is restored');
      assert.match(await readFile(join(root, 'jest.config.js'), 'utf8'), /lines: 81\.93/, 'the coverage threshold is restored');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('never keeps an edit inside node_modules, .git or an env file, whatever the repository configures', async () => {
    const root = await repo({ 'src/a.ts': 'x\n', '.gitignore': '' });
    const { agent: fake } = agent(async (dir) => {
      await writeFile(join(dir, 'src/a.ts'), 'y\n', 'utf8');
      await mkdir(join(dir, 'node_modules/logform'), { recursive: true });
      await writeFile(join(dir, 'node_modules/logform/index.d.ts'), 'export {};\n', 'utf8');
      await writeFile(join(dir, '.env'), 'TOKEN=x\n', 'utf8');
    });
    try {
      const configured = DriftConfigSchema.parse({ guardrails: { protectedPaths: ['infra/**'] } });
      const result = await runAgentUpgradeFix({ plan: plan(), config: configured, worktree: root, agent: fake, logger });
      const reverted = result.reverted.map((r: { path: string }) => r.path);
      assert.ok(reverted.some((p: string) => p.startsWith('node_modules/')), `node_modules edit must be reverted (got ${reverted})`);
      assert.ok(reverted.includes('.env'));
      assert.match(await readFile(join(root, 'src/a.ts'), 'utf8'), /y/, 'the legitimate edit is kept');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('still refuses a downgrade of the upgraded dependency', async () => {
    const root = await repo({ 'package.json': '{\n  "dependencies": { "lru-cache": "10.4.3" }\n}\n', 'src/a.ts': 'x\n' });
    const { agent: fake } = agent(async (dir) => {
      await writeFile(join(dir, 'package.json'), '{\n  "dependencies": { "lru-cache": "7.18.3" }\n}\n', 'utf8');
      await writeFile(join(dir, 'src/a.ts'), 'y\n', 'utf8');
    });
    try {
      const result = await runAgentUpgradeFix({ plan: plan(), config, worktree: root, agent: fake, logger });
      assert.deepEqual(result.reverted.map((r: { path: string }) => r.path), ['package.json']);
      assert.match(await readFile(join(root, 'package.json'), 'utf8'), /10\.4\.3/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('lockfiles are not protected paths for an upgrade, while workflows and infrastructure still are', () => {
    assert.deepEqual(upgradeProtectedPaths(['.github/workflows/**', '**/*.lock', 'infra/**', 'package-lock.json', 'pnpm-lock.yaml']), ['.github/workflows/**', 'infra/**']);
  });
});

describe('what the agent is told', () => {
  const task = (mode?: 'upgrade') =>
    ({
      plan: plan(),
      commit: { id: 'u', order: 1, message: 'm', body: '', breakingChangeIds: [], files: ['src/a.ts'], allowedFiles: ['src/a.ts'], instructions: 'fix', dependsOn: [], dependencyReasons: [], executionLayer: 0, expectedChecks: [], invalidationTriggers: [] },
      files: [],
      ...(mode ? { mode, protectedPaths: ['.github/workflows/**'] } : {}),
    }) as never;

  test('for an upgrade: findings are a head start, any needed file may change, and the agent verifies its own work', () => {
    const prompt = renderCommitAgentPrompt(task('upgrade'));
    assert.match(prompt, /head start, not as the whole job/);
    assert.match(prompt, /Investigate beyond what it\s+lists/);
    assert.match(prompt, /Edit whatever the migration needs/);
    assert.match(prompt, /Verify your work with the project's own build/);
    assert.match(prompt, /\.github\/workflows\/\*\*/);
    assert.doesNotMatch(prompt, /You may edit ONLY/);
    assert.doesNotMatch(prompt, /Do not run the full test suite/);
  });

  test('for a planned unit the scoped prompt is unchanged', () => {
    const prompt = renderCommitAgentPrompt(task());
    assert.match(prompt, /You may edit ONLY these 1 file/);
    assert.doesNotMatch(prompt, /head start/);
  });
});
