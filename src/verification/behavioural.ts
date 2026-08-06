import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { DriftConfig } from '../config/schema.js';
import type { BreakingChange, DependencyChange, Evidence, ImpactSite } from '../types.js';
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

/** The subset of a plan this selection needs, without requiring a full one. */
export interface BehaviouralCandidateInput {
  breakingChanges: readonly BreakingChange[];
  impactSites: readonly ImpactSite[];
}

/**
 * Pick only findings this bounded harness is willing to probe.
 *
 * No local reachability means no probe: executing arbitrary dependency exports
 * just because they changed upstream would turn verification into exploration.
 *
 * Every probe always carries a no-argument case — the only one that costs
 * nothing to construct — and, where a real call site was found, one case per
 * distinct literal argument list read off it. Reusing the actual arguments a
 * caller passes is what lets this catch "the return shape changed for the
 * input this repository uses" rather than only for `undefined`.
 */
export function selectBehaviouralCandidates(
  plan: BehaviouralCandidateInput,
  config: DriftConfig,
): BehaviouralProbe[] {
  const settings = config.verification.behavioural;
  if (!settings.enabled) return [];

  const probes: BehaviouralProbe[] = [];
  for (const change of plan.breakingChanges) {
    if (!SUPPORTED_KINDS.has(change.kind)) continue;
    const sites = plan.impactSites.filter((site) => site.breakingChangeId === change.id);
    if (sites.length === 0) continue;

    const taxonomy = taxonomyOf(change);
    if (
      !taxonomy.nature.includes('behaviour') &&
      taxonomy.nature !== 'type-contract' &&
      change.kind !== 'default-change'
    ) {
      continue;
    }

    for (const symbol of change.symbols.slice(0, settings.maxSymbols - probes.length)) {
      const contracts = contractsFor(change);
      const cases: ProbeCase[] = [{ id: 'default', args: [], contracts }];

      const seen = new Set<string>();
      const MAX_CASES = 4;
      for (const site of sites) {
        if (cases.length >= MAX_CASES) break;
        if (site.matchedSymbol !== symbol) continue;
        const args = literalArgsFromExcerpt(site.excerpt, symbol);
        if (!args) continue;
        const key = JSON.stringify(args);
        if (seen.has(key)) continue;
        seen.add(key);
        cases.push({ id: `site-${cases.length}`, args, contracts });
      }

      probes.push({ dependency: change.dependency, symbol, modulePath: '', exportName: symbol, cases });
      if (probes.length >= settings.maxSymbols) return probes;
    }
  }

  return probes;
}

/**
 * Read a call's literal argument list off the source line localization
 * matched, without evaluating anything.
 *
 * Bounded on purpose: only arguments that are themselves JSON after quoting
 * bare object keys and normalising quotes are accepted. A call site passing a
 * variable, a function, or anything else Drift cannot read the value of yields
 * `null`, and the symbol falls back to its no-argument case rather than
 * guessing.
 */
export function literalArgsFromExcerpt(excerpt: string, symbol: string): unknown[] | null {
  const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\s*\\(([^;]*)\\)`);
  const match = pattern.exec(excerpt);
  if (!match) return null;

  const inner = match[1]!.trim();
  if (inner === '') return [];

  const jsonish = `[${inner}]`.replace(/'/g, '"').replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');

  try {
    const parsed = JSON.parse(jsonish) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

export interface BehaviouralEnvironmentPair {
  oldEnvironment: BehaviouralEnvironment;
  newEnvironment: BehaviouralEnvironment;
}

export interface BehaviouralVerificationResult {
  /** New evidence, ready to append to the plan's evidence list. */
  evidence: Evidence[];
  /** Evidence ids each affected breaking change should cite, keyed by change id. */
  citationsByChangeId: Map<string, string[]>;
  /** What could not be probed, or what a probe found no difference in. */
  gaps: string[];
}

/**
 * Run behavioural probing for every dependency it applies to, and turn the
 * result into the two things the rest of the pipeline understands: evidence a
 * breaking change can cite, and gaps to report when it could not run.
 *
 * Environment resolution is supplied by the caller rather than fetched here,
 * because how "the old version" and "the new version" are located differs by
 * context — a published npm registry for a real repository, a fixture
 * directory already on disk for the evaluation harness.
 */
export async function runBehaviouralVerification(options: {
  config: DriftConfig;
  breakingChanges: readonly BreakingChange[];
  dependencyChanges: readonly DependencyChange[];
  impactSites: readonly ImpactSite[];
  resolveEnvironments: (change: DependencyChange) => Promise<BehaviouralEnvironmentPair | null>;
}): Promise<BehaviouralVerificationResult> {
  const settings = options.config.verification.behavioural;
  const evidence: Evidence[] = [];
  const citationsByChangeId = new Map<string, string[]>();
  const gaps: string[] = [];

  if (!settings.enabled) return { evidence, citationsByChangeId, gaps };

  const probes = selectBehaviouralCandidates(
    { breakingChanges: options.breakingChanges, impactSites: options.impactSites },
    options.config,
  );
  if (probes.length === 0) return { evidence, citationsByChangeId, gaps };

  const byDependency = new Map<string, BehaviouralProbe[]>();
  for (const probe of probes) {
    const list = byDependency.get(probe.dependency);
    if (list) list.push(probe);
    else byDependency.set(probe.dependency, [probe]);
  }

  for (const [dependency, dependencyProbes] of byDependency) {
    const change = options.dependencyChanges.find((c) => c.name === dependency && c.ecosystem === 'npm');
    if (!change?.from || !change.to) {
      gaps.push(`${dependency}: behavioural probing needs both a resolved old and new version; skipped.`);
      continue;
    }

    const environments = await options.resolveEnvironments(change);
    if (!environments) {
      gaps.push(
        `${dependency}: could not resolve ${change.from} and ${change.to} to executable code for behavioural probing; skipped.`,
      );
      continue;
    }

    const result = await runBehaviouralDifferential({
      config: settings,
      probes: dependencyProbes,
      oldEnvironment: environments.oldEnvironment,
      newEnvironment: environments.newEnvironment,
    });

    gaps.push(...result.gaps);

    for (const observation of result.observations) {
      const record = observationEvidence(observation);
      evidence.push(record);

      for (const affected of options.breakingChanges) {
        if (affected.dependency !== dependency || !affected.symbols.includes(observation.symbol)) continue;
        const list = citationsByChangeId.get(affected.id);
        if (list) list.push(record.id);
        else citationsByChangeId.set(affected.id, [record.id]);
      }
    }
  }

  return { evidence, citationsByChangeId, gaps };
}

/** A short, stable label for what kind of difference a probe observed. */
export function behaviouralFindingKind(observedDifference: string): string {
  if (observedDifference.startsWith('no observed difference')) return 'no-difference';
  if (observedDifference.includes('returned value changed')) return 'return-value';
  if (observedDifference.startsWith('status changed')) return 'thrown-error';
  if (observedDifference.includes('argument mutation')) return 'argument-mutation';
  return 'behaviour';
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
