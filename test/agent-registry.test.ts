import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { dispatch } from '../dist/dispatch/index.js';
import { DriftConfigSchema, type DriftConfig } from '../dist/config/schema.js';
import { AgentProviderRegistry, type AgentProviderAdapter } from '../dist/agents/registry.js';
import { resolveAgentSelection } from '../dist/agents/selection.js';
import type { CloudFixAgent, FixAgent, FixTask, AgentContext } from '../dist/agents/types.js';
import { reconcileCloudTask } from '../dist/remediation/cloud-lifecycle.js';
import { MemoryJobQueue } from '../dist/queue/memory.js';
import { createLogger } from '../dist/util/logger.js';
import type { RemediationPlan, RepoContext } from '../dist/types.js';

const run = promisify(execFile);
const logger = createLogger('error');
const sha = {
  before: 'a'.repeat(40),
  after: 'b'.repeat(40),
  result: 'c'.repeat(40),
};

function plan(branchName = 'drift/acme-agent'): RemediationPlan {
  return {
    schemaVersion: 1,
    id: 'plan_acme',
    branchName,
    baseBranch: 'main',
    headSha: sha.after,
    changes: [],
    evidence: [],
    breakingChanges: [
      {
        id: 'bc_acme',
        dependency: 'acme-sdk',
        kind: 'removed-export',
        summary: '`oldApi` was removed.',
        remediation: 'Replace `oldApi` with `newApi`.',
        symbols: ['oldApi'],
        confidence: 'high',
        citations: [],
      },
    ],
    upstreamBreakingCount: 1,
    impactSites: [
      {
        breakingChangeId: 'bc_acme',
        file: 'app.ts',
        line: 1,
        excerpt: 'oldApi();',
        matchedSymbol: 'oldApi',
        confidence: 'high',
      },
    ],
    commits: [
      {
        id: 'commit_acme',
        order: 1,
        message: 'fix: update acme sdk usage',
        body: 'Replace removed API usage.',
        breakingChangeIds: ['bc_acme'],
        files: ['app.ts'],
        allowedFiles: ['app.ts'],
        allowedSymbols: ['oldApi'],
        instructions: 'Replace oldApi with newApi.',
        dependsOn: [],
        dependencyReasons: [],
        executionLayer: 0,
        expectedChecks: [],
        invalidationTriggers: [],
      },
    ],
    planEdges: [],
    upgradeCohorts: [],
    risk: 'low',
    gaps: [],
    checkedSurfaces: [],
    confirmedRegressions: [],
    blockers: [],
    warnings: [],
    createdAt: new Date(0).toISOString(),
  } as RemediationPlan;
}

function fakeGithub() {
  const calls: string[] = [];
  return {
    calls,
    async createBranch() {
      calls.push('createBranch');
      return true;
    },
    async commitFiles() {
      calls.push('commitFiles');
      return { sha: sha.result };
    },
    async createCheckRun() {
      calls.push('createCheckRun');
    },
    async createPullRequest() {
      calls.push('createPullRequest');
      return { number: 17, url: 'https://github.com/acme/app/pull/17', existing: false };
    },
    async findPullRequestForBranch() {
      return null;
    },
    async getDefaultBranch() {
      return 'main';
    },
    async createIssue() {
      calls.push('createIssue');
      return { number: 2, url: 'https://github.com/acme/app/issues/2' };
    },
    async findOpenPlanIssue() {
      return null;
    },
    async getBranchHead() {
      calls.push('getBranchHead');
      return sha.result;
    },
    async changedFiles() {
      calls.push('changedFiles');
      return ['app.ts'];
    },
  };
}

class FakeWorkspaceAgent implements FixAgent {
  readonly id = 'acme-workspace';
  readonly label = 'Acme Workspace';
  readonly description = 'Fake workspace provider for registry architecture tests.';
  readonly kind = 'cli' as const;
  readonly capabilities = {
    execution: 'workspace',
    canAwaitCompletion: false,
    canInspectResult: true,
  } as const;
  task: FixTask | null = null;

  async detect() {
    return { available: true };
  }

  async run(task: FixTask, _ctx: AgentContext) {
    this.task = task;
    await writeFile(join(task.workspaceRoot, 'app.ts'), 'newApi();\n', 'utf8');
    return { status: 'applied' as const, message: 'Acme edited the worktree.' };
  }
}

class FakeCloudAgent implements CloudFixAgent {
  readonly id = 'acme-cloud';
  readonly label = 'Acme Cloud';
  readonly description = 'Fake cloud provider for registry architecture tests.';
  readonly kind = 'cloud' as const;
  readonly capabilities = {
    execution: 'cloud',
    canAwaitCompletion: true,
    canInspectResult: false,
  } as const;
  dispatched: FixTask | null = null;

  async detect() {
    return { available: true };
  }

  async run(task: FixTask, _ctx: AgentContext) {
    this.dispatched = task;
    return {
      status: 'delegated' as const,
      message: 'Acme cloud task started.',
      url: 'https://example.invalid/acme/tasks/task-1',
      handle: {
        provider: this.id,
        id: 'task-1',
        state: 'queued',
        branch: task.plan.branchName,
        url: 'https://example.invalid/acme/tasks/task-1',
        capabilities: this.capabilities,
      },
    };
  }

  async status() {
    return { state: 'completed', pullRequestUrl: 'https://github.com/acme/app/pull/17' };
  }

  isTerminalState(state: string): boolean {
    return state === 'completed' || state === 'failed';
  }
}

function workspaceAdapter(agent: FakeWorkspaceAgent): AgentProviderAdapter {
  return {
    id: agent.id,
    label: agent.label,
    description: agent.description,
    capabilities: agent.capabilities,
    create: async () => agent,
    detect: async () => ({ available: true }),
  };
}

function cloudAdapter(agent: FakeCloudAgent): AgentProviderAdapter {
  return {
    id: agent.id,
    label: agent.label,
    description: agent.description,
    capabilities: agent.capabilities,
    create: async () => agent,
    detect: async () => ({ available: true }),
  };
}

async function withGitRepo<T>(fn: (repo: RepoContext, workspace: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'drift-agent-registry-'));
  const origin = join(dir, 'origin.git');
  const workspace = join(dir, 'work');
  try {
    await mkdir(workspace);
    await run('git', ['init', '--bare', origin]);
    await run('git', ['init', '-b', 'main'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'drift@example.invalid'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Drift Test'], { cwd: workspace });
    await writeFile(join(workspace, 'app.ts'), 'oldApi();\n', 'utf8');
    await run('git', ['add', 'app.ts'], { cwd: workspace });
    await run('git', ['commit', '-m', 'initial'], { cwd: workspace });
    await run('git', ['remote', 'add', 'origin', origin], { cwd: workspace });
    await run('git', ['push', '-u', 'origin', 'main'], { cwd: workspace });
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: workspace });
    const head = stdout.trim();
    return await fn(
      {
        owner: 'acme',
        repo: 'app',
        baseBranch: 'main',
        beforeSha: `${head}^`,
        afterSha: head,
        workspace,
      },
      workspace,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('agent provider registry architecture', () => {
  test('a newly registered workspace provider goes through normal dispatch and scope validation', async () => {
    await withGitRepo(async (repo) => {
      const agent = new FakeWorkspaceAgent();
      const registry = new AgentProviderRegistry([workspaceAdapter(agent)]);
      const config = DriftConfigSchema.parse({ mode: 'auto', remediation: { agent: { provider: 'acme-workspace' } } });
      const available = await registry.available({ repo, config, logger, surface: 'cli' });
      const selection = resolveAgentSelection({
        config: config.remediation.agent,
        runtime: { surface: 'cli', interactive: false, eligibleProviders: [...available.keys()] },
      });

      assert.equal(selection.provider, 'acme-workspace');
      assert.equal(selection.source, 'repository');

      const created = await registry.create(selection.provider, { repo, config, logger, surface: 'cli' });
      assert.ok(created);

      const github = fakeGithub();
      const result = await dispatch({ repo, plan: plan('drift/acme-workspace'), config, github: github as never, logger, agent: created });

      assert.equal(result.status, 'dispatched');
      assert.equal(result.taskId, undefined);
      assert.equal(agent.task?.commit.id, 'commit_acme');
      assert.ok(github.calls.includes('createPullRequest'));
      assert.match(result.message, /Acme Workspace resolved 1 commit/);
    });
  });

  test('a newly registered cloud provider dispatches, persists a generic handle, and reconciles', async () => {
    const agent = new FakeCloudAgent();
    const registry = new AgentProviderRegistry([cloudAdapter(agent)]);
    const config: DriftConfig = DriftConfigSchema.parse({ mode: 'auto', remediation: { agent: { provider: 'acme-cloud' } } });
    const repo = { owner: 'acme', repo: 'app', baseBranch: 'main', beforeSha: sha.before, afterSha: sha.after };
    const available = await registry.available({ repo, config, logger, surface: 'action' });
    const selection = resolveAgentSelection({
      config: config.remediation.agent,
      runtime: { surface: 'action', interactive: false, eligibleProviders: [...available.keys()] },
    });
    const created = await registry.create(selection.provider, { repo, config, logger, surface: 'action' });
    assert.ok(created);

    const github = fakeGithub();
    const result = await dispatch({ repo, plan: plan('drift/acme-cloud'), config, github: github as never, logger, agent: created });

    assert.equal(result.taskProvider, 'acme-cloud');
    assert.equal(result.taskId, 'task-1');
    assert.equal(agent.dispatched?.plan.commits.length, 1);

    const queue = new MemoryJobQueue();
    await queue.recordPendingCloudTask({
      provider: result.taskProvider!,
      owner: repo.owner,
      repo: repo.repo,
      taskId: result.taskId!,
      state: 'queued',
      headSha: repo.afterSha,
      branchName: result.branchName!,
      prNumber: result.pullRequestNumber ?? null,
      prUrl: result.pullRequestUrl ?? null,
      planJson: JSON.stringify(plan('drift/acme-cloud')),
    });

    const [pending] = await queue.listPendingCloudTasks();
    const reconciliation = await reconcileCloudTask({
      task: pending!,
      agent,
      github: github as never,
      logger,
    });

    assert.equal(reconciliation.terminal, true);
    assert.equal(reconciliation.conclusion, 'success');
    assert.ok(github.calls.includes('changedFiles'));
    await queue.close();
  });

  test('generic orchestration files do not branch on built-in provider ids or import implementations', async () => {
    const files = [
      'src/dispatch/index.ts',
      'src/pipeline.ts',
      'src/remediation/cloud-lifecycle.ts',
      'src/agents/selection.ts',
    ];
    const forbidden = [
      /provider\s*={2,3}\s*['"`](?:copilot-cloud|codex|claude|gemini|aider|opencode)['"`]/,
      /selection\.provider\s*={2,3}\s*['"`](?:copilot-cloud|codex|claude|gemini|aider|opencode)['"`]/,
      /CopilotCloudAgent/,
      /from ['"`].*agents\/(?:copilot-cloud|cli)['"`]/,
    ];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const pattern of forbidden) {
        assert.doesNotMatch(source, pattern, `${file} must stay provider-agnostic`);
      }
    }
  });
});
