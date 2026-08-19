import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffConclusions, validateAdjudicationConsistency, validateConclusion, type Adjudication, type Conclusion, type Review } from './review.ts';

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

function review(id: string, conclusion: Conclusion): Review {
  return {
    id,
    fixtureId: 'x',
    createdAt: '2026-08-19T00:00:00.000Z',
    reviewer: { type: 'ai', name: 'test', provider: 'unavailable', model: 'unavailable', modelVersion: 'unavailable', toolVersion: 'unavailable' },
    reviewedRevision: { fixtureMetadata: 'h', upstreamOld: 'h', upstreamNew: 'h', consumer: 'h', oracles: 'h', goldPatch: 'h' },
    evidence: { files: [], commands: [], artifacts: [], notes: '' },
    conclusion,
    rationale: { summary: 's', findingNotes: [], uncertainty: '' },
    status: 'reviewed',
    reviewOf: [],
    promptVersion: 'v1',
    promptHash: 'h',
  };
}

function adjudicationFor(decision: Conclusion, extra: Partial<Adjudication> = {}): Adjudication {
  return {
    fixtureId: 'x',
    acceptedReviewIds: ['r1'],
    decision,
    status: 'accepted',
    decidedAt: '2026-08-19T00:00:00.000Z',
    decidedBy: { type: 'ai', name: 'test' },
    notes: '',
    ...extra,
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

// --- diffConclusions: canonical, order-insensitive comparison ---

test('array ordering differences alone do not count as semantic differences', () => {
  const a = baseConclusion({ upstreamFindings: ['a', 'b'], impactSites: ['x', 'y'], gaps: ['g1', 'g2'] });
  const b = baseConclusion({ upstreamFindings: ['b', 'a'], impactSites: ['y', 'x'], gaps: ['g2', 'g1'] });
  assert.deepEqual(diffConclusions(a, b), []);
});

test('a real semantic difference in a set field is detected', () => {
  const a = baseConclusion({ upstreamFindings: ['a', 'b'] });
  const b = baseConclusion({ upstreamFindings: ['a', 'c'] });
  assert.deepEqual(diffConclusions(a, b), ['upstreamFindings']);
});

test('repair.expectedAction differences are detected even though it is not a set', () => {
  const a = baseConclusion({ repair: { expectedAction: 'repair', expectedChangedFiles: ['x'] } });
  const b = baseConclusion({ repair: { expectedAction: 'abstain', expectedChangedFiles: ['x'] } });
  assert.deepEqual(diffConclusions(a, b), ['repair.expectedAction']);
});

test('taxonomy detectability/visibility ordering does not count, but nature/scope do', () => {
  const tax = { nature: 'api-shape', scope: 'symbol', detectability: ['a', 'b'], visibility: ['direct'] };
  const a = baseConclusion({ taxonomy: { ...tax, detectability: ['a', 'b'] } });
  const b = baseConclusion({ taxonomy: { ...tax, detectability: ['b', 'a'] } });
  assert.deepEqual(diffConclusions(a, b), []);

  const c = baseConclusion({ taxonomy: { ...tax, nature: 'behaviour' } });
  assert.deepEqual(diffConclusions(a, c), ['taxonomy']);
});

// --- validateAdjudicationConsistency: provenance gate (see eval/src/cli/validate.ts) ---

test('one accepted review exactly matching adjudication passes', () => {
  const conclusion = baseConclusion({ upstreamFindings: ['a'] });
  const problems = validateAdjudicationConsistency(adjudicationFor(conclusion), [review('r1', conclusion)]);
  assert.deepEqual(problems, []);
});

test('one accepted review differing from adjudication with no override metadata fails', () => {
  const reviewConclusion = baseConclusion({ upstreamFindings: ['a'] });
  const adjConclusion = baseConclusion({ upstreamFindings: ['b'] });
  const problems = validateAdjudicationConsistency(adjudicationFor(adjConclusion), [review('r1', reviewConclusion)]);
  assert.ok(problems.length > 0, 'expected a problem for an unexplained delta');
});

test('one accepted review differing from adjudication with a complete, accurate override passes', () => {
  const reviewConclusion = baseConclusion({ upstreamFindings: ['a'] });
  const adjConclusion = baseConclusion({ upstreamFindings: ['b'] });
  const adj = adjudicationFor(adjConclusion, {
    override: { enabled: true, reason: 'newer evidence', changedFields: ['upstreamFindings'] },
  });
  const problems = validateAdjudicationConsistency(adj, [review('r1', reviewConclusion)]);
  assert.deepEqual(problems, []);
});

test('override.changedFields missing an actually-differing field fails', () => {
  const reviewConclusion = baseConclusion({ upstreamFindings: ['a'], gaps: ['g1'] });
  const adjConclusion = baseConclusion({ upstreamFindings: ['b'], gaps: ['g2'] });
  const adj = adjudicationFor(adjConclusion, {
    override: { enabled: true, reason: 'partial', changedFields: ['upstreamFindings'] }, // missing 'gaps'
  });
  const problems = validateAdjudicationConsistency(adj, [review('r1', reviewConclusion)]);
  assert.ok(problems.some((p) => p.includes('missing')), `expected a "missing" problem, got: ${JSON.stringify(problems)}`);
});

test('override.changedFields listing a field that does not actually differ fails', () => {
  const conclusion = baseConclusion({ upstreamFindings: ['a'] });
  const adj = adjudicationFor(conclusion, {
    override: { enabled: true, reason: 'stale override', changedFields: ['gaps'] }, // decision === review; nothing differs
  });
  const problems = validateAdjudicationConsistency(adj, [review('r1', conclusion)]);
  assert.ok(problems.length > 0, 'expected a problem for an override that names a field that does not differ');
});

test('multiple accepted reviews with synthesis metadata covering every delta passes', () => {
  const reviewA = baseConclusion({ upstreamFindings: ['a'] });
  const reviewB = baseConclusion({ upstreamFindings: ['b'] });
  const adjConclusion = baseConclusion({ upstreamFindings: ['a', 'b'] });
  const adj = adjudicationFor(adjConclusion, {
    acceptedReviewIds: ['r1', 'r2'],
    synthesis: { reason: 'combined both reviewers findings', changedFields: ['upstreamFindings'] },
  });
  const problems = validateAdjudicationConsistency(adj, [review('r1', reviewA), review('r2', reviewB)]);
  assert.deepEqual(problems, []);
});

test('multiple accepted reviews with an unexplained synthesized decision fails', () => {
  const reviewA = baseConclusion({ upstreamFindings: ['a'] });
  const reviewB = baseConclusion({ upstreamFindings: ['b'] });
  const adjConclusion = baseConclusion({ upstreamFindings: ['a', 'b'] });
  const adj = adjudicationFor(adjConclusion, { acceptedReviewIds: ['r1', 'r2'] }); // no synthesis metadata
  const problems = validateAdjudicationConsistency(adj, [review('r1', reviewA), review('r2', reviewB)]);
  assert.ok(problems.length > 0, 'expected a problem for an unexplained multi-review synthesis');
});
