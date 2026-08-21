import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  isLocallyUnprovable,
  normalizeProposedTaxonomy,
  taxonomyOf,
} from '../dist/confidence/taxonomy.js';
import {
  assess,
  assessLocalImpact,
  assessUpstream,
  assessVerification,
  deriveLegacyConfidence,
} from '../dist/confidence/calibrate.js';
import { bandFor } from '../dist/confidence/types.js';
import { buildPlan, isAutoDispatchable } from '../dist/plan/index.js';
import { renderApprovalIssue, renderPullRequestBody } from '../dist/report/markdown.js';
import { verdictFor, reduceVerdict, resolvePlanVerdict } from '../dist/report/confidence.js';
import { DriftConfigSchema, DEFAULT_CONFIG } from '../dist/config/schema.js';

/**
 * The confidence model exists to stop one specific over-claim: a finding proven
 * upstream presenting as a high-confidence reason to edit local code that
 * nothing had shown to be affected. Most of what follows is about keeping the
 * two questions apart.
 */

const repo = {
  owner: 'acme',
  repo: 'app',
  baseBranch: 'main',
  beforeSha: 'a'.repeat(40),
  afterSha: 'b'.repeat(40),
};

const dependencyChange = {
  name: 'acme-sdk',
  ecosystem: 'npm' as const,
  from: '1.0.0',
  to: '2.0.0',
  kind: 'runtime' as const,
  bump: 'major' as const,
  manifestPath: 'package.json',
};

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ev_1',
    source: 'type-surface-diff' as const,
    dependency: 'acme-sdk',
    title: 'API surface diff',
    content: '`createClient` removed',
    weight: 1,
    ...overrides,
  };
}

function breaking(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bc_1',
    dependency: 'acme-sdk',
    kind: 'removed-export' as const,
    summary: '`createClient` was removed',
    remediation: 'Use `create`',
    symbols: ['createClient'],
    confidence: 'high' as const,
    taxonomy: classify('removed-export', 'export-removed'),
    citations: ['ev_1'],
    ...overrides,
  };
}

function site(overrides: Record<string, unknown> = {}) {
  return {
    breakingChangeId: 'bc_1',
    file: 'src/a.ts',
    line: 3,
    excerpt: 'createClient()',
    matchedSymbol: 'createClient',
    confidence: 'high' as const,
    ...overrides,
  };
}

describe('taxonomy', () => {
  test('a computed finding code gives a precise classification', () => {
    const taxonomy = classify('removed-export', 'export-removed');
    assert.equal(taxonomy.origin, 'computed');
    assert.equal(taxonomy.nature, 'api-shape');
    assert.ok(taxonomy.detectability.includes('compile-time'));
  });

  test('an unrecognised finding code falls back to the kind mapping', () => {
    const taxonomy = classify('behaviour-change', 'no-such-code');
    assert.equal(taxonomy.origin, 'rule');
    assert.equal(taxonomy.nature, 'behaviour');
  });

  test('an unclassified change stays explicitly unclassified', () => {
    // "We could not tell" must not read as "nothing to worry about".
    const taxonomy = classify('unknown');
    assert.equal(taxonomy.origin, 'default');
    assert.deepEqual(taxonomy.visibility, ['unknown']);
    assert.ok(isLocallyUnprovable(taxonomy), 'an unknown change is not provable locally');
  });

  test('a behaviour change is not detectable at compile time', () => {
    // The distinction the whole taxonomy exists for.
    assert.ok(isLocallyUnprovable(classify('behaviour-change')));
    assert.ok(isLocallyUnprovable(classify('default-change')));
    assert.ok(!isLocallyUnprovable(classify('removed-export', 'export-removed')));
  });

  test('endpoint changes are only externally observable', () => {
    const taxonomy = classify('removed-endpoint', 'path-removed');
    assert.equal(taxonomy.nature, 'protocol');
    assert.ok(isLocallyUnprovable(taxonomy));
  });

  test('a finding without a taxonomy still reads as one', () => {
    const derived = taxonomyOf({ kind: 'signature-change' });
    assert.equal(derived.nature, 'type-contract');
  });

  describe('LLM proposals', () => {
    const fallback = classify('behaviour-change');

    test('a valid proposal is accepted and marked as such', () => {
      const result = normalizeProposedTaxonomy(
        {
          nature: 'data-schema',
          scope: 'type',
          detectability: ['runtime-only'],
          visibility: ['transitive'],
        },
        fallback,
      );
      assert.equal(result.origin, 'llm-normalized');
      assert.equal(result.nature, 'data-schema');
    });

    test('invented vocabulary is dropped, not coerced', () => {
      // A plausible-looking wrong label is worse than an absent one.
      const result = normalizeProposedTaxonomy(
        { nature: 'catastrophic', scope: 'everything', detectability: ['vibes'], visibility: ['aura'] },
        fallback,
      );
      assert.deepEqual(result, fallback, 'nothing survived, so the deterministic mapping stands');
    });

    test('partially invalid lists keep only the valid members', () => {
      const result = normalizeProposedTaxonomy(
        {
          nature: 'behaviour',
          scope: 'symbol',
          detectability: ['runtime-only', 'telepathy'],
          visibility: ['made-up'],
        },
        fallback,
      );
      assert.deepEqual(result.detectability, ['runtime-only']);
      assert.deepEqual(result.visibility, ['unknown'], 'an empty visibility is explicitly unknown');
    });

    test('a proposal missing a required field is rejected wholesale', () => {
      const result = normalizeProposedTaxonomy({ detectability: ['compile-time'] }, fallback);
      assert.deepEqual(result, fallback, 'half a classification is not a classification');
    });

    test('junk is rejected', () => {
      for (const junk of [null, undefined, 'string', 42, []]) {
        assert.deepEqual(normalizeProposedTaxonomy(junk, fallback), fallback);
      }
    });

    test('list order is normalized so digests stay stable', () => {
      const a = normalizeProposedTaxonomy(
        { nature: 'behaviour', scope: 'symbol', detectability: ['runtime-only', 'compile-time'], visibility: [] },
        fallback,
      );
      const b = normalizeProposedTaxonomy(
        { nature: 'behaviour', scope: 'symbol', detectability: ['compile-time', 'runtime-only'], visibility: [] },
        fallback,
      );
      assert.deepEqual(a.detectability, b.detectability);
    });
  });
});

describe('upstream confidence', () => {
  test('a computed artifact diff is high on its own', () => {
    const score = assessUpstream({ change: breaking(), evidence: [evidence()] });
    assert.equal(score.band, 'high');
    assert.ok(score.score >= 0.8);
  });

  test('a changelog alone is medium', () => {
    const score = assessUpstream({
      change: breaking({ citations: ['ev_log'] }),
      evidence: [evidence({ id: 'ev_log', source: 'changelog', content: '`createClient` removed', weight: 0.65 })],
    });
    assert.equal(score.band, 'medium');
  });

  test('a semver guess alone establishes nothing', () => {
    // A major version bump is a fact about a number. It is not evidence that
    // any *particular* thing broke, so it lands below even the `low` band —
    // and `analyze` declines to create findings from it for the same reason.
    const score = assessUpstream({
      change: breaking({ citations: ['ev_semver'] }),
      evidence: [evidence({ id: 'ev_semver', source: 'semver-heuristic', content: 'major bump', weight: 0.3 })],
    });
    assert.equal(score.band, 'none');
    assert.ok(score.penalties.some((p) => p.code === 'heuristic-only'));
  });

  test('a release note and a changelog do not corroborate each other', () => {
    // The bug this replaces: these are routinely the same text published twice,
    // and counting them as two agreeing sources took one unverified maintainer
    // sentence to `high`.
    const score = assessUpstream({
      change: breaking({ citations: ['ev_log', 'ev_release'] }),
      evidence: [
        evidence({ id: 'ev_log', source: 'changelog', content: '`createClient` removed', weight: 0.65 }),
        evidence({ id: 'ev_release', source: 'github-release', content: 'something else entirely', weight: 0.6 }),
      ],
    });

    assert.equal(score.band, 'medium', 'same origin class, so no corroboration bonus');
    assert.ok(score.penalties.some((p) => p.code === 'single-origin'));
  });

  test('a changelog and a computed diff do corroborate', () => {
    const score = assessUpstream({
      change: breaking({ citations: ['ev_log', 'ev_1'] }),
      evidence: [
        evidence({ id: 'ev_log', source: 'changelog', content: 'createClient removed', weight: 0.65 }),
        evidence(),
      ],
    });
    assert.equal(score.band, 'high');
    assert.ok(score.evidence.some((e) => e.code === 'corroborated'));
  });

  test('byte-identical evidence counts once regardless of declared source', () => {
    // A release body pasted verbatim into a changelog is one observation.
    const shared = 'The `createClient` export has been removed.';
    const score = assessUpstream({
      change: breaking({ citations: ['ev_log', 'ev_release'] }),
      evidence: [
        evidence({ id: 'ev_log', source: 'changelog', content: shared, weight: 0.65 }),
        evidence({ id: 'ev_release', source: 'migration-guide', content: `  ${shared.toUpperCase()}  `, weight: 0.7 }),
      ],
    });
    assert.ok(!score.evidence.some((e) => e.code === 'corroborated'), 'identical text is not corroboration');
  });

  test('a finding with no citations scores zero', () => {
    const score = assessUpstream({ change: breaking({ citations: [] }), evidence: [] });
    assert.equal(score.score, 0);
    assert.equal(score.band, 'none');
  });

  test('every score records the calibration that produced it', () => {
    const score = assessUpstream({ change: breaking(), evidence: [evidence()] });
    assert.ok(score.calibration.length > 0);
  });
});

describe('local impact confidence', () => {
  const taxonomy = classify('removed-export', 'export-removed');

  test('not searching is not a clean result', () => {
    const score = assessLocalImpact({
      change: breaking(),
      taxonomy,
      sites: [],
      localizationRan: false,
    });
    assert.equal(score.band, 'none');
    assert.ok(score.penalties.some((p) => p.code === 'localization-unavailable'));
  });

  test('searching and finding nothing is a different answer from not searching', () => {
    const score = assessLocalImpact({ change: breaking(), taxonomy, sites: [], localizationRan: true });
    assert.equal(score.band, 'none');
    assert.ok(
      score.penalties.some((p) => p.code === 'no-usage-found'),
      'the two must be distinguishable by a reader',
    );
  });

  test('a bound import is the strongest local signal', () => {
    const score = assessLocalImpact({
      change: breaking(),
      taxonomy,
      sites: [site()],
      localizationRan: true,
    });
    assert.equal(score.band, 'high');
  });

  test('a purely textual match is penalised', () => {
    const score = assessLocalImpact({
      change: breaking(),
      taxonomy,
      sites: [site({ confidence: 'low' })],
      localizationRan: true,
    });
    assert.ok(score.band === 'low' || score.band === 'none');
    assert.ok(score.penalties.some((p) => p.code === 'textual-only'));
  });

  test('generated code is not where a fix belongs', () => {
    const score = assessLocalImpact({
      change: breaking(),
      taxonomy,
      sites: [site({ file: 'src/generated/api.ts' })],
      localizationRan: true,
    });
    assert.ok(score.penalties.some((p) => p.code === 'generated-only'));
  });

  test('dynamic access means the affected set cannot be enumerated', () => {
    const dynamic = { ...taxonomy, visibility: ['reflection-or-dynamic' as const] };
    const withDynamic = assessLocalImpact({
      change: breaking(),
      taxonomy: dynamic,
      sites: [site()],
      localizationRan: true,
    });
    const without = assessLocalImpact({
      change: breaking(),
      taxonomy,
      sites: [site()],
      localizationRan: true,
    });
    assert.ok(withDynamic.score < without.score);
  });

  test('a runtime-only change cannot be cleared by a source search', () => {
    const score = assessLocalImpact({
      change: breaking({ kind: 'behaviour-change' }),
      taxonomy: classify('behaviour-change'),
      sites: [],
      localizationRan: true,
    });
    assert.ok(score.penalties.some((p) => p.code === 'not-locally-checkable'));
  });
});

describe('verification confidence', () => {
  test('nothing run means nothing verified', () => {
    const score = assessVerification({
      outcomes: [],
      affectedFiles: ['src/a.ts'],
      taxonomy: classify('removed-export', 'export-removed'),
    });
    assert.equal(score.band, 'none');
    assert.ok(score.penalties.some((p) => p.code === 'nothing-ran'));
  });

  test('a skipped check is never counted as a pass', () => {
    const score = assessVerification({
      outcomes: [{ name: 'test', command: 'npm test', status: 'skipped' }],
      affectedFiles: [],
      taxonomy: classify('removed-export', 'export-removed'),
    });
    assert.equal(score.score, 0);
    assert.ok(score.penalties.some((p) => p.code.startsWith('did-not-run')));
  });

  test('a failing check is not confidence', () => {
    const score = assessVerification({
      outcomes: [{ name: 'test', command: 'npm test', status: 'failed' }],
      affectedFiles: [],
      taxonomy: classify('removed-export', 'export-removed'),
    });
    assert.equal(score.band, 'none');
  });

  test('a typecheck proves less about a behaviour change than a compile-time one', () => {
    const outcomes = [{ name: 'typecheck', command: 'tsc', status: 'passed' as const }];

    const compileTime = assessVerification({
      outcomes,
      affectedFiles: [],
      taxonomy: classify('removed-export', 'export-removed'),
    });
    const behaviour = assessVerification({
      outcomes,
      affectedFiles: [],
      taxonomy: classify('behaviour-change'),
    });

    assert.ok(
      behaviour.score < compileTime.score,
      'a passing type check says nothing about a change that compiles either way',
    );
  });

  test('passing checks that cover none of the affected files are discounted', () => {
    const score = assessVerification({
      outcomes: [{ name: 'test', command: 'npm test', status: 'passed', covers: ['src/other.ts'] }],
      affectedFiles: ['src/a.ts'],
      taxonomy: classify('removed-export', 'export-removed'),
    });
    assert.ok(score.penalties.some((p) => p.code === 'no-coverage'));
  });
});

describe('the two questions stay separate', () => {
  test('proven upstream does not imply locally affected', () => {
    // The over-claim the whole model exists to prevent.
    const assessment = assess({
      change: breaking(),
      taxonomy: classify('removed-export', 'export-removed'),
      evidence: [evidence()],
      sites: [],
      localizationRan: true,
    });

    assert.equal(assessment.upstream.band, 'high');
    assert.equal(assessment.localImpact.band, 'none');
    assert.equal(assessment.automaticExecutionEligible, false);
    assert.ok(assessment.reasons.some((r) => r.code === 'upstream-only'));
  });

  test('an unlocalized finding can never derive as high', () => {
    const assessment = assess({
      change: breaking(),
      taxonomy: classify('removed-export', 'export-removed'),
      evidence: [evidence()],
      sites: [],
      localizationRan: false,
    });
    assert.notEqual(deriveLegacyConfidence(assessment), 'high');
  });

  test('the legacy value follows the weaker dimension', () => {
    const assessment = assess({
      change: breaking({ citations: ['ev_semver'] }),
      taxonomy: classify('removed-export', 'export-removed'),
      evidence: [evidence({ id: 'ev_semver', source: 'semver-heuristic', content: 'major', weight: 0.3 })],
      sites: [site()],
      localizationRan: true,
    });

    assert.equal(assessment.localImpact.band, 'high');
    assert.equal(deriveLegacyConfidence(assessment), 'low', 'strong local usage of a guess is still a guess');
  });

  test('bands are computed in one place', () => {
    assert.equal(bandFor(0.9), 'high');
    assert.equal(bandFor(0.5), 'medium');
    assert.equal(bandFor(0.2), 'low');
    assert.equal(bandFor(0), 'none');
  });
});

describe('gaps', () => {
  function plan(overrides: Record<string, unknown> = {}) {
    return buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence: [evidence()],
      breakingChanges: [breaking()],
      impactSites: [site()],
      ...overrides,
    });
  }

  test('an unavailable checkout is recorded as a blocking gap', () => {
    const built = plan({ localizationRan: false });
    const gap = built.gaps.find((g) => g.stage === 'localize' && g.surface === 'repository source');

    assert.ok(gap, 'not searching must be recorded');
    assert.equal(gap!.automaticExecution, 'blocks');
    assert.ok(built.blockers.some((b) => /not searched|could not search/i.test(b)));
  });

  test('missing upstream evidence is a gap', () => {
    const built = plan({ evidence: [], breakingChanges: [breaking({ citations: [] })] });
    assert.ok(built.gaps.some((g) => g.stage === 'evidence'));
  });

  test('nothing verified is a gap whenever a commit was planned', () => {
    const built = plan();
    assert.ok(built.commits.length > 0);
    assert.ok(built.gaps.some((g) => g.stage === 'verify'));
  });

  test('a clean run with evidence records no spurious gaps', () => {
    const built = plan();
    assert.ok(!built.gaps.some((g) => g.stage === 'evidence'));
  });

  test('gaps carry their consequence for automatic execution', () => {
    for (const gap of plan({ localizationRan: false }).gaps) {
      assert.ok(['blocks', 'degrades', 'none'].includes(gap.automaticExecution));
      assert.ok(gap.remediation.length > 0, 'a gap without an action is just an apology');
    }
  });
});

describe('minConfidence blocks rather than warns', () => {
  const weakEvidence = evidence({
    id: 'ev_registry',
    source: 'registry-metadata',
    content: 'deprecated',
    weight: 0.4,
  });

  function planWithWeakFinding(config = DEFAULT_CONFIG) {
    return buildPlan({
      repo,
      config,
      changes: [dependencyChange],
      evidence: [weakEvidence],
      breakingChanges: [breaking({ citations: ['ev_registry'] })],
      impactSites: [site()],
    });
  }

  test('an actionable finding below the threshold blocks automatic dispatch', () => {
    // It used to warn, which made the setting a lie: a repository configured
    // for `high` still dispatched an agent against a low-confidence guess.
    const built = planWithWeakFinding();
    assert.ok(built.commits.length > 0, 'a commit was planned for it');
    assert.ok(
      built.blockers.some((b) => b.includes('minConfidence')),
      'being below the threshold must block, not merely warn',
    );

    const auto = DriftConfigSchema.parse({ mode: 'auto' });
    assert.equal(isAutoDispatchable(built, auto), false);
  });

  test('the plan is still filed in full for a human', () => {
    // Blocking downgrades to approval; it never discards the analysis.
    const built = planWithWeakFinding();
    assert.ok(built.breakingChanges.length > 0);
    assert.ok(renderApprovalIssue(built, DEFAULT_CONFIG).includes('createClient'));
  });

  test('the experimental opt-in restores dispatch, and says so', () => {
    const config = DriftConfigSchema.parse({
      mode: 'auto',
      guardrails: { experimentalDispatchBelowMinConfidence: true },
    });
    const built = planWithWeakFinding(config);

    assert.ok(!built.blockers.some((b) => b.includes('minConfidence')));
    assert.ok(built.warnings.some((w) => w.includes('experimentalDispatchBelowMinConfidence')));
  });

  test('it is off by default', () => {
    assert.equal(DEFAULT_CONFIG.guardrails.experimentalDispatchBelowMinConfidence, false);
  });

  test('a low-confidence finding with no planned commit only warns', () => {
    // Nothing is about to be edited on its account, and blocking on it would
    // train people to raise the threshold until it stopped mattering.
    const built = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence: [weakEvidence],
      breakingChanges: [breaking({ citations: ['ev_registry'] })],
      impactSites: [],
    });

    assert.equal(built.commits.length, 0);
    assert.ok(!built.blockers.some((b) => b.includes('minConfidence')));
    assert.ok(built.warnings.some((w) => w.includes('minConfidence')));
  });
});

describe('reporting never turns an absence into an all-clear', () => {
  function planWith(overrides: Record<string, unknown>) {
    return buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence: [evidence()],
      breakingChanges: [breaking()],
      impactSites: [],
      ...overrides,
    });
  }

  test('not searched and searched-clean produce different verdicts', () => {
    const notSearched = planWith({ localizationRan: false }).breakingChanges[0]!;
    const searched = planWith({ localizationRan: true }).breakingChanges[0]!;

    assert.equal(verdictFor(notSearched), 'verification-incomplete');
    assert.equal(verdictFor(searched), 'detected-not-locally-reachable');
    assert.notEqual(verdictFor(notSearched), verdictFor(searched));
  });

  test('a located finding says the repository is affected', () => {
    const affected = planWith({ impactSites: [site()] }).breakingChanges[0]!;
    assert.equal(verdictFor(affected), 'locally-affected');
  });

  describe('reduceVerdict', () => {
    // The one-repository-wide-conclusion reduction, moved here from the
    // benchmark harness (`eval/src/adapters/end-to-end.ts`) so production has
    // exactly one implementation and the harness imports it rather than
    // re-deriving it. The load-bearing property is that "no findings" is not
    // the same fact as "nothing was checked", and the two must not collapse
    // into one verdict.
    const CHECKED = [
      { surface: 'api-surface', dependency: 'fixture-lib', status: 'checked' },
      { surface: 'localization', status: 'checked' },
    ];

    test('no breaking change, surfaces genuinely checked: the honest verdict is a safe one', () => {
      assert.equal(reduceVerdict([], true, CHECKED), 'no-incompatible-change-in-checked-surfaces');
    });

    test('no breaking change and no computed surface is insufficient evidence, never safe', () => {
      assert.equal(
        reduceVerdict([], true, [
          { surface: 'api-surface', dependency: 'fixture-lib', status: 'unavailable' },
          { surface: 'localization', status: 'checked' },
        ]),
        'insufficient-evidence',
      );
    });

    test('no breaking change and an unsearched repository is insufficient evidence', () => {
      assert.equal(
        reduceVerdict([], true, [
          { surface: 'api-surface', dependency: 'fixture-lib', status: 'checked' },
          { surface: 'localization', status: 'skipped' },
        ]),
        'insufficient-evidence',
      );
    });

    test('an empty surface list can never produce a safe verdict', () => {
      assert.equal(reduceVerdict([], true, []), 'insufficient-evidence');
    });

    test('an inconclusive finding never outranks a positive one', () => {
      assert.equal(reduceVerdict(['insufficient-evidence', 'locally-affected'], false, CHECKED), 'locally-affected');
      assert.equal(
        reduceVerdict(['no-incompatible-change-in-checked-surfaces', 'insufficient-evidence'], false, CHECKED),
        'insufficient-evidence',
      );
    });
  });

  describe('resolvePlanVerdict', () => {
    test('a confirmed regression overrides a safe-equivalent static verdict', () => {
      // Detected upstream, not found in this repository's code — the exact
      // shape `verifyPlan` producing `confirmedRegressions` exists to correct.
      const plan = planWith({ localizationRan: true, confirmedRegressions: ['npm acme-sdk'] });
      assert.equal(verdictFor(plan.breakingChanges[0]!), 'detected-not-locally-reachable');
      assert.equal(resolvePlanVerdict(plan), 'locally-affected');
    });

    test('a confirmed regression with no breaking changes at all still overrides "safe"', () => {
      // Static analysis predicted nothing to worry about, but the project's
      // own checks disagree — the case a green-looking scan must not report
      // as clean.
      const plan = planWith({
        breakingChanges: [],
        impactSites: [],
        confirmedRegressions: ['npm acme-sdk'],
        checkedSurfaces: [
          { surface: 'api-surface', dependency: 'acme-sdk', status: 'checked', detail: 'diffed' },
          { surface: 'localization', status: 'checked', detail: 'searched' },
        ],
      });
      assert.equal(resolvePlanVerdict(plan), 'locally-affected');
    });

    test('an already-affected verdict is left alone, not double-counted', () => {
      const plan = planWith({ impactSites: [site()], confirmedRegressions: ['npm acme-sdk'] });
      assert.equal(resolvePlanVerdict(plan), 'locally-affected');
    });

    test('no confirmed regression leaves the static verdict untouched', () => {
      const plan = planWith({ localizationRan: true });
      assert.equal(resolvePlanVerdict(plan), 'detected-not-locally-reachable');
    });

    test('a confirmed regression never upgrades genuine insufficient-evidence into a claim', () => {
      // Upstream itself was never established — a measured failure elsewhere
      // in the manifest must not be read as proof of *this* unproven change.
      const plan = planWith({
        breakingChanges: [breaking({ citations: [] })],
        confirmedRegressions: ['npm acme-sdk'],
      });
      assert.equal(verdictFor(plan.breakingChanges[0]!), 'insufficient-evidence');
      assert.equal(resolvePlanVerdict(plan), 'insufficient-evidence');
    });
  });

  test('the report never calls an upgrade safe', () => {
    const body = renderPullRequestBody(planWith({ impactSites: [site()] }), DEFAULT_CONFIG);
    assert.ok(!/\bis safe\b|\bsafe to (merge|upgrade|apply)\b/i.test(body));
  });

  test('the report states the three dimensions and the taxonomy', () => {
    const body = renderPullRequestBody(planWith({ impactSites: [site()] }), DEFAULT_CONFIG);

    assert.match(body, /Upstream — did this change happen/);
    assert.match(body, /Local impact — does it reach this repo/);
    assert.match(body, /Verification — did anything run/);
    assert.match(body, /\*\*Nature:\*\*/);
    assert.match(body, /Detectable at:/);
  });

  test('a report with no checkout says it did not search', () => {
    const body = renderPullRequestBody(planWith({ localizationRan: false }), DEFAULT_CONFIG);
    assert.match(body, /not searched/i);
    assert.match(body, /not evidence the change is unused/i);
  });

  test('automatic-execution eligibility is stated per finding', () => {
    const body = renderPullRequestBody(planWith({ impactSites: [site()] }), DEFAULT_CONFIG);
    assert.match(body, /\*\*Automatic execution:\*\*/);
  });

  test('signature remediation renders before and after snippets as code fences', () => {
    const body = renderPullRequestBody(
      planWith({
        impactSites: [site()],
        breakingChanges: [
          breaking({
            kind: 'signature-change',
            remediation: 'Update calls exactly.\n  before: ACTION(old)\n  after:  ACTION(next)',
          }),
        ],
      }),
      DEFAULT_CONFIG,
    );

    assert.match(body, /\*\*Fix:\*\*\n\nUpdate calls exactly\./);
    assert.match(body, /\*\*Before:\*\*\n\n```\nACTION\(old\)\n```/);
    assert.match(body, /\*\*After:\*\*\n\n```\nACTION\(next\)\n```/);
  });
});
