import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { clearedByCompiler } from '../src/fix.js';
import { CLEAN_TYPECHECK_MARKER } from '../src/diagnostics-digest.js';
import type { BreakingChange, CommitUnit, RemediationPlan } from '../../src/types.js';
import type { ChangeDetectability } from '../../src/confidence/taxonomy.js';

/**
 * Not asking an agent a question the compiler has already answered.
 *
 * Drift predicts breakage from published type surfaces; a typecheck against
 * the installed upgrade measures it. When the two disagree and the change is
 * one a compiler can see, the compiler read the declarations that actually
 * shipped and is right. Drift was already running that check, already telling
 * the agent to "change nothing you cannot justify" — and then dispatching an
 * agent per commit unit anyway, each spending thousands of tokens to
 * rediscover that the code was fine.
 *
 * The asymmetry below is the whole design. Skipping a needless run saves
 * tokens; skipping a real one ships a break, so anything a typecheck cannot
 * see stays loud no matter how green the compile was.
 */

const CLEAN = `\`typecheck\` passes against the upgraded dependencies — it ${CLEAN_TYPECHECK_MARKER}.`;
const FAILING = '`typecheck` reports 3 errors across 2 files.';

function planWith(detectability: ChangeDetectability[]): { plan: RemediationPlan; commit: CommitUnit } {
  const change = {
    id: 'bc1',
    kind: 'signature-change',
    summary: 'The signature of `array` changed.',
    symbols: ['array'],
    taxonomy: {
      nature: 'type-contract',
      detectability,
      scope: 'symbol',
      visibility: ['direct'],
      origin: 'computed',
    },
  } as unknown as BreakingChange;

  const commit = {
    id: 'c1',
    order: 1,
    message: 'refactor(zod): update array',
    body: '',
    breakingChangeIds: ['bc1'],
    files: ['src/schema.ts'],
    allowedFiles: ['src/schema.ts'],
    instructions: '',
    dependsOn: [],
    dependencyReasons: [],
    executionLayer: 0,
    expectedChecks: [],
    invalidationTriggers: [],
  } as unknown as CommitUnit;

  const plan = {
    changes: [change],
    commits: [commit],
    impactSites: [
      { file: 'src/schema.ts', line: 4, symbol: 'array' },
      { file: 'src/schema.ts', line: 9, symbol: 'array' },
    ],
  } as unknown as RemediationPlan;

  return { plan, commit };
}

describe('not running an agent the compiler already answered', () => {
  test('a green typecheck clears a compile-time change', () => {
    const { plan, commit } = planWith(['compile-time', 'static-semantic']);
    const reason = clearedByCompiler(commit, plan, CLEAN);

    assert.ok(reason, 'the question was answered before the agent was asked');
    assert.match(reason!, /typecheck passes/);
    assert.match(reason!, /`array`/, 'it names what it cleared');
    assert.match(reason!, /2 predicted sites/, 'and how much it covers');
  });

  test('a green typecheck does NOT clear a runtime behaviour change', () => {
    const { plan, commit } = planWith(['runtime-only']);

    assert.equal(
      clearedByCompiler(commit, plan, CLEAN),
      null,
      'a default that moved is invisible to tsc; skipping it on a green compile ships the break',
    );
  });

  test('one runtime change in the unit keeps the whole unit', () => {
    const { plan, commit } = planWith(['compile-time']);
    plan.changes.push({
      ...plan.changes[0]!,
      id: 'bc2',
      taxonomy: { ...plan.changes[0]!.taxonomy!, detectability: ['test-time'] },
    });
    commit.breakingChangeIds.push('bc2');

    assert.equal(clearedByCompiler(commit, plan, CLEAN), null, 'every change must be one the compiler can see');
  });

  test('a failing typecheck clears nothing', () => {
    const { plan, commit } = planWith(['compile-time']);
    assert.equal(clearedByCompiler(commit, plan, FAILING), null);
  });

  test('no typecheck at all clears nothing', () => {
    const { plan, commit } = planWith(['compile-time']);
    assert.equal(clearedByCompiler(commit, plan, undefined), null, 'absence of evidence is not evidence');
  });

  test('a unit with no change to reason about is not cleared', () => {
    const { plan, commit } = planWith(['compile-time']);
    commit.breakingChangeIds = [];

    assert.equal(clearedByCompiler(commit, plan, CLEAN), null, 'nothing to check is not the same as checked');
  });
});
