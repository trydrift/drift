import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadPublicCase } from '../case/load.ts';
import { materializeCase } from '../case/materialize.ts';
import { loadHiddenChecks } from './hidden.ts';
import { runCaseStage } from './stage.ts';
import { scoreRepair } from '../evaluator/repair.ts';
import type { OracleStageArtifact, RepairArtifact } from '../artifacts/prediction.ts';
import type { Conclusion } from '../review.ts';

/**
 * The attack this benchmark has to survive, run against the real oracle rather
 * than against a mocked verdict.
 *
 * A failure signature is set algebra over three stages, and set algebra cannot
 * see deleted behaviour: emptying the file that called the changed API removes
 * the trigger diagnostic, leaves `npm test` exiting 0, and reads exactly like a
 * migration. Every prior benchmark in this space is defeated by that, and so is
 * signature comparison on its own — which is why the README says signatures
 * prevent *failure substitution* and names hidden behavioural checks as the
 * layer that prevents deletion.
 *
 * Four candidate repairs go through the actual `runCaseStage` -> `scoreRepair`
 * path on the actual `npm-member-rename` case: the correct migration, a
 * semantically different but behaviourally equivalent one, a wrong replacement,
 * and three destructive ones. Only the first two may be credited.
 */

const CASE_ID = 'npm-member-rename';
const STAGE_TIMEOUT = 600_000;

const TRUTH: Conclusion = {
  upstreamFindings: ['fixture-lib:oldQuery:renamed-export'],
  impactSites: ['src/app.js:oldQuery'],
  gaps: [],
  groundTruthSafety: 'unsafe',
  repair: { expectedAction: 'agent-delegation', expectedChangedFiles: ['src/app.js'] },
};

/** The consumer as a repair left it. Written straight into the disposable copy the stage makes. */
interface Candidate {
  name: string;
  source: string;
  expected: 'repaired' | 'not-repaired';
}

const CANDIDATES: Candidate[] = [
  {
    name: 'the correct migration',
    source: `import * as fixture from 'fixture-lib';

export function shout(name) {
  return fixture.query(name);
}

const value = shout('Ada');
if (value !== 'ADA') {
  throw new Error(\`expected ADA, got \${value}\`);
}
`,
    expected: 'repaired',
  },
  {
    name: 'a semantically equivalent migration that reads nothing like the gold patch',
    source: `import { query as renamedQuery } from 'fixture-lib';

export const shout = (name) => renamedQuery(\`\${name}\`);

if (shout('Ada') !== 'ADA') {
  throw new Error('the upgrade changed what shout() returns');
}
`,
    expected: 'repaired',
  },
  {
    name: 'a wrong replacement that swaps one real failure for another',
    source: `import * as fixture from 'fixture-lib';

export function shout(name) {
  return fixture.queryAll(name);
}

const value = shout('Ada');
if (value !== 'ADA') {
  throw new Error(\`expected ADA, got \${value}\`);
}
`,
    expected: 'not-repaired',
  },
  {
    name: 'destructive: the consumer file is emptied',
    source: '',
    expected: 'not-repaired',
  },
  {
    name: 'destructive: the call and its assertion are deleted',
    source: `import * as fixture from 'fixture-lib';

export function shout(name) {
  return fixture.oldQuery(name);
}
`,
    expected: 'not-repaired',
  },
  {
    name: 'destructive: the module returns before the failing behaviour runs',
    source: `import * as fixture from 'fixture-lib';

export function shout(name) {
  if (true) return 'ADA';
  return fixture.oldQuery(name);
}

const value = shout('Ada');
if (value !== 'ADA') {
  throw new Error(\`expected ADA, got \${value}\`);
}
`,
    expected: 'not-repaired',
  },
];

function repairArtifactFor(patch: string): RepairArtifact {
  return {
    attempted: true,
    notAttemptedReason: null,
    resolvedByTier: [{ commitId: 'unit-1', tier: 'test' }],
    patch,
    changedFiles: ['src/app.js'],
    scopeEscapeFiles: [],
    scopeValidationReasons: [],
    patchStats: { files: 1, hunks: 1, addedLines: 1, removedLines: 1 },
    residualImpactSites: 0,
  };
}

test('a destructive repair is never credited, and a valid alternative repair still is', { timeout: STAGE_TIMEOUT }, async () => {
  const publicCase = await loadPublicCase(CASE_ID);
  const hiddenChecks = await loadHiddenChecks(CASE_ID);
  assert.ok(hiddenChecks.length > 0, 'the case must carry at least one hidden behavioural check');

  const workspace = await materializeCase(publicCase);
  const results: { name: string; outcome: string }[] = [];

  try {
    const baseline = await runCaseStage(publicCase, workspace, {
      stage: 'baseline',
      command: publicCase.oracles.baseline.command,
      expected: publicCase.oracles.baseline.expect,
      dependencyVersion: 'old',
      hiddenChecks,
    });
    const broken = await runCaseStage(publicCase, workspace, {
      stage: 'broken',
      command: publicCase.oracles.broken.command,
      expected: publicCase.oracles.broken.expect,
      dependencyVersion: 'new',
      hiddenChecks,
    });

    assert.equal(baseline.observed, 'pass', 'the hidden check must pass before the upgrade, or it asserts something that was never true');
    assert.equal(broken.observed, 'fail');
    assert.ok(
      broken.signature.some((id) => id.startsWith('hidden:')),
      'the upgrade must break the hidden behavioural check, or the check cannot distinguish anything',
    );

    for (const candidate of CANDIDATES) {
      const repaired = await runCaseStage(publicCase, workspace, {
        stage: 'repaired',
        command: publicCase.oracles.repaired.command,
        expected: publicCase.oracles.repaired.expect,
        dependencyVersion: 'new',
        hiddenChecks,
        prepareConsumer: async (consumerDir) => {
          await writeFile(join(consumerDir, 'src', 'app.js'), candidate.source, 'utf8');
        },
      });

      const score = scoreRepair({
        caseId: CASE_ID,
        // A track that can delegate, so `agent-delegation` truth does not
        // short-circuit the classification before the oracle is consulted.
        track: 'repair-full-remediation',
        repair: repairArtifactFor(`diff --git a/src/app.js b/src/app.js\n${candidate.source}`),
        oracleStages: [baseline, broken, repaired] as OracleStageArtifact[],
        truth: TRUTH,
        developerPatch: null,
      });

      results.push({ name: candidate.name, outcome: score.outcome });

      if (candidate.expected === 'repaired') {
        assert.equal(score.outcome, 'repaired', `${candidate.name} should be credited, got ${score.outcome}`);
      } else {
        assert.notEqual(score.outcome, 'repaired', `${candidate.name} must not be credited as a repair`);
        assert.ok(score.scorable, `${candidate.name} must stay in the denominator rather than being excluded`);
      }
    }
  } finally {
    await workspace.teardown();
  }

  // Printed so a reader of the test output can see *which* outcome each attack
  // received, not merely that none of them said `repaired`.
  console.log(results.map((entry) => `  ${entry.outcome.padEnd(22)} ${entry.name}`).join('\n'));
});

/**
 * The control for the test above, and the reason the README's wording is what
 * it is.
 *
 * With hidden checks removed and nothing else changed, deleting the call to the
 * changed API scores `repaired`. That is not a defect in the signature
 * machinery — it is what signature comparison can and cannot establish, stated
 * as an executable fact so no future edit can quietly claim more for it.
 */
test('without a hidden behavioural check, deleting the broken call does score as a repair', { timeout: STAGE_TIMEOUT }, async () => {
  const publicCase = await loadPublicCase(CASE_ID);
  const workspace = await materializeCase(publicCase);

  try {
    const stages: OracleStageArtifact[] = [];
    for (const [stage, version, expect] of [
      ['baseline', 'old', publicCase.oracles.baseline.expect],
      ['broken', 'new', publicCase.oracles.broken.expect],
    ] as const) {
      stages.push(
        await runCaseStage(publicCase, workspace, {
          stage,
          command: publicCase.oracles[stage].command,
          expected: expect,
          dependencyVersion: version,
        }),
      );
    }

    const deletion = CANDIDATES.find((candidate) => candidate.name.includes('call and its assertion are deleted'))!;
    stages.push(
      await runCaseStage(publicCase, workspace, {
        stage: 'repaired',
        command: publicCase.oracles.repaired.command,
        expected: publicCase.oracles.repaired.expect,
        dependencyVersion: 'new',
        prepareConsumer: async (consumerDir) => {
          await writeFile(join(consumerDir, 'src', 'app.js'), deletion.source, 'utf8');
        },
      }),
    );

    const score = scoreRepair({
      caseId: CASE_ID,
      track: 'repair-full-remediation',
      repair: repairArtifactFor('diff --git a/src/app.js b/src/app.js\n'),
      oracleStages: stages,
      truth: TRUTH,
      developerPatch: null,
    });

    assert.equal(
      score.outcome,
      'repaired',
      'if this ever stops being `repaired`, the README claim that hidden checks are what stop deletion needs rewriting',
    );
  } finally {
    await workspace.teardown();
  }
});

test('the hidden check is not visible from the workspace a prediction or an agent sees', async () => {
  const publicCase = await loadPublicCase(CASE_ID);
  const workspace = await materializeCase(publicCase);
  try {
    const hidden = await readFile(join(workspace.root, 'hidden', 'behaviour.mjs'), 'utf8').catch(() => null);
    assert.equal(hidden, null, 'a hidden behavioural check must never be materialized into a prediction workspace');
  } finally {
    await workspace.teardown();
  }
});
