import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { severityOf, describeSeverity, compareSeverity, scanTitle } from '../dist/upgrade/severity.js';

/**
 * A failed verification is measured evidence — the project's own toolchain,
 * run for real against the upgrade — and must never be read as `clean` or
 * `upstream-only`, both of which tell the developer this is safe. See
 * `src/upgrade/severity.ts`.
 */

const base = { status: 'ready', breakingCount: 0, impactCount: 0, impactFiles: 0, gaps: [] as string[] };

describe('a package nothing has looked at yet', () => {
  test('is never reported as clean, however empty its counts are', () => {
    // The row a manifest produces before the scan reaches it. Every count on
    // it is zero because nothing has checked it, and reading those zeroes as
    // "no breaking changes found" is exactly the claim this module exists to
    // prevent.
    assert.equal(severityOf({ ...base, status: 'pending' }), 'pending');
    assert.equal(describeSeverity({ ...base, status: 'pending' }), 'Not checked yet');
  });

  test('sorts below anything with a real finding and above the ones found safe', () => {
    const pending = { ...base, status: 'pending' };
    const clean = { ...base, recommendation: 'safe-to-upgrade' };
    const affected = { ...base, impactCount: 1 };
    assert.ok(compareSeverity(affected, pending) < 0);
    assert.ok(compareSeverity(pending, clean) < 0);
  });
});

describe('a failed verification outranks a clean-looking result', () => {
  test('zero breaking changes and zero impact sites, but the build failed, is not clean', () => {
    const candidate = { ...base, verification: { status: 'failed', checks: [] } };
    assert.equal(severityOf(candidate), 'verification-failed');
  });

  test('a passing verification with nothing found is still clean', () => {
    const candidate = { ...base, verification: { status: 'passed', checks: [] } };
    assert.equal(severityOf(candidate), 'clean');
  });

  test('no verification at all falls through to the ordinary rules', () => {
    assert.equal(severityOf({ ...base }), 'clean');
    // An upstream API break with no located site and nothing verified is
    // "review-required", not "upstream-only": a completed localization that
    // found nothing is not affirmative evidence the repository is unaffected.
    assert.equal(severityOf({ ...base, breakingCount: 1 }), 'review-required');
    // A bare `passed` is not enough — the reconciled `verifiedUnaffected` flag
    // (isolated, compile-capable, everything cleared) is what earns
    // `upstream-only`.
    assert.equal(
      severityOf({ ...base, breakingCount: 1, verification: { status: 'passed', checks: [] } }),
      'review-required',
    );
    assert.equal(
      severityOf({
        ...base,
        breakingCount: 1,
        verification: { status: 'passed', checks: [{ label: 'tsc', status: 'passed', compileCapable: true }], measuredWith: 1 },
        verifiedUnaffected: true,
      }),
      'upstream-only',
    );
  });

  test('Deep Verification not-run is orthogonal to a clean static verdict', () => {
    const candidate = { ...base, recommendation: 'safe-to-upgrade' };
    assert.equal(severityOf(candidate), 'clean');
    assert.match(describeSeverity(candidate), /not deeply verified/);
  });

  test('an upstream evidence gap is Evidence Missing, not a review or runtime verdict', () => {
    const candidate = { ...base, recommendation: 'insufficient-evidence', gaps: ['artifact unavailable'] };
    assert.equal(severityOf(candidate), 'evidence-missing');
    assert.match(describeSeverity(candidate), /^Evidence Missing/);
  });

  test('truncated source localization cannot become upstream-only', () => {
    const candidate = { ...base, breakingCount: 1, sourceCoverage: { sourceTruncated: true } };
    assert.equal(severityOf(candidate), 'localization-incomplete');
    assert.match(describeSeverity(candidate), /^Localization Incomplete/);
    assert.doesNotMatch(describeSeverity(candidate), /none used here|safe/i);
  });

  test('truncation does not weaken a substantive no-breaking-change conclusion', () => {
    const candidate = {
      ...base,
      recommendation: 'safe-to-upgrade',
      sourceCoverage: { sourceTruncated: true, localizationComplete: false },
    };
    assert.equal(severityOf(candidate), 'clean');
  });

  test('source truncation does not contradict a resolved runtime-only finding', () => {
    const candidate = {
      ...base,
      breakingCount: 1,
      recommendation: 'safe-to-upgrade',
      runtimeCompatibility: 'compatible' as const,
      runtimeAnalyses: [{ state: 'compatible' as const, reason: 'declared-compatible' }],
      sourceCoverage: { sourceTruncated: true, localizationComplete: false },
    };
    assert.equal(severityOf(candidate), 'upstream-only');
  });

  test('a positive site outranks incomplete localization', () => {
    const candidate = {
      ...base,
      breakingCount: 1,
      impactCount: 1,
      sourceCoverage: { sourceTruncated: true, localizationComplete: false },
    };
    assert.equal(severityOf(candidate), 'affected');
  });

  test('affected and review-required wording retain independent runtime uncertainty', () => {
    const runtime = {
      runtimeCompatibility: 'unknown' as const,
      runtimeDeclarationSiteCount: 0,
      runtimeAnalyses: [{ state: 'unknown' as const, reason: 'config-incomplete', statement: 'A runtime config could not be indexed.' }],
    };
    const affected = { ...base, ...runtime, impactCount: 1, actionableImpactCount: 1, impactFiles: 1 };
    const review = { ...base, ...runtime, impactCount: 1, actionableImpactCount: 0, impactConfidence: 'low' as const };
    assert.match(describeSeverity(affected), /runtime config could not be indexed/);
    assert.match(describeSeverity(review), /runtime config could not be indexed/);
  });

  test('a real impact site still outranks a failed verification', () => {
    // Static analysis pinpointing an actual call site is the strongest, most
    // actionable signal Drift has; a failed check with no location does not
    // get to override it.
    const candidate = { ...base, impactCount: 1, verification: { status: 'failed', checks: [] } };
    assert.equal(severityOf(candidate), 'affected');
  });

  test('a scan-level error still outranks a failed verification', () => {
    const candidate = { ...base, status: 'error', verification: { status: 'failed', checks: [] } };
    assert.equal(severityOf(candidate), 'error');
  });

  test('names the failing checks in the developer-facing description', () => {
    const candidate = {
      ...base,
      verification: {
        status: 'failed',
        checks: [
          { label: 'npm run typecheck', status: 'failed' },
          { label: 'npm test', status: 'passed' },
        ],
      },
    };
    assert.match(describeSeverity(candidate), /npm run typecheck/);
    assert.doesNotMatch(describeSeverity(candidate), /safe/i);
  });

  test('sorts above clean and upstream-only, below a located impact site', () => {
    const affected = { ...base, impactCount: 1 };
    const verificationFailed = { ...base, verification: { status: 'failed', checks: [] } };
    const upstreamOnly = {
      ...base,
      breakingCount: 1,
      verification: { status: 'passed', checks: [{ label: 'tsc', status: 'passed', compileCapable: true }], measuredWith: 1 },
      verifiedUnaffected: true,
    };
    const clean = { ...base };

    const sorted = [clean, upstreamOnly, affected, verificationFailed].sort(compareSeverity);
    assert.deepEqual(sorted.map(severityOf), ['affected', 'verification-failed', 'upstream-only', 'clean']);
  });

  test('a failed verification counts toward the scan title, even with nothing else affected', () => {
    const candidates = [{ ...base, verification: { status: 'failed', checks: [] } }, { ...base }];
    assert.match(scanTitle(candidates), /1 of 2 affect this repo/);
  });
});

describe('impact wording is hedged to match how sure the match actually is', () => {
  test('a high-confidence, imported match reads "Affects"', () => {
    const candidate = { ...base, impactCount: 1, impactFiles: 1, impactConfidence: 'high' as const };
    assert.match(describeSeverity(candidate), /^Affects your code/);
  });

  test('a medium-confidence match reads "May affect"', () => {
    const candidate = { ...base, impactCount: 1, impactFiles: 1, impactConfidence: 'medium' as const };
    assert.match(describeSeverity(candidate), /^May affect your code/);
  });

  test('a low-confidence, textual-only match reads "May affect"', () => {
    const candidate = { ...base, impactCount: 1, impactFiles: 1, impactConfidence: 'low' as const };
    assert.match(describeSeverity(candidate), /^May affect your code/);
  });

  test('no impactConfidence supplied keeps the unhedged wording, for callers not yet updated', () => {
    const candidate = { ...base, impactCount: 1, impactFiles: 1 };
    assert.match(describeSeverity(candidate), /^Affects your code/);
  });
});

/**
 * Regression for #131: a direct/legacy caller that supplies only the fields
 * that predate `actionableImpactCount`/`runtimeDeclarationSiteCount` must
 * never have an unresolved runtime declaration promoted to `affected` by the
 * fallback — but a confirmed, high-confidence API impact reported alongside
 * that same unresolved runtime evidence must not be erased either. See
 * `src/upgrade/severity.ts`.
 */
describe('legacy-caller fallback stays conservative about unresolved runtime evidence', () => {
  test('unknown runtime, one site, low confidence, no canonical counts -> runtime unresolved', () => {
    const candidate = {
      status: 'ready',
      breakingCount: 1,
      impactCount: 1,
      impactFiles: 1,
      impactConfidence: 'low' as const,
      runtimeCompatibility: 'unknown' as const,
    };
    assert.equal(severityOf(candidate), 'runtime-unresolved');
  });

  test('partial runtime, one site, low confidence, no canonical counts -> runtime unresolved', () => {
    const candidate = {
      status: 'ready',
      breakingCount: 1,
      impactCount: 1,
      impactFiles: 1,
      impactConfidence: 'low' as const,
      runtimeCompatibility: 'partial' as const,
    };
    assert.equal(severityOf(candidate), 'runtime-unresolved');
  });

  test('unknown runtime, no confidence supplied at all -> runtime unresolved', () => {
    // Absent confidence cannot be read as "certain" here the way it can when
    // runtime is resolved: there is no way to tell a bare unresolved runtime
    // site from a confirmed API site without either a confidence signal or
    // `runtimeDeclarationSiteCount`, so the fallback must stay conservative.
    const candidate = {
      status: 'ready',
      breakingCount: 1,
      impactCount: 1,
      impactFiles: 1,
      runtimeCompatibility: 'unknown' as const,
    };
    assert.equal(severityOf(candidate), 'runtime-unresolved');
  });

  test('medium-confidence API-only impact with no canonical actionable count reads as review, not affected', () => {
    const candidate = {
      status: 'ready',
      breakingCount: 1,
      impactCount: 1,
      impactFiles: 1,
      impactConfidence: 'medium' as const,
    };
    assert.equal(severityOf(candidate), 'review-required');
  });

  test('mixed: unresolved runtime evidence plus a confirmed high-confidence API impact stays affected', () => {
    // The legacy caller cannot separate the runtime site out of `impactCount`
    // (no `runtimeDeclarationSiteCount`), but `impactConfidence: 'high'` is
    // the same signal the resolved-runtime branch already trusts to mean "a
    // real local match was found" — so the confirmed impact must survive.
    const candidate = {
      status: 'ready',
      breakingCount: 1,
      impactCount: 2,
      impactFiles: 2,
      impactConfidence: 'high' as const,
      runtimeCompatibility: 'unknown' as const,
    };
    assert.equal(severityOf(candidate), 'affected');
  });

  test('canonical caller with only unresolved runtime sites stays runtime unresolved', () => {
    const candidate = {
      status: 'ready',
      breakingCount: 1,
      impactCount: 2,
      impactFiles: 2,
      actionableImpactCount: 0,
      actionableImpactFiles: 0,
      runtimeDeclarationSiteCount: 2,
      impactConfidence: 'high' as const,
      runtimeCompatibility: 'unknown' as const,
    };
    assert.equal(severityOf(candidate), 'runtime-unresolved');
  });

  test('canonical caller with a nonzero actionableImpactCount is affected even with unresolved runtime', () => {
    const candidate = {
      status: 'ready',
      breakingCount: 1,
      impactCount: 2,
      impactFiles: 2,
      actionableImpactCount: 1,
      actionableImpactFiles: 1,
      runtimeDeclarationSiteCount: 1,
      runtimeCompatibility: 'unknown' as const,
    };
    assert.equal(severityOf(candidate), 'affected');
  });
});
