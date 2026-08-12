import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DependencyChange, DependencyKind, Ecosystem, RemediationPlan, RepoContext } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import { classifyBump, normalizeVersion } from '../detect/version.js';
import { parserFor } from '../detect/index.js';
import {
  describeCommand,
  detectPackageManagers,
  packageManagerAmbiguities,
  packageManagerById,
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
  nodeWorkspaceFs,
  type WorkspaceFs,
  type WorkspaceLayout,
} from '../detect/workspace.js';
import { discoverNestedProjects, type NestedProject } from '../detect/nested.js';
import { gatherEvidence } from '../evidence/index.js';
import { buildRationale } from '../rationale/index.js';
import { RECOMMENDATION_LABEL } from '../rationale/assess.js';
import type { UpgradeRationale } from '../rationale/types.js';
import type { SurfaceAddition, SurfaceUnavailable, ToolInstallRequest } from '../evidence/surface/types.js';
import type { ProseSource } from '../evidence/index.js';
import { analyze } from '../analyze/index.js';
import { walkSourceFiles } from '../index/walk.js';
import { buildIndex } from '../index/metarag.js';
import { localize } from '../localize/index.js';
import { resolveModuleMaps } from '../localize/modules.js';
import { buildPlan } from '../plan/index.js';
import { dependencyEcosystemKey } from '../util/id.js';
import { compareSeverity, describeSeverity, severityOf, type UpgradeSeverity } from './severity.js';
import { lookupVersions, versionSourceLabel } from './versions.js';

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

export type UpgradeStatus = 'checking' | 'ready' | 'clean' | 'error' | 'upgrading';

export interface UpgradeCandidate {
  id: string;
  name: string;
  kind: DependencyKind;
  ecosystem: Ecosystem;
  /** The tool that will be run to perform this upgrade. */
  packageManager: PackageManagerId;
  manifestPath: string;
  /** Workspace member directory, when the repository has more than one. */
  workspace?: string;
  /** That member's own package name, when its manifest declares one. */
  workspaceName?: string;
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
  evidenceCount: number;
  breakingCount: number;
  impactCount: number;
  /** Distinct repository files with at least one impact site. */
  impactFiles: number;
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

/**
 * Find every manifest in a set of directories and name the tool that owns it.
 *
 * An ambiguous directory still yields a target — Drift picks the first
 * candidate so the scan (which only reads) can proceed — but the ambiguity is
 * returned alongside so the caller can ask before anything is *written*.
 */
export async function discoverTargets(
  root: string,
  dirs: readonly string[] = [''],
  preferences: ManagerPreferences = new Map(),
  fs: WorkspaceFs = nodeWorkspaceFs(),
): Promise<{ targets: EcosystemTarget[]; ambiguities: DirectoryAmbiguity[] }> {
  const targets: EcosystemTarget[] = [];
  const ambiguities: DirectoryAmbiguity[] = [];

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
      const chosen = preferences.get(ambiguityKey(dir, ambiguity.ecosystem));
      if (!chosen) ambiguities.push({ ...ambiguity, dir });
    }

    for (const entry of chooseManagers(detected, dir, preferences)) {
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

/** One manager per ecosystem per directory: the preferred one, else the first. */
function chooseManagers(
  detected: readonly DetectedPackageManager[],
  dir: string,
  preferences: ManagerPreferences,
): DetectedPackageManager[] {
  const taken = new Set<Ecosystem>();
  const out: DetectedPackageManager[] = [];

  for (const ecosystem of new Set(detected.map((d) => d.manager.ecosystem))) {
    const candidates = detected.filter((d) => d.manager.ecosystem === ecosystem);
    const preferred = preferences.get(ambiguityKey(dir, ecosystem));
    const chosen = candidates.find((c) => c.manager.id === preferred) ?? candidates[0]!;
    if (taken.has(ecosystem)) continue;
    taken.add(ecosystem);
    out.push(chosen);
  }

  return out;
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
  /** Called as soon as each package resolves, so the caller can fill in gradually. */
  onCandidate?: (candidate: UpgradeCandidate) => void;
  token?: { isCancellationRequested: boolean };
  /** Stamped onto every candidate — set when scanning more than one open root. */
  repoLabel?: string;
  /** How the checkout is read. Defaults to plain Node `fs`. */
  fs?: WorkspaceFs;
  /** Environment for spawned tools (Go, etc.). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Packages checked in parallel. Defaults to 8, clamped to [1, 16]. */
  concurrency?: number;
}): Promise<UpgradeScanResult> {
  const { root, repo, config, logger, githubToken, onProgress, onCandidate, token, repoLabel } = args;
  const breadth = args.breadth ?? DEFAULT_BREADTH;
  const fs = args.fs ?? nodeWorkspaceFs();
  const env = args.env ?? process.env;
  const concurrency = Math.max(1, Math.min(16, Math.floor(args.concurrency ?? 8) || 8));

  const report = (phase: string, detail: string, done = 0, total = 0) =>
    onProgress?.({ phase, detail, done, total });

  report('Looking for manifests', root);
  // A monorepo is many packages sharing a checkout. Each member is scanned as
  // itself: its own manifest, its own package manager, its own impact sites.
  const workspaces = args.dirs ? [] : await detectWorkspaces(root, fs);
  const declaredMembers = memberDirectories(workspaces);

  // A repository can be multi-project without ever declaring it — a root
  // manifest plus a sibling subdirectory manifest with nothing but a shared
  // checkout tying them together (this repository's own layout: a root
  // `package.json` and an undeclared `extension/package.json`). Those are
  // found the same way a formal workspace member would be, so a scan covers
  // them without being pointed at them by hand.
  const nested = args.dirs ? [] : await discoverNestedProjects(root, fs, declaredMembers).catch(() => []);
  const nestedGitRepos = nested.filter((project) => project.hasOwnGit);
  const undeclaredDirs = nested.filter((project) => !project.hasOwnGit).map((project) => project.dir);

  const dirs = args.dirs ?? [...declaredMembers, ...undeclaredDirs];
  if (workspaces.length > 0 || undeclaredDirs.length > 0) {
    const kinds = [...workspaces.map((w) => w.kind), ...(undeclaredDirs.length > 0 ? ['undeclared'] : [])];
    report(
      'Reading the workspace',
      `${dirs.length} package${dirs.length === 1 ? '' : 's'} · ${kinds.join(', ')}`,
    );
  }

  const { targets, ambiguities } = await discoverTargets(root, dirs, args.managers ?? new Map(), fs);
  if (targets.length === 0) {
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

  const enabled = new Set(config.ecosystems);
  const multiPackage = new Set(targets.map((t) => t.dir)).size > 1;
  const all: ScanDependency[] = [];
  for (const target of targets) {
    if (!enabled.has(target.manager.ecosystem)) continue;
    report('Reading manifest', target.manifestPath);
    all.push(...(await directDependencies(root, target, breadth.includeDev, fs)));
  }

  const deps = breadth.maxPackages > 0 ? all.slice(0, breadth.maxPackages) : all;

  report('Indexing your code', 'Walking source files', 0, deps.length);
  // Repository-wide on purpose: an import that crosses a package boundary is a
  // real edge and the index needs it. Only the impact sites are scoped.
  const files = await walkSourceFiles(root, { members: dirs });
  const index = buildIndex(files);
  report(
    'Indexing your code',
    `${files.length} file${files.length === 1 ? '' : 's'} indexed · ${deps.length} direct dependenc${deps.length === 1 ? 'y' : 'ies'} to check`,
    0,
    deps.length,
  );

  let upToDate = 0;
  let done = 0;
  const candidates: UpgradeCandidate[] = [];
  const unchecked: UncheckedDependency[] = [];

  // Checking a package is almost entirely waiting: a registry request, a
  // changelog fetch, a release-notes call, a type-declaration download. Doing
  // that one package at a time made a scan take as long as the sum of every
  // network round trip in the project. Running several at once turns that sum
  // into something much closer to the slowest one.
  await inParallel(deps, concurrency, async (dep) => {
    if (token?.isCancellationRequested) return;

    report(
      `Checking ${versionSourceLabel(dep.target.manager.ecosystem)}`,
      `${dep.name} (installed ${dep.current})`,
      done,
      deps.length,
    );
    const available = await lookupVersions({
      name: dep.name,
      ecosystem: dep.target.manager.ecosystem,
      current: dep.current,
      range: dep.range,
      ...(githubToken ? { githubToken } : {}),
    });

    if (available.outcome === 'up-to-date') {
      upToDate += 1;
      done += 1;
      report('Up to date', `${dep.name}@${dep.current}`, done, deps.length);
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
      done += 1;
      report('Could not check', `${dep.name}@${dep.current} · ${available.reason}`, done, deps.length);
      return;
    }

    if (token?.isCancellationRequested) return;

    const selected = available.safeLatest ?? available.latest;
    const candidate = await analyzeUpgrade({
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
      files,
      index,
      logger,
      env,
      maxSites: breadth.maxSites,
      member: multiPackage ? dep.target.dir : undefined,
      memberName: memberNames.get(dep.target.dir),
      repoRoot: repoLabel ? root : undefined,
      repoLabel,
      onProgress: (phase, detail) => report(phase, detail, done, deps.length),
    });

    candidates.push(candidate);
    onCandidate?.(candidate);
    done += 1;
    report(
      severityOf(candidate) === 'affected' ? 'Needs your attention' : 'Checked',
      `${candidate.name} ${candidate.current} → ${candidate.selected} · ${describeSeverity(candidate).toLowerCase()}`,
      done,
      deps.length,
    );
  });

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
  const files = await walkSourceFiles(args.root);
  const index = buildIndex(files);

  return analyzeUpgrade({
    dep,
    selected: version,
    member: args.candidate.workspace,
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
    files,
    index,
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
  const command = manager?.upgrade({
    name: candidate.name,
    version: candidate.selected,
    kind: candidate.kind,
  });
  if (!command) return null;

  // `--force` is npm's word for "install it anyway"; nothing else in the table
  // has an equivalent, so forcing elsewhere is just the ordinary command.
  return mode === 'force' && candidate.packageManager === 'npm'
    ? { ...command, args: [...command.args, '--force'] }
    : command;
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
        { name: candidate.name, version: candidate.selected, kind: candidate.kind },
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
  files: Awaited<ReturnType<typeof walkSourceFiles>>;
  index: ReturnType<typeof buildIndex>;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  maxSites?: number;
  /** Workspace member to scope impact sites to. Absent in a single package. */
  member?: string;
  memberName?: string;
  /** Set when scanning more than one open root, so candidate ids stay unique across them. */
  repoRoot?: string;
  repoLabel?: string;
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
    // Prefixed with the root when more than one is open, so two repositories
    // that happen to share a manifest path and a dependency bump never
    // collide in a `Map<id, candidate>` the caller keeps.
    id: `${args.repoRoot ? `${args.repoRoot}::` : ''}${target.manifestPath}#${args.dep.name}@${args.dep.current}->${args.selected}`,
    name: args.dep.name,
    kind: args.dep.kind,
    ecosystem: target.manager.ecosystem,
    packageManager: target.manager.id,
    manifestPath: target.manifestPath,
    ...(args.member === undefined ? {} : { workspace: args.member }),
    ...(args.memberName ? { workspaceName: args.memberName } : {}),
    ...(args.repoRoot ? { repoRoot: args.repoRoot, repoLabel: args.repoLabel } : {}),
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

    const evidence = await gatherEvidence([change], {
      config: args.config,
      logger: args.logger,
      githubToken: args.githubToken,
      env: args.env,
      // Lets the Go provider read this repository's own go.mod, so a missing
      // toolchain is reported with the version this repository actually needs.
      workspaceRoot: args.root,
      onSurfaceComputed: (computedChange, diff) => {
        const key = dependencyEcosystemKey(computedChange);
        surfaceCompared.add(key);
        additions.set(key, { additions: diff.additions ?? [], locator: diff.locator });
      },
      onUnavailableSurface: (unavailableChange, reason) =>
        surfaceGaps.set(dependencyEcosystemKey(unavailableChange), reason),
      onProseConsulted: (proseChange, source) => {
        const key = dependencyEcosystemKey(proseChange);
        prose.set(key, [...(prose.get(key) ?? []), source]);
      },
    });

    report(
      'Comparing the public API surface',
      `${label} · ${evidence.length} evidence source${evidence.length === 1 ? '' : 's'}`,
    );
    const breakingChanges = await analyze([change], evidence, {
      config: args.config,
      logger: args.logger,
    });

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
        ? await resolveModuleMaps([change], { logger: args.logger })
        : undefined;
    const impactSites = localize(breakingChanges, [change], args.index, args.files, {
      logger: args.logger,
      maxSitesPerChange: args.maxSites ?? 40,
      member: args.member,
      ...(moduleMaps ? { moduleMaps } : {}),
    });
    report('Weighing what this upgrade is worth', label);
    const [rationale] = await buildRationale(
      { changes: [change], evidence, breakingChanges, impactSites },
      {
        config: args.config,
        logger: args.logger,
        githubToken: args.githubToken,
        additions,
        surfaceCompared,
        surfaceGaps,
        prose,
      },
    );

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
      risk: 'unknown',
      summary: 'Could not inspect this upgrade',
      gaps: [],
      toolRequests: [],
      error: (err as Error).message,
    };
  }
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
 * The one-line verdict.
 *
 * Written from the developer's point of view, not the registry's: what this
 * upgrade means for *this* repository comes first, and the upstream count is
 * context rather than a headline.
 *
 * It leads with the recommendation, because "Upgrade recommended — fixes a
 * high-severity advisory" and "Safe to upgrade" are different answers to the
 * question actually being asked, and a line that could only ever say what
 * might break was the old, weaker version of this.
 *
 * The failure case is the reason this function is careful. It used to
 * concatenate every gap onto a fixed preamble, which printed the same missing
 * toolchain twice — once as "Drift could not verify this upgrade" and once as
 * the gap that explained it. Gaps arrive deduplicated from the rationale, and
 * the preamble no longer restates them.
 */
function summarize(
  breakingCount: number,
  impactCount: number,
  name: string,
  rationale: UpgradeRationale | undefined,
): string {
  if (!rationale) {
    return breakingCount > 0
      ? `${breakingCount} breaking change${breakingCount === 1 ? '' : 's'} found in ${name}.`
      : `No breaking changes found for this version of ${name}.`;
  }

  const { assessment, security } = rationale;
  const headline = RECOMMENDATION_LABEL[assessment.recommendation];

  const detail: string[] = [];

  if (impactCount > 0) {
    detail.push(
      `${impactCount} place${impactCount === 1 ? '' : 's'} in this repository use${impactCount === 1 ? 's' : ''} an API that ${name} changed`,
    );
  } else if (breakingCount > 0) {
    detail.push(
      `${breakingCount} upstream breaking change${breakingCount === 1 ? '' : 's'}, none of which this repository uses`,
    );
  }

  if (security.checked && security.resolved.length > 0) {
    detail.push(
      `fixes ${security.resolved.length} known ${security.resolved.length === 1 ? 'vulnerability' : 'vulnerabilities'}`,
    );
  }
  if (security.checked && security.introduced.length > 0) {
    detail.push(
      `introduces ${security.introduced.length} known ${security.introduced.length === 1 ? 'vulnerability' : 'vulnerabilities'}`,
    );
  }

  // Said once, at the end, and only when nothing above already carried the
  // news. Repeating a stated gap is the bug this shape exists to prevent.
  if (detail.length === 0 && rationale.gaps.length > 0) {
    return `${headline}. ${rationale.gaps.join(' ')}`;
  }

  if (detail.length === 0) {
    return `${headline}. No breaking changes found for this version of ${name}.`;
  }

  return `${headline}. ${capitalizeFirst(detail.join('; '))}.`;
}

function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One direct dependency, and the manifest and manager it came from. */
export interface ScanDependency {
  name: string;
  kind: DependencyKind;
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
    out.push({ name, kind: entry.kind, current, range: entry.version ?? current, target });
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
  return a.name.localeCompare(b.name);
}

export { describeSeverity, severityOf, type UpgradeSeverity };
