import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DATASETS } from './dataset.ts';
import { computeMetrics, exhaustivePrf, formatRate, rate } from './metrics.ts';
import type { ExternalCaseResult } from './record.ts';

/**
 * The refusals are the point of this module, so they are what is tested.
 *
 * A metrics module that computes everything it is asked for is easy to write
 * and produces a website full of numbers that describe arithmetic rather than a
 * tool. Every test below is an assertion that some number is *absent*.
 */

function result(overrides: Partial<ExternalCaseResult> = {}): ExternalCaseResult {
  return {
    schemaVersion: 'drift-external-case-v1',
    caseId: 'c',
    provenance: {
      dataset: 'test',
      datasetVersion: 'v',
      recordId: 'r',
      repository: 'https://example.invalid/r',
      commit: 'deadbeef',
      baseCommit: null,
      dependency: null,
      fromVersion: null,
      toVersion: null,
      packageManager: null,
      requiredRuntime: null,
      oracleCommand: null,
      containerImage: null,
      sourceHash: 'h',
      extra: {},
    },
    truth: { label: 'l', mappedTo: null, mappingStatus: 'exact', mappingNote: '', polarity: 'positive' },
    prediction: {},
    outcomes: {},
    excluded: null,
    durationMs: 0,
    ...overrides,
  };
}

test('a rate over nothing is undefined, never zero', () => {
  assert.equal(rate(0, 0).value, null);
  assert.equal(formatRate(rate(0, 0)), 'n/a (0/0)');
  assert.equal(formatRate(rate(3, 7)), '3/7 (42.9%)');
});

test('a positive-only corpus yields no precision, no F1 and no false-positive rate', () => {
  const metrics = computeMetrics({
    dataset: DATASETS['swe-bump']!,
    available: 10,
    results: [
      result({ caseId: 'a', outcomes: { identifiedAffected: true }, predictedPositive: true }),
      result({ caseId: 'b', outcomes: { identifiedAffected: false }, predictedPositive: false }),
    ],
  });

  assert.equal(metrics.confusion, null, 'no confusion matrix without a negative population');
  assert.equal(metrics.classification, null);
  const refused = metrics.refusals.map((refusal) => refusal.metric);
  assert.deepEqual(refused.sort(), ['F1', 'false-positive rate', 'precision']);
  assert.ok(
    metrics.refusals[0]!.reason.includes('not exhaustive'),
    'the refusal must state why, not merely that',
  );
});

test('an exhaustively labelled corpus with real negatives does get a confusion matrix', () => {
  const metrics = computeMetrics({
    dataset: DATASETS['kong']!,
    available: 4,
    results: [
      result({ caseId: 'a', predictedPositive: true, outcomes: { detectedBreaking: true } }),
      result({ caseId: 'b', predictedPositive: false, outcomes: { detectedBreaking: false } }),
      result({ caseId: 'c', truth: { ...result().truth, polarity: 'negative' }, predictedPositive: true }),
      result({ caseId: 'd', truth: { ...result().truth, polarity: 'negative' }, predictedPositive: false }),
    ],
  });

  assert.deepEqual(metrics.confusion, { tp: 1, fp: 1, tn: 1, fn: 1 });
  assert.equal(metrics.classification!.precision.value, 0.5);
  assert.equal(metrics.classification!.recall.value, 0.5);
  assert.equal(metrics.refusals.length, 0);
});

/**
 * The subtle one, and the reason `hasNegatives` is computed from the results
 * rather than read off the dataset's `exhaustive` flag.
 */
test('an exhaustive dataset that supplied this run no negatives still gets no precision', () => {
  const metrics = computeMetrics({
    dataset: DATASETS['kong']!,
    available: 100,
    results: [
      result({ caseId: 'a', predictedPositive: true, outcomes: { detectedBreaking: true } }),
      result({ caseId: 'b', predictedPositive: false, outcomes: { detectedBreaking: false } }),
    ],
  });

  assert.equal(metrics.confusion, null);
  assert.ok(metrics.refusals.some((refusal) => refusal.metric === 'precision'));
  assert.ok(
    metrics.refusals.find((refusal) => refusal.metric === 'precision')!.reason.includes('no negative/control cases'),
    'and the reason must name the actual cause, not the dataset-level flag',
  );
});

test('exhaustivePrf throws rather than returning a placeholder for a non-exhaustive corpus', () => {
  assert.throws(
    () => exhaustivePrf(DATASETS['bump']!, { tp: 5, fp: 1, fn: 2 }),
    /Refusing to compute precision/,
  );
});

test('every exclusion is counted with its reason, and nothing disappears', () => {
  const metrics = computeMetrics({
    dataset: DATASETS['bump']!,
    available: 571,
    results: [
      result({ caseId: 'a', outcomes: { identifiedAffected: true } }),
      result({
        caseId: 'b',
        excluded: { kind: 'environment-unavailable', reason: 'no container runtime', missingRequirement: 'docker' },
      }),
      result({
        caseId: 'c',
        excluded: { kind: 'environment-unavailable', reason: 'no container runtime', missingRequirement: 'docker' },
      }),
    ],
  });

  assert.equal(metrics.selected, 3);
  assert.equal(metrics.scored, 1);
  assert.deepEqual(metrics.excluded, { 'environment-unavailable': 2 });
  assert.deepEqual(metrics.missingRequirements, { docker: 2 });
});

test('a metric the dataset says its annotation cannot support is dropped, with the reason recorded', () => {
  // BUMP's ground truth supports recall, repair success and a false-safe count.
  // A category-accuracy outcome asked of it is a fabrication, whoever asked.
  const metrics = computeMetrics({
    dataset: DATASETS['bump']!,
    available: 1,
    results: [result({ outcomes: { categoryCorrect: true } })],
  });

  assert.ok(!('category classification accuracy' in metrics.rates));
  assert.ok(metrics.refusals.some((refusal) => refusal.metric === 'category classification accuracy'));
});

test('a false-safe is reported with its denominator rather than as a bare percentage', () => {
  const metrics = computeMetrics({
    dataset: DATASETS['swe-bump']!,
    available: 3,
    results: [
      result({ caseId: 'a', outcomes: { falseSafe: true } }),
      result({ caseId: 'b', outcomes: { falseSafe: false } }),
      result({ caseId: 'c', outcomes: { falseSafe: false } }),
    ],
  });
  assert.deepEqual(metrics.rates['false-safe verdicts'], { numerator: 1, denominator: 3, value: 1 / 3 });
});

test('the breakdown splits every rate by label, so a pooled figure is never the only number', () => {
  const metrics = computeMetrics({
    dataset: DATASETS['kong']!,
    available: 2,
    results: [
      result({ caseId: 'a', truth: { ...result().truth, label: 'rename method' }, outcomes: { detectedBreaking: true } }),
      result({ caseId: 'b', truth: { ...result().truth, label: 'remove method' }, outcomes: { detectedBreaking: false } }),
    ],
  });

  assert.equal(metrics.breakdown['label: rename method']!['breaking-change detection recall']!.value, 1);
  assert.equal(metrics.breakdown['label: remove method']!['breaking-change detection recall']!.value, 0);
});
