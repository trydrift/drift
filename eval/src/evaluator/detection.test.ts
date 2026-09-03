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

test('a completed localization with no hits is NOT correct-safe — it is safe-but-inconclusive', () => {
  // "Drift searched and found nothing" is not affirmative evidence the
  // repository is unaffected, so it no longer scores as a safety success even
  // when the ground truth is safe. It is also not a safety failure.
  const result = d4('detected-not-locally-reachable', 'safe');
  assert.equal(result.correctSafe, false);
  assert.equal(result.falseSafe, false);
  assert.equal(result.safeButInconclusive, true);
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

test('unsafe truth plus a safe-equivalent verdict is a false-safe', () => {
  for (const verdict of ['clean', 'no-incompatible-change-in-checked-surfaces']) {
    assert.equal(d4(verdict, 'unsafe').falseSafe, true, `${verdict} must count as a safety claim`);
  }
});

test('unsafe truth plus detected-not-locally-reachable is a miss, not a false-safe', () => {
  // Reporting "breaking change upstream, impact unresolved — review" about code
  // that is in fact affected is a conservative miss, not the catastrophic
  // trust failure a false-safe is.
  const result = d4('detected-not-locally-reachable', 'unsafe');
  assert.equal(result.falseSafe, false);
  assert.equal(result.correctAffected, false);
  assert.equal(isSafeEquivalent('detected-not-locally-reachable'), false);
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
  const result = d4('no-incompatible-change-in-checked-surfaces', 'uncertain');
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

/*
 * Taxonomy attribution.
 *
 * Taxonomy is a claim *about a finding*, so it can only be credited against a
 * finding adjudicated truth recognised. The regression these pin is a real
 * scoring bug: `scoreTaxonomy` used to ask whether *any* predicted breaking
 * change carried the adjudicated labels, so a run that misclassified the one
 * real change and invented a second, unrelated one with the right labels
 * scored a correct taxonomy.
 */

const RENAME_TAXONOMY = {
  nature: 'rename',
  detectability: ['static'],
  scope: 'api',
  visibility: ['public'],
};

function change(symbol: string, kind: string, taxonomy?: DetectionArtifact['breakingChanges'][number]['taxonomy']) {
  return {
    dependency: 'left-pad',
    kind,
    symbols: [symbol],
    replacementSymbols: [],
    summary: `${kind} of ${symbol}`,
    citations: [],
    verdict: 'locally-affected',
    ...(taxonomy ? { taxonomy } : {}),
  };
}

test('taxonomy is wrong when the matched change carries the wrong labels, however right an unrelated prediction is', () => {
  const score = scoreDetection({
    caseId: 'c',
    detection: detection('locally-affected', {
      breakingChanges: [
        // The change truth actually ruled on — matched at D2, wrongly classified.
        change('A', 'rename', { ...RENAME_TAXONOMY, nature: 'removal' }),
        // An unrelated false positive that happens to carry the expected labels.
        change('B', 'rename', RENAME_TAXONOMY),
      ],
    }),
    truth: truth('unsafe', { upstreamFindings: ['left-pad:A:rename'], taxonomy: RENAME_TAXONOMY }),
  });

  assert.equal(score.d2BreakingChanges.confusion.tp, 1, 'A must match at D2');
  assert.equal(score.d2BreakingChanges.confusion.fp, 1, 'B must be a false positive at D2');
  assert.equal(score.taxonomy.status, 'scored');
  assert.equal(score.taxonomy.correct, false, 'an unmatched prediction must not earn the taxonomy point');
  assert.equal(score.taxonomy.matchedChanges, 1);
});

test('taxonomy is correct when the matched change itself carries the adjudicated labels', () => {
  const score = scoreDetection({
    caseId: 'c',
    detection: detection('locally-affected', {
      breakingChanges: [change('A', 'rename', RENAME_TAXONOMY), change('B', 'removal')],
    }),
    truth: truth('unsafe', { upstreamFindings: ['left-pad:A:rename'], taxonomy: RENAME_TAXONOMY }),
  });
  assert.equal(score.taxonomy.correct, true);
  assert.equal(score.taxonomy.matchedChanges, 1);
});

test('taxonomy is scored and wrong when Drift never produced the adjudicated finding at all', () => {
  const score = scoreDetection({
    caseId: 'c',
    detection: detection('locally-affected', { breakingChanges: [change('B', 'rename', RENAME_TAXONOMY)] }),
    truth: truth('unsafe', { upstreamFindings: ['left-pad:A:rename'], taxonomy: RENAME_TAXONOMY }),
  });
  assert.equal(score.taxonomy.status, 'scored');
  assert.equal(score.taxonomy.correct, false);
  assert.equal(score.taxonomy.matchedChanges, 0);
});

test('one adjudicated taxonomy over several adjudicated findings is not attributable, and scores nothing', () => {
  const score = scoreDetection({
    caseId: 'c',
    detection: detection('locally-affected', {
      breakingChanges: [change('A', 'rename', RENAME_TAXONOMY), change('B', 'rename', RENAME_TAXONOMY)],
    }),
    truth: truth('unsafe', {
      upstreamFindings: ['left-pad:A:rename', 'left-pad:B:rename'],
      taxonomy: RENAME_TAXONOMY,
    }),
  });
  assert.equal(score.taxonomy.status, 'not-attributable');
  assert.equal(score.taxonomy.correct, false);
});

test('taxonomy is not-adjudicated when the adjudication states none', () => {
  const score = scoreDetection({
    caseId: 'c',
    detection: detection('locally-affected', { breakingChanges: [change('A', 'rename', RENAME_TAXONOMY)] }),
    truth: truth('unsafe', { upstreamFindings: ['left-pad:A:rename'] }),
  });
  assert.equal(score.taxonomy.status, 'not-adjudicated');
});
