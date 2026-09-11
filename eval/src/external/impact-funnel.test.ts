import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyImpactMiss, type ImpactFunnelSignals } from './impact-funnel.ts';

/** A signal set that would classify as the last-resort localization bucket; each test overrides the field it exercises. */
function signals(overrides: Partial<ImpactFunnelSignals> = {}): ImpactFunnelSignals {
  return {
    updateDetected: true,
    exactVersionResolved: true,
    surfaceComputedForTarget: true,
    breakingChangeCount: 3,
    maxUpstreamBand: 'high',
    localizationRan: true,
    importerCandidateFiles: 4,
    impactSiteCount: 0,
    localImpactPenaltyCodes: ['no-usage-found'],
    onlyLocallyUnprovable: false,
    verificationStatus: 'passed',
    verificationReason: '',
    confirmedRegression: false,
    multiDependencyAmbiguous: false,
    ...overrides,
  };
}

test('the funnel charges the first failed stage, upstream of everything else', () => {
  assert.equal(classifyImpactMiss(signals({ updateDetected: false })), 'dependency-update-not-detected');
  assert.equal(
    classifyImpactMiss(signals({ updateDetected: false, surfaceComputedForTarget: false })),
    'dependency-update-not-detected',
    'a later stage failing too does not move the charge earlier stages own',
  );
});

test('an unresolved version pair is its own bucket, not a localization miss', () => {
  assert.equal(classifyImpactMiss(signals({ exactVersionResolved: false })), 'exact-version-unresolved');
});

test('a missing upstream surface is charged before any consumer stage', () => {
  assert.equal(classifyImpactMiss(signals({ surfaceComputedForTarget: false })), 'upstream-surface-unavailable');
});

test('a surface with no breaking change derived, and a weak one, are distinct', () => {
  assert.equal(classifyImpactMiss(signals({ breakingChangeCount: 0 })), 'no-breaking-change-derived');
  assert.equal(classifyImpactMiss(signals({ maxUpstreamBand: 'low' })), 'breaking-change-low-confidence');
  assert.equal(classifyImpactMiss(signals({ maxUpstreamBand: 'none' })), 'breaking-change-low-confidence');
});

test('a failed verification splits on whether the regression could be isolated', () => {
  assert.equal(classifyImpactMiss(signals({ verificationStatus: 'failed' })), 'verification-inconclusive');
  assert.equal(
    classifyImpactMiss(signals({ verificationStatus: 'failed', multiDependencyAmbiguous: true })),
    'multi-dependency-attribution-ambiguous',
  );
});

test('a skipped verification is bucketed by why it skipped, and a benign skip falls through', () => {
  assert.equal(
    classifyImpactMiss(
      signals({ verificationStatus: 'skipped', verificationReason: '`build` already fails on this commit before any upgrade is applied' }),
    ),
    'verification-baseline-failed',
  );
  assert.equal(
    classifyImpactMiss(
      signals({ verificationStatus: 'skipped', verificationReason: 'mvn is not installed, so repo could not be built or tested' }),
    ),
    'verification-unavailable',
  );
  assert.equal(
    classifyImpactMiss(
      signals({
        verificationStatus: 'skipped',
        verificationReason: 'This project declares no typecheck or build that Drift could run against the upgrade.',
        importerCandidateFiles: 0,
      }),
    ),
    'dependency-import-not-found',
    'a benign skip does not become a verification miss — the localization stage still owns it',
  );
});

test('behavioural-only changes are charged to the behavioural bucket, not to localization', () => {
  assert.equal(
    classifyImpactMiss(signals({ onlyLocallyUnprovable: true, importerCandidateFiles: 0 })),
    'behavioural-change-without-static-signal',
  );
});

test('no importer, importer-but-no-usage, and unresolved-symbol are three different misses', () => {
  assert.equal(classifyImpactMiss(signals({ importerCandidateFiles: 0 })), 'dependency-import-not-found');
  assert.equal(
    classifyImpactMiss(signals({ importerCandidateFiles: 5, localImpactPenaltyCodes: ['no-usage-found'] })),
    'consumer-usage-not-found',
  );
  assert.equal(
    classifyImpactMiss(signals({ importerCandidateFiles: 5, localImpactPenaltyCodes: [] })),
    'consumer-symbol-not-resolved',
  );
});

test('a weak or partial consumer match is charged to insufficient confidence', () => {
  assert.equal(
    classifyImpactMiss(signals({ impactSiteCount: 2, localImpactPenaltyCodes: ['textual-only'] })),
    'consumer-match-insufficient-confidence',
  );
  assert.equal(
    classifyImpactMiss(signals({ impactSiteCount: 0, localImpactPenaltyCodes: ['wrapper-mediated'] })),
    'consumer-match-insufficient-confidence',
  );
});

test('an unknown importer count still classifies from the penalty codes', () => {
  assert.equal(
    classifyImpactMiss(signals({ importerCandidateFiles: -1, localImpactPenaltyCodes: ['no-usage-found'] })),
    'consumer-usage-not-found',
  );
  assert.equal(
    classifyImpactMiss(signals({ importerCandidateFiles: -1, localImpactPenaltyCodes: [] })),
    'consumer-symbol-not-resolved',
  );
});
