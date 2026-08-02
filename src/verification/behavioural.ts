import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { DriftConfig } from '../config/schema.js';
import type { BreakingChange, Evidence, RemediationPlan } from '../types.js';
import { taxonomyOf } from '../confidence/taxonomy.js';

export type ContractKind =
  | 'return-shape'
  | 'thrown-error'
  | 'argument-mutation'
  | 'callback-count-order'
  | 'promise-state'
  | 'serialization-output'
  | 'configured-defaults'
  | 'selected-side-effect';

export interface ProbeCase {
  id: string;
  args: unknown[];
  contracts: ContractKind[];
}

export interface BehaviouralProbe {
  dependency: string;
  symbol: string;
  modulePath: string;
  exportName: string;
  cases: ProbeCase[];
}

export interface BehaviouralEnvironment {
  label: 'old' | 'new';
  packageRoot: string;
  modulePath: string;
}

export interface BehaviouralObservation {
  dependency: string;
  symbol: string;
  caseId: string;
  generatedInput: unknown[];
  oldResult: WorkerResult;
  newResult: WorkerResult;
  observedDifference: string;
  nondeterministic: boolean;
  limitations: string[];
}

export interface BehaviouralRunResult {
  evidence: Evidence[];
  observations: BehaviouralObservation[];
  gaps: string[];
}

export interface WorkerResult {
  status: string;
  value?: unknown;
  error?: unknown;
  mutations?: unknown[];
  durationMs?: number;
  signal?: string;
  stdoutDigest?: string;
  stderrDigest?: string;
}

const HARNESS_VERSION = 'behavioural-diff-npm-ts-v1';
const SUPPORTED_KINDS = new Set<BreakingChange['kind']>([
  'behaviour-change',
  'default-change',
  'type-change',
  'signature-change',
  'required-field-added',
]);

/**
 * Pick only findings this bounded harness is willing to probe.
 *
 * No local reachability means no probe: executing arbitrary dependency exports
 * just because they changed upstream would turn verification into exploration.
 */
export function selectBehaviouralCandidates(
  plan: RemediationPlan,
  config: DriftConfig,
): BehaviouralProbe[] {
  const settings = config.verification.behavioural;
  if (!settings.enabled) return [];

  const probes: BehaviouralProbe[] = [];
  for (const change of plan.breakingChanges) {
    if (!SUPPORTED_KINDS.has(change.kind)) continue;
    if (plan.impactSites.every((site) => site.breakingChangeId !== change.id)) continue;

    const taxonomy = taxonomyOf(change);
    if (
      !taxonomy.nature.includes('behaviour') &&
      taxonomy.nature !== 'type-contract' &&
      change.kind !== 'default-change'
    ) {
      continue;
    }

    for (const symbol of change.symbols.slice(0, settings.maxSymbols - probes.length)) {
      probes.push({
        dependency: change.dependency,
        symbol,
        modulePath: '',
        exportName: symbol,
        cases: [
          {
            id: 'default',
            args: [],
            contracts: contractsFor(change),
          },
        ],
      });
      if (probes.length >= settings.maxSymbols) return probes;
    }
  }

  return probes;
}

function contractsFor(change: BreakingChange): ContractKind[] {
  switch (change.kind) {
    case 'default-change':
      return ['configured-defaults', 'return-shape'];
    case 'type-change':
    case 'signature-change':
    case 'required-field-added':
      return ['return-shape', 'thrown-error', 'argument-mutation', 'promise-state'];
    case 'behaviour-change':
      return ['return-shape', 'thrown-error', 'argument-mutation', 'promise-state', 'serialization-output'];
    default:
      return ['return-shape'];
  }
}

export async function runBehaviouralDifferential(options: {
  config: DriftConfig['verification']['behavioural'];
  probes: readonly BehaviouralProbe[];
  oldEnvironment: BehaviouralEnvironment;
  newEnvironment: BehaviouralEnvironment;
}): Promise<BehaviouralRunResult> {
  const { config, oldEnvironment, newEnvironment } = options;
  const probes = options.probes.slice(0, config.maxSymbols);
  const observations: BehaviouralObservation[] = [];
  const gaps: string[] = [];

  if (!config.enabled) {
    return { evidence: [], observations: [], gaps: ['behavioural probing disabled'] };
  }
  if (config.sandbox !== 'required') {
    return { evidence: [], observations: [], gaps: ['behavioural probing requires a sandbox'] };
  }

  for (const probe of probes) {
    const cases = probe.cases.slice(0, config.maxCasesPerSymbol);
    for (const probeCase of cases) {
      const oldA = await runWorker(config, oldEnvironment, probe, probeCase);
      const oldB = await runWorker(config, oldEnvironment, probe, probeCase);
      const newA = await runWorker(config, newEnvironment, probe, probeCase);
      const newB = await runWorker(config, newEnvironment, probe, probeCase);
      const nondeterministic = !sameResult(oldA, oldB) || !sameResult(newA, newB);

      observations.push({
        dependency: probe.dependency,
        symbol: probe.symbol,
        caseId: probeCase.id,
        generatedInput: probeCase.args,
        oldResult: oldA,
        newResult: newA,
        observedDifference: nondeterministic ? 'nondeterministic result; no compatibility conclusion drawn' : diffResult(oldA, newA),
        nondeterministic,
        limitations: limitations(config, probeCase.contracts),
      });
    }
  }

  return {
    observations,
    gaps,
    evidence: observations.map(observationEvidence),
  };
}

async function runWorker(
  config: DriftConfig['verification']['behavioural'],
  environment: BehaviouralEnvironment,
  probe: BehaviouralProbe,
  probeCase: ProbeCase,
): Promise<WorkerResult> {
  const dir = await mkdtemp(join(tmpdir(), 'drift-behavioural-'));
  const realDir = await realpath(dir);
  const casePath = join(dir, 'case.json');
  const workerPath = await realpath(fileURLToPath(new URL('./behavioural-worker.js', import.meta.url)));
  const modulePath = resolve(environment.modulePath || probe.modulePath);
  const realModulePath = await realpath(modulePath);
  const packageRoot = resolve(environment.packageRoot);

  await writeFile(
    casePath,
    JSON.stringify({
      modulePath: realModulePath,
      exportName: probe.exportName,
      args: probeCase.args,
      network: config.network,
    }),
  );

  const readablePaths = [
    workerPath,
    packageRoot,
    await realpath(packageRoot),
    modulePath,
    realModulePath,
    casePath,
    await realpath(casePath),
  ];

  const args = [
    '--permission',
    ...[...new Set(readablePaths)].map((path) => `--allow-fs-read=${path}`),
    `--max-old-space-size=${config.memoryMb}`,
    workerPath,
    casePath,
  ];

  try {
    return await new Promise<WorkerResult>((resolvePromise) => {
      const child = spawn(process.execPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: realDir,
          TMPDIR: realDir,
          DRIFT_BEHAVIOURAL_SANDBOX: '1',
        },
      });

      let stdout = '';
      let stderr = '';
      const outputLimit = 64 * 1024;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, config.timeoutSeconds * 1000);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString('utf8')).slice(-outputLimit);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-outputLimit);
      });
      child.on('close', (_code, signal) => {
        clearTimeout(timer);
        if (signal) {
          resolvePromise({
            status: 'timed-out',
            signal,
            stdoutDigest: digest(stdout),
            stderrDigest: digest(stderr),
          });
          return;
        }

        const line = stdout.trim().split('\n').at(-1) ?? '';
        const parsed = safeJson<WorkerResult>(line);
        resolvePromise(
          parsed ?? {
            status: 'worker-failed',
            stdoutDigest: digest(stdout),
            stderrDigest: digest(stderr),
          },
        );
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolvePromise({ status: 'worker-failed', error: { name: err.name, messageCategory: 'spawn' } });
      });
    });
  } finally {
    if (!config.retainArtifacts) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function sameResult(a: WorkerResult, b: WorkerResult): boolean {
  return JSON.stringify(normalizedComparable(a)) === JSON.stringify(normalizedComparable(b));
}

function normalizedComparable(result: WorkerResult): Record<string, unknown> {
  return {
    status: result.status,
    value: result.value ?? null,
    error: result.error ?? null,
    mutations: result.mutations ?? [],
  };
}

function diffResult(oldResult: WorkerResult, newResult: WorkerResult): string {
  if (sameResult(oldResult, newResult)) {
    return 'no observed difference for this contract and generated input domain';
  }
  if (oldResult.status !== newResult.status) return `status changed from ${oldResult.status} to ${newResult.status}`;
  if (JSON.stringify(oldResult.value ?? null) !== JSON.stringify(newResult.value ?? null)) return 'returned value changed';
  if (JSON.stringify(oldResult.error ?? null) !== JSON.stringify(newResult.error ?? null)) return 'thrown error changed';
  if (JSON.stringify(oldResult.mutations ?? []) !== JSON.stringify(newResult.mutations ?? [])) return 'argument mutation changed';
  return 'observable result changed';
}

function limitations(config: DriftConfig['verification']['behavioural'], contracts: readonly ContractKind[]): string[] {
  const out = [
    `Harness ${HARNESS_VERSION}; bounded to ${contracts.join(', ') || 'return-shape'} contracts.`,
    `No observed difference is not proof of behavioural compatibility outside these generated inputs.`,
    `CPU limit requested: ${config.cpuLimit}; Node subprocess enforces wall-clock, memory, output, filesystem, and network policy.`,
  ];
  if (!config.network) out.push('Network APIs were disabled for the probe.');
  return out;
}

function observationEvidence(observation: BehaviouralObservation): Evidence {
  const content = JSON.stringify(
    {
      generatedInput: observation.generatedInput,
      normalizedOldResult: observation.oldResult,
      normalizedNewResult: observation.newResult,
      observedDifference: observation.observedDifference,
      testHarnessVersion: HARNESS_VERSION,
      nondeterminismHandling: observation.nondeterministic
        ? 'Repeated runs disagreed, so Drift records the observation but draws no compatibility conclusion.'
        : 'Old and new observations were repeated once and matched within each version.',
      limitations: observation.limitations,
    },
    null,
    2,
  );

  return {
    id: `ev_behaviour_${digest(`${observation.dependency}:${observation.symbol}:${observation.caseId}`).slice(0, 12)}`,
    source: 'behavioural-diff',
    dependency: observation.dependency,
    locator: `${observation.symbol}:${observation.caseId}`,
    title: `Behavioural differential probe for ${observation.symbol}`,
    content,
    weight: observation.observedDifference.startsWith('no observed difference') ? 0.25 : 0.8,
    findings: [
      {
        code: 'behavioural-observation',
        symbol: observation.symbol,
        detail: observation.observedDifference,
      },
    ],
  };
}

function safeJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
