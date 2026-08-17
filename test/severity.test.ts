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
    assert.equal(severityOf({ ...base, breakingCount: 1 }), 'upstream-only');
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
    const upstreamOnly = { ...base, breakingCount: 1 };
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
