/**
 * The canonical breaking-change disposition — the single downstream authority
 * for what one localized change means for this repository.
 *
 * The invariant these tests exist to defend: review-only evidence is neither
 * actionable nor an all-clear, and an unresolved runtime never erases an
 * independent API impact on the same candidate.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveBreakingChangeDispositions, isActionableImpact } from '../dist/disposition.js';
import { completeRuntimeAnalyses } from '../dist/rationale/compatibility.js';
import { planCommitGraph } from '../dist/plan/commits.js';
import { DEFAULT_CONFIG } from '../dist/config/schema.js';

const apiChange = (id = 'bc_api', overrides: Record<string, unknown> = {}) => ({
  id,
  dependency: 'pkg',
  kind: 'removed-export' as const,
  summary: '`gone` was removed',
  remediation: 'stop using it',
  symbols: ['gone'],
  confidence: 'high' as const,
  citations: ['ev'],
  ...overrides,
});

const runtimeChange = (id = 'bc_rt', runtime = 'node', overrides: Record<string, unknown> = {}) => ({
  id,
  dependency: 'pkg',
  kind: 'runtime-requirement' as const,
  summary: `requires ${runtime} >=20`,
  remediation: 'raise the declared runtime',
  symbols: [runtime],
  confidence: 'high' as const,
  citations: ['ev'],
  runtime: { kind: 'minimum-runtime', runtime, requirement: '>=20', sourceText: `${runtime} >=20` },
  ...overrides,
});

const site = (breakingChangeId: string, confidence: 'high' | 'medium' | 'low', extra: Record<string, unknown> = {}) => ({
  breakingChangeId,
  file: `src/${breakingChangeId}.ts`,
  line: 1,
  excerpt: 'x',
  matchedSymbol: 'gone',
  confidence,
  ...extra,
});

const rt = (changeId: string, state: string, reason: string, runtime = 'node') => ({
  changeId,
  runtime,
  state,
  reason,
});

const only = <T,>(list: readonly T[]): T => {
  assert.equal(list.length, 1, `expected exactly one, got ${list.length}`);
  return list[0]!;
};

describe('deriveBreakingChangeDispositions: API findings', () => {
  test('a high-confidence API hit is actionable', () => {
    const d = only(deriveBreakingChangeDispositions([apiChange()], [site('bc_api', 'high')], [], true));
    assert.equal(d.state, 'actionable');
    assert.equal(d.reason, 'high-confidence-impact');
    assert.equal(d.sites.length, 1);
    assert.equal(d.actionableSites.length, 1);
  });

  test('a low-confidence API hit is review-only, not actionable and not an all-clear', () => {
    const d = only(deriveBreakingChangeDispositions([apiChange()], [site('bc_api', 'low')], [], true));
    assert.equal(d.state, 'review-only');
    assert.equal(d.reason, 'low-confidence-impact');
    assert.equal(d.sites.length, 1, 'the site is still explained');
    assert.equal(d.actionableSites.length, 0, 'but it may not drive an edit');
  });

  test('no hit after a completed localization is impact-unresolved, never unaffected', () => {
    // A completed syntactic search that found nothing is not affirmative
    // evidence the change cannot reach this repository — structural typing,
    // inferred types, wrappers, generated code, dynamic dispatch, behavioural
    // changes and ownership relationships all defeat it. Only an authoritative
    // verification can turn this into an all-clear.
    const d = only(deriveBreakingChangeDispositions([apiChange()], [], [], true));
    assert.equal(d.state, 'unknown');
    assert.equal(d.reason, 'impact-unresolved');
  });

  test('an authoritative verification clearing the change makes a zero-hit search unaffected', () => {
    const d = only(
      deriveBreakingChangeDispositions([apiChange()], [], [], true, true, new Set(['bc_api'])),
    );
    assert.equal(d.state, 'unaffected');
    assert.equal(d.reason, 'no-local-impact');
  });

  test('no hit and localization never ran is unknown, never unaffected', () => {
    const d = only(deriveBreakingChangeDispositions([apiChange()], [], [], false));
    assert.equal(d.state, 'unknown');
    assert.equal(d.reason, 'not-localized');
  });

  test('no hit in a partial localization is unknown, never unaffected', () => {
    const d = only(deriveBreakingChangeDispositions([apiChange()], [], [], true, false));
    assert.equal(d.state, 'unknown');
    assert.equal(d.reason, 'localization-incomplete');
  });

  test('a positive hit remains actionable in a partial localization', () => {
    const d = only(deriveBreakingChangeDispositions([apiChange()], [site('bc_api', 'high')], [], true, false));
    assert.equal(d.state, 'actionable');
  });
});

describe('deriveBreakingChangeDispositions: runtime findings resolve per change id', () => {
  const cases: Array<[string, string, string, string]> = [
    ['incompatible', 'violates', 'actionable', 'runtime-incompatible'],
    ['partial', 'overlaps', 'review-only', 'runtime-partial'],
    ['unknown', 'no-declaration', 'review-only', 'runtime-unknown'],
    ['compatible', 'satisfies', 'unaffected', 'runtime-compatible'],
  ];
  for (const [state, reason, expectState, expectReason] of cases) {
    test(`runtime ${state} -> ${expectState}`, () => {
      const change = runtimeChange();
      const sites = [site('bc_rt', 'high', { runtimeVerdict: state === 'incompatible' ? 'incompatible' : state })];
      const d = only(deriveBreakingChangeDispositions([change], sites, [rt('bc_rt', state, reason)], true));
      assert.equal(d.state, expectState);
      assert.equal(d.reason, expectReason);
      assert.equal(d.runtimeAnalysis?.state, state);
      if (expectState === 'actionable') assert.ok(d.actionableSites.length > 0);
      else assert.equal(d.actionableSites.length, 0);
    });
  }

  test('a runtime change with no analysis is unknown / not-localized, never compatible', () => {
    const d = only(deriveBreakingChangeDispositions([runtimeChange()], [], [], true));
    assert.equal(d.state, 'unknown');
    assert.equal(d.reason, 'not-localized');
  });

  test('a duplicated runtime analysis does not resolve to a single verdict', () => {
    const d = only(
      deriveBreakingChangeDispositions(
        [runtimeChange()],
        [],
        [rt('bc_rt', 'compatible', 'satisfies'), rt('bc_rt', 'incompatible', 'violates')],
        true,
      ),
    );
    assert.equal(d.state, 'unknown', 'ambiguous coverage is never an all-clear');
  });

  test('a runtime card never reads a sibling change’s worse verdict', () => {
    const changes = [runtimeChange('bc_rt_a', 'node'), runtimeChange('bc_rt_b', 'python')];
    const analyses = [rt('bc_rt_a', 'compatible', 'satisfies', 'node'), rt('bc_rt_b', 'incompatible', 'violates', 'python')];
    const ds = deriveBreakingChangeDispositions(changes, [], analyses, true);
    assert.equal(ds.find((d) => d.changeId === 'bc_rt_a')?.state, 'unaffected');
    assert.equal(ds.find((d) => d.changeId === 'bc_rt_b')?.state, 'actionable');
  });
});

describe('deriveBreakingChangeDispositions: mixed API + runtime candidates', () => {
  test('API actionable + runtime unknown: both dispositions stand on their own', () => {
    const changes = [apiChange('bc_api'), runtimeChange('bc_rt')];
    const sites = [site('bc_api', 'high'), site('bc_rt', 'high', { runtimeVerdict: 'unknown' })];
    const ds = deriveBreakingChangeDispositions(changes, sites, [rt('bc_rt', 'unknown', 'dynamic')], true);
    assert.equal(ds.find((d) => d.changeId === 'bc_api')?.state, 'actionable');
    assert.equal(ds.find((d) => d.changeId === 'bc_rt')?.state, 'review-only');
  });

  test('API review-only + runtime compatible: no actionable site anywhere, still not a clean bill', () => {
    const changes = [apiChange('bc_api'), runtimeChange('bc_rt')];
    const sites = [site('bc_api', 'low'), site('bc_rt', 'high', { runtimeVerdict: 'compatible' })];
    const ds = deriveBreakingChangeDispositions(changes, sites, [rt('bc_rt', 'compatible', 'satisfies')], true);
    assert.equal(ds.find((d) => d.changeId === 'bc_api')?.state, 'review-only');
    assert.equal(ds.find((d) => d.changeId === 'bc_rt')?.state, 'unaffected');
    assert.equal(ds.flatMap((d) => d.actionableSites).length, 0);
    assert.ok(ds.some((d) => d.state === 'review-only'));
  });

  test('API actionable + runtime partial: the API edit is not suppressed by the partial runtime', () => {
    const changes = [apiChange('bc_api'), runtimeChange('bc_rt')];
    const sites = [site('bc_api', 'high'), site('bc_rt', 'high', { runtimeVerdict: 'partial' })];
    const ds = deriveBreakingChangeDispositions(changes, sites, [rt('bc_rt', 'partial', 'overlaps')], true);
    assert.equal(ds.find((d) => d.changeId === 'bc_api')?.actionableSites.length, 1);
    assert.equal(ds.find((d) => d.changeId === 'bc_rt')?.state, 'review-only');
  });

  test('API zero-hit + runtime compatible: the runtime clears, the API stays unresolved', () => {
    const changes = [apiChange('bc_api'), runtimeChange('bc_rt')];
    const ds = deriveBreakingChangeDispositions(
      changes,
      [site('bc_rt', 'high', { runtimeVerdict: 'compatible' })],
      [rt('bc_rt', 'compatible', 'satisfies')],
      true,
    );
    assert.equal(ds.find((d) => d.changeId === 'bc_rt')?.state, 'unaffected');
    const api = ds.find((d) => d.changeId === 'bc_api');
    assert.equal(api?.state, 'unknown');
    assert.equal(api?.reason, 'impact-unresolved');
  });

  test('a verification clearing the API change is the genuine all-clear', () => {
    const changes = [apiChange('bc_api'), runtimeChange('bc_rt')];
    const ds = deriveBreakingChangeDispositions(
      changes,
      [site('bc_rt', 'high', { runtimeVerdict: 'compatible' })],
      [rt('bc_rt', 'compatible', 'satisfies')],
      true,
      true,
      new Set(['bc_api']),
    );
    assert.deepEqual(ds.map((d) => d.state).sort(), ['unaffected', 'unaffected']);
  });
});

describe('isActionableImpact', () => {
  test('only a high-confidence site for the same change can be actionable', () => {
    assert.equal(isActionableImpact(apiChange(), site('bc_api', 'high')), true);
    assert.equal(isActionableImpact(apiChange(), site('bc_api', 'low')), false);
    assert.equal(isActionableImpact(apiChange(), site('other', 'high')), false);
  });

  test('a runtime site is actionable only with a matching incompatible analysis', () => {
    const change = runtimeChange();
    assert.equal(isActionableImpact(change, site('bc_rt', 'high', { runtimeVerdict: 'incompatible' }), rt('bc_rt', 'incompatible', 'violates')), true);
    assert.equal(isActionableImpact(change, site('bc_rt', 'high'), rt('bc_rt', 'partial', 'overlaps')), false);
    assert.equal(isActionableImpact(change, site('bc_rt', 'high'), rt('other', 'incompatible', 'violates')), false);
    assert.equal(isActionableImpact(change, site('bc_rt', 'high')), false);
  });
});

describe('completeRuntimeAnalyses closes coverage without implying compatibility', () => {
  test('a missing analysis becomes an explicit unknown / not-analyzed', () => {
    const a = only(completeRuntimeAnalyses([runtimeChange()], []));
    assert.equal(a.state, 'unknown');
    assert.equal(a.reason, 'not-analyzed');
    assert.deepEqual(a.sites, []);
    assert.deepEqual(a.declarations, []);
  });

  test('a duplicate analysis is discarded in favour of an explicit unknown', () => {
    const dup = [rt('bc_rt', 'compatible', 'satisfies'), rt('bc_rt', 'compatible', 'satisfies')].map((r) => ({
      ...r,
      declarations: [],
      unresolved: [],
      sites: [],
      statement: 's',
    }));
    const a = only(completeRuntimeAnalyses([runtimeChange()], dup as never));
    assert.equal(a.reason, 'not-analyzed');
  });

  test('a mismatched runtime identity is not accepted as the answer', () => {
    const wrong = [{ ...rt('bc_rt', 'compatible', 'satisfies', 'python'), declarations: [{}], unresolved: [], sites: [], statement: 's' }];
    const a = only(completeRuntimeAnalyses([runtimeChange('bc_rt', 'node')], wrong as never));
    assert.equal(a.reason, 'not-analyzed');
    assert.equal(a.runtime, 'node');
  });

  test('the single matching analysis is passed through untouched', () => {
    const good = [{ ...rt('bc_rt', 'compatible', 'satisfies', 'node'), declarations: [{ file: '.nvmrc' }], unresolved: [], sites: [], statement: 's' }];
    const a = only(completeRuntimeAnalyses([runtimeChange('bc_rt', 'node')], good as never));
    assert.equal(a.state, 'compatible');
    assert.equal(a.reason, 'satisfies');
  });
});

describe('only an actionable disposition generates a fix commit', () => {
  const build = (changes: readonly unknown[], sites: readonly unknown[], analyses: readonly unknown[]) => {
    const dispositions = deriveBreakingChangeDispositions(changes as never, sites as never, analyses as never, true);
    const graph = planCommitGraph({
      breakingChanges: changes as never,
      impactSites: sites as never,
      dispositions,
      config: DEFAULT_CONFIG,
      changes: [],
    });
    return { dispositions, commits: graph.commits };
  };

  test('a high-confidence API hit produces a commit', () => {
    const { commits } = build([apiChange()], [site('bc_api', 'high')], []);
    assert.equal(commits.length, 1);
  });

  test('a low-confidence API hit produces no commit', () => {
    const { commits } = build([apiChange()], [site('bc_api', 'low')], []);
    assert.deepEqual(commits, []);
  });

  test('runtime incompatible produces a commit; partial, unknown, compatible do not', () => {
    assert.equal(
      build([runtimeChange()], [site('bc_rt', 'high', { runtimeVerdict: 'incompatible' })], [rt('bc_rt', 'incompatible', 'violates')]).commits.length,
      1,
    );
    for (const [state, reason] of [['partial', 'overlaps'], ['unknown', 'dynamic'], ['compatible', 'satisfies']] as const) {
      const verdict = state === 'compatible' ? 'compatible' : state;
      assert.deepEqual(
        build([runtimeChange()], [site('bc_rt', 'high', { runtimeVerdict: verdict })], [rt('bc_rt', state, reason)]).commits,
        [],
        `runtime ${state} must not generate a commit`,
      );
    }
  });
});
