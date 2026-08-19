import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSafeEquivalent, scoreDetection } from './detection.ts';
import type { DetectionArtifact } from '../artifacts/prediction.ts';
import type { Conclusion } from '../review.ts';

/**
 * D4 — whether the user was told something honest.
 *
 * The property under test is not "does Drift get these cases right"; it is that
 * every one of the five judgements is *reachable*. A control case that cannot
 * score `correctSafe` however correct Drift is measures nothing, and a
 * false-safe that a verdict wording can slip past is worse than no metric.
 */

function detection(verdict: string, overrides: Partial<DetectionArtifact> = {}): DetectionArtifact {
  return {
    dependencyChanges: [],
    triageSkipped: [],
    upstreamFindings: [],
    checkedSurfaces: [],
    breakingChanges: [],
    impactSites: [],
    gaps: [],
    verificationOutcomes: [],
    verdict,
    ...overrides,
  };
}

function truth(safety: Conclusion['groundTruthSafety'], overrides: Partial<Conclusion> = {}): Conclusion {
  return {
    upstreamFindings: [],
    impactSites: [],
    gaps: [],
    groundTruthSafety: safety,
    repair: { expectedAction: 'no-repair-needed', expectedChangedFiles: [] },
    ...overrides,
  };
}

const d4 = (verdict: string, safety: Conclusion['groundTruthSafety']) =>
  scoreDetection({ caseId: 'c', detection: detection(verdict), truth: truth(safety) }).d4;

test('a safe control scores correct-safe when Drift searched and found nothing reachable', () => {
  const result = d4('detected-not-locally-reachable', 'safe');
  assert.equal(result.correctSafe, true);
  assert.equal(result.falseSafe, false);
  assert.equal(result.safeButInconclusive, false);
});

test('a safe control scores correct-safe when no incompatible change was found in checked surfaces', () => {
  assert.equal(d4('no-incompatible-change-in-checked-surfaces', 'safe').correctSafe, true);
});

test('a safe control with insufficient evidence is not correct-safe, and is not a safety failure either', () => {
  const result = d4('insufficient-evidence', 'safe');
  assert.equal(result.correctSafe, false);
  assert.equal(result.falseSafe, false);
  assert.equal(result.safeButInconclusive, true);
});

test('unsafe truth plus any safe-equivalent verdict is a false-safe, including not-locally-reachable', () => {
  for (const verdict of ['clean', 'no-incompatible-change-in-checked-surfaces', 'detected-not-locally-reachable']) {
    assert.equal(d4(verdict, 'unsafe').falseSafe, true, `${verdict} must count as a safety claim`);
  }
});

test('unsafe truth plus an inconclusive verdict is a miss, not a false-safe', () => {
  for (const verdict of ['insufficient-evidence', 'verification-incomplete', 'unchecked', 'verification-failed']) {
    const result = d4(verdict, 'unsafe');
    assert.equal(result.falseSafe, false, `${verdict} is not a claim of safety`);
    assert.equal(result.correctAffected, false);
    assert.equal(isSafeEquivalent(verdict), false);
  }
});

test('uncertain truth plus a safe-equivalent verdict is unsupported-safe, never pooled into false-safe', () => {
  const result = d4('detected-not-locally-reachable', 'uncertain');
  assert.equal(result.unsupportedSafe, true);
  assert.equal(result.falseSafe, false);
  assert.equal(result.correctSafe, false);
});

test('unsafe truth plus locally-affected is correct-affected', () => {
  const result = d4('locally-affected', 'unsafe');
  assert.equal(result.correctAffected, true);
  assert.equal(result.falseSafe, false);
});

test('an empty finding list does not by itself make a verdict safe', () => {
  // The artifact carries no breaking changes and no impact sites at all. What
  // decides the verdict is what Drift *said*, never the emptiness of a list.
  assert.equal(d4('insufficient-evidence', 'safe').correctSafe, false);
  assert.equal(d4('unchecked', 'safe').correctSafe, false);
});
