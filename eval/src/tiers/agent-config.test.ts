import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentTimeoutMs, requestedProvenance, withAgentSelection } from './agent-config.ts';
import { runAgentTrack } from './agent.ts';
import { runFullRemediationTrack } from './full-remediation.ts';
import type { RepairContext } from './context.ts';
import { DriftConfigSchema, type CommitUnit, type DriftConfig, type Logger, type RemediationPlan } from '../../../dist/index.js';
import type { PublicCase } from '../case/schema.ts';

/**
 * What the production runner is actually handed.
 *
 * The defect these tests exist for was invisible from the outside: the
 * standalone agent track built a config carrying the requested model and
 * effort, and the full-remediation track recorded the same values in
 * provenance while handing the runner `context.config` — the unmodified one.
 * An artifact from a `--model X --effort high` run could truthfully-looking
 * report `model: X, effort: high` while the agent ran on its own defaults.
 * Provenance cannot catch that; only asserting on the config the runner
 * received can.
 */

const SILENT: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  group: (_label, fn) => fn(),
};

const BASE: DriftConfig = DriftConfigSchema.parse({ mode: 'auto' });

test('selection is pushed through Drift’s own remediation.agent block', () => {
  const config = withAgentSelection(BASE, { agentId: 'codex', model: 'gpt-5.5', effort: 'xhigh', timeoutSeconds: 90, fast: true });
  assert.equal(config.remediation.agent.model, 'gpt-5.5');
  assert.equal(config.remediation.agent.effort, 'xhigh');
  assert.equal(config.remediation.agent.timeoutSeconds, 90);
  assert.equal(config.remediation.agent.fast, true);
  assert.equal(config.remediation.agent.provider, 'codex');
  assert.equal(agentTimeoutMs(BASE, { timeoutSeconds: 90 }), 90_000);
});

test('an empty selection changes nothing, so a default run is a genuine default run', () => {
  assert.deepEqual(withAgentSelection(BASE, {}).remediation.agent, BASE.remediation.agent);
});

test('requested provenance never claims a confirmed value', () => {
  const provenance = requestedProvenance(BASE, { model: 'gpt-5.5', effort: 'high' });
  assert.equal(provenance.requestedModel, 'gpt-5.5');
  assert.equal(provenance.requestedEffort, 'high');
  assert.equal(provenance.model, undefined, 'the confirmed field must stay unset until the agent reports');
  assert.equal(provenance.effort, undefined);
});

/* ------------------------------------------------------------------ */

interface Recorded {
  config: DriftConfig | null;
}

/** An agent that is available, reports a banner, and edits the file it was allowed to. */
function fakeAgent(banner: readonly string[]) {
  return {
    detect: async () => ({ available: true, detail: 'fake-agent 1.0.0' }),
    run: async () => ({ status: 'completed' as const, message: 'done' }),
    banner,
  };
}

async function fixtureContext(): Promise<{ context: RepairContext; teardown: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'drift-agent-config-'));
  await writeFile(join(root, 'app.js'), 'export const value = 1;\n', 'utf8');

  const commit = {
    id: 'unit-1',
    order: 1,
    message: 'refactor: migrate',
    body: '',
    breakingChangeIds: ['bc-1'],
    files: ['app.js'],
    allowedFiles: ['app.js'],
    allowedSymbols: [],
    instructions: 'Rename it.',
    dependsOn: [],
    dependencyReasons: [],
    executionLayer: 0,
    expectedChecks: [],
    invalidationTriggers: [],
  } as unknown as CommitUnit;

  const plan = {
    schemaVersion: 1,
    id: 'plan-1',
    branchName: 'drift/x',
    baseBranch: 'main',
    headSha: 'abc',
    changes: [],
    evidence: [],
    breakingChanges: [],
    impactSites: [],
    commits: [commit],
    planEdges: [],
    upgradeCohorts: [],
    risk: 'low',
    gaps: [],
  } as unknown as RemediationPlan;

  return {
    context: {
      publicCase: { id: 'agent-config-fixture' } as PublicCase,
      workspace: { root, upstreamOldDir: root, upstreamNewDir: root, beforeDir: root, evidenceDir: null, auditedPaths: 0, teardown: async () => undefined },
      plan,
      config: DriftConfigSchema.parse({ mode: 'auto' }),
      logger: SILENT,
      observedCommands: [],
    },
    teardown: () => rm(root, { recursive: true, force: true }),
  };
}

test('the standalone agent track hands the production runner the requested model and effort', { timeout: 120_000 }, async () => {
  const { context, teardown } = await fixtureContext();
  const recorded: Recorded = { config: null };

  try {
    const outcome = await runAgentTrack(
      context,
      { model: 'gpt-5.5-codex', effort: 'xhigh', timeoutSeconds: 120 },
      {
        createAgent: () => fakeAgent([]) as never,
        runAgentCommits: async (options) => {
          recorded.config = options.config;
          options.logger.info('model: gpt-5.5-codex');
          options.logger.info('reasoning effort: xhigh');
          return { resolved: [...options.commits], unresolved: [], committed: true };
        },
      },
    );

    assert.equal(recorded.config?.remediation.agent.model, 'gpt-5.5-codex');
    assert.equal(recorded.config?.remediation.agent.effort, 'xhigh');
    assert.equal(recorded.config?.remediation.agent.timeoutSeconds, 120);

    assert.equal(outcome.provenance?.requestedModel, 'gpt-5.5-codex');
    assert.equal(outcome.provenance?.requestedEffort, 'xhigh');
    // Confirmed, because the agent's own banner said so.
    assert.equal(outcome.provenance?.model, 'gpt-5.5-codex');
    assert.equal(outcome.provenance?.effort, 'xhigh');
  } finally {
    await teardown();
  }
});

test('the full-remediation agent fallback hands the runner the same config, not the untouched one', { timeout: 120_000 }, async () => {
  const { context, teardown } = await fixtureContext();
  const recorded: Recorded = { config: null };

  try {
    const outcome = await runFullRemediationTrack(
      context,
      { model: 'gpt-5.5-codex', effort: 'xhigh', timeoutSeconds: 120 },
      {
        createAgent: () => fakeAgent([]) as never,
        runAgentCommits: async (options) => {
          recorded.config = options.config;
          return { resolved: [], unresolved: [], committed: false };
        },
      },
    );

    assert.equal(recorded.config?.remediation.agent.model, 'gpt-5.5-codex', 'the requested model must reach the runner');
    assert.equal(recorded.config?.remediation.agent.effort, 'xhigh');
    assert.equal(recorded.config?.remediation.agent.timeoutSeconds, 120);
    assert.notEqual(recorded.config, context.config, 'the untouched config must not be what runs');

    assert.equal(outcome.provenance?.requestedModel, 'gpt-5.5-codex');
    assert.equal(outcome.provenance?.requestedEffort, 'xhigh');
    // The agent reported nothing, so nothing is confirmed. This is the case
    // that used to record the request as though it were execution metadata.
    assert.equal(outcome.provenance?.model, undefined);
    assert.equal(outcome.provenance?.effort, undefined);
  } finally {
    await teardown();
  }
});
