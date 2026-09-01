import assert from 'node:assert/strict';
import test from 'node:test';
import { caseState, compareCases, renderComparison } from './compare.ts';
import type { ExternalCaseResult } from './record.ts';

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
  const newResults = [result('affected', 'locally-affected'), result('moved-safe', 'detected-not-locally-reachable')];
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
