import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
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
 * BUMP: real Java projects whose Maven build a dependency update broke.
 *
 * ## Why this runs without Docker, and what that costs
 *
 * BUMP's own reproduction is a pair of published container images per case,
 * `<sha>-pre` and `<sha>-breaking`, and those images are the authority on
 * whether the build fails. This machine has no container runtime, so the
 * oracle cannot be run here at all, and this adapter does not pretend
 * otherwise: it evaluates **detection only**, and the repair and oracle
 * questions are recorded as `environment-unavailable` naming `docker` rather
 * than as zeroes. A zero would be a measurement. There was no measurement.
 *
 * What detection does not need is the image. BUMP records a `breakingCommit`,
 * which *is* the commit that changed the version in `pom.xml`, so its parent
 * is the pre-update state — and that pair is a genuine historical manifest
 * diff, not a bump this benchmark synthesised. It is stronger provenance than
 * the TypeScript corpus, where the version bump has to be applied by the
 * harness because the dataset states a target range rather than a commit.
 *
 * The pair is fed to `analyzeRepository()` through production's own
 * `LocalGitProvider`. Drift's Maven detection reads `pom.xml` directly, so
 * nothing needs to be built for the manifest diff, the evidence retrieval or
 * the localization pass to run exactly as they do for a user.
 *
 * ## Why 571 records do not become "N/571"
 *
 * The corpus is heavyweight by design — 1,142 images — and a run that
 * evaluates part of it must say so. Selection is deterministic and stratified
 * over failure category, update class and project, and every published figure
 * names the subset and links its manifest. `BUMP: 40 cases` and `BUMP: 40/571`
 * are different claims and only the first one would be true.
 *
 * ## What no amount of running this can establish
 *
 * Every record is a reproduced breaking update. There are no non-breaking
 * control updates, so there is no population over which a false-positive rate
 * exists, and `metrics.ts` refuses to compute one.
 */

export const ADAPTER_VERSION = 'bump-detect-v1';

const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  group: (_label, fn) => fn(),
};

export interface BumpRecord {
  url: string;
  project: string;
  projectOrganisation: string;
  breakingCommit: string;
  updatedDependency: {
    dependencyGroupID: string;
    dependencyArtifactID: string;
    previousVersion: string;
    newVersion: string;
    dependencyScope: string;
    versionUpdateType: string;
    githubRepoSlug?: string;
    dependencySection?: string;
  };
  preCommitReproductionCommand: string;
  breakingUpdateReproductionCommand: string;
  javaVersionUsedForReproduction: string;
  failureCategory: string;
}

export async function loadBump(root: string): Promise<{ records: BumpRecord[]; datasetVersion: string; sourceHash: string }> {
  const dir = join(root, 'data', 'benchmark');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  const hash = createHash('sha256');
  const records: BumpRecord[] = [];

  for (const file of files) {
    const bytes = await readFile(join(dir, file));
    hash.update(bytes);
    records.push(JSON.parse(bytes.toString('utf8')) as BumpRecord);
  }

  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: root });
  return { records, datasetVersion: stdout.trim(), sourceHash: hash.digest('hex') };
}

/**
 * Stratification dimensions, in the order they matter.
 *
 * Failure category first: a compilation failure and an enforcer failure are
 * different products of the same event and Drift's static path can plausibly
 * see one and not the other. Update class second, because a major bump and a
 * patch bump are different evidence situations. Project last, so that the 153
 * distinct projects cannot let one prolific repository dominate a sample.
 */
export function bumpSelectables(records: readonly BumpRecord[]): Selectable[] {
  return records.map((record) => ({
    id: record.breakingCommit,
    strata: [
      record.failureCategory,
      record.updatedDependency.versionUpdateType,
      `${record.projectOrganisation}/${record.project}`,
    ],
  }));
}

export class BumpUnavailable extends Error {
  readonly kind: ExclusionKind;
  readonly missingRequirement: string | null;

  constructor(kind: ExclusionKind, message: string, missingRequirement: string | null = null) {
    super(message);
    this.kind = kind;
    this.missingRequirement = missingRequirement;
  }
}

export interface BumpPrediction {
  dependencyChanges: { name: string; from: string | null; to: string | null }[];
  breakingChanges: { kind: string; symbols: string[] }[];
  impactSites: { file: string; line: number; matchedSymbol: string }[];
  verdict: string;
  summary: string;
  checkedSurfaces: { surface: string; dependency?: string; ecosystem?: string; workspace?: string; status: string; detail: string }[];
}

const SAFE_EQUIVALENT = new Set(['no-incompatible-change-in-checked-surfaces', 'clean', 'detected-not-locally-reachable']);

/**
 * Fetches the real commit pair and runs Drift over it.
 *
 * Depth 2 because the parent is the pre-update state and is the whole point:
 * the diff between them is the historical manifest change a developer actually
 * received. A commit the remote no longer has — dependabot branches are often
 * deleted — is `source-unavailable`, and is never replaced by the branch head.
 */
export async function predictBump(record: BumpRecord): Promise<BumpPrediction> {
  const work = await mkdtemp(join(tmpdir(), `drift-bump-${record.project}-`));
  const repo = join(work, 'repo');
  const slug = `${record.projectOrganisation}/${record.project}`;

  try {
    await mkdir(repo, { recursive: true });
    await execFile('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo });
    await execFile('git', ['remote', 'add', 'origin', `https://github.com/${slug}.git`], { cwd: repo });
    try {
      await execFile('git', ['fetch', '--quiet', '--depth', '2', 'origin', record.breakingCommit], {
        cwd: repo,
        timeout: 900_000,
      });
    } catch (err) {
      throw new BumpUnavailable(
        'source-unavailable',
        `commit ${record.breakingCommit} could not be fetched from ${slug}: ${(err as Error).message.slice(0, 300)}`,
      );
    }
    await execFile('git', ['checkout', '--quiet', record.breakingCommit], { cwd: repo });

    const parents = (await execFile('git', ['rev-list', '--parents', '-n', '1', record.breakingCommit], { cwd: repo })).stdout
      .trim()
      .split(/\s+/);
    const beforeSha = parents[1];
    if (!beforeSha) {
      throw new BumpUnavailable(
        'source-unavailable',
        `the breaking commit ${record.breakingCommit} has no parent available in a depth-2 fetch, so the pre-update manifest state cannot be read`,
      );
    }

    const config = DriftConfigSchema.parse({});
    const context: RepoContext = {
      owner: record.projectOrganisation,
      repo: record.project,
      baseBranch: 'main',
      beforeSha,
      afterSha: record.breakingCommit,
      workspace: repo,
    };

    const analysisOptions = {
      repo: context,
      config,
      logger: SILENT_LOGGER,
      provider: new LocalGitProvider(repo, { before: beforeSha, after: record.breakingCommit }),
      workspace: repo,
    };

    // Deep Verification: install the change and run the project's own build,
    // exactly as `runPipeline` does when a caller asks for it — always, here,
    // matching what this harness measured before PR #69 split Quick Scan from
    // Deep Verification into two calls. `deepVerify` itself still no-ops
    // without `mvn` on the host or a checkout to run it in.
    const result = await deepVerify(await analyzeRepository(analysisOptions), analysisOptions);

    const plan = result.plan;
    return {
      dependencyChanges: (plan?.changes ?? []).map((change) => ({ name: change.name, from: change.from, to: change.to })),
      breakingChanges: (plan?.breakingChanges ?? []).map((change) => ({ kind: String(change.kind), symbols: change.symbols ?? [] })),
      impactSites: (plan?.impactSites ?? []).map((site) => ({ file: site.file, line: site.line, matchedSymbol: site.matchedSymbol })),
      verdict: verdictFromPlan(plan),
      summary: result.summary,
      checkedSurfaces: (plan?.checkedSurfaces ?? []).map((surface) => ({ ...surface })),
    };
  } finally {
    await cleanupTemporaryDirectory(work);
  }
}

/**
 * The user-facing verdict, derived exactly as production derives it — by
 * calling production's own `resolvePlanVerdict` rather than reconstructing
 * the reduction here. That includes the confirmed-regression override: a
 * project whose own build measurably broke after this change scores as
 * affected even where static localization found nothing to point at.
 */
function verdictFromPlan(plan: RemediationPlan | null | undefined): string {
  return plan ? resolvePlanVerdict(plan) : 'insufficient-evidence';
}

export interface ScoreBumpInput {
  record: BumpRecord;
  prediction: BumpPrediction | null;
  excluded: { kind: ExclusionKind; reason: string; missingRequirement: string | null } | null;
  datasetVersion: string;
  sourceHash: string;
  durationMs: number;
}

export function scoreBump(input: ScoreBumpInput): ExternalCaseResult {
  const { record, prediction } = input;
  const dependency = `${record.updatedDependency.dependencyGroupID}:${record.updatedDependency.dependencyArtifactID}`;

  const base = {
    schemaVersion: EXTERNAL_RECORD_VERSION as typeof EXTERNAL_RECORD_VERSION,
    caseId: record.breakingCommit,
    provenance: {
      dataset: 'bump',
      datasetVersion: input.datasetVersion,
      recordId: record.breakingCommit,
      repository: `https://github.com/${record.projectOrganisation}/${record.project}`,
      commit: record.breakingCommit,
      // The real pre-update state, resolved at run time from the breaking
      // commit's parent. Not a revision this harness chose.
      baseCommit: `${record.breakingCommit}^`,
      dependency,
      fromVersion: record.updatedDependency.previousVersion,
      toVersion: record.updatedDependency.newVersion,
      packageManager: 'maven',
      requiredRuntime: `java ${record.javaVersionUsedForReproduction}`,
      oracleCommand: 'mvn test (inside the published image)',
      // Recorded even though it cannot be pulled here, so a reader with Docker
      // can run the authoritative reproduction from this artifact alone.
      containerImage: record.breakingUpdateReproductionCommand.replace(/^docker run /, ''),
      sourceHash: input.sourceHash,
      extra: {
        failureCategory: record.failureCategory,
        versionUpdateType: record.updatedDependency.versionUpdateType,
        dependencyScope: record.updatedDependency.dependencyScope,
        pullRequest: record.url,
        preImage: record.preCommitReproductionCommand.replace(/^docker run /, ''),
      },
    },
    truth: {
      label: record.failureCategory,
      mappedTo: 'locally-affected',
      mappingStatus: 'compatible' as const,
      mappingNote:
        "BUMP's failure category describes how the build failed, not what changed in the API. It is mapped only to the claim that the project is affected — which is what the reproduction establishes — and never to a Drift breaking-change kind, which this dataset does not record.",
      polarity: 'positive' as const,
    },
    durationMs: input.durationMs,
  };

  if (!prediction) return { ...base, prediction: {}, outcomes: {}, excluded: input.excluded };

  return {
    ...base,
    prediction: { ...prediction } as Record<string, unknown>,
    outcomes: {
      /*
       * Matched on the full coordinate, or on the artifact as a whole segment.
       *
       * The fallback used to be `endsWith(artifactId)` with no separator,
       * which credits a detection for the wrong dependency: `endsWith('core')`
       * matches `com.example:jackson-core` and `com.other:core` alike. It
       * happened to change nothing on this subset — 34 of 39 either way — but
       * a matcher that can credit the wrong package is not one to leave in
       * because it has not misfired yet.
       */
      detectedUpdate: prediction.dependencyChanges.some(
        (change) => change.name === dependency || change.name.endsWith(`:${record.updatedDependency.dependencyArtifactID}`),
      ),
      identifiedAffected: prediction.verdict === 'locally-affected',
      localized: prediction.impactSites.length > 0,
      falseSafe: SAFE_EQUIVALENT.has(prediction.verdict),
      // Deliberately no `repaired` key. Repair cannot be judged without the
      // Maven oracle, and the oracle needs the published image. An absent key
      // means the question was not asked; a `false` would mean Drift tried and
      // failed, which is not what happened.
    },
    excluded: null,
  };
}
