import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAuditInvariants } from '../site/scripts/validate-recordings.mjs';

const ENGINE = 'semantic-fixture';

function candidate(name = 'demo') {
  return {
    id: `package.json#${name}@1.0.0`,
    name,
    current: '1.0.0',
    latest: '2.0.0',
    selected: '2.0.0',
    publishedVersions: ['2.0.0', '1.0.0'],
    provenance: { kind: 'runtime', source: 'manifest' },
    manifestPath: 'package.json',
    hasCompatibilityEvidence: true,
    recommendation: 'safe-to-upgrade',
    runtimeCompatibility: null,
    runtimeAnalyses: [],
    runtimeChanges: [],
    severity: 'clean',
    dispositions: [],
    independentActionableFindingCount: 0,
    breakingCount: 0,
    breaking: [],
    sourceCoverage: {
      localizationRan: true,
      localizationComplete: true,
      sourceFilesDiscovered: 1,
      sourceFilesIndexed: 1,
      sourceTruncated: false,
      runtimeConfigsDiscovered: 0,
      runtimeConfigsIndexed: 0,
      runtimeConfigComplete: true,
    },
    surfaceAssessment: null,
  };
}

function recording(candidates = [candidate()]) {
  return { schemaVersion: 2, id: 'fixture', ecosystem: 'npm', engine: ENGINE, manifests: ['package.json'], candidates };
}

function validate(value) {
  validateAuditInvariants(value, 'fixture.json', true, ENGINE);
}

describe('semantic recording invariants', () => {
  test('accepts an explicitly classified legitimate availability gap', () => {
    const item = candidate();
    item.recommendation = 'insufficient-evidence';
    item.severity = 'evidence-missing';
    item.hasCompatibilityEvidence = false;
    item.surfaceAssessment = {
      available: false,
      reason: 'artifact-unavailable',
      inspection: 'failed',
      tool: 'npm registry tarball',
      detail: 'registry timed out',
    } as never;
    assert.doesNotThrow(() => validate(recording([item])));
  });

  test('rejects fake identities and prerelease identity loss', () => {
    const fake = candidate();
    fake.selected = '3.0.0';
    assert.throws(() => validate(recording([fake])), /not an exact published identity/);

    const prerelease = candidate();
    prerelease.selected = '2.0.0';
    prerelease.publishedVersions = ['2.0.0-rc.1', '1.0.0'];
    assert.throws(() => validate(recording([prerelease])), /lost prerelease identity/);
  });

  test('rejects transitive dependencies presented as manifest-direct', () => {
    const item = candidate();
    item.provenance = { kind: 'transitive', source: 'manifest' };
    assert.throws(() => validate(recording([item])), /transitive.*manifest-direct/);
  });

  test('requires positive inspection before no-public-surface', () => {
    const item = candidate();
    item.surfaceAssessment = {
      available: false,
      reason: 'no-public-surface',
      inspection: 'failed',
      tool: 'declaration archive',
      detail: 'download failed',
    } as never;
    assert.throws(() => validate(recording([item])), /without a successful artifact inspection/);
  });

  test('rejects progress-only causal tool summaries', () => {
    const item = candidate();
    item.surfaceAssessment = {
      available: false,
      reason: 'toolchain-failed',
      inspection: 'failed',
      tool: 'cargo public-api',
      detail: 'failed',
      diagnostic: { causalErrorPresent: true, summary: 'Updating crates.io index\nCompiling demo' },
    } as never;
    assert.throws(() => validate(recording([item])), /progress output instead of the causal tool failure/);
  });

  test('rejects package-role contradictions', () => {
    const item = candidate();
    item.surfaceAssessment = {
      available: false,
      reason: 'artifact-type-unsupported',
      inspection: 'not-applicable',
      packageRole: 'pom',
      tool: 'japicmp classfile API',
      detail: 'missing jar',
    } as never;
    assert.throws(() => validate(recording([item])), /role pom is labeled/);
  });

  test('rejects a changed package-role contract recorded as an ordinary all-clear', () => {
    const item = candidate();
    item.breakingCount = 1;
    item.severity = 'upstream-only';
    item.surfaceAssessment = {
      available: true,
      inspection: 'succeeded',
      packageRole: 'pom',
      tool: 'Maven POM contract',
    } as never;
    assert.throws(() => validate(recording([item])), /changed pom package-role contract safe-to-upgrade/);

    item.recommendation = 'upgrade-after-review';
    assert.doesNotThrow(() => validate(recording([item])));
  });

  test('rejects verdict and localization contradictions', () => {
    const item = candidate();
    item.breakingCount = 1;
    item.severity = 'localization-incomplete';
    item.sourceCoverage.localizationComplete = false;
    item.sourceCoverage.sourceTruncated = true;
    item.dispositions = [{ changeId: 'bc', state: 'unaffected', reason: 'no-local-impact', siteCount: 0, actionableSiteCount: 0 }];
    assert.throws(() => validate(recording([item])), /safe-to-upgrade despite incomplete localization/);

    item.recommendation = 'upgrade-after-review';
    assert.throws(() => validate(recording([item])), /exhaustive absence with truncated source indexing/);
  });

  test('accepts incomplete source indexing for a resolved runtime-only finding', () => {
    const item = candidate();
    item.breakingCount = 1;
    item.sourceCoverage.localizationComplete = false;
    item.sourceCoverage.sourceTruncated = true;
    item.runtimeCompatibility = 'compatible';
    item.runtimeChanges = [{ id: 'runtime', runtime: 'go' }];
    item.runtimeAnalyses = [{
      changeId: 'runtime', runtime: 'go', state: 'compatible', reason: 'satisfies',
      siteCount: 1, declarationCount: 1, unresolvedCount: 0, statement: 'Go is compatible.',
    }];
    item.dispositions = [{ changeId: 'runtime', state: 'unaffected', reason: 'runtime-compatible', siteCount: 1, actionableSiteCount: 0 }];
    assert.doesNotThrow(() => validate(recording([item])));
  });

  test('flags repeated unresolved runtime fingerprints only at a suspicious corpus threshold', () => {
    const candidates = Array.from({ length: 4 }, (_, index) => {
      const item = candidate(`package-${index}`);
      item.recommendation = 'upgrade-after-review';
      item.severity = 'runtime-unresolved';
      item.runtimeCompatibility = 'unknown';
      item.runtimeChanges = [{ id: `rt-${index}`, runtime: 'node' }];
      item.runtimeAnalyses = [{
        changeId: `rt-${index}`,
        runtime: 'node',
        state: 'unknown',
        reason: 'dynamic',
        siteCount: 1,
        declarationCount: 1,
        unresolvedCount: 1,
        statement: 'dynamic',
      }];
      item.breaking = [{
        id: `rt-${index}`,
        kind: 'runtime-requirement',
        runtime: { kind: 'minimum-runtime', runtime: 'node', requirement: '>=22' },
        sites: [{ file: '.github/workflows/ci.yml', line: 10, excerpt: 'node-version: $NODE', runtimeVerdict: 'unknown' }],
      }];
      item.breakingCount = 1;
      item.dispositions = [{ changeId: `rt-${index}`, state: 'review-only', reason: 'runtime-unknown', siteCount: 1, actionableSiteCount: 0 }];
      return item;
    });
    assert.throws(() => validate(recording(candidates)), /suspicious unresolved runtime fingerprint repeats across 4 unrelated packages/);
  });
});
