import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exclusionKindSchema, type ExternalCaseResult } from './record.ts';
import { reclassifyRecordedExclusion } from './exclusion-reclassification.ts';

/**
 * The published TimeMachine card said "32 excluded — reproduction-failed". 31 of
 * those cases had no dependency update in them at all; one genuinely timed out.
 * These tests pin that the correction moves exactly the first kind and never the
 * second, and that the recorded reason — the observation itself — is left alone.
 */

type Kind = NonNullable<ExternalCaseResult['excluded']>['kind'];

const NO_UPDATE =
  'no requirements file at e32fba3f8eecfc291201b21776b9f130e152c1c3 declares a package whose resolved version differs, so no dependency update could be constructed for this task';

function excludedAs(kind: Kind, reason: string): ExternalCaseResult {
  return { caseId: 'case', excluded: { kind, reason, missingRequirement: null } } as unknown as ExternalCaseResult;
}

test('no-dependency-update is a recognised exclusion kind', () => {
  assert.equal(exclusionKindSchema.parse('no-dependency-update'), 'no-dependency-update');
});

test('a TimeMachine case with no dependency update is refiled, and its reason is untouched', () => {
  const out = reclassifyRecordedExclusion(excludedAs('reproduction-failed', NO_UPDATE));
  assert.equal(out.excluded?.kind, 'no-dependency-update');
  assert.equal(out.excluded?.reason, NO_UPDATE);
});

test('a genuine timeout stays a reproduction failure', () => {
  const reason = 'timed-out: the case exceeded its 900s deadline and was abandoned so the run could continue';
  assert.equal(reclassifyRecordedExclusion(excludedAs('reproduction-failed', reason)).excluded?.kind, 'reproduction-failed');
});

test('a near-miss message is not refiled', () => {
  // Also "no update can be applied", but a different claim about a different
  // corpus — the match is the adapter's exact sentence, not its vocabulary.
  const reason = 'axios is not declared in package.json at 0a1b2c3, so the recorded bump cannot be applied';
  assert.equal(reclassifyRecordedExclusion(excludedAs('reproduction-failed', reason)).excluded?.kind, 'reproduction-failed');
});

test('only a reproduction-failed record is ever refiled', () => {
  assert.equal(reclassifyRecordedExclusion(excludedAs('source-unavailable', NO_UPDATE)).excluded?.kind, 'source-unavailable');
});

test('a case that was not excluded passes through as the same object', () => {
  const scored = { caseId: 'case', excluded: null } as unknown as ExternalCaseResult;
  assert.equal(reclassifyRecordedExclusion(scored), scored);
});
