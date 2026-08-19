import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConclusion, type Conclusion } from './review.ts';

function baseConclusion(overrides: Partial<Conclusion> = {}): Conclusion {
  return {
    upstreamFindings: [],
    impactSites: [],
    gaps: [],
    groundTruthSafety: 'safe',
    repair: { expectedAction: 'no-repair-needed', expectedChangedFiles: [] },
    ...overrides,
  };
}

test('unsafe with no supporting evidence fails validation', () => {
  const problems = validateConclusion(baseConclusion({ groundTruthSafety: 'unsafe' }));
  assert.ok(problems.length > 0, 'expected a validation problem for unsupported unsafe claim');
});

test('unsafe with a real impact site passes validation', () => {
  const problems = validateConclusion(
    baseConclusion({ groundTruthSafety: 'unsafe', impactSites: ['src/app.js:foo'], repair: { expectedAction: 'repair', expectedChangedFiles: ['src/app.js'] } }),
  );
  assert.deepEqual(problems, []);
});

test('unsafe with a stated gap passes validation even with no impact sites', () => {
  const problems = validateConclusion(
    baseConclusion({ groundTruthSafety: 'unsafe', gaps: ['could not verify locally'] }),
  );
  assert.deepEqual(problems, []);
});

test('safe with a non-empty impactSites list fails validation', () => {
  const problems = validateConclusion(baseConclusion({ groundTruthSafety: 'safe', impactSites: ['src/app.js:foo'] }));
  assert.ok(problems.length > 0);
});

test('safe with an empty impactSites list passes validation', () => {
  const problems = validateConclusion(baseConclusion({ groundTruthSafety: 'safe' }));
  assert.deepEqual(problems, []);
});

test('uncertain never fails validation on its own', () => {
  const problems = validateConclusion(baseConclusion({ groundTruthSafety: 'uncertain' }));
  assert.deepEqual(problems, []);
});
