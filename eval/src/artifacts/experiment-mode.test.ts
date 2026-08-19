import assert from 'node:assert/strict';
import { test } from 'node:test';
import { experimentModeFor, trackSchema, type Track } from './prediction.ts';
import { endToEndOnly, type CaseEvaluation } from '../evaluate.ts';

/**
 * The distinction `experimentMode` exists to encode, pinned so it cannot decay
 * back into a comment.
 *
 * It previously was one: `base()` stamped `end-to-end` on every artifact,
 * whatever the track, while the docs described capability tracks as
 * conditional and the report separated them by consulting a set that answers a
 * different question. Anything that pools results now reads the field.
 */

test('every track has an explicit mode, and only the user-facing chain is end-to-end', () => {
  const modes = Object.fromEntries(trackSchema.options.map((track) => [track, experimentModeFor(track)]));

  assert.deepEqual(modes, {
    'detect-end-to-end': 'end-to-end',
    'repair-full-remediation': 'end-to-end',
    'detect-known-bump': 'ablation',
    'repair-codemod': 'conditional',
    'repair-fixplan-cache': 'conditional',
    'repair-fixplan-recipe': 'conditional',
    'repair-fixplan-model': 'conditional',
    'repair-agent': 'conditional',
  });
});

function evaluation(track: Track): CaseEvaluation {
  return {
    caseId: 'c',
    track,
    trial: 1,
    stale: false,
    detection: null,
    repair: null,
    provenance: {} as CaseEvaluation['provenance'],
    experimentMode: experimentModeFor(track),
    adjudicationRevision: 'unavailable',
    isolation: { audited: true, pathsAudited: 0, networkPolicy: 'disabled', level: 'workspace-audit' as const, groundTruthReadableOnHost: true, spawnsSubprocesses: false },
    integrityFailures: [],
  };
}

test('a conditional or ablation result cannot reach a headline pool', () => {
  const all = trackSchema.options.map(evaluation);
  const headline = endToEndOnly(all);

  assert.deepEqual(
    headline.map((entry) => entry.track).sort(),
    ['detect-end-to-end', 'repair-full-remediation'],
  );
  assert.ok(
    headline.every((entry) => entry.experimentMode === 'end-to-end'),
    'the filter reads the artifact field, not the track name',
  );
});

test('the filter follows the field, so a mislabelled artifact is excluded rather than trusted for its name', () => {
  // If an artifact ever says `conditional`, it stays out of the headline even
  // when its track would otherwise qualify. The field is the authority.
  const mislabelled: CaseEvaluation = { ...evaluation('repair-full-remediation'), experimentMode: 'conditional' };
  assert.deepEqual(endToEndOnly([mislabelled]), []);
});
