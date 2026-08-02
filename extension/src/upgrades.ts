import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import semver from 'semver';
import type { DependencyChange, DependencyKind, Ecosystem, RemediationPlan, RepoContext } from '../../src/types.js';
import type { DriftConfig } from '../../src/config/schema.js';
import { classifyBump, normalizeVersion } from '../../src/detect/version.js';
import { parserFor } from '../../src/detect/index.js';
import {
  describeCommand,
  detectPackageManagers,
  packageManagerAmbiguities,
  packageManagerById,
  type Command,
  type DetectedPackageManager,
  type PackageManager,
  type PackageManagerAmbiguity,
  type PackageManagerId,
} from '../../src/detect/package-manager.js';
import { fetchRegistryInfo } from '../../src/evidence/registry.js';
import {
  detectWorkspaces,
  memberDirectories,
  type WorkspaceFs,
  type WorkspaceLayout,
} from '../../src/detect/workspace.js';
import { discoverNestedProjects, type NestedProject } from '../../src/detect/nested.js';
import { gatherEvidence } from '../../src/evidence/index.js';
import { buildRationale } from '../../src/rationale/index.js';
import { RECOMMENDATION_LABEL } from '../../src/rationale/assess.js';
import type { UpgradeRationale } from '../../src/rationale/types.js';
import type { SurfaceAddition, SurfaceUnavailable } from '../../src/evidence/surface/types.js';
import type { ProseSource } from '../../src/evidence/index.js';
import { analyze } from '../../src/analyze/index.js';
import { walkSourceFiles } from '../../src/index/walk.js';
import { buildIndex } from '../../src/index/metarag.js';
import { localize } from '../../src/localize/index.js';
import { buildPlan } from '../../src/plan/index.js';
import { createLogger } from '../../src/util/logger.js';
import { compareSeverity, describeSeverity, severityOf, type UpgradeSeverity } from './severity.js';
import { envWithShellPath } from './shell-path.js';

const run = promisify(execFile);

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
   * see `severityOf`.
   */
  gaps: string[];
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

export interface UpgradeScanResult {
  candidates: UpgradeCandidate[];
  checked: number;
  skipped: number;
  /** Which manifests were read, so the UI can say what was covered. */
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

interface NpmPackument {
  versions?: Record<string, unknown>;
  'dist-tags'?: Record<string, string>;
}

/** How widely to look. Comes from the effort picker in the panel composer. */
export interface ScanBreadth {
  /** Include dev, optional and peer dependencies. */
  includeDev: boolean;
  /** Cap on impact sites recorded per breaking change. */
  maxSites: number;
  /** Cap on packages checked. `0` means no cap. */
  maxPackages: number;
}

const DEFAULT_BREADTH: ScanBreadth = { includeDev: false, maxSites: 40, maxPackages: 0 };

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
): Promise<{ targets: EcosystemTarget[]; ambiguities: DirectoryAmbiguity[] }> {
  const targets: EcosystemTarget[] = [];
  const ambiguities: DirectoryAmbiguity[] = [];

  for (const dir of dirs) {
    const absolute = dir ? join(root, dir) : root;
    const entries = await readDirectory(absolute);
    if (entries.length === 0) continue;

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
      const manifest = entry.manager.manifests.find((f) => entries.includes(f));
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

/** The workspace-detection seam, backed by VS Code's own filesystem. */
export function vscodeWorkspaceFs(): WorkspaceFs {
  return {
    readFile: (path) => readText(path),
    readDirectory: (path) => readDirectory(path),
    async isDirectory(path) {
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(path));
        return stat.type === vscode.FileType.Directory;
      } catch {
        return false;
      }
    },
  };
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

export async function scanUpgrades(args: {
  root: string;
  repo: RepoContext;
  config: DriftConfig;
  githubToken?: string;
  breadth?: ScanBreadth;
  /** Directories to scan. Defaults to the workspace root alone. */
  dirs?: readonly string[];
  managers?: ManagerPreferences;
  onProgress?: (progress: ScanProgress) => void;
  /** Called as soon as each package resolves, so the UI can fill in gradually. */
  onCandidate?: (candidate: UpgradeCandidate) => void;
  token?: { isCancellationRequested: boolean };
  /** Stamped onto every candidate — set when scanning more than one open root. */
  repoLabel?: string;
}): Promise<UpgradeScanResult> {
  const { root, repo, config, githubToken, onProgress, onCandidate, token, repoLabel } = args;
  const breadth = args.breadth ?? DEFAULT_BREADTH;
  const logger = createLogger(vscode.workspace.getConfiguration('drift').get('logLevel', 'info'));

  const report = (phase: string, detail: string, done = 0, total = 0) =>
    onProgress?.({ phase, detail, done, total });

  report('Looking for manifests', root);
  // A monorepo is many packages sharing a checkout. Each member is scanned as
  // itself: its own manifest, its own package manager, its own impact sites.
  const workspaces = args.dirs ? [] : await detectWorkspaces(root, vscodeWorkspaceFs());
  const declaredMembers = memberDirectories(workspaces);

  // A repository can be multi-project without ever declaring it — a root
  // manifest plus a sibling subdirectory manifest with nothing but a shared
  // checkout tying them together (this repository's own layout: a root
  // `package.json` and an undeclared `extension/package.json`). Those are
  // found the same way a formal workspace member would be, so `/scan` covers
  // them without the user having to point Drift at them by hand.
  const nested = args.dirs
    ? []
    : await discoverNestedProjects(root, vscodeWorkspaceFs(), declaredMembers).catch(() => []);
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

  const { targets, ambiguities } = await discoverTargets(root, dirs, args.managers ?? new Map());
  if (targets.length === 0) {
    return { candidates: [], checked: 0, skipped: 0, targets, workspaces, ambiguities, nestedGitRepos };
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
    all.push(...(await directDependencies(root, target, breadth.includeDev)));
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

  let skipped = 0;
  let done = 0;
  const candidates: UpgradeCandidate[] = [];

  // Checking a package is almost entirely waiting: a registry request, a
  // changelog fetch, a release-notes call, a type-declaration download. Doing
  // that one package at a time made a scan take as long as the sum of every
  // network round trip in the project. Running several at once turns that sum
  // into something much closer to the slowest one.
  await inParallel(deps, concurrency(), async (dep) => {
    if (token?.isCancellationRequested) return;

    report(
      `Checking the ${registryLabel(dep.target.manager.ecosystem)}`,
      `${dep.name} (installed ${dep.current})`,
      done,
      deps.length,
    );
    const available = await availableVersions(dep, dep.current, dep.range).catch(() => null);

    if (!available || available.versions.length === 0) {
      skipped += 1;
      done += 1;
      report('Up to date', `${dep.name}@${dep.current}`, done, deps.length);
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
    skipped,
    targets,
    workspaces,
    ambiguities,
    nestedGitRepos,
  };
}

/**
 * How many packages to check at once.
 *
 * High enough that a fifty-dependency project finishes in the time a developer
 * will actually wait, low enough to stay a polite client of the npm registry and
 * the GitHub API — the unauthenticated GitHub rate limit is the real ceiling
 * here, and blowing through it turns evidence into "could not check", which is
 * worse than being slower.
 */
function concurrency(): number {
  const configured = vscode.workspace.getConfiguration('drift').get<number>('analysis.concurrency', 8);
  return Math.max(1, Math.min(16, Math.floor(configured) || 8));
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
  githubToken?: string;
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
  const logger = createLogger(vscode.workspace.getConfiguration('drift').get('logLevel', 'info'));

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
    const available = await availableVersions(dep, dep.current, dep.range).catch(() => null);
    if (available && available.versions.length > 0) {
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
    logger,
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

/** What Drift will run for this upgrade, so the UI can show it before running it. */
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

export async function installUpgrade(
  root: string,
  candidate: UpgradeCandidate,
  mode: 'safe' | 'force' = 'safe',
): Promise<void> {
  const command = plannedUpgrade(candidate, mode);
  if (!command) throw new NoUpgradeCommandError(candidate);

  const cwd = dirname(join(root, candidate.manifestPath));
  const env = await envWithShellPath();
  try {
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
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${command.command} was not found. Drift asked your login shell for its PATH and checked common toolchain ` +
          `manager directories directly, and still came up empty. This usually means ${command.command} ` +
          `is installed under a different $HOME than VS Code sees (common with sudo/root installs, or a devcontainer ` +
          `mismatch), or genuinely isn't installed for this user. Run \`command -v ${command.command}\` in a plain ` +
          `terminal — if that also comes back empty, install ${command.command}; if it finds one, restart VS Code from ` +
          `that same terminal (\`code .\`) so it inherits the same PATH.`,
      );
    }
    throw err;
  }
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
  logger: ReturnType<typeof createLogger>;
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
    // collide in the `Map<id, candidate>` the panel keeps.
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
    // Passed in, never recomputed here: `args.versions` is the list the picker
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
    const toolEnv = await envWithShellPath();

    // Every reason this check came up short. `gatherEvidence` has always known
    // when it could not compute an API surface; until now nothing asked, so a
    // dependency Drift was unable to read looked exactly like one it had read
    // and cleared.
    const additions = new Map<string, { additions: SurfaceAddition[]; locator: string }>();
    const surfaceGaps = new Map<string, SurfaceUnavailable>();
    const prose = new Map<string, ProseSource[]>();

    const evidence = await gatherEvidence([change], {
      config: args.config,
      logger: args.logger,
      githubToken: args.githubToken,
      env: toolEnv,
      // Lets the Go provider read this repository's own go.mod, so a missing
      // toolchain is reported with the version this repository actually needs.
      workspaceRoot: args.root,
      onSurfaceComputed: (_change, diff) =>
        additions.set(change.name, { additions: diff.additions ?? [], locator: diff.locator }),
      onUnavailableSurface: (_change, reason) => surfaceGaps.set(change.name, reason),
      onProseConsulted: (_change, source) =>
        prose.set(change.name, [...(prose.get(change.name) ?? []), source]),
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
    const impactSites = localize(breakingChanges, [change], args.index, args.files, {
      logger: args.logger,
      maxSitesPerChange: args.maxSites ?? 40,
      member: args.member,
    });
    report('Weighing what this upgrade is worth', label);
    const [rationale] = await buildRationale(
      { changes: [change], evidence, breakingChanges, impactSites },
      {
        config: args.config,
        logger: args.logger,
        githubToken: args.githubToken,
        additions,
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
      error: (err as Error).message,
    };
  }
}

/**
 * The one-line verdict.
 *
 * Written from the developer's point of view, not the registry's: what this
 * upgrade means for *this* repository comes first, and the upstream count is
 * context rather than a headline.
 *
 * It now leads with the recommendation, because "Upgrade recommended — fixes a
 * high-severity advisory" and "Safe to upgrade" are different answers to the
 * question actually being asked, and the old line could only ever say what
 * might break.
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
interface ScanDependency {
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
 */
async function directDependencies(
  root: string,
  target: EcosystemTarget,
  includeDev: boolean,
): Promise<ScanDependency[]> {
  const parser = parserFor(target.manifestPath);
  const content = await readText(join(root, target.manifestPath));
  if (!parser || content === null) return [];

  const declared = parser.parse(content, target.manifestPath);

  const lockContent = target.lockfilePath ? await readText(join(root, target.lockfilePath)) : null;
  const locked =
    lockContent !== null && target.lockfilePath
      ? parserFor(target.lockfilePath)?.parse(lockContent, target.lockfilePath)
      : undefined;

  // Runtime dependencies are what ship, so they are always checked. The rest are
  // opt-in: a broken test helper is a nuisance, a broken runtime import is an
  // outage, and mixing the two dilutes the signal.
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

/**
 * Newer published versions of one package.
 *
 * npm is special-cased for its `dist-tags`, which is the only registry that
 * tells us which version the maintainer considers current rather than merely
 * highest. Everywhere else the highest stable version is the best available
 * answer, and prereleases are excluded so a scan never proposes an alpha.
 */
async function availableVersions(
  dep: ScanDependency,
  current: string,
  range: string,
): Promise<{ latest: string; safeLatest?: string; latestMinor?: string; versions: string[] } | null> {
  const published =
    dep.target.manager.ecosystem === 'npm'
      ? await npmVersions(dep.name)
      : await registryVersions(dep.name, dep.target.manager.ecosystem);
  if (!published) return null;

  const newer = published.versions
    .map((raw) => normalizeVersion(raw))
    .filter((version): version is string => Boolean(version))
    .filter((version) => semver.gt(version, current))
    .sort(semver.rcompare);

  const latest = published.latest ?? newer.find((v) => !semver.prerelease(v)) ?? newer[0];
  if (!latest || !semver.gt(latest, current)) return null;

  // Computed over every published version, never over the truncated list the
  // picker shows: `maxSatisfying` of the twenty newest releases of a busy
  // package is `null` for anything still on the previous major, which left
  // `safeLatest` undefined precisely where it mattered most.
  const safe = safeLatest(newer, current, range);

  // Prereleases are noise unless the developer is already on one. Twenty
  // versions of zod came back as one release and nine canaries, with no 3.x in
  // sight — the safe upgrade was not merely hard to find, it was not on the
  // list. The in-range version is now pinned into the picker by construction.
  const onPrerelease = Boolean(semver.prerelease(current));
  const stable = newer.filter((version) => onPrerelease || !semver.prerelease(version));

  const withinMajor = latestWithinMajor(stable, current);

  const versions = [...new Set([latest, ...(safe ? [safe] : []), ...(withinMajor ? [withinMajor] : []), ...stable.slice(0, 18)])]
    .filter((version) => semver.gt(version, current))
    .sort(semver.rcompare);

  return { latest, safeLatest: safe, latestMinor: withinMajor, versions };
}

/**
 * The newest release that does not cross a major boundary.
 *
 * Distinct from `safeLatest`, which is bounded by the range the manifest
 * declares: a caret range on `4.2.0` stops at the 4.x line *and* at whatever
 * the developer pinned, so a repository pinned to `4.2.0` exactly has no safe
 * upgrade at all while 4.9.0 sits published and compatible. This is the target
 * a developer means by "update it, but don't put me on the next major".
 *
 * Returns undefined when the only thing ahead is a major bump — in which case
 * offering the button would be offering a choice that does not exist.
 */
function latestWithinMajor(versions: readonly string[], current: string): string | undefined {
  const parsed = semver.parse(current);
  if (!parsed) return undefined;

  return versions
    .filter((version) => {
      const next = semver.parse(version);
      return next !== null && next.major === parsed.major && semver.gt(version, current);
    })
    .sort(semver.rcompare)[0];
}

async function npmVersions(name: string): Promise<{ latest: string | null; versions: string[] } | null> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`, {
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) return null;

  const packument = (await response.json()) as NpmPackument;
  return {
    latest: normalizeVersion(packument['dist-tags']?.latest),
    versions: Object.keys(packument.versions ?? {}),
  };
}

async function registryVersions(
  name: string,
  ecosystem: Ecosystem,
): Promise<{ latest: string | null; versions: string[] } | null> {
  const info = await fetchRegistryInfo(name, ecosystem, null);
  if (!info) return null;
  // No registry outside npm publishes a "current" tag, so the caller derives
  // one from the version list rather than inventing an authority for it.
  return { latest: null, versions: info.versions };
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

function registryLabel(ecosystem: Ecosystem): string {
  switch (ecosystem) {
    case 'npm':
      return 'npm registry';
    case 'pypi':
      return 'PyPI';
    case 'cargo':
      return 'crates.io';
    case 'go':
      return 'Go module proxy';
    case 'maven':
      return 'Maven Central';
    case 'rubygems':
      return 'RubyGems';
  }
}

function safeLatest(versions: readonly string[], current: string, range: string): string | undefined {
  const candidates = versions.filter((version) => semver.gt(version, current));
  const validRange = semver.validRange(range);
  if (validRange) {
    const matched = semver.maxSatisfying(candidates, validRange);
    if (matched) return matched;
  }

  const parsed = semver.parse(current);
  if (!parsed) return undefined;

  const sameCompatibilityBand = candidates.filter((version) => {
    const next = semver.parse(version);
    if (!next) return false;
    if (parsed.major === 0) {
      return next.major === 0 && next.minor === parsed.minor;
    }
    return next.major === parsed.major;
  });

  return semver.maxSatisfying(sameCompatibilityBand, '*') ?? undefined;
}

async function readText(path: string): Promise<string | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return null;
  }
}

async function readDirectory(path: string): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path));
    return entries.map(([name]) => name);
  } catch {
    return [];
  }
}

/**
 * Synchronous peek, for the one caller that needs content during detection.
 *
 * Telling yarn classic from berry means reading `yarn.lock`'s header, and the
 * detector is a pure function over a listing rather than an async walk.
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
