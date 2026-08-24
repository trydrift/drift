import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { confidenceDisplay } from '../dist/report/confidence.js';
import type { ConfidenceAssessment } from '../src/confidence/types.js';

const dimension = (score: number, band: 'high' | 'medium' | 'low' | 'none') => ({
  score,
  band,
  evidence: [],
  penalties: [],
  calibration: 'test',
});

function change(confidence: 'high' | 'medium' | 'low', assessment?: ConfidenceAssessment) {
  return { confidence, assessment } as never;
}

function assessment(score: number, band: 'high' | 'medium' | 'low' | 'none'): ConfidenceAssessment {
  return {
    upstream: dimension(score, band),
    localImpact: dimension(score, band),
    verification: dimension(0, 'none'),
    automaticExecutionEligible: false,
    reasons: [],
    checkedSurfaces: [],
    gaps: [],
  } as ConfidenceAssessment;
}

describe('shared confidence presentation', () => {
  test('uses the calibrated numeric score and label for every band', () => {
    assert.equal(confidenceDisplay(change('high', assessment(0.86, 'high'))).text, '86/100 — Very confident');
    assert.equal(confidenceDisplay(change('medium', assessment(0.64, 'medium'))).text, '64/100 — Fairly confident');
    assert.equal(confidenceDisplay(change('low', assessment(0.31, 'low'))).text, '31/100 — Not very confident');
    assert.equal(confidenceDisplay(change('low', assessment(0, 'none'))).text, '0/100 — Not enough evidence to say');
  });

  test('does not present upstream-only confidence as overall confidence', () => {
    for (const upstreamConfidence of ['high', 'medium', 'low'] as const) {
      const display = confidenceDisplay(change(upstreamConfidence));
      assert.equal(display.text, 'Confidence unavailable');
      assert.equal(display.score, null);
      assert.equal(display.band, 'none');
      assert.equal(display.label, 'Confidence unavailable');
      assert.doesNotMatch(display.text, /\/100/);
    }
  });
});
