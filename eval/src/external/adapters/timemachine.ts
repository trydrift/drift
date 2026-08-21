import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { EXTERNAL_RECORD_VERSION, type ExclusionKind, type ExternalCaseResult } from '../record.ts';
import type { Selectable } from '../selection.ts';
import { reduceVerdict, type CheckedSurfaceLike } from '../../adapters/end-to-end.ts';
import {
  DriftConfigSchema,
  LocalGitProvider,
  analyzeRepository,
  verdictFor,
  type Logger,
  type RemediationPlan,
  type RepoContext,
} from '../../../../dist/index.js';

const execFile = promisify(execFileCallback);

/**
 * TimeMachine-bench: real Python repositories whose historical dependency
 * state no longer works.
 *
 * ## What this run can and cannot do
 *
 * TimeMachine's own reproduction is a container per task, built on a
 * date-filtered PyPI index served at `localhost:5000`, which is what preserves
 * the historical resolution the task depends on. There is no container runtime
 * on the machine these runs happen on, so the oracle is not run and the repair
 * questions are not asked — they are absent from every case record rather than
 * recorded as failures, because Drift was never asked and did not fail.
 *
 * Detection needs neither. The dataset supplies a repository at an exact
 * historical commit and, separately, the dependency versions that resolve at
 * the migration target date — so a before/after manifest pair can be built
 * from two facts the dataset states, and Drift's real `analyzeRepository()` can
 * run over it through production's own `LocalGitProvider`.
 *
 * ## Where the after-state comes from, and where it deliberately does not
 *
 * The after-state is built from `dependency_versions`, the resolved
 * environment at the migration date. It is **not** built from `patch` or
 * `gold_patch`, which are the developer's migration — those are ground truth
 * and they never touch a prediction. The distinction matters because both
 * fields contain manifest edits: reading the upgrade out of the fix would hand
 * Drift the answer and call the result detection.
 *
 * Only requirements the repository itself declares are repinned. The rest of
 * `dependency_versions` is the transitive closure, and writing all of it into
 * a manifest would be inventing declarations the project never made.
 *
 * ## The construction is stated, not hidden
 *
 * This is a manifest pair the harness assembles, unlike BUMP where the pair is
 * two real consecutive commits. It is the weaker of the two constructions and
 * every artifact says so, because a reader comparing the two ecosystems is
 * entitled to know that one of them is reading history and the other is
 * reading a state derived from it.
 */

export const ADAPTER_VERSION = 'timemachine-detect-v1';

const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  group: (_label, fn) => fn(),
};

export interface TimemachineTask {
  repo_name: string;
  repo_url: string;
  commit_hash: string;
  reproduction_target_date: string;
  reproduction_target_version: string;
  migration_target_date: string;
  migration_target_version: string;
  dependency_versions: string;
  script_source: string;
  version_source: string;
  test_type: string;
  difficulty: string;
  license: string;
}

export type TimemachineSubset = 'verified' | 'random' | 'full';

export async function loadTimemachine(
  root: string,
  subset: TimemachineSubset,
): Promise<{ tasks: TimemachineTask[]; datasetVersion: string; sourceHash: string }> {
  const path = join(root, 'benchmark', 'data', 'v1', `timemachine-bench-${subset}.jsonl`);
  const bytes = await readFile(path);
  const tasks = bytes
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TimemachineTask);

  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: root });
  return { tasks, datasetVersion: stdout.trim(), sourceHash: createHash('sha256').update(bytes).digest('hex') };
}

export function timemachineSelectables(tasks: readonly TimemachineTask[]): Selectable[] {
  // Difficulty is the dataset's own stratification and the one that matters:
  // a sample that lost the Hard cases would report an easier corpus than the
  // one it names.
  return tasks.map((task) => ({ id: `${task.repo_name}@${task.commit_hash.slice(0, 12)}`, strata: [task.difficulty, task.script_source] }));
}

export class TimemachineUnavailable extends Error {
  readonly kind: ExclusionKind;
  readonly missingRequirement: string | null;

  constructor(kind: ExclusionKind, message: string, missingRequirement: string | null = null) {
    super(message);
    this.kind = kind;
    this.missingRequirement = missingRequirement;
  }
}

/**
 * `alabaster==1.0.0\nbabel==2.17.0\n…` -> a lookup of resolved versions.
 *
 * Names are normalised the way PyPI normalises them, so `Sphinx` in a
 * requirements file matches `sphinx` in the resolved set. Without that, half
 * the repins would silently not happen and the run would report Drift missing
 * updates that were never written.
 */
export function resolvedVersions(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z0-9._-]+)==([^\s;#]+)/.exec(line.trim());
    if (match) out.set(normalizeName(match[1]!), match[2]!);
  }
  return out;
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * Rewrites a requirements file's declared pins to their resolved versions.
 *
 * Returns the new text and the packages that actually moved, so the case can
 * record what upgrade Drift was shown rather than what the dataset listed.
 */
export function repinRequirements(
  text: string,
  resolved: ReadonlyMap<string, string>,
): { text: string; changed: { name: string; from: string | null; to: string }[] } {
  const changed: { name: string; from: string | null; to: string }[] = [];
  const lines = text.split('\n').map((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('-')) return line;

    const match = /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(?:([=<>!~]=?)\s*([^\s;#]+))?/.exec(trimmed);
    if (!match) return line;

    const name = match[1]!;
    const target = resolved.get(normalizeName(name));
    if (!target) return line;

    const from = match[2] === '==' ? (match[3] ?? null) : null;
    if (from === target) return line;
    changed.push({ name, from, to: target });
    return `${name}==${target}`;
  });

  return { text: lines.join('\n'), changed };
}

export interface TimemachinePrediction {
  dependencyChanges: { name: string; from: string | null; to: string | null }[];
  breakingChanges: { kind: string; symbols: string[] }[];
  impactSites: { file: string; line: number; matchedSymbol: string }[];
  verdict: string;
  summary: string;
  /** What the harness actually repinned, so the constructed upgrade is inspectable. */
  repinned: { name: string; from: string | null; to: string }[];
  manifestPath: string;
}

const SAFE_EQUIVALENT = new Set(['no-incompatible-change-in-checked-surfaces', 'clean', 'detected-not-locally-reachable']);

const REQUIREMENTS_CANDIDATES = [
  'requirements.txt',
  'requirements/base.txt',
  'requirements/requirements.txt',
  'requirements_dev.txt',
  'requirements-dev.txt',
];

export async function predictTimemachine(task: TimemachineTask): Promise<TimemachinePrediction> {
  const work = await mkdtemp(join(tmpdir(), 'drift-timemachine-'));
  const repo = join(work, 'repo');

  try {
    await mkdir(repo, { recursive: true });
    await execFile('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo });
    await execFile('git', ['remote', 'add', 'origin', `${task.repo_url}.git`], { cwd: repo });
    try {
      await execFile('git', ['fetch', '--quiet', '--depth', '1', 'origin', task.commit_hash], {
        cwd: repo,
        timeout: 600_000,
      });
    } catch (err) {
      throw new TimemachineUnavailable(
        'source-unavailable',
        `commit ${task.commit_hash} could not be fetched from ${task.repo_url}: ${(err as Error).message.slice(0, 300)}`,
      );
    }
    await execFile('git', ['checkout', '--quiet', 'FETCH_HEAD'], { cwd: repo });
    await execFile('git', ['config', 'user.email', 'bench@drift.invalid'], { cwd: repo });
    await execFile('git', ['config', 'user.name', 'Drift Benchmark'], { cwd: repo });
    const beforeSha = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

    const resolved = resolvedVersions(task.dependency_versions);
    let manifestPath: string | null = null;
    let repinned: { name: string; from: string | null; to: string }[] = [];

    for (const candidate of REQUIREMENTS_CANDIDATES) {
      const existing = await readFile(join(repo, candidate), 'utf8').catch(() => null);
      if (existing === null) continue;
      const rewritten = repinRequirements(existing, resolved);
      if (rewritten.changed.length === 0) continue;
      await writeFile(join(repo, candidate), rewritten.text, 'utf8');
      manifestPath = candidate;
      repinned = rewritten.changed;
      break;
    }

    if (!manifestPath) {
      // No declared requirement moved, so there is no upgrade to show Drift.
      // A case with nothing to detect cannot measure detection, and scoring it
      // as a miss would charge Drift for an empty input.
      throw new TimemachineUnavailable(
        'reproduction-failed',
        `no requirements file at ${task.commit_hash} declares a package whose resolved version differs, so no dependency update could be constructed for this task`,
      );
    }

    await execFile('git', ['add', '-A'], { cwd: repo });
    await execFile('git', ['commit', '--quiet', '-m', `repin declared requirements to ${task.migration_target_date}`], {
      cwd: repo,
    });
    const afterSha = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

    const config = DriftConfigSchema.parse({});
    const context: RepoContext = {
      owner: task.repo_name.split('/')[0] ?? 'unknown',
      repo: task.repo_name.split('/')[1] ?? task.repo_name,
      baseBranch: 'main',
      beforeSha,
      afterSha,
      workspace: repo,
    };

    const result = await analyzeRepository({
      repo: context,
      config,
      logger: SILENT_LOGGER,
      provider: new LocalGitProvider(repo, { before: beforeSha, after: afterSha }),
      workspace: repo,
    });

    const plan = result.plan;
    return {
      dependencyChanges: (plan?.changes ?? []).map((change) => ({ name: change.name, from: change.from, to: change.to })),
      breakingChanges: (plan?.breakingChanges ?? []).map((change) => ({ kind: String(change.kind), symbols: change.symbols ?? [] })),
      impactSites: (plan?.impactSites ?? []).map((site) => ({ file: site.file, line: site.line, matchedSymbol: site.matchedSymbol })),
      verdict: verdictFromPlan(plan),
      summary: result.summary,
      repinned,
      manifestPath,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Production's own reduction. See the note in `swe-bump.ts` about why this is not reimplemented. */
function verdictFromPlan(plan: RemediationPlan | null | undefined): string {
  if (!plan) return 'insufficient-evidence';
  const verdicts = plan.breakingChanges.map((change) => String(verdictFor(change)));
  const surfaces = ((plan as unknown as { checkedSurfaces?: CheckedSurfaceLike[] }).checkedSurfaces ?? []).map((surface) => ({
    surface: surface.surface,
    ...(surface.dependency ? { dependency: surface.dependency } : {}),
    status: surface.status,
  }));
  return reduceVerdict(verdicts, plan.breakingChanges.length === 0, surfaces);
}

export interface ScoreTimemachineInput {
  task: TimemachineTask;
  subset: TimemachineSubset;
  prediction: TimemachinePrediction | null;
  excluded: { kind: ExclusionKind; reason: string; missingRequirement: string | null } | null;
  datasetVersion: string;
  sourceHash: string;
  durationMs: number;
}

export function scoreTimemachine(input: ScoreTimemachineInput): ExternalCaseResult {
  const { task, prediction } = input;

  const base = {
    schemaVersion: EXTERNAL_RECORD_VERSION as typeof EXTERNAL_RECORD_VERSION,
    caseId: `${task.repo_name}@${task.commit_hash.slice(0, 12)}`,
    provenance: {
      dataset: 'timemachine',
      datasetVersion: input.datasetVersion,
      recordId: `${task.repo_name}@${task.commit_hash}`,
      repository: task.repo_url,
      commit: task.commit_hash,
      baseCommit: null,
      dependency: prediction?.repinned.map((entry) => entry.name).join(', ') ?? null,
      fromVersion: task.reproduction_target_date,
      toVersion: task.migration_target_date,
      packageManager: 'pip',
      requiredRuntime: `python ${task.reproduction_target_version} -> ${task.migration_target_version}`,
      oracleCommand: `${task.test_type} (inside the published container, against a PyPI index filtered to ${task.migration_target_date})`,
      containerImage: 'built per task by the dataset; not pulled here',
      sourceHash: input.sourceHash,
      extra: {
        subset: input.subset,
        difficulty: task.difficulty,
        scriptSource: task.script_source,
        licence: task.license,
        // Stated on every case: this pair is assembled by the harness from two
        // dataset facts, not read from two consecutive commits.
        manifestPairConstruction: 'harness-repinned-declared-requirements',
        manifestPath: prediction?.manifestPath ?? 'unavailable',
        repinnedCount: String(prediction?.repinned.length ?? 0),
      },
    },
    truth: {
      label: `migration-failure-${task.difficulty.toLowerCase()}`,
      mappedTo: 'locally-affected',
      mappingStatus: 'compatible' as const,
      mappingNote:
        "TimeMachine records that the repository's tests fail after migration, not which API changed. The label maps only to the claim that the project is affected, never to a Drift breaking-change kind.",
      polarity: 'positive' as const,
    },
    durationMs: input.durationMs,
  };

  if (!prediction) return { ...base, prediction: {}, outcomes: {}, excluded: input.excluded };

  const repinnedNames = new Set(prediction.repinned.map((entry) => normalizeName(entry.name)));
  return {
    ...base,
    prediction: { ...prediction } as Record<string, unknown>,
    outcomes: {
      detectedUpdate: prediction.dependencyChanges.some((change) => repinnedNames.has(normalizeName(change.name))),
      identifiedAffected: prediction.verdict === 'locally-affected',
      localized: prediction.impactSites.length > 0,
      falseSafe: SAFE_EQUIVALENT.has(prediction.verdict),
    },
    excluded: null,
  };
}
