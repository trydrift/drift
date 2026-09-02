import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import semver from 'semver';
import { EXTERNAL_RECORD_VERSION, type ExclusionKind, type ExternalCaseResult } from '../record.ts';
import { cleanupTemporaryDirectory } from '../cleanup.ts';
import type { Selectable } from '../selection.ts';
import {
  DriftConfigSchema,
  LocalGitProvider,
  analyzeRepository,
  resolvePlanVerdict,
  type Logger,
  type RemediationPlan,
  type RepoContext,
} from '../../../../dist/index.js';
// Not part of the public package surface — see the note in
// `eval/src/adapters/end-to-end.ts`.
import { deepVerify } from '../../../../dist/analysis.js';

const execFile = promisify(execFileCallback);

/**
 * swe-bump-bench: real TypeScript projects whose build a dependency upgrade
 * breaks.
 *
 * ## What this measures, and what it cannot
 *
 * Every task is a known-breaking upgrade: the corpus was collected by bumping
 * packages until `tsc` failed, and a task only exists because it did. There is
 * no negative population — no upgrade that was checked and found harmless — so
 * this corpus can say how often Drift *catches* a break and can never say how
 * often it cries wolf. A tool that answered "affected" to every input would
 * score a perfect result on every question below. `metrics.ts` refuses to
 * compute precision here rather than leaving it to a caveat.
 *
 * ## Detection without installation, deliberately
 *
 * Drift's detection path needs two manifest states and the repository's
 * source; it does not need `node_modules`. So the detection track checks the
 * project out at the exact recorded commit, commits the manifest bump on top,
 * and runs the real `analyzeRepository()` over production's own
 * `LocalGitProvider` — the same provider the VS Code extension uses. Nothing
 * about the pipeline is stubbed: registry metadata, the published type-surface
 * diff, the Meta-RAG index, localization and the verdict all run for real,
 * against the network.
 *
 * That split matters because installation is where this corpus is fragile.
 * These are projects pinned to four different Node majors with three package
 * managers and lockfiles from 2022–2024, and a failed `yarn install` in 2026
 * is a fact about npm's registry and this machine, not about Drift. Keeping
 * the oracle separate means an install failure excludes a case from the
 * *repair* questions with a recorded reason, and leaves the detection answer
 * standing.
 *
 * ## A reproducibility limit of the corpus itself, recorded not hidden
 *
 * `versionTo` is a semver *range* (`^8.0.1`), produced by running
 * `npm-check-updates --target latest` when the corpus was collected. What
 * `^8.0.1` resolves to today is not what it resolved to then, so this corpus
 * is not version-pinned and two runs of it a year apart are not strictly
 * comparable.
 *
 * This track cannot close that gap and does not pretend to. It writes the
 * range into the manifest exactly as the dataset states it and records that
 * under `manifestVersionTo`, with `versionToIsRange` beside it. Resolving the
 * range would mean running the package manager, which is the install step this
 * track deliberately does not perform — so what the range resolves to is
 * genuinely unknown here, and the artifact says `versionToIsRange: true`
 * rather than presenting a range under a field name that implies a resolution.
 */

export const ADAPTER_VERSION = 'swe-bump-detect-v1';

const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  group: (_label, fn) => fn(),
};

export interface SweBumpTask {
  id: string;
  name: string;
  owner: string;
  pkgManager: string;
  package: string;
  versionTo: string;
  nodeVersion: string;
  commit: string;
}

export async function loadSweBump(root: string): Promise<{ tasks: SweBumpTask[]; datasetVersion: string; sourceHash: string }> {
  const bytes = await readFile(join(root, 'tasks.json'));
  const tasks = JSON.parse(bytes.toString('utf8')) as SweBumpTask[];
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: root });
  return {
    tasks,
    datasetVersion: stdout.trim(),
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function sweBumpSelectables(tasks: readonly SweBumpTask[]): Selectable[] {
  // Stratified by package manager first — it is what decides whether a case
  // can be installed at all here — then by repository, so one project with
  // several tasks cannot dominate a sample.
  return tasks.map((task) => ({ id: task.id, strata: [task.pkgManager, `${task.owner}/${task.name}`] }));
}

export interface SweBumpPrediction {
  dependencyChanges: { name: string; from: string | null; to: string | null }[];
  breakingChanges: { kind: string; symbols: string[] }[];
  impactSites: { file: string; line: number; matchedSymbol: string }[];
  verdict: string;
  summary: string;
  /**
   * The specifier written into the manifest, verbatim from the dataset.
   *
   * Named for what it is. It was `resolvedVersionTo` for one commit, which was
   * a false claim in a field name: nothing resolves it, because this track
   * runs no install.
   */
  manifestVersionTo: string;
  versionFrom: string | null;
  exactVersionPair: { from: string; to: string } | null;
}

/**
 * The verdicts that tell a developer this upgrade does not affect them.
 *
 * Identical to the set the case-based evaluator uses, and identical for the
 * same reason: two halves of one harness disagreeing about what "Drift said it
 * was safe" means would be worse than either answer.
 */
const SAFE_EQUIVALENT = new Set(['no-incompatible-change-in-checked-surfaces', 'clean', 'detected-not-locally-reachable']);

export class SweBumpUnavailable extends Error {
  readonly kind: ExclusionKind;
  readonly missingRequirement: string | null;

  constructor(kind: ExclusionKind, message: string, missingRequirement: string | null = null) {
    super(message);
    this.kind = kind;
    this.missingRequirement = missingRequirement;
  }
}

/**
 * Checks the project out at the exact recorded commit and runs real Drift.
 *
 * The checkout is a full clone rather than a shallow one: the recorded commit
 * is frequently not the branch head any more, and a shallow clone of the
 * default branch would silently analyse today's code — which is precisely the
 * substitution this benchmark must never make. A commit the remote no longer
 * has is reported `source-unavailable`, never replaced.
 */
export async function predictSweBump(task: SweBumpTask): Promise<SweBumpPrediction> {
  // The target alone is enough to prove this case cannot adjudicate an exact
  // version question. Do not clone a repository or query registries merely to
  // produce outcomes that scoring must discard; keep the case and its raw
  // specifier, explicitly unadjudicated.
  if (!semver.valid(task.versionTo)) return unresolvedPrediction(task.versionTo, null);

  const work = await mkdtemp(join(tmpdir(), `drift-swebump-${task.owner}-`));
  const repo = join(work, 'repo');

  try {
    await mkdir(repo, { recursive: true });
    const url = `https://github.com/${task.owner}/${task.name}.git`;
    await execFile('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo });
    await execFile('git', ['remote', 'add', 'origin', url], { cwd: repo });
    try {
      await execFile('git', ['fetch', '--quiet', '--depth', '1', 'origin', task.commit], {
        cwd: repo,
        timeout: 600_000,
      });
    } catch (err) {
      throw new SweBumpUnavailable(
        'source-unavailable',
        `commit ${task.commit} could not be fetched from ${url}: ${(err as Error).message.slice(0, 300)}`,
      );
    }
    await execFile('git', ['checkout', '--quiet', 'FETCH_HEAD'], { cwd: repo });
    await execFile('git', ['config', 'user.email', 'bench@drift.invalid'], { cwd: repo });
    await execFile('git', ['config', 'user.name', 'Drift Benchmark'], { cwd: repo });

    const beforeSha = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

    const manifestPath = join(repo, 'package.json');
    const before = await readFile(manifestPath, 'utf8').catch(() => null);
    if (before === null) {
      throw new SweBumpUnavailable('reproduction-failed', `no package.json at ${task.commit}`);
    }

    const manifest = JSON.parse(before) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const section = manifest.dependencies?.[task.package]
      ? manifest.dependencies
      : manifest.devDependencies?.[task.package]
        ? manifest.devDependencies
        : null;
    if (!section) {
      // The corpus names a package the manifest at that commit does not
      // declare. Reported, never patched around by adding it.
      throw new SweBumpUnavailable(
        'reproduction-failed',
        `${task.package} is not declared in package.json at ${task.commit}, so the recorded bump cannot be applied`,
      );
    }

    const versionFrom = section[task.package] ?? null;
    const exactVersionPair = exactSweBumpVersionPair(versionFrom, task.versionTo);
    if (!exactVersionPair) {
      return unresolvedPrediction(task.versionTo, versionFrom);
    }

    section[task.package] = task.versionTo;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await execFile('git', ['add', 'package.json'], { cwd: repo });
    await execFile('git', ['commit', '--quiet', '-m', `bump ${task.package} to ${task.versionTo}`], { cwd: repo });
    const afterSha = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

    const config = DriftConfigSchema.parse({ evidence: { typeSurface: true } });
    const context: RepoContext = {
      owner: task.owner,
      repo: task.name,
      baseBranch: 'main',
      beforeSha,
      afterSha,
      workspace: repo,
    };

    const analysisOptions = {
      repo: context,
      config,
      logger: SILENT_LOGGER,
      provider: new LocalGitProvider(repo, { before: beforeSha, after: afterSha }),
      workspace: repo,
    };

    // Deep Verification: install the change and run the project's own
    // checks, exactly as `runPipeline` does when a caller asks for it —
    // always, here, matching what this harness measured before PR #69 split
    // Quick Scan from Deep Verification into two calls.
    const result = await deepVerify(await analyzeRepository(analysisOptions), analysisOptions);

    const plan = result.plan;
    return {
      dependencyChanges: (plan?.changes ?? []).map((change) => ({
        name: change.name,
        from: change.from,
        to: change.to,
      })),
      breakingChanges: (plan?.breakingChanges ?? []).map((change) => ({
        kind: String(change.kind),
        symbols: change.symbols ?? [],
      })),
      impactSites: (plan?.impactSites ?? []).map((site) => ({
        file: site.file,
        line: site.line,
        matchedSymbol: site.matchedSymbol,
      })),
      verdict: verdictFromPlan(plan),
      summary: result.summary,
      manifestVersionTo: task.versionTo,
      versionFrom,
      exactVersionPair,
    };
  } finally {
    await cleanupTemporaryDirectory(work);
  }
}

export function exactSweBumpVersionPair(from: string | null, to: string): { from: string; to: string } | null {
  const exactFrom = from ? semver.valid(from) : null;
  const exactTo = semver.valid(to);
  return exactFrom && exactTo ? { from: exactFrom, to: exactTo } : null;
}

function unresolvedPrediction(manifestVersionTo: string, versionFrom: string | null): SweBumpPrediction {
  return {
    dependencyChanges: [],
    breakingChanges: [],
    impactSites: [],
    verdict: 'insufficient-evidence',
    summary: 'No authoritative exact before/after version pair was available to analyze.',
    manifestVersionTo,
    versionFrom,
    exactVersionPair: null,
  };
}

/**
 * The user-facing verdict, derived exactly as production derives it — by
 * calling production's own `resolvePlanVerdict` rather than reconstructing
 * the reduction here. That includes the confirmed-regression override: a
 * project whose own build measurably broke after this change scores as
 * affected even where static localization found nothing to point at.
 *
 * The first version of this adapter had its own three-line reduction: sites
 * means affected, findings means detected-not-reachable, otherwise
 * no-incompatible-change. That third branch was wrong in the one direction
 * that matters — an absence of findings is a *safety claim* only when the API
 * surface was genuinely computed and the repository genuinely searched, and
 * reading it as safe regardless would have manufactured a false-safe out of
 * every case where Drift correctly declined to conclude anything.
 */
function verdictFromPlan(plan: RemediationPlan | null | undefined): string {
  return plan ? resolvePlanVerdict(plan) : 'insufficient-evidence';
}

export interface ScoreSweBumpInput {
  task: SweBumpTask;
  prediction: SweBumpPrediction | null;
  excluded: { kind: ExclusionKind; reason: string; missingRequirement: string | null } | null;
  datasetVersion: string;
  sourceHash: string;
  durationMs: number;
}

export function scoreSweBump(input: ScoreSweBumpInput): ExternalCaseResult {
  const { task, prediction } = input;

  const base = {
    schemaVersion: EXTERNAL_RECORD_VERSION as typeof EXTERNAL_RECORD_VERSION,
    caseId: task.id,
    provenance: {
      dataset: 'swe-bump',
      datasetVersion: input.datasetVersion,
      recordId: task.id,
      repository: `https://github.com/${task.owner}/${task.name}`,
      commit: task.commit,
      baseCommit: null,
      dependency: task.package,
      fromVersion: prediction?.exactVersionPair?.from ?? null,
      toVersion: prediction?.exactVersionPair?.to ?? null,
      packageManager: task.pkgManager,
      requiredRuntime: task.nodeVersion,
      oracleCommand: 'tsc --noEmit',
      containerImage: null,
      sourceHash: input.sourceHash,
      extra: {
        // The corpus states a range, not a pin. See the module docstring.
        // The corpus states a range, not a pin. See the module docstring.
        versionToIsRange: String(/[\^~><*x|\s]/.test(task.versionTo)),
        manifestVersionTo: prediction?.manifestVersionTo ?? 'unavailable',
        manifestVersionFrom: prediction?.versionFrom ?? 'unavailable',
        exactVersionAdjudicated: String(Boolean(prediction?.exactVersionPair)),
      },
    },
    truth: {
      label: 'known-breaking-upgrade',
      mappedTo: 'locally-affected',
      mappingStatus: 'exact' as const,
      mappingNote: '',
      // Every task in this corpus is a positive by construction. Recorded per
      // case anyway, so that `metrics.ts` derives the absence of negatives from
      // the data rather than from a dataset-level flag.
      polarity: 'positive' as const,
    },
    durationMs: input.durationMs,
  };

  if (!prediction) {
    return { ...base, prediction: {}, outcomes: {}, excluded: input.excluded };
  }

  const detectedUpdate = prediction.exactVersionPair
    ? prediction.dependencyChanges.some(
        (change) =>
          change.name === task.package &&
          change.from === prediction.exactVersionPair!.from &&
          change.to === prediction.exactVersionPair!.to,
      )
    : undefined;
  const identifiedAffected = prediction.verdict === 'locally-affected';
  const localized = prediction.impactSites.length > 0;
  const adjudicated = detectedUpdate !== undefined;
  const unadjudicatedReason =
    'the corpus supplies a manifest range rather than an authoritative exact before/after version pair';

  return {
    ...base,
    prediction: { ...prediction } as Record<string, unknown>,
    outcomes: adjudicated
      ? {
          detectedUpdate,
          identifiedAffected,
          localized,
          // The question this corpus is best at answering. Every case really is
          // broken, so any safe-equivalent verdict is Drift telling a developer
          // with a broken build that they are fine.
          falseSafe: SAFE_EQUIVALENT.has(prediction.verdict),
        }
      : {},
    ...(!adjudicated
      ? {
          notAdjudicated: {
            detectedUpdate: unadjudicatedReason,
            identifiedAffected: unadjudicatedReason,
            localized: unadjudicatedReason,
            falseSafe: unadjudicatedReason,
          },
        }
      : {}),
    excluded: null,
  };
}
