import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPublicCase } from '../case/load.ts';
import { materializeCase } from '../case/materialize.ts';
import { runCaseStage } from './stage.ts';
import { diagnosticKindOf } from './reproducibility.ts';
import type { HiddenCheck } from '../case/schema.ts';

/**
 * The adversarial half of hidden behavioural checks: what happens when the
 * check itself cannot run.
 *
 * A hidden check is an assertion about the consumer's behaviour, and the whole
 * mechanism's authority rests on the difference between two statements — "the
 * behaviour is gone" and "we could not look". The stage used to collapse them:
 * a check whose command could not be spawned observed `unable-to-run`, that
 * was compared against the check's `expect: pass`, found unequal, and recorded
 * as an ordinary behavioural violation. A missing interpreter on the machine
 * therefore failed the stage, entered the failure signature, and was charged
 * to whatever repair happened to be under test.
 *
 * These run against the real `runCaseStage` on a real case rather than a
 * mocked one, because the defect lived in the seam between the check runner
 * and the stage's own outcome, and a mock of either would have reproduced the
 * seam rather than the bug.
 */

const CASE_ID = 'npm-member-rename';
const STAGE_TIMEOUT = 600_000;

/** A check whose command names a binary that does not exist on any machine. */
const UNSPAWNABLE: HiddenCheck = {
  id: 'unspawnable',
  description: 'A check whose interpreter is not installed.',
  command: 'drift-nonexistent-interpreter-9d3f hidden/behaviour.mjs',
  expect: 'pass',
  provenance: 'benchmark-added',
  files: { 'hidden/behaviour.mjs': 'process.exit(0);\n' },
};

/** A check that runs perfectly well and reports the behaviour is gone. */
const FAILING: HiddenCheck = {
  id: 'genuinely-failing',
  description: 'A check that executes and finds the behaviour missing.',
  command: 'node hidden/behaviour.mjs',
  expect: 'pass',
  provenance: 'benchmark-added',
  files: { 'hidden/behaviour.mjs': "throw new Error('the behaviour is gone');\n" },
};

test(
  'a hidden check that cannot be executed makes the stage unable-to-run, not failed',
  { timeout: STAGE_TIMEOUT },
  async () => {
    const publicCase = await loadPublicCase(CASE_ID);
    const workspace = await materializeCase(publicCase);
    try {
      const stage = await runCaseStage(publicCase, workspace, {
        stage: 'baseline',
        command: publicCase.oracles.baseline.command,
        expected: 'pass',
        dependencyVersion: 'old',
        hiddenChecks: [UNSPAWNABLE],
      });

      assert.equal(stage.observed, 'unable-to-run');
      assert.equal(stage.matchesExpectation, false);
      // Nothing may enter the signature: an assertion that never ran has not
      // observed a failure, and a fabricated identity here would flow straight
      // into the trigger set and be charged to a repair.
      assert.deepEqual(stage.signature, []);
      assert.match(stage.outputExcerpt, /could not be executed/);
    } finally {
      await workspace.teardown();
    }
  },
);

test(
  'a hidden check that runs and fails is still an ordinary stage failure',
  { timeout: STAGE_TIMEOUT },
  async () => {
    const publicCase = await loadPublicCase(CASE_ID);
    const workspace = await materializeCase(publicCase);
    try {
      const stage = await runCaseStage(publicCase, workspace, {
        stage: 'baseline',
        command: publicCase.oracles.baseline.command,
        expected: 'pass',
        dependencyVersion: 'old',
        hiddenChecks: [FAILING],
      });

      assert.equal(stage.observed, 'fail', 'an assertion that ran and failed is a result about the code');
      assert.ok(
        stage.signature.some((id) => id.startsWith('hidden:genuinely-failing:')),
        `the failure must be in the signature, got ${JSON.stringify(stage.signature)}`,
      );
    } finally {
      await workspace.teardown();
    }
  },
);

/*
 * The second half of the same defect, one layer up: how a hidden diagnostic is
 * *classified* once it is in a signature.
 */

test('a hidden diagnostic keeps its own inner kind rather than being read off the hidden: prefix', () => {
  assert.equal(diagnosticKindOf('hidden:preserves-shout:runtime:TypeError:x is not a function'), 'runtime');
  assert.equal(diagnosticKindOf('hidden:preserves-shout:test:resolves the renamed export'), 'test');
  assert.equal(diagnosticKindOf('hidden:preserves-shout:tsc:TS2551:src/app.ts:nope'), 'tsc');
  assert.equal(diagnosticKindOf('hidden:preserves-shout:process:exit:1'), 'process');
});

test('an ordinary diagnostic is unaffected', () => {
  assert.equal(diagnosticKindOf('tsc:TS2551:src/app.ts:nope'), 'tsc');
  assert.equal(diagnosticKindOf('runtime:TypeError:x is not a function'), 'runtime');
  assert.equal(diagnosticKindOf('test:resolves the renamed export'), 'test');
  assert.equal(diagnosticKindOf('process:exit:1'), 'process');
});
