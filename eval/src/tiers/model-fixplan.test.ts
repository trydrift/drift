import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadPublicCase } from '../case/load.ts';
import { materializeCase } from '../case/materialize.ts';
import { runEndToEndDetection } from '../adapters/end-to-end.ts';
import { runFixPlanCacheTrack, runFixPlanRecipeTrack, runModelFixPlanTrack } from './model-fixplan.ts';
import type { RepairContext } from './context.ts';
import { DriftConfigSchema, type Logger, type RemediationPlan } from '../../../dist/index.js';
import type { AnthropicLike } from '../../../dist/analyze/llm.js';
import type { CommunityRecipeCandidate } from '../../../dist/remediation/types.js';

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

/* ------------------------------------------------------------------ *
 * The other two proposal sources.
 *
 * Everything after the proposal is shared with the model track and is already
 * covered above, so these test exactly what is different: that the source is
 * actually consulted through production's `resolveFixPlans`, that a plan from
 * it goes through the same gate, and that a track with no input says so
 * instead of reporting a zero.
 * ------------------------------------------------------------------ */

test('the cache track restores a plan an earlier run wrote, and revalidates it through the same gate', { timeout: 300_000 }, async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'drift-fixplan-cache-'));
  const authored = await contextFor('npm-documented-rename');

  try {
    // Populated the only honest way: an earlier model run whose plan the gate
    // accepted, written through production's own `cache.put`.
    const client = stubClient({
      applicable: true,
      migration: 'fixture-lib renamed oldQuery to query.',
      rationale: 'The changelog states oldQuery has been renamed to query.',
      citations: authored.context.plan.breakingChanges.flatMap((change) => change.citations),
      ops: [{ kind: 'rename-member', from: 'oldQuery', to: 'query' }],
    });
    const seeding = await runModelFixPlanTrack(authored.context, { client, cacheDir });
    assert.equal(seeding.repair.attempted, true, 'the seeding run must have produced an accepted plan');

    const cached = await readdir(cacheDir);
    assert.ok(cached.length > 0, 'production must have written the accepted plan to the cache');

    // A fresh workspace, no model at all, cache as the only proposal source.
    const replay = await contextFor('npm-documented-rename');
    try {
      const outcome = await runFixPlanCacheTrack(replay.context, { cacheDir });

      assert.equal(outcome.repair.attempted, true, `expected a repair, got ${outcome.repair.notAttemptedReason}`);
      assert.equal(outcome.repair.fixPlan?.proposalSource, 'cache');
      assert.equal(outcome.repair.fixPlan?.validation, 'accepted', 'a restored plan is revalidated, not trusted');
      assert.deepEqual(outcome.repair.changedFiles, ['src/app.js']);
      assert.deepEqual(
        outcome.repair.resolvedByTier.map((entry) => entry.tier),
        ['fixplan-cache'],
      );
      assert.equal(outcome.provenance, undefined, 'no model ran, so no model provenance may be written');

      const source = await readFile(join(replay.context.workspace.root, 'src', 'app.js'), 'utf8');
      assert.match(source, /fixture\.query\(name\)/);
    } finally {
      await replay.teardown();
    }
  } finally {
    await authored.teardown();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('a cache track with no cache reports that it had none, and is excluded from every rate', async () => {
  const { context, teardown } = await contextFor('npm-documented-rename');
  try {
    const outcome = await runFixPlanCacheTrack(context, {});
    assert.equal(outcome.repair.attempted, false);
    assert.equal(outcome.repair.notAttemptedReason, 'cache-unavailable');
    assert.equal(outcome.repair.patch, '');
  } finally {
    await teardown();
  }
});

test('a recipe track with no recipe candidate reports that it had none rather than a zero', async () => {
  const { context, teardown } = await contextFor('npm-documented-rename');
  try {
    const outcome = await runFixPlanRecipeTrack(context, {});
    assert.equal(outcome.repair.attempted, false);
    assert.equal(outcome.repair.notAttemptedReason, 'recipe-unavailable');
    assert.deepEqual(outcome.repair.resolvedByTier, []);
  } finally {
    await teardown();
  }
});

test('the recipe track re-derives a rule from a recipe’s own edits and puts it through the gate', { timeout: 300_000 }, async () => {
  const { context, teardown } = await contextFor('npm-documented-rename');

  try {
    const recipe: CommunityRecipeCandidate = {
      provider: 'codemod.com',
      name: '@drift-bench/fixture-lib-v2',
      version: '1.0.0',
      publisher: 'Drift benchmark',
      source: 'https://example.invalid/drift-bench/fixture-lib-v2',
      migration: 'Rename fixture-lib’s oldQuery to query.',
      official: false,
    };

    // A controlled stand-in for the third-party tool. `git` is passed straight
    // through, because production reads the sandbox's real git status to bound
    // what the recipe touched; only the recipe's own command is replaced, and
    // it makes exactly the edit a real recipe would make. Everything after
    // that — reading the diff, re-deriving a rule Drift can describe,
    // validating it against the localized sites — is production's.
    const exec = async (bin: string, args: string[], options?: { cwd?: string }) => {
      if (bin === 'git') {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const run = promisify(execFile);
        try {
          const { stdout, stderr } = await run(bin, args, { cwd: options?.cwd });
          return { code: 0, stdout, stderr };
        } catch (err) {
          const error = err as { stdout?: string; stderr?: string; code?: number };
          return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
        }
      }

      // The recipe writes into whatever sandbox production handed it, never
      // into the workspace — which is exactly the boundary being tested.
      const path = join(options?.cwd ?? context.workspace.root, 'src', 'app.js');
      await writeFile(path, (await readFile(path, 'utf8')).replace('fixture.oldQuery(', 'fixture.query('), 'utf8');
      return { code: 0, stdout: 'applied 1 file', stderr: '' };
    };

    const outcome = await runFixPlanRecipeTrack(context, { recipe, exec: exec as never });

    assert.equal(outcome.repair.attempted, true, `expected a repair, got ${outcome.repair.notAttemptedReason}`);
    assert.equal(outcome.repair.fixPlan?.proposalSource, 'recipe');
    assert.equal(outcome.repair.fixPlan?.validation, 'accepted', 'a recipe-derived rule is validated, not trusted');
    assert.deepEqual(
      outcome.repair.resolvedByTier.map((entry) => entry.tier),
      ['fixplan-recipe'],
    );
    assert.deepEqual(outcome.repair.changedFiles, ['src/app.js']);
    assert.equal(outcome.provenance, undefined, 'no model ran, so no model provenance may be written');
  } finally {
    await teardown();
  }
});
