import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DriftConfigSchema } from '../src/config/schema.ts';
import {
  assertTelemetrySafe,
  buildUpgradeOutcomeEvent,
  hashInstallationId,
  sampleTelemetryEvent,
  telemetryEnabled,
} from '../src/telemetry.ts';
import type { RemediationPlan } from '../src/types.ts';

describe('privacy-preserving telemetry', () => {
  test('is off by default and honours kill switches', () => {
    const config = DriftConfigSchema.parse({});

    assert.equal(config.telemetry.enabled, false);
    assert.equal(telemetryEnabled(config.telemetry, {}), false);
    assert.equal(telemetryEnabled({ enabled: true }, { DRIFT_TELEMETRY_DISABLED: '1' }), false);
    assert.equal(telemetryEnabled({ enabled: true }, { DRIFT_TELEMETRY_DISABLED: 'true' }), false);
    assert.equal(telemetryEnabled({ enabled: true }, { DO_NOT_TRACK: '1' }), false);
    assert.equal(telemetryEnabled({ enabled: true }, {}), true);
  });

  test('builds an allow-listed event without paths or repository identity', () => {
    const event = buildUpgradeOutcomeEvent({
      plan: planFixture(),
      agentType: 'cli',
      userAction: 'approved',
      checks: [
        { kind: 'test', status: 'passed' },
        { kind: 'build', status: 'not-run' },
      ],
      featureFlags: { behaviouralVerification: false, planDag: true },
      installationId: 'install-123',
      rotationSalt: '2026-08',
      now: new Date('2026-08-02T00:00:00Z'),
    });

    const serialized = JSON.stringify(event);
    assert.equal(event.dependencies[0]?.package, 'fixture-lib');
    assert.equal(event.confidenceBands[0]?.upstream, 'high');
    assert.equal(event.checks.passed, 1);
    assert.equal(event.checks.notRun, 1);
    assert.doesNotMatch(serialized, /RodolpheKouyoumdjian|src\/app\.ts|prompt|model response/i);
  });

  test('rejects prohibited payload fields before send', () => {
    assert.throws(() => assertTelemetrySafe({ repository: 'owner/repo' }), /prohibited/);
    assert.throws(() => assertTelemetrySafe({ nested: { filePath: 'src/app.ts' } }), /prohibited/);
    assert.throws(() => assertTelemetrySafe({ prompt: 'fix my code' }), /prohibited/);
    assert.throws(() => assertTelemetrySafe({ modelResponse: 'changed src/app.ts' }), /prohibited/);
    assert.throws(() => assertTelemetrySafe({ value: '-----BEGIN PRIVATE KEY-----' }), /private key/);
    assert.doesNotThrow(() => assertTelemetrySafe(sampleTelemetryEvent()));
  });

  test('hashes installation identifiers with rotation', () => {
    assert.equal(hashInstallationId('install', '2026-08'), hashInstallationId('install', '2026-08'));
    assert.notEqual(hashInstallationId('install', '2026-08'), hashInstallationId('install', '2026-09'));
  });
});

function planFixture(): RemediationPlan {
  return {
    schemaVersion: 3,
    id: 'plan-1',
    branchName: 'drift/fixture-lib-2',
    baseBranch: 'main',
    headSha: 'a'.repeat(40),
    changes: [
      {
        name: 'fixture-lib',
        ecosystem: 'npm',
        from: '1.0.0',
        to: '2.0.0',
        kind: 'runtime',
        bump: 'major',
        manifestPath: 'package.json',
      },
    ],
    evidence: [
      {
        id: 'ev-1',
        source: 'type-surface-diff',
        dependency: 'fixture-lib',
        title: 'API diff',
        content: 'not exported',
        weight: 1,
      },
    ],
    breakingChanges: [
      {
        id: 'bc-1',
        dependency: 'fixture-lib',
        kind: 'behaviour-change',
        summary: 'Return shape changed',
        symbols: ['formatUser'],
        citations: ['ev-1'],
        confidence: 'medium',
        taxonomy: {
          nature: 'behaviour',
          detectability: ['test-time'],
          scope: 'symbol',
          visibility: ['direct'],
        },
        assessment: {
          upstream: { score: 0.9, band: 'high', evidence: [], penalties: [], calibration: 'test' },
          localImpact: { score: 0.7, band: 'medium', evidence: [], penalties: [], calibration: 'test' },
          verification: { score: 0.2, band: 'low', evidence: [], penalties: [], calibration: 'test' },
          automaticExecutionEligible: false,
          reasons: [],
          checkedSurfaces: [],
          gaps: [],
        },
        remediation: 'Update call sites.',
      },
    ],
    impactSites: [
      {
        breakingChangeId: 'bc-1',
        file: 'src/app.ts',
        line: 1,
        excerpt: 'formatUser(user)',
        confidence: 'high',
      },
    ],
    commits: [],
    planEdges: [],
    upgradeCohorts: [],
    risk: 'medium',
    gaps: [
      {
        stage: 'verification',
        ecosystem: 'npm',
        dependency: 'fixture-lib',
        surface: 'tests',
        reason: 'tests absent',
        severity: 'significant',
        automaticExecution: 'blocks',
        remediation: 'Add or run tests.',
      },
    ],
    checkedSurfaces: [],
    blockers: [],
    warnings: [],
    createdAt: '2026-08-02T00:00:00Z',
  };
}
