/**
 * The safety invariant, pinned end to end.
 *
 *   An upstream breaking change cannot become safe-equivalent merely because
 *   localization produced zero matches.
 *
 * A completed syntactic search is not affirmative evidence that an upstream
 * breaking change cannot reach this repository — structural typing, inferred
 * types, wrappers, generated code, dynamic dispatch, behavioural changes and
 * API-ownership relationships all defeat it. Only an authoritative, isolated
 * verification turns "found nothing" into "unaffected".
 *
 * These cases mirror the ones in the task brief (A, B, E, F, G) and exercise
 * every surface that used to be free to disagree: the disposition model
 * (`src/disposition.ts`), the scan severity model (`src/upgrade/severity.ts`),
 * the per-finding / plan verdict (`src/report/confidence.ts`) and the bulk
 * upgrade eligibility predicate (`safeUpgradeCandidates` in `src/cli.ts`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveBreakingChangeDispositions } from '../dist/disposition.js';
import { severityOf } from '../dist/upgrade/severity.js';
import { safeUpgradeCandidates } from '../dist/cli.js';
import { isSafeEquivalentVerdict, verdictFor, resolvePlanVerdict } from '../dist/report/confidence.js';
import { buildPlan } from '../dist/plan/index.js';
import { applyVerification } from '../dist/upgrade/verification.js';
import { classify } from '../dist/confidence/taxonomy.js';
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

const site = (breakingChangeId: string, confidence: 'high' | 'medium' | 'low' = 'high') => ({
  breakingChangeId,
  file: `src/${breakingChangeId}.ts`,
  line: 1,
  excerpt: 'x',
  matchedSymbol: 'gone',
  confidence,
});

const scanCandidate = (overrides: Record<string, unknown> = {}) => ({
  name: 'pkg',
  manifestPath: 'package.json',
  packageManager: 'npm',
  status: 'ready',
  breakingCount: 0,
  impactCount: 0,
  impactFiles: 0,
  gaps: [] as string[],
  ...overrides,
});

describe('Case A — upstream API break, localization complete, zero sites, nothing verified', () => {
  test('disposition is unknown / impact-unresolved, never unaffected', () => {
    const [d] = deriveBreakingChangeDispositions([apiChange()], [], [], true, true);
    assert.equal(d!.state, 'unknown');
    assert.equal(d!.reason, 'impact-unresolved');
  });

  test('scan severity is review-required, not upstream-only or clean', () => {
    assert.equal(severityOf(scanCandidate({ breakingCount: 1 })), 'review-required');
  });

  test('the per-finding verdict is not a safety claim', () => {
    const change = apiChange('bc_api', {
      assessment: {
        upstream: { band: 'high', score: 0.9, evidence: [], penalties: [] },
        localImpact: { band: 'none', score: 0, evidence: [], penalties: [] },
        verification: { band: 'none', score: 0, evidence: [], penalties: [] },
        gaps: [],
        automaticExecutionEligible: false,
      },
    });
    const verdict = verdictFor(change as never);
    assert.equal(verdict, 'detected-not-locally-reachable');
    assert.equal(isSafeEquivalentVerdict(verdict), false);
  });

  test('bulk upgrade will not touch it', () => {
    const selected = safeUpgradeCandidates([scanCandidate({ name: 'a', breakingCount: 1 })] as never);
    assert.deepEqual(selected.map((c) => c.name), []);
  });
});

describe('Case B — a high-confidence imported local site', () => {
  test('disposition is actionable', () => {
    const [d] = deriveBreakingChangeDispositions([apiChange()], [site('bc_api', 'high')], [], true, true);
    assert.equal(d!.state, 'actionable');
    assert.equal(d!.actionableSites.length, 1);
  });

  test('scan severity is affected', () => {
    assert.equal(
      severityOf(scanCandidate({ breakingCount: 1, impactCount: 1, impactFiles: 1, impactConfidence: 'high' })),
      'affected',
    );
  });
});

describe('Case D — only an isolated, compile-capable verification clears a zero-hit search', () => {
  const compilePass = [{ label: 'typecheck', status: 'passed', compileCapable: true }];

  test('a completed zero-hit search alone never resolves a disposition to unaffected', () => {
    const d = deriveBreakingChangeDispositions([apiChange()], [], [], true, true)[0]!;
    assert.equal(d.state, 'unknown');
    assert.equal(d.reason, 'impact-unresolved');
  });

  test('severity: upstream-only requires the reconciled verifiedUnaffected flag, not verification.status', () => {
    // nothing verified
    assert.equal(severityOf(scanCandidate({ breakingCount: 1 })), 'review-required');
    // a bare `passed` with no reconciled flag — the exact case the reviewer flagged
    assert.equal(
      severityOf(scanCandidate({ breakingCount: 1, verification: { status: 'passed', checks: [] } })),
      'review-required',
    );
    // passed, compile-capable, but batch-scoped
    assert.equal(
      severityOf(
        scanCandidate({
          breakingCount: 1,
          verification: { status: 'passed', checks: compilePass, measuredWith: 2 },
          verifiedUnaffected: false,
        }),
      ),
      'review-required',
    );
    // the reconciled flag is set — an isolated compile-capable pass cleared it
    assert.equal(
      severityOf(
        scanCandidate({
          breakingCount: 1,
          verification: { status: 'passed', checks: compilePass, measuredWith: 1 },
          verifiedUnaffected: true,
        }),
      ),
      'upstream-only',
    );
  });
});

describe('Case E — API surface unavailable, zero sites', () => {
  test('scan severity is evidence-missing, not clean', () => {
    assert.equal(
      severityOf(scanCandidate({ recommendation: 'insufficient-evidence', gaps: ['no diff available'] })),
      'evidence-missing',
    );
  });

  test('plan verdict is insufficient-evidence when the api-surface row is unavailable', () => {
    const plan = {
      breakingChanges: [],
      changes: [{ name: 'pkg', ecosystem: 'npm' }],
      confirmedRegressions: [],
      blockers: [],
      checkedSurfaces: [
        { surface: 'api-surface', dependency: 'pkg', ecosystem: 'npm', status: 'unavailable', detail: 'no diff' },
        { surface: 'localization', status: 'checked', detail: 'searched' },
      ],
    };
    assert.equal(resolvePlanVerdict(plan as never), 'insufficient-evidence');
  });
});

describe('Case F — localization unavailable', () => {
  test('disposition is unknown / not-localized', () => {
    const [d] = deriveBreakingChangeDispositions([apiChange()], [], [], false);
    assert.equal(d!.state, 'unknown');
    assert.equal(d!.reason, 'not-localized');
  });

  test('scan severity for a truncated localization over an API break is localization-incomplete', () => {
    assert.equal(
      severityOf(
        scanCandidate({ breakingCount: 1, sourceCoverage: { sourceTruncated: true, localizationComplete: false } }),
      ),
      'localization-incomplete',
    );
  });
});

describe('Case G — a multi-dependency plan is only as safe as its weakest dependency', () => {
  test('one dependency fully checked cannot make an unchecked sibling safe', () => {
    const plan = {
      breakingChanges: [],
      changes: [
        { name: 'a', ecosystem: 'npm' },
        { name: 'b', ecosystem: 'npm' },
      ],
      confirmedRegressions: [],
      blockers: [],
      checkedSurfaces: [
        { surface: 'api-surface', dependency: 'a', ecosystem: 'npm', status: 'checked', detail: 'diffed' },
        { surface: 'api-surface', dependency: 'b', ecosystem: 'npm', status: 'unavailable', detail: 'no diff' },
        { surface: 'localization', status: 'checked', detail: 'searched' },
      ],
    };
    assert.equal(resolvePlanVerdict(plan as never), 'insufficient-evidence');
  });
});

describe('severity and disposition/verdict cannot disagree after a real verification', () => {
  const repo = {
    owner: 'acme',
    repo: 'app',
    baseBranch: 'main',
    beforeSha: 'a'.repeat(40),
    afterSha: 'b'.repeat(40),
  };
  const change = {
    name: 'acme-sdk',
    ecosystem: 'npm' as const,
    from: '1.0.0',
    to: '2.0.0',
    kind: 'runtime' as const,
    bump: 'major' as const,
    manifestPath: 'package.json',
  };
  const ev = {
    id: 'ev_1',
    source: 'type-surface-diff' as const,
    dependency: 'acme-sdk',
    title: 'API surface diff',
    content: '`createClient` removed',
    weight: 1,
  };
  const breakingOf = (kind: string) => ({
    id: 'bc_1',
    dependency: 'acme-sdk',
    kind,
    summary: 'something changed',
    remediation: 'adapt',
    symbols: ['createClient'],
    confidence: 'high' as const,
    taxonomy: classify(kind),
    citations: ['ev_1'],
  });
  const plan = (kind: string) =>
    buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [change],
      evidence: [ev],
      breakingChanges: [breakingOf(kind)],
      impactSites: [],
      localizationRan: true,
      localizationComplete: true,
    });
  const candidate = (p: unknown) => ({
    name: 'acme-sdk',
    manifestPath: 'package.json',
    packageManager: 'npm',
    status: 'ready',
    breakingCount: 1,
    impactCount: 0,
    impactFiles: 0,
    impactConfidence: 'none' as const,
    gaps: [] as string[],
    risk: 'none',
    summary: 's',
    plan: p,
  });
  const isolatedCompilePass = {
    status: 'passed' as const,
    checks: [{ kind: 'typecheck', label: 'tsc', status: 'passed', compileCapable: true, durationMs: 1, output: '' }],
    failedFiles: [],
    measuredWith: 1,
  };

  test('compiler-provable change + isolated compile-capable pass: pruned, severity is upstream-only', () => {
    const verified = applyVerification(candidate(plan('removed-export')) as never, isolatedCompilePass as never);
    assert.equal(verified.verifiedUnaffected, true);
    assert.equal(severityOf(verified as never), 'upstream-only');
    // The compiler-provable prediction was cleared and removed from the plan —
    // that removal, not a special-case verdict, is what makes it safe.
    assert.equal((verified.plan as { breakingChanges: unknown[] }).breakingChanges.length, 0);
  });

  test('behavioural change + isolated compile-capable pass: NOT cleared, nothing reads safe', () => {
    const verified = applyVerification(candidate(plan('behaviour-change')) as never, isolatedCompilePass as never);
    assert.notEqual(verified.verifiedUnaffected, true);
    assert.equal(severityOf(verified as never), 'review-required');
    const dispositions = (verified.plan as { dispositions?: { state: string }[] }).dispositions ?? [];
    assert.ok(dispositions.length > 0 && dispositions.every((d) => d.state !== 'unaffected'));
    assert.equal(isSafeEquivalentVerdict(resolvePlanVerdict(verified.plan as never)), false);
  });

  test('batch pass never clears, whatever the change kind', () => {
    const batch = { ...isolatedCompilePass, measuredWith: 2 };
    const verified = applyVerification(candidate(plan('removed-export')) as never, batch as never);
    assert.notEqual(verified.verifiedUnaffected, true);
    assert.equal(severityOf(verified as never), 'review-required');
  });

  test('a green run with no compile-capable check never clears', () => {
    const testOnly = {
      status: 'passed' as const,
      checks: [{ kind: 'test', label: 'npm test', status: 'passed', compileCapable: false, durationMs: 1, output: '' }],
      failedFiles: [],
      measuredWith: 1,
    };
    const verified = applyVerification(candidate(plan('removed-export')) as never, testOnly as never);
    assert.notEqual(verified.verifiedUnaffected, true);
    assert.equal(severityOf(verified as never), 'review-required');
  });
});

describe('the canonical safe-equivalent predicate', () => {
  test('only genuinely affirmative verdicts pass', () => {
    assert.equal(isSafeEquivalentVerdict('no-incompatible-change-in-checked-surfaces'), true);
    for (const v of [
      'detected-not-locally-reachable',
      'locally-affected',
      'insufficient-evidence',
      'verification-incomplete',
    ] as const) {
      assert.equal(isSafeEquivalentVerdict(v), false, `${v} must not read as a safety claim`);
    }
  });
});
