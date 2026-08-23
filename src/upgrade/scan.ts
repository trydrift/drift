import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  DependencyChange,
  DependencyKind,
  Ecosystem,
  ImpactSite,
  RemediationPlan,
  RepoContext,
} from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import { classifyBump, normalizeVersion } from '../detect/version.js';
import { parserFor } from '../detect/index.js';
import {
  describeCommand,
  detectPackageManagers,
  packageManagerAmbiguities,
  packageManagerById,
  upgradeMany,
  PACKAGE_MANAGERS,
  type Command,
  type DetectedPackageManager,
  type PackageManager,
  type PackageManagerAmbiguity,
  type PackageManagerId,
} from '../detect/package-manager.js';
import {
  detectWorkspaces,
  memberDirectories,
  memberName,
  nodeWorkspaceFs,
  type WorkspaceFs,
  type WorkspaceLayout,
} from '../detect/workspace.js';
import { discoverNestedProjects, type NestedProject } from '../detect/nested.js';
import { gatherDependencyEvidence } from '../evidence/index.js';
import { buildRationale } from '../rationale/index.js';
import { findNodeDeclarations, findPythonDeclarations } from '../rationale/runtime.js';
import type { UpgradeRationale } from '../rationale/types.js';
import {
  CONFIDENT_SURFACE_WEIGHT,
  type SurfaceAddition,
  type SurfaceUnavailable,
  type ToolInstallRequest,
} from '../evidence/surface/types.js';
import type { ProseSource } from '../evidence/index.js';
import { analyze } from '../analyze/index.js';
import { walkSourceFiles } from '../index/walk.js';
import { buildIndex } from '../index/metarag.js';
import { localize } from '../localize/index.js';
import { resolveModuleMaps } from '../localize/modules.js';
import { buildPlan } from '../plan/index.js';
import { dependencyEcosystemKey, upstreamUpgradeKey } from '../util/id.js';
import { compareSeverity, describeSeverity, severityOf, type UpgradeSeverity } from './severity.js';
import { lookupVersions, versionSourceLabel, type VersionLookup } from './versions.js';
import { summarize } from './summary.js';
import { analysisConcurrency, describeParallelism, networkConcurrency } from '../util/parallelism.js';
import { count, measure, span } from '../util/profile.js';
import { startSpan as diagSpan, withSpan as diagWithSpan } from '../util/diagnostics.js';
import type { BaselineCache } from '../verification/baseline-cache.js';
import {
  probeUpgrades,
  scrubEnv,
  warmProbe,
  type ProbeTarget,
  type ProbeWarmup,
  type UpgradeVerification,
} from '../verification/upgrade-probe.js';
import type { CheckKind } from '../detect/checks.js';
import { applyVerification, describeVerification } from './verification.js';
import type { CargoDependencyPlacement } from '../detect/ecosystems/types.js';

const run = promisify(execFile);

/**
 * Scanning a repository for available upgrades — not "what changed", which is
 * `analysis.ts`'s job, but "what *could* change": every direct dependency's
 * installed version, checked against what its registry has published.
 *
 * Shared by the VS Code extension (`extension/src/upgrades.ts`, a thin wrapper
 * that supplies VS Code's own filesystem, config, and PATH-corrected
 * environment) and the CLI's `drift outdated`, so "what upgrades are
 * available" means the same thing everywhere Drift runs — the same registry
 * calls, the same breaking-change analysis, the same severity verdict.
 */

/**
 * Where one package is in the scan.
 *
 * `pending` is the row that exists before anything is known about it: the
 * manifest has been read, the dependency is real, and nothing has been checked
 * yet. It exists because the alternative — showing nothing until the first
 * verdict lands — made the first minute of a scan look like a tool that had not
 * started, when in fact it had already read every manifest and knew exactly
 * what it was going to check.
 */
export type UpgradeStatus = 'pending' | 'checking' | 'ready' | 'clean' | 'error' | 'upgrading';

export interface UpgradeCandidate {
  id: string;
  name: string;
  kind: DependencyKind;
  cargo?: CargoDependencyPlacement;
  ecosystem: Ecosystem;
  /** The tool that will be run to perform this upgrade. */
  packageManager: PackageManagerId;
  manifestPath: string;
  /** Workspace member directory, when the repository has more than one. */
  workspace?: string;
  /** That member's own package name, when its manifest declares one. */
  workspaceName?: string;
  /**
   * Every workspace member directory this candidate was scanned against —
   * declared workspaces plus undeclared nested projects — the same universe
   * `analyzeUpgrade` used to scope this candidate's runtime declarations.
   *
   * Persisted so a reanalysis (`reanalyzeUpgrade`) can reuse the exact
   * ownership universe the original scan used, rather than re-deriving the
   * repository's full member set from scratch. That distinction matters
   * specifically after a `scanUpgrades({ dirs })` custom-directory scan: the
   * full repository can have more members than were actually scanned, and
   * re-deriving from scratch would silently widen (or otherwise change) the
   * scope a reanalysis reasons about compared to the original scan. Absent
   * only when the repository is a single package and no scoping was needed.
   */
  allMembers?: readonly string[];
  /** Absolute path of the root this candidate was scanned from. Set when more than one root is open. */
  repoRoot?: string;
  /** That root's display label. */
  repoLabel?: string;
  current: string;
  range: string;
  safeLatest?: string;
  /**
   * The newest version that stays on the current major.
   *
   * Absent when the only upgrade available crosses a major boundary.
   */
  latestMinor?: string;
  selected: string;
  latest: string;
  versions: string[];
  status: UpgradeStatus;
  /**
   * What is being done to this package right now, in the developer's terms.
   *
   * "Reading release notes", "Running `npm run build`" — the actual step,
   * named. A row that says only "Checking…" for four minutes is
   * indistinguishable from a row that is stuck, which is the whole reason this
   * field exists rather than being left to a spinner. Absent once the package
   * is settled: a finished row describes a result, not an activity.
   */
  phase?: string;
  evidenceCount: number;
  breakingCount: number;
  impactCount: number;
  /** Distinct repository files with at least one impact site. */
  impactFiles: number;
  /**
   * The strongest local-impact confidence among the sites behind
   * `impactCount` — `'none'` when there are no sites. Lets `describeSeverity`
   * say "May affect your code" instead of "Affects your code" when the only
   * matches are textual or wrapper-mediated, rather than an import Drift
   * actually traced. See `SeverityInput.impactConfidence`.
   */
  impactConfidence: 'high' | 'medium' | 'low' | 'none';
  /**
   * `impactCount` includes a compiler-provable finding that only a batch pass
   * has weighed in on — not because isolated evidence found it real, but
   * because a batch is never allowed to clear one (see
   * `verification/apply.ts`). `false` covers every other case: nothing was
   * verified, an isolated pass ran and left this uncleared on its own merits
   * (a behavioural change no compiler can see, or a genuine failure), or
   * there is nothing left to clear. Absent (not `undefined` on purpose vs.
   * omitted) is read as `false` by callers not yet updated to supply it.
   */
  impactPendingIsolatedClearance?: boolean;
  risk: string;
  summary: string;
  /**
   * Why this check is incomplete, in the developer's terms.
   *
   * Empty means every source Drift knows how to read was reachable and had
   * something to say. Non-empty with no findings is `unchecked`, not `clean` —
   * see `severity.ts`.
   */
  gaps: string[];
  /** Helper analyzers Drift can install after explicit approval. */
  toolRequests: ToolInstallRequest[];
  /**
   * Why this upgrade might be worth taking, weighed against what it costs.
   *
   * Absent only when the analysis threw. A candidate with findings and no
   * rationale would let "two breaking changes" stand as the whole story, when
   * the fuller one may be "two breaking changes, and it fixes a high-severity
   * advisory you are exposed to today".
   */
  rationale?: UpgradeRationale;
  /**
   * The rationale's conclusion, flattened onto the row.
   *
   * `severity.ts` is deliberately dependency-free so the render layer and the
   * tests can use it in plain Node, so it reads this string rather than
   * reaching into the rationale object.
   */
  recommendation?: string;
  /**
   * What happened when this upgrade was actually installed and checked.
   *
   * The scan tests every candidate in a throwaway worktree before reporting it,
   * so what a developer is shown has already survived their own typecheck and
   * build. Absent when verification was switched off; `skipped` with a reason
   * when it could not run. Never inferred — a candidate with no `verification`
   * has not been measured, and a caller must not read that as "it passed".
   */
  verification?: UpgradeVerification;
  plan?: RemediationPlan;
  error?: string;
}

/**
 * A dependency the scan could not reach a verdict on.
 *
 * Its own list, not a candidate with empty fields: there is no version to
 * offer, no severity to rank, and nothing to press a button on. What there is
 * is a name and a reason, and a caller that renders those has told the truth.
 */
export interface UncheckedDependency {
  name: string;
  kind: DependencyKind;
  ecosystem: Ecosystem;
  packageManager: PackageManagerId;
  manifestPath: string;
  /** The installed version, which is all Drift managed to learn. */
  current: string;
  /** Why the check came up empty, in the developer's terms. */
  reason: string;
}

/**
 * What a scan knows after its cheap first phase, and before its expensive one.
 *
 * The same question `npm outdated` answers — which direct dependencies have a
 * newer version, and what that version is — with none of the "what would this
 * do to my code" work behind it yet. Every candidate here is `pending`: the
 * version numbers on it are final, the verdict on it does not exist.
 */
export interface OutdatedSummary {
  /** One per outdated dependency, in name order, all of them `pending`. */
  outdated: readonly UpgradeCandidate[];
  /** Direct dependencies whose version was looked up, outdated or not. */
  checked: number;
  /** How many of those are already current. */
  upToDate: number;
  /** The ones no source would answer for. Never counted as up to date. */
  unchecked: readonly UncheckedDependency[];
}

export interface UpgradeScanResult {
  candidates: UpgradeCandidate[];
  checked: number;
  /**
   * Dependencies confirmed current: a source answered, and nothing it has
   * published is newer. Distinct from `unchecked` on purpose — this one is
   * the only one that earns the words "up to date".
   */
  upToDate: number;
  /**
   * Dependencies Drift could not check at all.
   *
   * This list is the reason the field exists. These used to be counted as
   * `skipped` and reported as "Up to date", which turned a registry timeout,
   * an unreadable version list, or an ecosystem with no version API into a
   * clean bill of health. A caller that ignores this is making the same claim
   * again, so it is a list of reasons rather than a number that is easy to
   * drop on the floor.
   */
  unchecked: UncheckedDependency[];
  /** Which manifests were read, so the caller can say what was covered. */
  targets: EcosystemTarget[];
  /** Workspace layouts found at the root. Empty for a single-package repo. */
  workspaces: WorkspaceLayout[];
  /** Directories where more than one package manager claims an ecosystem. */
  ambiguities: DirectoryAmbiguity[];
  /**
   * Nested directories with their own `.git` — a separate repository (most
   * often a submodule), not a sub-package of this one. Never scanned as part
   * of this result; surfaced so the caller can offer it as its own root.
   */
  nestedGitRepos: NestedProject[];
}

/** One manifest, and the tool that owns it. */
export interface EcosystemTarget {
  manager: PackageManager;
  /** Directory relative to the workspace root. `''` is the root itself. */
  dir: string;
  /** Repo-relative path of the manifest direct dependencies are read from. */
  manifestPath: string;
  /** Repo-relative lockfile path, when one is committed. */
  lockfilePath: string | null;
}

export interface DirectoryAmbiguity extends PackageManagerAmbiguity {
  dir: string;
}

/**
 * Which manager to use where two claim the same ecosystem in one directory.
 *
 * Keyed `dir\0ecosystem`. Absent means Drift has not been told, and an
 * ambiguous directory is reported rather than guessed at.
 */
export type ManagerPreferences = ReadonlyMap<string, PackageManagerId>;

export function ambiguityKey(dir: string, ecosystem: Ecosystem): string {
  return `${dir}\u0000${ecosystem}`;
}

/**
 * Live scan progress.
 *
 * Deliberately structured rather than a bare string. "Scanning" tells a
 * developer nothing; "Reading the changelog for react 18.3.1 → 19.2.0 (12 of
 * 48)" tells them the tool is working and roughly how long is left.
 */
export interface ScanProgress {
  /** Short label for the current phase, e.g. `Reading changelog`. */
  phase: string;
  /** What specifically is being worked on, e.g. `react 18.3.1 → 19.2.0`. */
  detail: string;
  /** Packages finished so far. */
  done: number;
  /** Packages to check in total, once known. */
  total: number;
  /**
   * Candidate ids this phase is about, when it is about particular packages.
   *
   * See {@link ProbeProgress.targets} — the scan forwards them so a caller
   * rendering one row per package can say what is happening on that row.
   */
  targets?: readonly string[];
  /**
   * A chunk the command named by the current phase just printed.
   *
   * Present *instead of* a phase change: `phase` and `detail` are empty and a
   * consumer appends this to whatever it is already showing. See
   * {@link ProbeProgress.output}.
   */
  output?: string;
}

/** How widely to look. */
export interface ScanBreadth {
  /** Include dev, optional and peer dependencies. On by default. */
  includeDev: boolean;
  /** Cap on impact sites recorded per breaking change. */
  maxSites: number;
  /** Cap on packages checked. `0` means no cap. */
  maxPackages: number;
}

const DEFAULT_BREADTH: ScanBreadth = { includeDev: true, maxSites: 40, maxPackages: 0 };

interface PreparedUpstreamEvidence {
  evidence: Awaited<ReturnType<typeof gatherDependencyEvidence>>;
  additions: Map<string, { additions: SurfaceAddition[]; locator: string }>;
  surfaceGaps: Map<string, SurfaceUnavailable>;
  surfaceCompared: Set<string>;
  prose: Map<string, ProseSource[]>;
}

/**
 * The breadth the extension's Quick Scan panel actually asks for.
 *
 * Exported so nothing else has to guess or hand-copy these numbers — the
 * extension's scan trigger (`extension/src/ui/home.ts`) and the
 * `production-extension-quick` benchmark profile
 * (`scripts/benchmark-scan.mjs`) both import this constant, so a benchmark
 * claiming to measure "the real default" cannot silently drift from what the
 * extension configures. `includeDev` is *not* included here: the extension
 * reads that from the user's `drift.analysis.includeDev` setting
 * (`ctx.config.triggerOn.dev`), not from a fixed default.
 */
export const QUICK_SCAN_MAX_SITES = 400;

/**
 * Find every manifest in a set of directories and name the tool that owns it.
 *
 * An ambiguous directory still yields a target — Drift picks a candidate so
 * the scan (which only reads) can proceed — but the ambiguity is returned
 * alongside so the caller can ask before anything is *written*.
 */
export async function discoverTargets(
  root: string,
  dirs: readonly string[] = [''],
  preferences: ManagerPreferences = new Map(),
  fs: WorkspaceFs = nodeWorkspaceFs(),
): Promise<{ targets: EcosystemTarget[]; ambiguities: DirectoryAmbiguity[] }> {
  const targets: EcosystemTarget[] = [];
  const ambiguities: DirectoryAmbiguity[] = [];
  const rootDefaults = await rootManagerDefaults(root, fs);

  for (const dir of dirs) {
    const absolute = dir ? join(root, dir) : root;
    const direct = await fs.readDirectory(absolute);
    if (direct.length === 0) continue;

    // A directory listing finds `build.gradle`; it never finds
    // `gradle/libs.versions.toml`, because that is not an entry in this
    // directory. Gradle's version catalog is where a modern Gradle build keeps
    // the versions, so a scan that only ever looked at `readdir()` output
    // could parse the catalog perfectly and never be handed one.
    const entries = [...direct, ...(await nestedManifests(absolute, direct, fs))];

    const detected = detectPackageManagers({
      entries,
      read: (name) => readFileSyncish(join(absolute, name)),
    });
    if (detected.length === 0) continue;

    for (const ambiguity of packageManagerAmbiguities(detected)) {
      // `rootDefaults` describes the root's own manager, for a *member*
      // directory with no lockfile of its own to inherit. Falling back to it
      // for the root directory itself is circular — `rootDefaults` is derived
      // from this same directory — and let an ambiguous root (both a
      // `package-lock.json` and a `pnpm-lock.yaml` at the top level, say)
      // silently resolve to whichever lockfile-backed manager happened to be
      // detected last, instead of being reported as the ambiguity it is.
      const chosen = preferences.get(ambiguityKey(dir, ambiguity.ecosystem)) ?? (dir ? rootDefaults.get(ambiguity.ecosystem) : undefined);
      if (!chosen) ambiguities.push({ ...ambiguity, dir });
    }

    for (const entry of chooseManagers(detected, dir, preferences, rootDefaults)) {
      const manifest =
        entry.manager.manifests.find((f) => entries.includes(f)) ??
        (entry.manager.manifestPattern
          ? entries.find((f) => entry.manager.manifestPattern!.test(f))
          : undefined);
      if (!manifest) continue;
      const lockfile = entry.manager.lockfiles.find((f) => entries.includes(f)) ?? null;
      targets.push({
        manager: entry.manager,
        dir,
        manifestPath: dir ? `${dir}/${manifest}` : manifest,
        lockfilePath: lockfile ? (dir ? `${dir}/${lockfile}` : lockfile) : null,
      });
    }
  }

  return { targets, ambiguities };
}

/**
 * Manifests and lockfiles a manager declares at a path rather than a name.
 *
 * Every entry in the package-manager table containing a `/` is probed for
 * existence and reported in the same shape as a directory entry, so detection
 * and manifest selection can treat it exactly like one. Only the nested names
 * managers actually declare are checked — currently Gradle's version catalog —
 * so this is a fixed, tiny number of probes per directory, not a walk.
 */
async function nestedManifests(
  absolute: string,
  direct: readonly string[],
  fs: WorkspaceFs,
): Promise<string[]> {
  const candidates = new Set<string>();
  for (const manager of PACKAGE_MANAGERS) {
    for (const name of [...manager.manifests, ...manager.lockfiles]) {
      if (name.includes('/')) candidates.add(name);
    }
  }

  const found: string[] = [];
  for (const name of candidates) {
    if (direct.includes(name)) continue;
    // The first segment has to exist as a directory entry before the file can,
    // which skips the read entirely for the overwhelming majority of dirs.
    const top = name.slice(0, name.indexOf('/'));
    if (!direct.includes(top)) continue;
    if ((await fs.readFile(join(absolute, name))) !== null) found.push(name);
  }
  return found;
}

/**
 * One manager per ecosystem per directory: the preferred one, else the
 * repository root's own manager for that ecosystem, else the first candidate.
 */
function chooseManagers(
  detected: readonly DetectedPackageManager[],
  dir: string,
  preferences: ManagerPreferences,
  rootDefaults: ReadonlyMap<Ecosystem, PackageManagerId> = new Map(),
): DetectedPackageManager[] {
  const taken = new Set<Ecosystem>();
  const out: DetectedPackageManager[] = [];

  for (const ecosystem of new Set(detected.map((d) => d.manager.ecosystem))) {
    const candidates = detected.filter((d) => d.manager.ecosystem === ecosystem);
    const preferred = preferences.get(ambiguityKey(dir, ecosystem));
    // A member directory of a pnpm/Yarn/Bun workspace usually has nothing but
    // its own `package.json` — the lockfile that actually identifies the
    // manager lives once, at the repository root. Without this fallback an
    // ambiguity here (no local lockfile, several npm-ecosystem managers all
    // matching the manifest) settles on whichever sorts first in the manager
    // table, which is npm, regardless of what the repository actually uses.
    const chosen =
      candidates.find((c) => c.manager.id === preferred) ??
      candidates.find((c) => c.manager.id === rootDefaults.get(ecosystem)) ??
      candidates[0]!;
    if (taken.has(ecosystem)) continue;
    taken.add(ecosystem);
    out.push(chosen);
  }

  return out;
}

/** Which manager the repository root itself uses, per ecosystem. */
async function rootManagerDefaults(
  root: string,
  fs: WorkspaceFs,
): Promise<Map<Ecosystem, PackageManagerId>> {
  const entries = await fs.readDirectory(root);
  const detected = detectPackageManagers({ entries, read: (name) => readFileSyncish(join(root, name)) });
  const defaults = new Map<Ecosystem, PackageManagerId>();
  // A lockfile-backed manager is the only trustworthy root default — an
  // ambiguous root (several manifest-only candidates, no lockfile) has no
  // more of an answer than the member does, so it contributes nothing rather
  // than propagating one guess as another.
  for (const entry of detected) if (entry.fromLockfile) defaults.set(entry.manager.ecosystem, entry.manager.id);
  return defaults;
}

/**
 * Every directory a scan of this root will actually read.
 *
 * The root, plus each declared workspace member, plus each undeclared nested
 * project. Exported because a caller that needs to settle something *before*
 * the scan — which package manager owns an ambiguous directory, say — has to
 * ask about the same directories the scan will visit, and the only reliable
 * way to guarantee that is to compute it in one place and use it in both.
 *
 * The VS Code extension asked about the root alone, so its careful
 * "which package manager do you actually use?" question simply did not happen
 * for a monorepo's members, and the ambiguity was silently guessed at exactly
 * where a monorepo is most likely to have one.
 */
export async function scanDirectories(
  root: string,
  fs: WorkspaceFs = nodeWorkspaceFs(),
): Promise<string[]> {
  const workspaces = await detectWorkspaces(root, fs);
  const declaredMembers = memberDirectories(workspaces);
  const nested = await discoverNestedProjects(root, fs, declaredMembers).catch(() => []);
  const undeclaredDirs = nested.filter((project) => !project.hasOwnGit).map((project) => project.dir);
  return [...declaredMembers, ...undeclaredDirs];
}

export async function scanUpgrades(args: {
  root: string;
  repo: RepoContext;
  config: DriftConfig;
  logger: Logger;
  githubToken?: string;
  breadth?: ScanBreadth;
  /** Directories to scan. Defaults to the workspace root alone. */
  dirs?: readonly string[];
  managers?: ManagerPreferences;
  onProgress?: (progress: ScanProgress) => void;
  /**
   * Called every time a package's row changes — when the manifest first names
   * it, at each phase of its analysis, and with the verdict.
   *
   * Always keyed by `candidate.id`, and the id does not change across those
   * calls, so a caller keeps one row per package and replaces it in place.
   */
  onCandidate?: (candidate: UpgradeCandidate) => void;
  /**
   * Called when a package announced by `onCandidate` turns out to have no
   * upgrade to offer — it is already current, or its version lookup failed.
   *
   * The counterpart to announcing a row before anything is known about it: the
   * row has to be able to go away again, or a scan would end showing rows for
   * every dependency it checked and cleared.
   */
  onDropped?: (id: string) => void;
  token?: { isCancellationRequested: boolean };
  /** Stamped onto every candidate — set when scanning more than one open root. */
  repoLabel?: string;
  /** How the checkout is read. Defaults to plain Node `fs`. */
  fs?: WorkspaceFs;
  /** Environment for spawned tools (Go, etc.). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Packages analysed in parallel. Defaults to what the machine can carry —
   * see `util/parallelism.ts` — and is clamped to [1, 32].
   */
  concurrency?: number;
  /**
   * Called once, as soon as every dependency's version lookup has settled and
   * before any of them has been analysed.
   *
   * This is the cheap half of a scan, and it is the half that answers the
   * question `npm outdated` answers: what is out of date, and what is the
   * newest version. A caller that wants a table on screen in seconds renders
   * this and then lets `onCandidate` fill the verdicts in behind it.
   */
  onOutdated?: (summary: OutdatedSummary) => void;
  /**
   * Install each candidate in a throwaway worktree and run the project's own
   * checks against it before reporting it. Defaults to `config.verify`.
   *
   * A caller passing `enabled: false` gets the old behaviour — predictions,
   * unverified — and should be able to say why.
   */
  verify?: {
    enabled?: boolean;
    checks?: readonly CheckKind[];
    timeoutMs?: number;
    generatedSourceGlobs?: readonly string[];
    /**
     * Where a measured baseline is remembered between runs. See
     * `verification/baseline-cache.ts`.
     *
     * Absent means measure it every time. Two scans of the same commit
     * otherwise re-derive the same typecheck, build and test result at full
     * cost, which on this repository is most of a minute per run spent
     * confirming what did not change.
     */
    baselineCache?: BaselineCache;
  };
}): Promise<UpgradeScanResult> {
  const { root, repo, config, logger, githubToken, onProgress, onCandidate, onDropped, onOutdated, token, repoLabel } =
    args;
  const breadth = args.breadth ?? DEFAULT_BREADTH;
  const fs = args.fs ?? nodeWorkspaceFs();
  const env = args.env ?? process.env;
  // Sized from the machine rather than from a constant. A fixed 8 was both too
  // many for a two-core CI container and far too few for a workstation that
  // spends the whole scan mostly idle.
  const concurrency = Math.max(1, Math.min(32, Math.floor(args.concurrency ?? analysisConcurrency(env)) || 1));
  logger.debug(`Scan parallelism: ${describeParallelism(env)}`);
  // Quick Scan is the default: verification only runs when a caller asks for
  // it explicitly (`verify.enabled: true`), and `config.verify.enabled`
  // remains a hard ceiling above that request — a repository that has turned
  // verification off entirely stays off no matter what a caller asks for.
  // Before this, an unset `args.verify.enabled` fell back to
  // `config.verify.enabled` (default `true`), so verification ran
  // automatically on every scan.
  const verify = {
    enabled: (args.verify?.enabled ?? false) && config.verify.enabled,
    checks: args.verify?.checks ?? (config.verify.checks as readonly CheckKind[]),
    timeoutMs: args.verify?.timeoutMs ?? config.verify.timeoutMs,
    generatedSourceGlobs: args.verify?.generatedSourceGlobs ?? config.verify.generatedSourceGlobs,
    baselineCache: args.verify?.baselineCache,
  };

  // Timed the same way `analyzeRepository`'s stages are: not for `onProgress`,
  // which callers already render as-is, but so a slow scan's time can be
  // attributed to a phase (registry lookups vs. localization vs. the
  // install-and-check probe) instead of guessed at.
  let phaseStarted = Date.now();
  const report = (phase: string, detail: string, done = 0, total = 0) => {
    const now = Date.now();
    logger.debug(`${phase} (+${now - phaseStarted}ms): ${detail}`);
    phaseStarted = now;
    onProgress?.({ phase, detail, done, total });
  };

  const scanSpan = span('scan', 'total');
  const discovery = span('discover', 'manifests');
  report('Looking for manifests', root);
  // A monorepo is many packages sharing a checkout. Each member is scanned as
  // itself: its own manifest, its own package manager, its own impact sites.
  // Computed unconditionally -- even when `args.dirs` restricts what is
  // actually scanned below -- because this is the *ownership* universe, not
  // the scan target list. A directory left out of `args.dirs` still exists in
  // the repository and still owns its own files; if it were left out here
  // too, `memberOf` would attribute its files to no member at all, and
  // runtime scoping would treat them as repository-global (a sibling
  // package's `.nvmrc` bleeding into every other package's compatibility
  // check). See `allMembers` below and `UpgradeCandidate.allMembers`.
  const workspaces = await detectWorkspaces(root, fs);
  const declaredMembers = memberDirectories(workspaces);

  // A repository can be multi-project without ever declaring it — a root
  // manifest plus a sibling subdirectory manifest with nothing but a shared
  // checkout tying them together (this repository's own layout: a root
  // `package.json` and an undeclared `extension/package.json`). Those are
  // found the same way a formal workspace member would be, so a scan covers
  // them without being pointed at them by hand.
  const nested = await discoverNestedProjects(root, fs, declaredMembers).catch(() => []);
  const nestedGitRepos = nested.filter((project) => project.hasOwnGit);
  const undeclaredDirs = nested.filter((project) => !project.hasOwnGit).map((project) => project.dir);

  // The full ownership universe: every member this repository actually has,
  // regardless of which subset is about to be scanned.
  const allMembers = [...declaredMembers, ...undeclaredDirs];
  // The subset actually scanned below. Defaults to the full universe.
  const dirs = args.dirs ?? allMembers;
  if (workspaces.length > 0 || undeclaredDirs.length > 0) {
    const kinds = [...workspaces.map((w) => w.kind), ...(undeclaredDirs.length > 0 ? ['undeclared'] : [])];
    report(
      'Reading the workspace',
      `${dirs.length} package${dirs.length === 1 ? '' : 's'} · ${kinds.join(', ')}`,
    );
  }

  const manifestDiscovery = diagSpan('manifest.discovery');
  const { targets, ambiguities } = await discoverTargets(root, dirs, args.managers ?? new Map(), fs);
  if (targets.length === 0) {
    discovery.end({ targets: 0 });
    manifestDiscovery.end({ targets: 0 });
    scanSpan.end({ checked: 0, candidates: 0 });
    return {
      candidates: [],
      checked: 0,
      upToDate: 0,
      unchecked: [],
      targets,
      workspaces,
      ambiguities,
      nestedGitRepos,
    };
  }

  const memberNames = new Map<string, string>();
  for (const layout of workspaces) {
    for (const member of layout.members) if (member.name) memberNames.set(member.dir, member.name);
  }

  // Every *other* directory the scan is about to read, named from its own
  // manifest. A declared workspace member arrives with a name; the repository
  // root and an undeclared sibling package do not, and without this they were
  // the rows with no label on them — so a checkout with a root `package.json`
  // and an `extension/package.json` showed `zod` twice, once tagged
  // `extension` and once tagged nothing at all, with no way to tell which was
  // which or why the same package appeared to be listed twice.
  for (const target of targets) {
    if (memberNames.has(target.dir)) continue;
    const manifest = target.manifestPath.includes('/')
      ? target.manifestPath.slice(target.manifestPath.lastIndexOf('/') + 1)
      : target.manifestPath;
    const name = await memberName(root, fs, target.dir, manifest, target.manager.ecosystem).catch(() => null);
    if (name) memberNames.set(target.dir, name);
  }

  discovery.end({ targets: targets.length });
  manifestDiscovery.end({ targets: targets.length, manifests: targets.length });
  const enabled = new Set(config.ecosystems);
  // Whether *this repository* is multi-package, not merely whether the
  // targets actually being scanned this run happen to span more than one
  // directory. A `scanUpgrades({ dirs })` custom scan can legitimately touch
  // only one member of an otherwise multi-package repository -- using only
  // `targets` here would then leave `member`/`allMembers` both undefined for
  // that member, which disables scoping entirely rather than narrowing it,
  // letting a sibling member's runtime declarations read as repository-global.
  const multiPackage = allMembers.length > 1 || new Set(targets.map((t) => t.dir)).size > 1;

  /**
   * Every row this scan has put on screen and not yet taken back.
   *
   * A row announced from a manifest is a promise that a verdict is coming, and
   * every path out of this function has to keep or withdraw it — including the
   * ones nobody plans for. See `releaseUnreached`.
   */
  const announced = new Set<string>();

  /** Where each package is right now, published as soon as it changes. */
  const announce = (dep: ScanDependency, phase: string): void => {
    announced.add(candidateId(dep, repoLabel ? root : undefined));
    onCandidate?.(
      pendingCandidate({
        dep,
        member: multiPackage ? dep.target.dir : undefined,
        memberName: multiPackage ? memberNames.get(dep.target.dir) : undefined,
        repoRoot: repoLabel ? root : undefined,
        repoLabel,
        phase,
      }),
    );
  };

  /** The same row, once a registry has said which version it is heading for. */
  const outdatedRow = (
    dep: ScanDependency,
    available: Extract<VersionLookup, { outcome: 'upgrade' }>,
  ): UpgradeCandidate =>
    versionedCandidate(dep, available, 'Waiting to be checked', {
      ...(multiPackage ? { member: dep.target.dir } : {}),
      ...(multiPackage && memberNames.get(dep.target.dir)
        ? { memberName: memberNames.get(dep.target.dir)! }
        : {}),
      ...(repoLabel ? { repoRoot: root, repoLabel } : {}),
    });

  /**
   * Withdraw every row that was announced and never settled.
   *
   * A scan can end without reaching a package it has already listed: the
   * developer pressed stop, a root threw, an ecosystem was disabled between
   * one phase and the next. Without this, each of those leaves a row with a
   * name on it, no verdict, and a spinner that never stops — and every caller
   * would have to implement the same cleanup to avoid it. The lifecycle
   * belongs to whoever opened it.
   */
  const releaseUnreached = (): void => {
    for (const candidate of candidates) announced.delete(candidate.id);
    for (const id of announced) onDropped?.(id);
    announced.clear();
  };

  const drop = (dep: ScanDependency): void => {
    const id = candidateId(dep, repoLabel ? root : undefined);
    announced.delete(id);
    onDropped?.(id);
  };

  const all: ScanDependency[] = [];
  for (const target of targets) {
    if (!enabled.has(target.manager.ecosystem)) continue;
    report('Reading manifest', target.manifestPath);
    const found = await directDependencies(root, target, breadth.includeDev, fs);
    // Listed the moment the manifest names them, with nothing in them yet.
    //
    // Everything below — the registry lookups, the evidence, the impact
    // search, the install-and-check probe — takes time proportional to the
    // number of dependencies, and until the first of them finished the panel
    // had nothing to show at all. A developer watching that has no way to tell
    // a scan that is working from one that is wedged. An empty row with a name
    // on it answers that immediately, and fills itself in as the answers
    // arrive.
    const room = breadth.maxPackages > 0 ? Math.max(0, breadth.maxPackages - all.length) : found.length;
    for (const dep of found.slice(0, room)) announce(dep, 'Waiting to be checked');
    all.push(...found);
  }

  const deps = breadth.maxPackages > 0 ? all.slice(0, breadth.maxPackages) : all;

  report('Indexing your code', 'Walking source files', 0, deps.length);
  // Started, not awaited. Walking and indexing a repository is disk- and
  // CPU-bound and depends on nothing the registry lookups below are about to
  // learn; those are pure latency. Awaiting here made every scan pay for the
  // walk before the first HTTP request went out, which on a large checkout is
  // the difference between "the scan has started" and "the scan is thinking".
  // The index is only needed by `localize`, which is the last thing each
  // package does, so it is awaited there instead.
  //
  // Repository-wide on purpose: an import that crosses a package boundary is a
  // real edge and the index needs it. Only the impact sites are scoped.
  const indexSpan = span('index', 'walk+build');
  const indexing = walkSourceFiles(root, { members: dirs }).then((files) => {
    report(
      'Indexing your code',
      `${files.length} file${files.length === 1 ? '' : 's'} indexed · ${deps.length} direct dependenc${deps.length === 1 ? 'y' : 'ies'} to check`,
      0,
      deps.length,
    );
    const built = { files, index: buildIndex(files) };
    indexSpan.end({ files: files.length });
    return built;
  });
  // Nothing here reads a rejection until `analyzeUpgrade` awaits it, and an
  // unhandled rejection in the meantime would take down the process.
  indexing.catch(() => undefined);

  let upToDate = 0;
  /** Dependencies whose version lookup has settled — phase one's progress. */
  let looked = 0;
  /** Outdated packages whose analysis has settled — phase two's progress. */
  let done = 0;
  const candidates: UpgradeCandidate[] = [];
  const unchecked: UncheckedDependency[] = [];

  /**
   * Prepare the test checkouts now, while the analysis is waiting on registries
   * and changelogs.
   *
   * Verification needs a worktree with the project's dependencies installed and
   * its baseline checks measured, and none of that depends on anything the
   * analysis is about to learn. Leaving it until afterwards meant a scan cost
   * the network phase *plus* an install and a full typecheck/build/test,
   * strictly one after the other, and the install is usually the larger half.
   * Overlapping them costs a little memory and takes the total down to roughly
   * the longer of the two.
   *
   * Started after phase one rather than before it, and only for the directories
   * that turned out to have something to test. Before the scan had two phases
   * this had to guess, so it prepared a checkout for every manifest in the
   * repository — which for an up-to-date project meant a full `npm install` and
   * a whole typecheck, build and test suite run to verify nothing at all, in
   * every member. Waiting for the version lookups costs the four seconds they
   * take and skips all of it.
   *
   * The probe still prepares its own checkout for any directory this did not
   * cover, so this changes what is *prepared*, never what is measured.
   */
  const warmFor = (dirs: ReadonlySet<string>) =>
    verify.enabled && dirs.size > 0 && !token?.isCancellationRequested
      ? warmProbe(
          {
            root,
            targets: [],
            kinds: verify.checks,
            env,
            logger,
            timeoutMs: verify.timeoutMs,
            ...(verify.generatedSourceGlobs ? { allowedGlobs: verify.generatedSourceGlobs } : {}),
            ...(verify.baselineCache ? { baselineCache: verify.baselineCache } : {}),
            ...(token ? { token } : {}),
          },
          [...new Map(targets.filter((target) => dirs.has(target.dir)).map((target) => [target.dir, target])).values()].map(
            (target) => ({ dir: target.dir, packageManager: target.manager.id }),
          ),
          (progress) =>
            progress.output !== undefined
              ? onProgress?.({ phase: '', detail: '', done: 0, total: 0, output: progress.output })
              : report(progress.phase, progress.detail),
        )
      : undefined;

  // Phase one: what is outdated at all.
  //
  // Split out of the analysis on purpose, and it is the difference between a
  // scan that answers in seconds and one that answers in minutes. A version
  // lookup is a single registry request per package and nothing else; the
  // analysis behind it — changelogs, declaration trees, an impact search, an
  // install-and-check probe — is orders of magnitude more work. Interleaving
  // them meant the *list* of what is outdated could not be known until the
  // slowest package had been fully analysed, so `drift outdated` had nothing at
  // all to show for minutes where `npm outdated` shows a table in seconds.
  //
  // Doing every lookup first costs nothing (they were all going to happen
  // anyway) and lets `onOutdated` hand the caller the complete list — name,
  // installed, wanted, latest — as soon as the registries have answered. The
  // analysis then fills that list in, row by row.
  //
  // Run at `networkConcurrency` rather than the analysis limit: this phase is
  // pure latency with no parsing behind it, so the bound that matters is the
  // registry's tolerance, not the machine's.
  report('Checking registries', `${deps.length} direct dependenc${deps.length === 1 ? 'y' : 'ies'}`, 0, deps.length);
  const outdated: { dep: ScanDependency; available: Extract<VersionLookup, { outcome: 'upgrade' }> }[] = [];
  const versionLookups = new Map<string, Promise<VersionLookup>>();
  const lookupPhase = span('phase', 'version-discovery');
  await diagWithSpan('version.discovery', { dependencies: deps.length }, () =>
    inParallel(deps, networkConcurrency(env), async (dep) => {
    if (token?.isCancellationRequested) return;

    const source = versionSourceLabel(dep.target.manager.ecosystem);
    announce(dep, `Asking ${source} what has been published`);
    const lookupSpan = diagSpan('registry.lookup', { package: dep.name });
    const lookupKey = JSON.stringify([dep.target.manager.ecosystem, dep.name, dep.current, dep.range ?? null]);
    let lookupPromise = versionLookups.get(lookupKey);
    if (!lookupPromise) {
      lookupPromise = measure('versions', dep.target.manager.ecosystem, () => lookupVersions({
        name: dep.name,
        ecosystem: dep.target.manager.ecosystem,
        current: dep.current,
        range: dep.range,
        ...(githubToken ? { githubToken } : {}),
      }));
      versionLookups.set(lookupKey, lookupPromise);
      lookupPromise.finally(() => versionLookups.get(lookupKey) === lookupPromise && versionLookups.delete(lookupKey)).catch(() => undefined);
    }
    const available = await lookupPromise;
    lookupSpan.end({ outcome: available.outcome });

    if (available.outcome === 'up-to-date') {
      upToDate += 1;
      looked += 1;
      // The row announced when the manifest was read has nothing to offer, so
      // it is taken back rather than left sitting there with no target version
      // and no verdict.
      drop(dep);
      report('Up to date', `${dep.name}@${dep.current}`, looked, deps.length);
      return;
    }

    // The case this whole shape exists for. Reporting it as "Up to date" —
    // which is what happened until the lookup learned to say so — turns every
    // registry timeout and every ecosystem without a version API into a clean
    // bill of health for a dependency nobody looked at.
    if (available.outcome === 'unchecked') {
      unchecked.push({
        name: dep.name,
        kind: dep.kind,
        ecosystem: dep.target.manager.ecosystem,
        packageManager: dep.target.manager.id,
        manifestPath: dep.target.manifestPath,
        current: dep.current,
        reason: available.reason,
      });
      looked += 1;
      drop(dep);
      report('Could not check', `${dep.name}@${dep.current} · ${available.reason}`, looked, deps.length);
      return;
    }

    outdated.push({ dep, available });
    looked += 1;
    // The row now knows which version it is heading for, which is most of what
    // a table of outdated packages is, so it is republished with those numbers
    // on it rather than waiting for the verdict to carry them.
    onCandidate?.(outdatedRow(dep, available));
    report('Outdated', `${dep.name} ${dep.current} → ${available.safeLatest ?? available.latest}`, looked, deps.length);
    }),
  );

  lookupPhase.end({ checked: deps.length, outdated: outdated.length });
  outdated.sort((a, b) => a.dep.name.localeCompare(b.dep.name));

  // Now that the outdated set is known, prepare exactly the checkouts that will
  // be needed — and start doing it while the analysis below runs.
  const warm = warmFor(new Set(outdated.map(({ dep }) => dep.target.dir)));

  // The answer to "what is out of date", complete, before a single changelog
  // has been read.
  onOutdated?.({
    outdated: outdated.map(({ dep, available }) => outdatedRow(dep, available)),
    checked: deps.length,
    upToDate,
    unchecked: [...unchecked],
  });

  if (token?.isCancellationRequested) {
    releaseUnreached();
    await warm?.dispose();
    scanSpan.end({ cancelled: true });
    return {
      candidates: [],
      checked: deps.length,
      upToDate,
      unchecked,
      targets,
      workspaces,
      ambiguities,
      nestedGitRepos,
    };
  }

  // Phase two: what those upgrades would do to this repository.
  //
  // Still parallel, and still mostly waiting — a changelog fetch, a
  // release-notes call, a type-declaration download — but with real parsing and
  // a repository-wide search behind each one, so this is bounded by the
  // machine rather than by the registries.
  const analysisPhase = span('phase', 'analysis');
  const upstreamCache = new Map<string, Promise<PreparedUpstreamEvidence>>();
  const prepareUpstream = (dep: ScanDependency, selected: string): Promise<PreparedUpstreamEvidence> => {
    const canonical: DependencyChange = {
      name: dep.name,
      ecosystem: dep.target.manager.ecosystem,
      from: dep.current,
      to: selected,
      kind: dep.kind,
      bump: classifyBump(dep.current, selected),
      manifestPath: dep.target.manifestPath,
      rawFrom: dep.current,
      rawTo: selected,
    };
    const key = upstreamUpgradeKey(canonical);
    const existing = upstreamCache.get(key);
    if (existing) {
      diagSpan('upstream.wait', { package: dep.name, ecosystem: canonical.ecosystem, from: canonical.from, to: canonical.to, shared: true }).end();
      return existing;
    }
    const additions = new Map<string, { additions: SurfaceAddition[]; locator: string }>();
    const surfaceGaps = new Map<string, SurfaceUnavailable>();
    const surfaceCompared = new Set<string>();
    const prose = new Map<string, ProseSource[]>();
    const promise = diagWithSpan('upstream.analysis', { package: dep.name, ecosystem: canonical.ecosystem, from: canonical.from, to: canonical.to, shared: false }, () =>
      gatherDependencyEvidence(canonical, {
        config, logger, ...(githubToken ? { githubToken } : {}), env, workspaceRoot: root,
        onSurfaceComputed: (change, diff) => {
          const k = dependencyEcosystemKey(change);
          if (diff.weight >= CONFIDENT_SURFACE_WEIGHT) surfaceCompared.add(k);
          additions.set(k, { additions: diff.additions ?? [], locator: diff.locator });
        },
        onUnavailableSurface: (change, reason) => surfaceGaps.set(dependencyEcosystemKey(change), reason),
        onProseConsulted: (change, source) => {
          const k = dependencyEcosystemKey(change);
          prose.set(k, [...(prose.get(k) ?? []), source]);
        },
      }).then((evidence) => ({ evidence, additions, surfaceGaps, surfaceCompared, prose }))
    );
    upstreamCache.set(key, promise);
    promise.catch(() => { if (upstreamCache.get(key) === promise) upstreamCache.delete(key); });
    return promise;
  };
  try {
    await diagWithSpan('analysis', { packages: outdated.length }, () =>
      inParallel(outdated, concurrency, async ({ dep, available }) => {
      if (token?.isCancellationRequested) return;

      const selected = available.safeLatest ?? available.latest;
      const prepared = await prepareUpstream(dep, selected);
      const candidate = await diagWithSpan(
        'package',
        { package: dep.name, ecosystem: dep.target.manager.ecosystem, from: dep.current, to: selected },
        () =>
          analyzeUpgrade({
            dep,
            selected,
            versions: available.versions,
            latest: available.latest,
            safeLatest: available.safeLatest,
            latestMinor: available.latestMinor,
            repo,
            config,
            githubToken,
            root,
            indexing,
            logger,
            env,
            maxSites: breadth.maxSites,
            member: multiPackage ? dep.target.dir : undefined,
            // The full ownership universe, not `dirs` (the subset this run is
            // actually scanning) -- a member left out of a custom `dirs` scan
            // must still be known here, or its runtime files fall out of
            // `allMembers` entirely and get attributed to no member, which
            // `findNodeDeclarations`/`findPythonDeclarations` then treat as
            // repository-global instead of that member's own business.
            allMembers: multiPackage ? allMembers : undefined,
            // Paired with `member` above: a name without a directory would put a
            // label on every row of a single-package repository, which is one more
            // thing to read past on every line and never varies.
            memberName: multiPackage ? memberNames.get(dep.target.dir) : undefined,
            repoRoot: repoLabel ? root : undefined,
            repoLabel,
            prepared,
            onProgress: (phase, detail) => {
              report(phase, detail, done, outdated.length);
              // The same phase, said on the package's own row. The scan-wide step
              // line only ever shows whichever of the packages in flight reported
              // last, so without this a developer looking at one row can see it is
              // busy and never what it is busy with.
              announce(dep, phase);
            },
          }),
      );

      candidates.push(candidate);
      // Released immediately, but marked `checking` while the upgrade is about to
      // be tested for real. Holding it back entirely left a package invisible for
      // as long as its install took; releasing it as-is presented a prediction the
      // probe may be about to withdraw as though it were the answer. `checking` is
      // the honest third option — here is what we suspect, we are not finished —
      // and it is the same status the row already uses while a re-check runs.
      onCandidate?.(
        verify.enabled
          ? { ...candidate, status: 'checking', phase: 'Waiting to be installed and tested' }
          : candidate,
      );
      done += 1;
      report(
        severityOf(candidate) === 'affected' ? 'Needs your attention' : 'Checked',
        `${candidate.name} ${candidate.current} → ${candidate.selected} · ${describeSeverity(candidate).toLowerCase()}`,
        done,
        outdated.length,
      );
      }),
    );

    analysisPhase.end({ packages: outdated.length });

    const verifyPhase = span('phase', 'verification');
    try {
      if (verify.enabled && candidates.length > 0 && !token?.isCancellationRequested) {
        await diagWithSpan('verification', { candidates: candidates.length }, () =>
          verifyUpgradeCandidates({
          root,
          candidates,
          checks: verify.checks,
          timeoutMs: verify.timeoutMs,
          generatedSourceGlobs: verify.generatedSourceGlobs,
          ...(verify.baselineCache ? { baselineCache: verify.baselineCache } : {}),
          env,
          logger,
          ...(warm ? { warm } : {}),
          ...(token ? { token } : {}),
          // A chunk of command output is not a phase, so it bypasses `report` —
          // which logs and re-times every call as though a new stage had begun.
          onProgress: (progress) => {
            if (progress.output !== undefined) {
              onProgress?.({ phase: '', detail: '', done: progress.done, total: progress.total, output: progress.output });
              return;
            }
            report(progress.phase, progress.detail, progress.done, progress.total);
            // Said on the rows it is actually about. A install-and-check pass is
            // the longest part of a scan by far, and "Checking…" on every row for
            // the whole of it is exactly the wait that reads as a hang.
            for (const id of progress.targets ?? []) {
              const at = candidates.findIndex((entry) => entry.id === id);
              const candidate = at >= 0 ? candidates[at]! : undefined;
              if (!candidate || candidate.verification) continue;
              onCandidate?.({
                ...candidate,
                status: 'checking',
                phase: progress.detail ? `${progress.phase} · ${progress.detail}` : progress.phase,
              });
            }
          },
          onCandidate,
          }),
        );
      }
    } finally {
      // Every candidate released as `checking` has to be released again, whatever
      // happened in between.
      //
      // `checking` is a promise that a verdict is coming, and the row renders it
      // as a spinner. Verification is skipped outright when the scan is cancelled
      // or when it throws, and both used to leave every one of those rows turning
      // for the rest of the session — a scan that looked permanently stuck on
      // packages it had in fact finished analysing. Cancellation is no longer a
      // rare path (the stop button reaches it directly), so this settles the
      // difference explicitly and says why rather than leaving a spinner to imply
      // work that is not happening.
      if (verify.enabled) {
        for (const [at, candidate] of candidates.entries()) {
          if (candidate.verification) continue;
          const settled = applyVerification(candidate, {
            status: 'skipped',
            reason: token?.isCancellationRequested
              ? `The scan was stopped before ${candidate.name} ${candidate.selected} could be installed and checked, so the findings below are predictions.`
              : `${candidate.name} ${candidate.selected} was not installed and checked, so the findings below are predictions.`,
            checks: [],
            failedFiles: [],
          });
          candidates[at] = settled;
          onCandidate?.(settled);
        }
      }

      // Directories that turned out to have no upgrades to test, and everything
      // prepared for a scan that was cancelled or threw. A warmed checkout
      // nobody took is a `git worktree` and an installed `node_modules` sitting
      // on disk, so this runs on every path out — including the ones where
      // verification never ran at all.
      await warm?.dispose();
      verifyPhase.end({ candidates: candidates.length });
    }
  } finally {
    // Cancellation, a throw from any stage above, or simply a package the loop
    // never reached: whatever ended the scan, no row is left claiming that a
    // verdict is still coming.
    releaseUnreached();
  }

  scanSpan.end({ checked: deps.length, candidates: candidates.length });
  return {
    candidates: candidates.sort(compareCandidates),
    checked: deps.length,
    upToDate,
    unchecked,
    targets,
    workspaces,
    ambiguities,
    nestedGitRepos,
  };
}

/**
 * Install every candidate for real and let the project's own toolchain rule on
 * it, rewriting the candidate list in place with what was measured.
 *
 * Runs after the whole analysis rather than inside it: the analysis is network
 * -bound and parallel, this is disk- and CPU-bound and serial, and interleaving
 * them would have sixteen `npm install`s fighting over one machine.
 *
 * Every candidate is released to `onCandidate` here — verified, disproved, or
 * skipped with a reason — because this is the first moment any of them is a
 * statement about this repository rather than a guess about it.
 *
 * Exported so a caller can run Deep Verification on its own, after a Quick
 * Scan already returned — on one candidate ("Deep Verify"), or every candidate
 * from a scan ("Deep Verify All") — without repeating the analysis phase that
 * produced them. `scanUpgrades` itself calls this the same way, as its own
 * verification phase, whenever `verify.enabled` is true.
 */
export async function verifyUpgradeCandidates(args: {
  root: string;
  candidates: UpgradeCandidate[];
  checks: readonly CheckKind[];
  timeoutMs: number;
  /** See {@link WorktreeOptions.allowedGlobs} — `config.verify.generatedSourceGlobs`. */
  generatedSourceGlobs?: readonly string[];
  /** See {@link ProbeOptions.baselineCache}. */
  baselineCache?: BaselineCache;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  token?: { isCancellationRequested: boolean };
  /** Checkouts the scan started preparing while it was busy on the network. */
  warm?: ProbeWarmup;
  onProgress?: (progress: ScanProgress) => void;
  onCandidate?: (candidate: UpgradeCandidate) => void;
}): Promise<void> {
  const byId = new Map(args.candidates.map((candidate) => [candidate.id, candidate]));

  // A version the registry has already disowned (yanked, withdrawn, retracted)
  // cannot be installed, so probing it is not a cheaper version of the real
  // answer — it is a worktree and a package-manager invocation spent to learn
  // something `assessMaintenance` already knows for certain. Settle it here,
  // immediately, instead of handing it to `probeUpgrades` to fail the same way
  // more slowly.
  const withdrawn = args.candidates.filter((candidate) => candidate.rationale?.maintenance.deprecated);
  for (const candidate of withdrawn) {
    const deprecated = candidate.rationale?.maintenance.deprecated;
    const verified = applyVerification(candidate, {
      status: 'skipped',
      reason: `${candidate.name} ${candidate.selected} has been withdrawn (${deprecated}), so it cannot be installed to test.`,
      checks: [],
      failedFiles: [],
    });
    const at = args.candidates.indexOf(candidate);
    if (at >= 0) args.candidates[at] = verified;
    args.onCandidate?.(verified);
  }
  const probeCandidates = args.candidates.filter((candidate) => !withdrawn.includes(candidate));

  const targets: ProbeTarget[] = probeCandidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    current: candidate.current,
    selected: candidate.selected,
    manifestPath: candidate.manifestPath,
    packageManager: candidate.packageManager,
    // The worktree, never `args.root`. `installUpgrade` writes a manifest and
    // runs a package manager, and the whole point of this phase is that neither
    // happens where someone is working. The env is scrubbed of credentials
    // here too: this install runs a version of `candidate` nobody has vetted
    // yet, and its package-manager lifecycle scripts should not find Drift's
    // own tokens sitting in the environment.
    install: (checkout) => installUpgrade(checkout, candidate, 'safe', scrubEnv(args.env)),
  }));

  await probeUpgrades({
    root: args.root,
    targets,
    // One `npm install` for a whole batch instead of one per package. The
    // probe falls back to `install` per target wherever this declines, so
    // nothing depends on which managers can do it.
    installTogether: (checkout, group) =>
      installUpgrades(
        checkout,
        group.map((target) => byId.get(target.id)).filter((c): c is UpgradeCandidate => c !== undefined),
        'safe',
        scrubEnv(args.env),
      ),
    kinds: args.checks,
    env: args.env,
    logger: args.logger,
    timeoutMs: args.timeoutMs,
    ...(args.generatedSourceGlobs ? { allowedGlobs: args.generatedSourceGlobs } : {}),
    ...(args.baselineCache ? { baselineCache: args.baselineCache } : {}),
    ...(args.warm ? { warm: args.warm } : {}),
    ...(args.token ? { token: args.token } : {}),
    onProgress: (progress) =>
      args.onProgress?.({
        phase: progress.phase,
        detail: progress.detail,
        done: progress.done,
        total: progress.total,
        ...(progress.targets ? { targets: progress.targets } : {}),
        ...(progress.output !== undefined ? { output: progress.output } : {}),
      }),
    onVerified: (target, verification) => {
      const candidate = byId.get(target.id);
      if (!candidate) return;
      const verified = applyVerification(candidate, verification);
      const at = args.candidates.indexOf(candidate);
      if (at >= 0) args.candidates[at] = verified;

      // Always logged, never only on failure. A verification that quietly did
      // not happen is indistinguishable from one that passed, right up until
      // the fix stage contradicts the row — which is exactly the confusion this
      // whole feature exists to remove, so the reason is on the record whether
      // or not anyone is watching a panel.
      const dropped = (candidate.plan?.breakingChanges.length ?? 0) - (verified.plan?.breakingChanges.length ?? 0);
      args.logger.info(
        `${target.name}@${target.selected}: ${describeVerification(verification)}` +
          (dropped > 0 ? ` ${dropped} predicted finding(s) dropped as disproved.` : ''),
      );

      args.onCandidate?.(verified);
    },
  });
}

/** Run `worker` over `items`, at most `limit` in flight, preserving no order. */
async function inParallel<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export async function reanalyzeUpgrade(args: {
  candidate: UpgradeCandidate;
  version: string;
  root: string;
  repo: RepoContext;
  config: DriftConfig;
  logger: Logger;
  githubToken?: string;
  fs?: WorkspaceFs;
  env?: NodeJS.ProcessEnv;
  /**
   * Ask the registry again before checking.
   *
   * Off when the developer picked a different version from the list they are
   * already looking at — the list is a second old. On for an explicit re-check
   * of one package, where "has anything changed since the scan" is the whole
   * question being asked, and the answer includes a release published since.
   */
  refreshVersions?: boolean;
  onProgress?: (phase: string, detail: string) => void;
}): Promise<UpgradeCandidate> {
  const dep: ScanDependency = {
    name: args.candidate.name,
    kind: args.candidate.kind,
    current: args.candidate.current,
    range: args.candidate.range,
    target: targetForCandidate(args.candidate),
  };

  let { versions, latest, safeLatest, latestMinor } = args.candidate;
  let version = args.version;

  if (args.refreshVersions) {
    args.onProgress?.('Checking the registry', `${dep.name} (installed ${dep.current})`);
    // A failed refresh keeps the list from the scan rather than emptying it: a
    // registry hiccup must not turn a re-check into "no versions available".
    const available = await lookupVersions({
      name: dep.name,
      ecosystem: dep.target.manager.ecosystem,
      current: dep.current,
      range: dep.range,
      ...(args.githubToken ? { githubToken: args.githubToken } : {}),
    });
    if (available.outcome === 'upgrade') {
      versions = available.versions;
      latest = available.latest;
      safeLatest = available.safeLatest;
      latestMinor = available.latestMinor;
      // Keep the developer's own choice if it is still published; otherwise the
      // selection has to move, and the in-range version is the safe landing.
      if (!versions.includes(version)) version = available.safeLatest ?? available.latest;
    }
  }

  args.onProgress?.('Indexing your code', `Re-checking ${args.candidate.name}@${version}`);
  // Started rather than awaited, for the same reason the scan does it: the
  // walk overlaps the evidence gathering `analyzeUpgrade` is about to do, and
  // is awaited inside it at the one point that needs it.
  const indexing = walkSourceFiles(args.root).then((files) => ({ files, index: buildIndex(files) }));
  indexing.catch(() => undefined);
  const fs = args.fs ?? nodeWorkspaceFs();
  // Must match the member universe `scanUpgrades` computed for the original
  // scan — declared workspace members *and* undeclared nested projects (this
  // repository's own layout: a root `package.json` plus an undeclared
  // `extension/package.json`) — or a package correctly scoped during the scan
  // gets incorrectly scoped the moment it is reanalyzed.
  //
  // The candidate itself is the source of truth when it has one:
  // `UpgradeCandidate.allMembers` is exactly the universe the original scan
  // used, persisted for this reason — including after a `scanUpgrades({
  // dirs })` custom-directory scan, where re-deriving from scratch via
  // `scanDirectories` would silently widen the universe back out to the
  // whole repository instead of the (possibly narrower, possibly identical)
  // one the original scan actually reasoned about. `scanDirectories` remains
  // the fallback for a candidate from before this field existed, or one a
  // caller constructed by hand.
  const allMembers =
    args.candidate.allMembers ??
    (await scanDirectories(args.root, fs).catch(() =>
      args.candidate.workspace === undefined ? [] : [args.candidate.workspace],
    ));

  return analyzeUpgrade({
    dep,
    selected: version,
    member: args.candidate.workspace,
    allMembers: args.candidate.workspace === undefined ? undefined : allMembers,
    memberName: args.candidate.workspaceName,
    repoRoot: args.candidate.repoRoot,
    repoLabel: args.candidate.repoLabel,
    versions,
    latest,
    safeLatest,
    latestMinor,
    repo: args.repo,
    config: args.config,
    githubToken: args.githubToken,
    root: args.root,
    indexing,
    logger: args.logger,
    env: args.env ?? process.env,
    onProgress: args.onProgress,
  });
}

/** Raised when an ecosystem has no command that installs a chosen version. */
export class NoUpgradeCommandError extends Error {
  constructor(readonly candidate: UpgradeCandidate) {
    super(
      `${candidate.packageManager} cannot pin a version from the command line. Edit ${candidate.manifestPath} to require ${candidate.name} ${candidate.selected}, then re-run the scan.`,
    );
  }
}

/** What Drift will run for this upgrade, so the caller can show it before running it. */
export function upgradeCommandFor(
  candidate: UpgradeCandidate,
  mode: 'safe' | 'force' = 'safe',
): string | null {
  const command = plannedUpgrade(candidate, mode);
  return command ? describeCommand(command) : null;
}

/**
 * The command that installs this candidate's selected version.
 *
 * `mode` used to choose the *version* as well as the flags — `force` meant
 * "install `latest`" — which made the version picker a lie: a developer who
 * chose 4.2.0 and pressed the button that said "Upgrade to 5.0.0" got 5.0.0,
 * and a developer who chose 5.0.0 had no button that would install it. The
 * selected version is now the only version any button installs, and `mode`
 * decides one thing: whether the declared range may be overridden.
 */
function plannedUpgrade(candidate: UpgradeCandidate, mode: 'safe' | 'force'): Command | null {
  const manager = packageManagerById(candidate.packageManager);
  const command = manager?.upgrade(upgradeTargetForCandidate(candidate));
  if (!command) return null;

  // `--force` is npm's word for "install it anyway"; nothing else in the table
  // has an equivalent, so forcing elsewhere is just the ordinary command.
  return mode === 'force' && candidate.packageManager === 'npm'
    ? { ...command, args: [...command.args, '--force'] }
    : command;
}

function upgradeTargetForCandidate(candidate: UpgradeCandidate) {
  return {
    name: candidate.name,
    version: candidate.selected,
    kind: candidate.kind,
    ...(candidate.cargo ? { cargo: candidate.cargo } : {}),
  };
}

/**
 * Install one candidate's selected version.
 *
 * Transactional, by snapshot and restore. Drift's whole proposition is that it
 * modifies a repository safely, and a half-applied upgrade is the one outcome
 * that breaks that promise outright: for every manager that needs a manifest
 * rewrite (Bundler, Mix, Rebar3, CocoaPods, Conan, vcpkg, pip's
 * `requirements.txt`, ...), the rewrite lands *before* the install command
 * runs, so a command that then fails used to leave the manifest declaring a
 * version that was never installed and no longer matches the lockfile.
 *
 * So both files the operation can touch — the manifest and the lockfile — are
 * read first and written back verbatim if anything throws. Either the upgrade
 * happened or the tree is exactly as it was found; there is no third state.
 */
export async function installUpgrade(
  root: string,
  candidate: UpgradeCandidate,
  mode: 'safe' | 'force' = 'safe',
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const command = plannedUpgrade(candidate, mode);
  if (!command) throw new NoUpgradeCommandError(candidate);

  const manager = packageManagerById(candidate.packageManager);
  const manifestFile = join(root, candidate.manifestPath);
  const cwd = dirname(manifestFile);

  // Taken before the first write, and covering the lockfile as well as the
  // manifest: the install command rewrites both, so restoring only the one
  // Drift edited by hand would still leave the pair inconsistent.
  const snapshot = await snapshotFiles([
    manifestFile,
    ...(manager?.lockfiles ?? []).map((name) => join(cwd, name)),
  ]);

  try {
    if (manager?.rewriteManifest) {
      const original = await readFile(manifestFile, 'utf8');
      const rewritten = manager.rewriteManifest(
        original,
        upgradeTargetForCandidate(candidate),
        candidate.manifestPath,
      );
      if (rewritten !== original) await writeFile(manifestFile, rewritten, 'utf8');
    }

    await run(command.command, command.args, {
      cwd,
      env,
      // package managers on Windows (npm, pnpm, yarn) ship as .cmd shims,
      // which Windows can only execute through a shell.
      shell: process.platform === 'win32',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    await restoreFiles(snapshot);

    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${command.command} was not found on PATH. Run \`command -v ${command.command}\` to check, and install it ` +
          `if it is genuinely missing.`,
      );
    }
    throw err;
  }
}

/**
 * Install several candidates of one manifest in as few commands as possible.
 *
 * The verification pass tests a whole manifest's worth of upgrades together
 * before it tries to attribute anything, and it used to apply them by calling
 * `installUpgrade` in a loop — twenty outdated packages meant twenty `npm
 * install` runs, each re-resolving a dependency graph that had barely changed
 * and rewriting the same lockfile, before a single check had run. One
 * invocation resolves the whole set once, which is what a developer taking
 * these upgrades by hand would do.
 *
 * `false` means nothing was installed and the caller should fall back to
 * one at a time: the manager cannot take several packages in one command, or
 * the candidates do not share a manifest. Failure throws, having put every file
 * it touched back — the same transactional guarantee `installUpgrade` makes,
 * for the same reason.
 */
export async function installUpgrades(
  root: string,
  candidates: readonly UpgradeCandidate[],
  mode: 'safe' | 'force' = 'safe',
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (candidates.length === 0) return false;

  const first = candidates[0]!;
  const sameProject = candidates.every(
    (candidate) =>
      candidate.manifestPath === first.manifestPath &&
      candidate.packageManager === first.packageManager,
  );
  if (!sameProject) return false;

  const manager = packageManagerById(first.packageManager);
  if (!manager) return false;

  const commands = upgradeMany(
    manager,
    candidates.map(upgradeTargetForCandidate),
  );
  if (!commands) return false;

  const manifestFile = join(root, first.manifestPath);
  const cwd = dirname(manifestFile);
  const snapshot = await snapshotFiles([
    manifestFile,
    ...(manager.lockfiles ?? []).map((name) => join(cwd, name)),
  ]);

  try {
    // Every rewrite first, then every command. A manager in this position
    // (Bundler, Mix, CocoaPods, Conan, pip's requirements.txt) resolves against
    // what the manifest declares, so the whole set has to be declared before
    // the first resolution runs — otherwise the batch is no batch at all.
    if (manager.rewriteManifest) {
      const original = await readFile(manifestFile, 'utf8');
      let rewritten = original;
      for (const candidate of candidates) {
        rewritten = manager.rewriteManifest(
          rewritten,
          upgradeTargetForCandidate(candidate),
          candidate.manifestPath,
        );
      }
      if (rewritten !== original) await writeFile(manifestFile, rewritten, 'utf8');
    }

    for (const command of commands) {
      const args =
        mode === 'force' && first.packageManager === 'npm' ? [...command.args, '--force'] : command.args;
      await run(command.command, args, {
        cwd,
        env,
        shell: process.platform === 'win32',
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
    }
  } catch (err) {
    await restoreFiles(snapshot);

    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${commands[0]!.command} was not found on PATH. Run \`command -v ${commands[0]!.command}\` to check, ` +
          `and install it if it is genuinely missing.`,
      );
    }
    throw err;
  }

  return true;
}

/** A file's contents before an upgrade, or `null` where it did not exist. */
type FileSnapshot = { path: string; content: string | null };

async function snapshotFiles(paths: readonly string[]): Promise<FileSnapshot[]> {
  return Promise.all(
    paths.map(async (path) => ({
      path,
      content: await readFile(path, 'utf8').catch(() => null),
    })),
  );
}

/**
 * Put every snapshotted file back exactly as it was.
 *
 * A file that did not exist before is deleted rather than left behind — a
 * lockfile the failed install created is as much a leftover as an edit to one
 * that was already there. Restore failures are swallowed deliberately: the
 * caller is already throwing the error that actually matters, and replacing it
 * with a filesystem error from the cleanup would hide the cause.
 */
async function restoreFiles(snapshot: readonly FileSnapshot[]): Promise<void> {
  await Promise.all(
    snapshot.map(async ({ path, content }) => {
      try {
        if (content === null) await rm(path, { force: true });
        else await writeFile(path, content, 'utf8');
      } catch {
        // Nothing useful to do here, and nothing worth masking the real error for.
      }
    }),
  );
}

async function analyzeUpgrade(args: {
  dep: ScanDependency;
  selected: string;
  versions: string[];
  latest: string;
  /** The newest version satisfying the manifest's range, computed over every published version. */
  safeLatest?: string;
  /** The newest version on the current major, whether or not the range allows it. */
  latestMinor?: string;
  repo: RepoContext;
  config: DriftConfig;
  githubToken?: string;
  root: string;
  /**
   * The repository walk and its index, still in flight.
   *
   * A promise rather than the finished thing so the walk overlaps every
   * registry round trip in the scan — see where it is started. Awaited once,
   * immediately before the only step that needs it.
   */
  indexing: Promise<{
    files: Awaited<ReturnType<typeof walkSourceFiles>>;
    index: ReturnType<typeof buildIndex>;
  }>;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  maxSites?: number;
  /** Workspace member to scope impact sites to. Absent in a single package. */
  member?: string;
  /**
   * Every workspace member directory in the repository, `member` included —
   * declared workspaces plus any undeclared nested project. Lets runtime
   * declarations be scoped correctly: a file under a *different* member's
   * directory is that member's business, not this one's, while a file that
   * belongs to no member directory at all (root-level config, a CI workflow)
   * is legitimately repository-wide. Absent only when the caller has not
   * gathered a member list, in which case scoping falls back to the old,
   * unscoped behavior rather than guessing.
   */
  allMembers?: readonly string[];
  memberName?: string;
  /** Set when scanning more than one open root, so candidate ids stay unique across them. */
  repoRoot?: string;
  repoLabel?: string;
  prepared?: PreparedUpstreamEvidence;
  onProgress?: (phase: string, detail: string) => void;
}): Promise<UpgradeCandidate> {
  const label = `${args.dep.name} ${args.dep.current} → ${args.selected}`;
  const report = args.onProgress ?? (() => undefined);

  const { target } = args.dep;
  const change: DependencyChange = {
    name: args.dep.name,
    ecosystem: target.manager.ecosystem,
    from: args.dep.current,
    to: args.selected,
    kind: args.dep.kind,
    bump: classifyBump(args.dep.current, args.selected),
    manifestPath: target.manifestPath,
    rawFrom: args.dep.current,
    rawTo: args.selected,
    ...(args.member === undefined ? {} : { workspace: args.member }),
    ...(args.memberName ? { workspaceName: args.memberName } : {}),
  };

  const base = {
    id: candidateId(args.dep, args.repoRoot),
    name: args.dep.name,
    kind: args.dep.kind,
    ecosystem: target.manager.ecosystem,
    packageManager: target.manager.id,
    manifestPath: target.manifestPath,
    ...(args.member === undefined ? {} : { workspace: args.member }),
    ...(args.memberName ? { workspaceName: args.memberName } : {}),
    ...(args.repoRoot ? { repoRoot: args.repoRoot, repoLabel: args.repoLabel } : {}),
    // Persisted so a later `reanalyzeUpgrade` can reuse the exact ownership
    // universe this candidate was scoped against, rather than re-deriving it
    // (potentially differently, after a custom-`dirs` scan) from scratch.
    ...(args.allMembers ? { allMembers: args.allMembers } : {}),
    current: args.dep.current,
    range: args.dep.range,
    // Passed in, never recomputed here: `args.versions` is the list the caller
    // shows, which is capped, so deriving the in-range version from it silently
    // reported "nothing fits your range" for any package with more recent
    // releases than the cap.
    safeLatest: args.safeLatest,
    latestMinor: args.latestMinor,
    selected: args.selected,
    latest: args.latest,
    versions: args.versions,
  };

  try {
    report('Reading release notes and changelog', label);

    // Every reason this check came up short. `gatherEvidence` has always known
    // when it could not compute an API surface; until now nothing asked, so a
    // dependency Drift was unable to read looked exactly like one it had read
    // and cleared.
    const additions = new Map<string, { additions: SurfaceAddition[]; locator: string }>();
    const surfaceGaps = new Map<string, SurfaceUnavailable>();
    const surfaceCompared = new Set<string>();
    const prose = new Map<string, ProseSource[]>();

    const evidence = args.prepared?.evidence.map((record) =>
      args.member === undefined ? record : { ...record, workspace: args.member },
    ) ?? await diagWithSpan('evidence', { package: args.dep.name, ecosystem: target.manager.ecosystem }, () => measure('evidence', target.manager.ecosystem, () => gatherDependencyEvidence(change, {
      config: args.config,
      logger: args.logger,
      githubToken: args.githubToken,
      env: args.env,
      // Lets the Go provider read this repository's own go.mod, so a missing
      // toolchain is reported with the version this repository actually needs.
      workspaceRoot: args.root,
      onSurfaceComputed: (computedChange, diff) => {
        const key = dependencyEcosystemKey(computedChange);
        // A diff below this weight (currently only Python's GitHub-tag
        // fallback) is too approximate to earn the automatic high confidence
        // `judgeConfidence` gives any dependency it believes had a real
        // computed API diff — see `CONFIDENT_SURFACE_WEIGHT`.
        if (diff.weight >= CONFIDENT_SURFACE_WEIGHT) surfaceCompared.add(key);
        additions.set(key, { additions: diff.additions ?? [], locator: diff.locator });
      },
      onUnavailableSurface: (unavailableChange, reason) =>
        surfaceGaps.set(dependencyEcosystemKey(unavailableChange), reason),
      onProseConsulted: (proseChange, source) => {
        const key = dependencyEcosystemKey(proseChange);
        prose.set(key, [...(prose.get(key) ?? []), source]);
      },
    }), { package: args.dep.name }));
    if (args.prepared) {
      const canonicalKey = dependencyEcosystemKey(change);
      const sharedKey = dependencyEcosystemKey({ ...change, workspace: undefined });
      additions.clear(); const addition = args.prepared.additions.get(sharedKey); if (addition) additions.set(canonicalKey, addition);
      surfaceGaps.clear(); const gap = args.prepared.surfaceGaps.get(sharedKey); if (gap) surfaceGaps.set(canonicalKey, gap);
      if (args.prepared.surfaceCompared.has(sharedKey)) surfaceCompared.add(canonicalKey);
      prose.clear(); const consulted = args.prepared.prose.get(sharedKey); if (consulted) prose.set(canonicalKey, consulted);
    }

    report(
      'Comparing the public API surface',
      `${label} · ${evidence.length} evidence source${evidence.length === 1 ? '' : 's'}`,
    );
    const breakingChanges = await diagWithSpan(
      'api.diff',
      { package: args.dep.name, evidenceSources: evidence.length },
      () =>
        measure('analyze', target.manager.ecosystem, () =>
          analyze([change], evidence, {
            config: args.config,
            logger: args.logger,
          }),
        ),
    );

    report(
      breakingChanges.length > 0
        ? `Searching your code for ${breakingChanges.length} breaking change${breakingChanges.length === 1 ? '' : 's'}`
        : 'No breaking changes to look for',
      label,
    );
    // Only worth a round trip when there is something to localize. The
    // resolver caches per process, so a repository whose dependencies repeat
    // across findings pays for each package once however many times this runs.
    const moduleMaps =
      breakingChanges.length > 0
        ? await measure('module-maps', target.manager.ecosystem, () =>
            resolveModuleMaps([change], { logger: args.logger }),
          )
        : undefined;
    const awaitIndex = span('index-wait', target.manager.ecosystem);
    const { files, index } = await args.indexing;
    awaitIndex.end();
    const localizing = span('localize', target.manager.ecosystem, { changes: breakingChanges.length });
    const localization = diagSpan('localization', { package: args.dep.name, changes: breakingChanges.length, filesConsidered: files.length });
    const impactSites = localize(breakingChanges, [change], index, files, {
      logger: args.logger,
      maxSitesPerChange: args.maxSites ?? 40,
      member: args.member,
      ...(moduleMaps ? { moduleMaps } : {}),
    });
    localizing.end({ sites: impactSites.length });
    localization.end({ sites: impactSites.length });
    report('Weighing what this upgrade is worth', label);
    const [rationale] = await measure('rationale', target.manager.ecosystem, () => buildRationale(
      { changes: [change], evidence, breakingChanges, impactSites },
      {
        config: args.config,
        logger: args.logger,
        githubToken: args.githubToken,
        additions,
        surfaceCompared,
        surfaceGaps,
        prose,
        repoRuntime: findNodeDeclarations(files, args.member, args.allMembers),
        pythonRuntime: findPythonDeclarations(files, args.member, args.allMembers),
        // Replaces the single opaque phase above with the actual named stage
        // rationaleFor is in, so a slow scan shows which network call it is
        // waiting on instead of one frozen label.
        onProgress: (_change, phase) => report(phase, label),
      },
    ));

    const plan = buildPlan({
      repo: args.repo,
      config: args.config,
      changes: [change],
      evidence,
      breakingChanges,
      impactSites,
      ...(rationale ? { rationale: [rationale] } : {}),
    });

    return {
      ...base,
      status: breakingChanges.length > 0 ? 'ready' : 'clean',
      evidenceCount: evidence.length,
      breakingCount: breakingChanges.length,
      impactCount: impactSites.length,
      impactFiles: new Set(impactSites.map((site) => site.file)).size,
      impactConfidence: strongestImpactConfidence(impactSites),
      risk: plan.risk,
      summary: summarize(breakingChanges.length, impactSites.length, args.dep.name, rationale),
      // Kept even when there are findings: "two breaking changes, and the type
      // surface could not be read" is a different claim from "two breaking
      // changes", and the weaker one is the true one.
      gaps: rationale?.gaps ?? [],
      toolRequests: installRequests(surfaceGaps),
      ...(rationale
        ? { rationale, recommendation: rationale.assessment.recommendation }
        : {}),
      plan,
    };
  } catch (err) {
    return {
      ...base,
      status: 'error',
      evidenceCount: 0,
      breakingCount: 0,
      impactCount: 0,
      impactFiles: 0,
      impactConfidence: 'none',
      risk: 'unknown',
      summary: 'Could not inspect this upgrade',
      gaps: [],
      toolRequests: [],
      error: (err as Error).message,
    };
  }
}

/** The best-supported match, so a report can hedge on the weaker ones. */
function strongestImpactConfidence(sites: readonly ImpactSite[]): 'high' | 'medium' | 'low' | 'none' {
  if (sites.some((s) => s.confidence === 'high')) return 'high';
  if (sites.some((s) => s.confidence === 'medium')) return 'medium';
  if (sites.some((s) => s.confidence === 'low')) return 'low';
  return 'none';
}

function installRequests(gaps: ReadonlyMap<string, SurfaceUnavailable>): ToolInstallRequest[] {
  const seen = new Set<string>();
  const out: ToolInstallRequest[] = [];
  for (const gap of gaps.values()) {
    if (!gap.install || seen.has(gap.install.id)) continue;
    seen.add(gap.install.id);
    out.push(gap.install);
  }
  return out;
}


/**
 * The identity of one row in the packages list.
 *
 * The installed version rather than the target one: a package is one row from
 * the moment its manifest is read until the moment it is settled, and the
 * target version is chosen partway through that (and can be changed again
 * afterwards, from the version picker). Keying on the target made every one of
 * those moments a *different* row — the pending row could not become the
 * checked one, and re-targeting replaced the row rather than updating it.
 *
 * Prefixed with the root when more than one is open, so two repositories that
 * share a manifest path and a dependency never collide in a `Map<id,
 * candidate>` the caller keeps.
 */
function candidateId(dep: ScanDependency, repoRoot?: string): string {
  return `${repoRoot ? `${repoRoot}::` : ''}${dep.target.manifestPath}#${dep.name}@${dep.current}`;
}

/**
 * The row for a dependency nothing has been learned about yet.
 *
 * Every count is zero and every version is the installed one, because that is
 * genuinely all that is known — this is the manifest entry, rendered. `status`
 * is what keeps a caller from reading those zeroes as "no breaking changes".
 */
function pendingCandidate(args: {
  dep: ScanDependency;
  member?: string;
  memberName?: string;
  repoRoot?: string;
  repoLabel?: string;
  phase: string;
}): UpgradeCandidate {
  const { dep } = args;
  return {
    id: candidateId(dep, args.repoRoot),
    name: dep.name,
    kind: dep.kind,
    ...(dep.cargo ? { cargo: dep.cargo } : {}),
    ecosystem: dep.target.manager.ecosystem,
    packageManager: dep.target.manager.id,
    manifestPath: dep.target.manifestPath,
    ...(args.member === undefined ? {} : { workspace: args.member }),
    ...(args.memberName ? { workspaceName: args.memberName } : {}),
    ...(args.repoRoot ? { repoRoot: args.repoRoot, repoLabel: args.repoLabel } : {}),
    current: dep.current,
    range: dep.range,
    selected: dep.current,
    latest: dep.current,
    versions: [],
    status: 'pending',
    phase: args.phase,
    evidenceCount: 0,
    breakingCount: 0,
    impactCount: 0,
    impactFiles: 0,
    impactConfidence: 'none',
    risk: 'unknown',
    summary: '',
    gaps: [],
    toolRequests: [],
  };
}

/**
 * A row that knows where it is going but not yet what that would cost.
 *
 * Built the moment a registry answers, so a table of outdated packages can be
 * complete long before the first changelog has been read. Still `pending`:
 * every finding count on it is zero because nothing has looked, and
 * `severityOf` reads `pending` precisely so those zeroes are never mistaken for
 * a clean bill of health.
 */
function versionedCandidate(
  dep: ScanDependency,
  available: Extract<VersionLookup, { outcome: 'upgrade' }>,
  phase: string,
  context?: { member?: string; memberName?: string; repoRoot?: string; repoLabel?: string },
): UpgradeCandidate {
  return {
    ...pendingCandidate({
      dep,
      phase,
      ...(context?.member === undefined ? {} : { member: context.member }),
      ...(context?.memberName ? { memberName: context.memberName } : {}),
      ...(context?.repoRoot ? { repoRoot: context.repoRoot } : {}),
      ...(context?.repoLabel ? { repoLabel: context.repoLabel } : {}),
    }),
    selected: available.safeLatest ?? available.latest,
    latest: available.latest,
    ...(available.safeLatest ? { safeLatest: available.safeLatest } : {}),
    ...(available.latestMinor ? { latestMinor: available.latestMinor } : {}),
    versions: available.versions,
  };
}

/** One direct dependency, and the manifest and manager it came from. */
export interface ScanDependency {
  name: string;
  kind: DependencyKind;
  cargo?: CargoDependencyPlacement;
  current: string;
  /** The constraint as written in the manifest, e.g. `^1.2.0`. */
  range: string;
  target: EcosystemTarget;
}

/**
 * Direct dependencies of one manifest, at their installed versions.
 *
 * The manifest is parsed with the same parser `detect` uses, so an ecosystem
 * supported there is supported here by construction. The lockfile is consulted
 * only to sharpen the *installed* version — a range in the manifest says what
 * is permitted, not what is on disk.
 *
 */
export async function directDependencies(
  root: string,
  target: EcosystemTarget,
  includeDev: boolean,
  fs: WorkspaceFs,
): Promise<ScanDependency[]> {
  const parser = parserFor(target.manifestPath);
  const content = await fs.readFile(join(root, target.manifestPath));
  if (!parser || content === null) return [];

  const declared = parser.parse(content, target.manifestPath);

  const lockContent = target.lockfilePath ? await fs.readFile(join(root, target.lockfilePath)) : null;
  const locked =
    lockContent !== null && target.lockfilePath
      ? parserFor(target.lockfilePath)?.parse(lockContent, target.lockfilePath)
      : undefined;

  // Runtime dependencies are what ship, so they are always checked. Dev,
  // optional, and peer dependencies are checked by default too — they still
  // run in CI or in some consumers' hands — but can be excluded to look at
  // runtime alone.
  const kinds: DependencyKind[] = includeDev
    ? ['runtime', 'dev', 'optional', 'peer']
    : ['runtime'];

  const out: ScanDependency[] = [];
  for (const [name, entry] of declared) {
    if (!kinds.includes(entry.kind)) continue;
    const current = normalizeVersion(locked?.get(name)?.version ?? entry.version);
    if (!current) continue;
    out.push({
      name,
      kind: entry.kind,
      ...(entry.cargo ? { cargo: entry.cargo } : {}),
      current,
      range: entry.version ?? current,
      target,
    });
  }

  return out;
}

/** Rebuild the manifest/manager pairing a candidate came from. */
function targetForCandidate(candidate: UpgradeCandidate): EcosystemTarget {
  const manager = packageManagerById(candidate.packageManager);
  if (!manager) throw new Error(`Unknown package manager: ${candidate.packageManager}`);
  const dir = candidate.manifestPath.includes('/')
    ? candidate.manifestPath.slice(0, candidate.manifestPath.lastIndexOf('/'))
    : '';
  return { manager, dir, manifestPath: candidate.manifestPath, lockfilePath: null };
}

/**
 * Synchronous peek, for the one caller that needs content during detection.
 *
 * Telling yarn classic from berry means reading `yarn.lock`'s header, and the
 * detector is a pure function over a listing rather than an async walk. Plain
 * `node:fs`, not the injected `WorkspaceFs` — package-manager detection only
 * ever runs against a real local checkout, never a virtual/remote one.
 */
function readFileSyncish(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Order by what the developer has to act on, not by upstream noise. */
function compareCandidates(a: UpgradeCandidate, b: UpgradeCandidate): number {
  const bySeverity = compareSeverity(a, b);
  if (bySeverity !== 0) return bySeverity;
  if (a.impactCount !== b.impactCount) return b.impactCount - a.impactCount;
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  // A monorepo declares the same package in several manifests, and those rows
  // tied on every comparison above — so the order they came out in was the
  // order the analysis happened to finish in, which differs between two runs of
  // the same scan. A report whose rows move around between identical runs
  // cannot be diffed, and diffing two scans is how anyone sees what changed.
  return a.manifestPath.localeCompare(b.manifestPath);
}

export { describeSeverity, severityOf, type UpgradeSeverity };
// Re-exported so a caller that already imports the scan can turn its baseline
// cache on without reaching two directories deeper for the constructor.
export { createBaselineCache, noBaselineCache, type BaselineCache } from '../verification/baseline-cache.js';
