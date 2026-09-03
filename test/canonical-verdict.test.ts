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

describe('Case D — an isolated verification pass is the one thing that clears a zero-hit search', () => {
  test('disposition is unaffected only when the change id is in the verified-compatible set', () => {
    const withoutProof = deriveBreakingChangeDispositions([apiChange()], [], [], true, true)[0]!;
    assert.equal(withoutProof.state, 'unknown');

    const withProof = deriveBreakingChangeDispositions(
      [apiChange()],
      [],
      [],
      true,
      true,
      new Set(['bc_api']),
    )[0]!;
    assert.equal(withProof.state, 'unaffected');
  });

  test('scan severity reaches upstream-only only behind a passing verification', () => {
    assert.equal(severityOf(scanCandidate({ breakingCount: 1 })), 'review-required');
    assert.equal(
      severityOf(scanCandidate({ breakingCount: 1, verification: { status: 'passed', checks: [] } })),
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
