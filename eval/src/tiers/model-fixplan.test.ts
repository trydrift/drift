import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadPublicCase } from '../case/load.ts';
import { materializeCase } from '../case/materialize.ts';
import { runEndToEndDetection } from '../adapters/end-to-end.ts';
import { runModelFixPlanTrack } from './model-fixplan.ts';
import type { RepairContext } from './context.ts';
import { DriftConfigSchema, type Logger, type RemediationPlan } from '../../../dist/index.js';
import type { AnthropicLike } from '../../../dist/analyze/llm.js';

/**
 * `repair-fixplan-model` end to end, minus the model.
 *
 * The track's whole claim is a chain: production detection localizes, the model
 * authors a *rule* through Drift's own authoring path, Drift's validator
 * decides, Drift's policy decides, and Drift's deterministic executor applies
 * whatever survived. Every link is production code here; only the model call is
 * stubbed, because a live one would make this test cost money and stop being
 * runnable in CI.
 *
 * The case is chosen so the initial production plan carries NO fix plan — the
 * deterministic run has no model, so nothing is attached — which is exactly the
 * state the track used to mishandle: it resolved a fresh plan, recorded it in
 * the artifact, and then applied `context.plan.commits.filter(c => c.fixPlan)`,
 * which was empty. The plan was authored and never used.
 */

const SILENT: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  group: (_label, fn) => fn(),
};

/** A model that always answers with the same fix plan, and counts how often it was asked. */
function stubClient(payload: unknown): AnthropicLike & { calls: number } {
  const client = {
    calls: 0,
    messages: {
      create: async () => {
        client.calls += 1;
        return { content: [{ type: 'text', text: JSON.stringify(payload) }], stop_reason: 'end_turn' };
      },
    },
  };
  return client;
}

async function contextFor(caseId: string): Promise<{ context: RepairContext; teardown: () => Promise<void> }> {
  const publicCase = await loadPublicCase(caseId);
  const workspace = await materializeCase(publicCase);
  const detection = await runEndToEndDetection(publicCase, workspace);
  // The same configuration `eval/src/bench.ts` runs every repair track under.
  const config = DriftConfigSchema.parse({
    mode: 'auto',
    // `review` — the default — proposes every fix plan and applies none, so
    // the tier could never be measured under it. `proven` is the most
    // conservative setting that lets it act at all: only plans whose every
    // operation swaps one token for another of the same kind, anchored to an
    // occurrence Drift localized itself. A plan that changes expression
    // structure still needs the project's own checks to have passed, which
    // `verified` would be required for and which this benchmark does not
    // enable — so results here understate what a `verified` configuration
    // could apply, rather than overstating it.
    remediation: { fixPlans: { autoApply: 'proven' } },
    evidence: { typeSurface: true },
    verification: { behavioural: { enabled: true, network: false, timeoutSeconds: 20 } },
  });

  return {
    context: {
      publicCase,
      workspace,
      plan: detection.plan as unknown as RemediationPlan,
      config,
      logger: SILENT,
      observedCommands: [],
    },
    teardown: () => workspace.teardown(),
  };
}

/**
 * `npm-documented-rename` is the accepted-path case, and the choice is not
 * incidental. Drift's fix-plan gate refuses any replacement name the cited
 * evidence does not state, so on a case with no retrievable prose — which is
 * every other synthetic case here — no model-authored plan can ever be
 * accepted however correct it is. That refusal is the gate working; testing the
 * accepted path needs a case whose evidence actually attests the replacement.
 */
test('a freshly authored plan is the plan that gets applied, by Drift’s own executor', { timeout: 300_000 }, async () => {
  const { context, teardown } = await contextFor('npm-documented-rename');
  try {
    assert.ok(
      context.plan.commits.length > 0 && context.plan.commits.every((commit) => !commit.fixPlan),
      'the initial production plan must carry no fix plan, or this test is not testing what it claims',
    );

    const client = stubClient({
      applicable: true,
      migration: 'fixture-lib renamed oldQuery to query.',
      rationale: 'The changelog states oldQuery has been renamed to query.',
      citations: context.plan.breakingChanges.flatMap((change) => change.citations),
      ops: [{ kind: 'rename-member', from: 'oldQuery', to: 'query' }],
    });

    const outcome = await runModelFixPlanTrack(context, { client });

    assert.ok(client.calls > 0, 'the model authoring path must actually have been invoked');
    assert.equal(outcome.repair.attempted, true, `expected a repair, got ${outcome.repair.notAttemptedReason}`);
    assert.equal(outcome.repair.fixPlan?.proposal, 'produced');
    assert.equal(outcome.repair.fixPlan?.proposalSource, 'model');
    assert.equal(outcome.repair.fixPlan?.validation, 'accepted');
    assert.deepEqual(
      outcome.repair.fixPlan?.operations.map((op) => op.kind),
      ['rename-member'],
      'the applied plan must be the operations the model authored',
    );
    assert.deepEqual(outcome.repair.changedFiles, ['src/app.js']);
    assert.deepEqual(
      outcome.repair.resolvedByTier.map((entry) => entry.tier),
      ['fixplan-model'],
    );
    assert.deepEqual(outcome.repair.scopeEscapeFiles, []);

    // The executor's own output, not a benchmark rewrite: the identifier the
    // model named is the one that changed, and nothing else moved.
    const source = await readFile(join(context.workspace.root, 'src', 'app.js'), 'utf8');
    assert.match(source, /fixture\.query\(name\)/);
    assert.doesNotMatch(source, /oldQuery/);
    assert.match(outcome.repair.patch, /^diff --git /m);

    assert.equal(outcome.provenance?.provider, 'Anthropic');
    assert.equal(outcome.provenance?.agentId, 'fixplan-model');
  } finally {
    await teardown();
  }
});

test('a hallucinated replacement is rejected by the gate and never applied', { timeout: 300_000 }, async () => {
  const { context, teardown } = await contextFor('npm-member-rename');
  try {
    const before = await readFile(join(context.workspace.root, 'src', 'app.js'), 'utf8');
    const client = stubClient({
      applicable: true,
      migration: 'fixture-lib renamed oldQuery to fetchRecordsV2.',
      rationale: 'Recalled from the package’s release history.',
      citations: context.plan.breakingChanges[0]!.citations,
      ops: [{ kind: 'rename-member', from: 'oldQuery', to: 'fetchRecordsV2' }],
    });

    const outcome = await runModelFixPlanTrack(context, { client });

    assert.ok(client.calls > 0);
    assert.equal(outcome.repair.attempted, false);
    assert.equal(outcome.repair.fixPlan?.proposal, 'produced', 'a proposal existed; the gate is what stopped it');
    assert.equal(outcome.repair.fixPlan?.validation, 'rejected');
    assert.ok((outcome.repair.fixPlan?.rejections.length ?? 0) > 0, 'the gate must say why');
    assert.equal(outcome.repair.patch, '');
    assert.deepEqual(outcome.repair.changedFiles, []);

    const after = await readFile(join(context.workspace.root, 'src', 'app.js'), 'utf8');
    assert.equal(after, before, 'a rejected plan must leave the workspace untouched');
  } finally {
    await teardown();
  }
});

test('a model that declines is an abstention, not a failure, and is not recorded as a repair', { timeout: 300_000 }, async () => {
  const { context, teardown } = await contextFor('npm-member-rename');
  try {
    const client = stubClient({
      applicable: false,
      migration: '',
      rationale: 'This migration cannot be expressed as a mechanical rule.',
      citations: [],
      ops: [],
    });

    const outcome = await runModelFixPlanTrack(context, { client });

    assert.ok(client.calls > 0);
    assert.equal(outcome.repair.attempted, false);
    assert.equal(outcome.repair.fixPlan?.proposal, 'declined-not-applicable');
    assert.equal(outcome.repair.fixPlan?.validation, 'not-run');
  } finally {
    await teardown();
  }
});

test('with no model configured nothing is attempted and no model invocation is recorded', { timeout: 300_000 }, async () => {
  const { context, teardown } = await contextFor('npm-member-rename');
  try {
    const outcome = await runModelFixPlanTrack(context, { client: null });
    assert.equal(outcome.repair.attempted, false);
    assert.equal(outcome.repair.notAttemptedReason, 'model-unavailable');
    assert.equal(outcome.provenance, undefined, 'no model ran, so no model provenance may be written');
  } finally {
    await teardown();
  }
});
