import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { foldForWholeUpgrade, typecheckFailed } from '../src/fix.js';
import { CLEAN_TYPECHECK_MARKER } from '../src/diagnostics-digest.js';
import { renderCommitAgentPrompt } from '../../src/agents/types.js';
import type { CommitUnit, RemediationPlan } from '../../src/types.js';

/**
 * What "Fix with AI" fixes, at every place it can be pressed.
 *
 * Measured on ten real upgrades, handing an agent one planned unit at a time,
 * confined to that unit's files, fixed none of them where the same agent
 * working the upgrade whole fixed nearly all. So an agent unit may now change
 * any file its fix needs. What it is asked to fix is still exactly what the
 * developer chose: the whole upgrade, one package's upgrade, or one concern.
 */

const unit = (order: number, id: string, extra: Partial<CommitUnit> = {}): CommitUnit =>
  ({
    id,
    order,
    message: `fix: concern ${order}`,
    body: '',
    breakingChangeIds: [`bc${order}`],
    files: [`src/f${order}.ts`],
    allowedFiles: [`src/f${order}.ts`],
    instructions: '',
    dependsOn: [],
    dependencyReasons: [],
    executionLayer: 0,
    expectedChecks: [],
    invalidationTriggers: [],
    ...extra,
  }) as CommitUnit;

const plan = (commits: CommitUnit[], changes = [{ name: 'lru-cache', from: '7.18.3', to: '10.4.3' }]): RemediationPlan =>
  ({
    changes,
    commits,
    breakingChanges: commits.flatMap((c) => c.breakingChangeIds.map((id) => ({ id, summary: `${id} changed`, dependency: changes[0]!.name, kind: 'removed-export', symbols: [], citations: [], confidence: 'high', remediation: '' }))),
    impactSites: commits.map((c) => ({ breakingChangeId: c.breakingChangeIds[0], file: c.files[0], line: 1, excerpt: '', matchedSymbol: 'x', confidence: 'high' })),
    evidence: [],
  }) as unknown as RemediationPlan;

describe('fixing everything, or one package', () => {
  test('is one agent unit carrying every finding, after the units Drift solves deterministically', () => {
    const codemod = unit(1, 'c1', { codemod: [{ ruleId: 'rename-identifier' }] as never });
    const folded = foldForWholeUpgrade(plan([codemod, unit(2, 'c2'), unit(3, 'c3', { executionLayer: 1 })]));
    assert.deepEqual(folded.commits.map((c) => c.id), ['c1', 'upgrade']);
    const whole = folded.commits[1]!;
    assert.deepEqual([...whole.breakingChangeIds].sort(), ['bc1', 'bc2', 'bc3']);
    assert.equal(whole.executionLayer, 1, 'after the deterministic unit');
    assert.equal(whole.order, 2, 'a row of its own in the panel, not colliding with the codemod row');
  });

  test('folding twice changes nothing, so the rows the panel draws are the units that run', () => {
    const once = foldForWholeUpgrade(plan([unit(1, 'c1'), unit(2, 'c2')]));
    assert.equal(foldForWholeUpgrade(once), once);
  });

  test('a package chosen on its own is asked to fix only what that package broke', () => {
    const whole = foldForWholeUpgrade(plan([unit(1, 'c1')], [{ name: 'ajv', from: '6.15.0', to: '8.20.0' }]));
    const prompt = renderCommitAgentPrompt({ plan: whole, commit: whole.commits.at(-1)!, files: [], mode: 'upgrade' } as never);
    assert.match(prompt, /What upgrading ajv broke in this repository — and only that/);
    assert.match(prompt, /Leave those alone; they\s+are not this task/);
  });
});

describe('fixing one concern', () => {
  test('is asked to fix only that concern, and may reach another file only where that fix needs it', () => {
    const concern = unit(2, 'c2');
    const prompt = renderCommitAgentPrompt({ plan: plan([unit(1, 'c1'), concern]), commit: concern, files: [], mode: 'upgrade' } as never);
    assert.match(prompt, /Only this: fix: concern 2\./);
    assert.match(prompt, /Leave every other concern/);
    assert.match(prompt, /change another\s+file only where this fix needs it/);
    assert.doesNotMatch(prompt, /You may edit ONLY/);
  });
});

describe('when there is work at all', () => {
  test('a failing typecheck is work even with nothing planned, and a clean or absent one is not', () => {
    assert.equal(typecheckFailed('`tsc` reports 2 errors across 1 file.\nsrc/a.ts(3,1): error TS2351'), true);
    assert.equal(typecheckFailed(`\`tsc\` passes against the upgraded dependencies — it ${CLEAN_TYPECHECK_MARKER}.`), false);
    assert.equal(typecheckFailed(undefined), false);
    assert.equal(typecheckFailed(''), false);
  });
});
