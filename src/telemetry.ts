import { createHash } from 'node:crypto';
import type { DispatchResult, Ecosystem, EvidenceSource, RemediationPlan } from './types.js';
import type { ConfidenceBand } from './confidence/types.js';

export const TELEMETRY_SCHEMA_VERSION = 1;

const PROHIBITED_KEYS = new Set([
  'sourceCode',
  'code',
  'snippet',
  'excerpt',
  'file',
  'filePath',
  'path',
  'paths',
  'rawPath',
  'repository',
  'repo',
  'owner',
  'organization',
  'org',
  'secret',
  'token',
  'prompt',
  'modelResponse',
  'stdout',
  'stderr',
  'output',
  'fullOutput',
  'commandOutput',
]);

export interface TelemetryConfig {
  enabled?: boolean;
  endpoint?: string;
  installationId?: string;
  rotationSalt?: string;
  retentionDays?: number;
}

export interface TelemetryFeatureFlags {
  behaviouralVerification?: boolean;
  automaticDispatch?: boolean;
  planDag?: boolean;
  approvalRequired?: boolean;
}

export interface UpgradeOutcomeTelemetryInput {
  plan: RemediationPlan;
  result?: DispatchResult;
  agentType?: 'cloud' | 'cli' | 'in-editor' | 'none';
  userAction?: 'dismissed' | 'approved' | 'merged' | 'opened' | 'ignored';
  checks?: { kind: string; status: 'passed' | 'failed' | 'not-run' | 'cancelled' }[];
  latencyMs?: number;
  costUsd?: number;
  featureFlags?: TelemetryFeatureFlags;
  installationId?: string;
  rotationSalt?: string;
  /**
   * How long the sender wants this event kept, carried in the event itself.
   *
   * This module only ever sends events — there is no collector in this
   * repository for it to instruct directly. Putting the preference in the
   * payload is the one lever a sender actually has: whatever receives
   * `sendTelemetryEvent`'s POST can honour it, whereas a config field that
   * stays local to the sender cannot be enforced by anything.
   */
  retentionDays?: number;
  now?: Date;
}

export interface UpgradeOutcomeTelemetryEvent {
  schemaVersion: 1;
  event: 'upgrade_outcome';
  occurredAt: string;
  installation: {
    idHash: string;
    rotation: string;
  };
  dependencies: {
    ecosystem: Ecosystem;
    package: string;
    oldVersion: string | null;
    newVersion: string | null;
  }[];
  taxonomy: {
    nature: string;
    detectability: string[];
    scope: string;
    visibility: string[];
  }[];
  evidenceSourceClasses: EvidenceSource[];
  confidenceBands: {
    upstream: ConfidenceBand;
    localImpact: ConfidenceBand;
    verification: ConfidenceBand;
  }[];
  gaps: {
    stage: string;
    ecosystem?: Ecosystem;
    dependency?: string;
    reason: string;
    severity: string;
    consequence: string;
  }[];
  checks: {
    run: number;
    passed: number;
    failed: number;
    notRun: number;
    cancelled: number;
  };
  agentType: 'cloud' | 'cli' | 'in-editor' | 'none';
  executionResult: string;
  userAction?: 'dismissed' | 'approved' | 'merged' | 'opened' | 'ignored';
  featureFlags: Record<string, string>;
  latencyMs: number;
  costUsd: number;
  /** The sender's requested retention window, when configured. See `UpgradeOutcomeTelemetryInput.retentionDays`. */
  retentionDays?: number;
}

export function telemetryEnabled(config: TelemetryConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DRIFT_TELEMETRY_DISABLED === '1' || env.DRIFT_TELEMETRY_DISABLED === 'true') return false;
  if (env.DO_NOT_TRACK === '1') return false;
  return Boolean(config.enabled);
}

export function buildUpgradeOutcomeEvent(input: UpgradeOutcomeTelemetryInput): UpgradeOutcomeTelemetryEvent {
  const now = input.now ?? new Date();
  const rotation = input.rotationSalt ?? rotationFor(now);
  const event: UpgradeOutcomeTelemetryEvent = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    event: 'upgrade_outcome',
    occurredAt: now.toISOString(),
    installation: {
      idHash: hashInstallationId(input.installationId ?? 'anonymous-local-install', rotation),
      rotation,
    },
    dependencies: input.plan.changes.map((change) => ({
      ecosystem: change.ecosystem,
      package: change.name,
      oldVersion: change.from,
      newVersion: change.to,
    })),
    taxonomy: input.plan.breakingChanges.map(telemetryTaxonomy),
    evidenceSourceClasses: [...new Set(input.plan.evidence.map((evidence) => evidence.source))].sort(),
    confidenceBands: input.plan.breakingChanges.map((change) => ({
      upstream: change.assessment?.upstream.band ?? 'none',
      localImpact: change.assessment?.localImpact.band ?? 'none',
      verification: change.assessment?.verification.band ?? 'none',
    })),
    gaps: input.plan.gaps.map((gap) => ({
      stage: gap.stage,
      ...(gap.ecosystem ? { ecosystem: gap.ecosystem } : {}),
      ...(gap.dependency ? { dependency: gap.dependency } : {}),
      reason: gap.reason,
      severity: gap.severity,
      consequence: gap.automaticExecution,
    })),
    checks: summarizeChecks(input.checks ?? []),
    agentType: input.agentType ?? 'none',
    executionResult: input.result?.status ?? 'not-dispatched',
    ...(input.userAction ? { userAction: input.userAction } : {}),
    featureFlags: anonymizeFlags(input.featureFlags ?? {}),
    latencyMs: input.latencyMs ?? 0,
    costUsd: input.costUsd ?? 0,
    ...(input.retentionDays !== undefined ? { retentionDays: input.retentionDays } : {}),
  };

  assertTelemetrySafe(event);
  return event;
}

function telemetryTaxonomy(change: RemediationPlan['breakingChanges'][number]): UpgradeOutcomeTelemetryEvent['taxonomy'][number] {
  if (!change.taxonomy) {
    return { nature: 'unknown', detectability: ['external-observation'], scope: 'ecosystem', visibility: ['unknown'] };
  }
  return {
    nature: change.taxonomy.nature,
    detectability: [...change.taxonomy.detectability].sort(),
    scope: change.taxonomy.scope,
    visibility: [...change.taxonomy.visibility].sort(),
  };
}

export function assertTelemetrySafe(value: unknown): void {
  visit(value, []);
}

export function hashInstallationId(id: string, rotation: string): string {
  return createHash('sha256').update(`drift:${rotation}:${id}`).digest('hex');
}

export async function sendTelemetryEvent(
  event: UpgradeOutcomeTelemetryEvent,
  options: { endpoint: string; fetch?: typeof fetch; env?: NodeJS.ProcessEnv },
): Promise<{ sent: boolean; status?: number; reason?: string }> {
  if (options.env?.DRIFT_TELEMETRY_DISABLED === '1' || options.env?.DO_NOT_TRACK === '1') {
    return { sent: false, reason: 'telemetry disabled by environment' };
  }
  assertTelemetrySafe(event);
  const response = await (options.fetch ?? fetch)(options.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
  return { sent: response.ok, status: response.status };
}

export function sampleTelemetryEvent(now = new Date(0)): UpgradeOutcomeTelemetryEvent {
  return {
    schemaVersion: 1,
    event: 'upgrade_outcome',
    occurredAt: now.toISOString(),
    installation: {
      idHash: hashInstallationId('sample-installation', 'sample-rotation'),
      rotation: 'sample-rotation',
    },
    dependencies: [{ ecosystem: 'npm', package: 'fixture-lib', oldVersion: '1.0.0', newVersion: '2.0.0' }],
    taxonomy: [{ nature: 'behaviour', detectability: ['test-time'], scope: 'symbol', visibility: ['direct'] }],
    evidenceSourceClasses: ['changelog', 'type-surface-diff'],
    confidenceBands: [{ upstream: 'high', localImpact: 'medium', verification: 'low' }],
    gaps: [
      {
        stage: 'verification',
        ecosystem: 'npm',
        dependency: 'fixture-lib',
        reason: 'tests absent',
        severity: 'medium',
        consequence: 'blocks automatic execution',
      },
    ],
    checks: { run: 1, passed: 0, failed: 1, notRun: 0, cancelled: 0 },
    agentType: 'cli',
    executionResult: 'blocked',
    userAction: 'approved',
    featureFlags: { behaviouralVerification: 'off', automaticDispatch: 'off', planDag: 'on', approvalRequired: 'on' },
    latencyMs: 0,
    costUsd: 0,
  };
}

function summarizeChecks(checks: NonNullable<UpgradeOutcomeTelemetryInput['checks']>): UpgradeOutcomeTelemetryEvent['checks'] {
  return {
    run: checks.filter((check) => check.status === 'passed' || check.status === 'failed').length,
    passed: checks.filter((check) => check.status === 'passed').length,
    failed: checks.filter((check) => check.status === 'failed').length,
    notRun: checks.filter((check) => check.status === 'not-run').length,
    cancelled: checks.filter((check) => check.status === 'cancelled').length,
  };
}

function anonymizeFlags(flags: TelemetryFeatureFlags): Record<string, string> {
  return Object.fromEntries(
    Object.entries(flags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, value ? 'on' : 'off']),
  );
}

function rotationFor(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function visit(value: unknown, path: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (/-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/.test(value)) {
      throw new Error(`Telemetry field ${path.join('.')} looks like a private key.`);
    }
    return;
  }
  if (typeof value !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach((entry, index) => visit(entry, [...path, String(index)]));
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (PROHIBITED_KEYS.has(key)) {
      throw new Error(`Telemetry field ${[...path, key].join('.')} is prohibited.`);
    }
    visit(child, [...path, key]);
  }
}
