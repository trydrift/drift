import assert from 'node:assert/strict';
import test from 'node:test';
import {
  caseState,
  compareCases,
  normalizeComparisonSelection,
  renderComparison,
  validateRunCompatibility,
  type ComparisonSelection,
} from './compare.ts';
import { DATASETS } from './dataset.ts';
import type { ExternalCaseResult } from './record.ts';
import type { RunManifest } from './results.ts';
import type { Selection } from './selection.ts';

function result(caseId: string, verdict: string, polarity: 'positive' | 'negative' = 'positive'): ExternalCaseResult {
  return {
    schemaVersion: 'drift-external-case-v1',
    caseId,
    provenance: {
      dataset: 'bump', datasetVersion: 'v', recordId: caseId, repository: 'https://example.invalid',
      commit: 'abc', baseCommit: null, dependency: 'g:a', fromVersion: '1', toVersion: '2', packageManager: 'maven',
      requiredRuntime: null, oracleCommand: null, containerImage: null, sourceHash: 'h', extra: {},
    },
    truth: { label: 'break', mappedTo: 'locally-affected', mappingStatus: 'compatible', mappingNote: '', polarity },
    prediction: { verdict, checkedSurfaces: ['api-surface'], breakingChanges: [{ kind: 'signature' }], impactSites: [] },
    outcomes: {},
    excluded: null,
    durationMs: 1,
  };
}

test('case comparison reports stable identities and verdict transitions', () => {
  const oldResults = [result('moved-safe', 'insufficient-evidence'), result('affected', 'locally-affected')];
  const newResults = [result('affected', 'locally-affected'), result('moved-safe', 'no-incompatible-change-in-checked-surfaces')];
  const transitions = compareCases(oldResults, newResults);

  assert.deepEqual(transitions.map(({ caseId, from, to }) => ({ caseId, from, to })), [
    { caseId: 'affected', from: 'locally-affected', to: 'locally-affected' },
    { caseId: 'moved-safe', from: 'unknown', to: 'safe-equivalent' },
  ]);
  assert.equal(caseState(newResults[1]!), 'safe-equivalent');
});

test('positive non-safe to safe transitions require an explicit adjudication', () => {
  const transitions = compareCases(
    [result('positive', 'insufficient-evidence'), result('negative', 'insufficient-evidence', 'negative')],
    [result('positive', 'clean'), result('negative', 'clean', 'negative')],
  );
  const blocked = renderComparison('BUMP', transitions);
  assert.deepEqual(blocked.unadjudicatedSafeTransitions, ['positive']);
  assert.match(blocked.text, /checkedSurfaces/);
  assert.match(blocked.text, /Adjudication: \*\*required\*\*/);

  const allowed = renderComparison('BUMP', transitions, { positive: 'false positive fixed; reviewed by benchmark owner' });
  assert.deepEqual(allowed.unadjudicatedSafeTransitions, []);
});

test('case comparison rejects old-only and new-only results instead of comparing the intersection', () => {
  assert.throws(
    () => compareCases([result('old-only', 'clean')], [result('new-only', 'clean')]),
    /result case populations differ; old-only: old-only; new-only: new-only/,
  );
});

test('legacy selections resolve their dataset from the manifest before comparison', () => {
  const manifest = comparisonManifest('bump', 'dataset-version');
  const legacySelection: Selection = {
    seed: 1,
    limit: null,
    mode: 'all',
    ids: ['case'],
    strata: {},
    available: 1,
  };
  const newSelection = comparisonSelection(['case']);
  const normalizedLegacy = normalizeComparisonSelection(legacySelection, manifest);
  const results = [result('case', 'clean')];

  assert.equal(normalizedLegacy.dataset, DATASETS['bump']);
  assert.doesNotThrow(() =>
    validateRunCompatibility(manifest, manifest, normalizedLegacy, newSelection, results, results),
  );
});

test('run comparison rejects changed selections and incomplete result files', () => {
  const manifest = comparisonManifest('bump', 'dataset-version');
  const oldSelection = comparisonSelection(['shared', 'old-only']);
  const newSelection = comparisonSelection(['shared', 'new-only']);

  assert.throws(
    () =>
      validateRunCompatibility(
        manifest,
        manifest,
        oldSelection,
        newSelection,
        [result('shared', 'clean'), result('old-only', 'clean')],
        [result('shared', 'clean'), result('new-only', 'clean')],
      ),
    /selected case populations differ/,
  );

  const sameSelection = comparisonSelection(['shared', 'missing']);
  assert.throws(
    () =>
      validateRunCompatibility(
        manifest,
        manifest,
        sameSelection,
        sameSelection,
        [result('shared', 'clean'), result('missing', 'clean')],
        [result('shared', 'clean')],
      ),
    /new run results versus its selection case populations differ.*old-only: missing/,
  );
});

test('run comparison rejects different dataset or source identities', () => {
  const bumpManifest = comparisonManifest('bump', 'dataset-version');
  const otherManifest = comparisonManifest('roseau', 'dataset-version');
  const selection = comparisonSelection(['case']);
  const results = [result('case', 'clean')];

  assert.throws(
    () => validateRunCompatibility(bumpManifest, otherManifest, selection, selection, results, results),
    /Cannot compare different datasets/,
  );

  assert.throws(
    () =>
      validateRunCompatibility(
        bumpManifest,
        comparisonManifest('bump', 'other-version'),
        selection,
        selection,
        results,
        results,
      ),
    /Cannot compare different dataset versions/,
  );

  const otherSource = {
    ...selection,
    dataset: { ...selection.dataset, source: { ...selection.dataset.source, url: 'https://example.invalid/other' } },
  };
  assert.throws(
    () => validateRunCompatibility(bumpManifest, bumpManifest, selection, otherSource, results, results),
    /Cannot compare different dataset sources/,
  );
});

function comparisonManifest(datasetId: string, datasetVersion: string): RunManifest {
  return {
    version: 'drift-external-run-v1',
    runId: 'run',
    datasetId,
    createdAt: '2026-01-01T00:00:00.000Z',
    driftCommit: 'commit',
    driftTreeDirty: false,
    harnessVersion: 'commit',
    datasetVersion,
    command: 'eval',
    node: 'v24',
    platform: 'darwin',
    arch: 'arm64',
    notes: '',
  };
}

function comparisonSelection(ids: string[]): ComparisonSelection {
  return {
    seed: 1,
    limit: null,
    mode: 'all',
    ids,
    strata: {},
    available: ids.length,
    dataset: DATASETS['bump']!,
  };
}
