import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import semver from 'semver';
import type { DependencyChange, DependencyKind, RemediationPlan, RepoContext } from '../../src/types.js';
import type { DriftConfig } from '../../src/config/schema.js';
import { classifyBump, normalizeVersion } from '../../src/detect/version.js';
import { gatherEvidence } from '../../src/evidence/index.js';
import { analyze } from '../../src/analyze/index.js';
import { walkSourceFiles } from '../../src/index/walk.js';
import { buildIndex } from '../../src/index/metarag.js';
import { localize } from '../../src/localize/index.js';
import { buildPlan } from '../../src/plan/index.js';
import { createLogger } from '../../src/util/logger.js';
import { compareSeverity, describeSeverity, severityOf, type UpgradeSeverity } from './severity.js';

const run = promisify(execFile);

export type UpgradeStatus = 'checking' | 'ready' | 'clean' | 'error' | 'upgrading';

export interface UpgradeCandidate {
  id: string;
  name: string;
  kind: DependencyKind;
  manifestPath: string;
  current: string;
  range: string;
  safeLatest?: string;
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
  plan?: RemediationPlan;
  error?: string;
}

export interface UpgradeScanResult {
  candidates: UpgradeCandidate[];
  checked: number;
  skipped: number;
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

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
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

export async function scanNpmUpgrades(args: {
  root: string;
  repo: RepoContext;
  config: DriftConfig;
  githubToken?: string;
  breadth?: ScanBreadth;
  onProgress?: (progress: ScanProgress) => void;
  /** Called as soon as each package resolves, so the UI can fill in gradually. */
  onCandidate?: (candidate: UpgradeCandidate) => void;
  token?: { isCancellationRequested: boolean };
}): Promise<UpgradeScanResult> {
  const { root, repo, config, githubToken, onProgress, onCandidate, token } = args;
  const breadth = args.breadth ?? DEFAULT_BREADTH;
  const logger = createLogger(vscode.workspace.getConfiguration('drift').get('logLevel', 'info'));

  const report = (phase: string, detail: string, done = 0, total = 0) =>
    onProgress?.({ phase, detail, done, total });

  report('Reading manifest', 'package.json');
  const manifest = await readJson<PackageJson>(join(root, 'package.json'));
  if (!manifest) return { candidates: [], checked: 0, skipped: 0 };

  const lock = await readJson<{ packages?: Record<string, { version?: string }> }>(
    join(root, 'package-lock.json'),
  );

  const all = directDependencies(manifest, lock, breadth.includeDev);
  const deps = breadth.maxPackages > 0 ? all.slice(0, breadth.maxPackages) : all;

  report('Indexing your code', 'Walking source files', 0, deps.length);
  const files = await walkSourceFiles(root);
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

  for (const dep of deps) {
    if (token?.isCancellationRequested) break;

    report('Checking npm registry', `${dep.name} (installed ${dep.current})`, done, deps.length);
    const available = await availableVersions(dep.name, dep.current, dep.range).catch(() => null);

    if (!available || available.versions.length === 0) {
      skipped += 1;
      done += 1;
      report('Up to date', `${dep.name}@${dep.current}`, done, deps.length);
      continue;
    }

    const selected = available.safeLatest ?? available.latest;
    const candidate = await analyzeUpgrade({
      dep,
      selected,
      versions: available.versions,
      latest: available.latest,
      repo,
      config,
      githubToken,
      root,
      files,
      index,
      logger,
      maxSites: breadth.maxSites,
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
  }

  return {
    candidates: candidates.sort(compareCandidates),
    checked: deps.length,
    skipped,
  };
}

export async function reanalyzeUpgrade(args: {
  candidate: UpgradeCandidate;
  version: string;
  root: string;
  repo: RepoContext;
  config: DriftConfig;
  githubToken?: string;
  onProgress?: (phase: string, detail: string) => void;
}): Promise<UpgradeCandidate> {
  const logger = createLogger(vscode.workspace.getConfiguration('drift').get('logLevel', 'info'));
  args.onProgress?.('Indexing your code', `Re-checking ${args.candidate.name}@${args.version}`);
  const files = await walkSourceFiles(args.root);
  const index = buildIndex(files);

  return analyzeUpgrade({
    dep: {
      name: args.candidate.name,
      kind: args.candidate.kind,
      current: args.candidate.current,
      manifestPath: args.candidate.manifestPath,
      range: args.candidate.range,
    },
    selected: args.version,
    versions: args.candidate.versions,
    latest: args.candidate.latest,
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

export async function installNpmUpgrade(root: string, candidate: UpgradeCandidate): Promise<void> {
  const packageSpec = `${candidate.name}@${candidate.selected}`;
  const cwd = dirname(join(root, candidate.manifestPath));
  const args = ['install', packageSpec];
  if (candidate.kind === 'dev') args.push('--save-dev');
  if (candidate.kind === 'optional') args.push('--save-optional');
  await run('npm', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}

export async function installNpmForcedUpgrade(root: string, candidate: UpgradeCandidate): Promise<void> {
  const packageSpec = `${candidate.name}@${candidate.latest}`;
  const cwd = dirname(join(root, candidate.manifestPath));
  const args = ['install', packageSpec, '--force'];
  if (candidate.kind === 'dev') args.push('--save-dev');
  if (candidate.kind === 'optional') args.push('--save-optional');
  await run('npm', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}

async function analyzeUpgrade(args: {
  dep: { name: string; kind: DependencyKind; current: string; manifestPath: string; range: string };
  selected: string;
  versions: string[];
  latest: string;
  repo: RepoContext;
  config: DriftConfig;
  githubToken?: string;
  root: string;
  files: Awaited<ReturnType<typeof walkSourceFiles>>;
  index: ReturnType<typeof buildIndex>;
  logger: ReturnType<typeof createLogger>;
  maxSites?: number;
  onProgress?: (phase: string, detail: string) => void;
}): Promise<UpgradeCandidate> {
  const label = `${args.dep.name} ${args.dep.current} → ${args.selected}`;
  const report = args.onProgress ?? (() => undefined);

  const change: DependencyChange = {
    name: args.dep.name,
    ecosystem: 'npm',
    from: args.dep.current,
    to: args.selected,
    kind: args.dep.kind,
    bump: classifyBump(args.dep.current, args.selected),
    manifestPath: args.dep.manifestPath,
    rawFrom: args.dep.current,
    rawTo: args.selected,
  };

  try {
    report('Reading release notes and changelog', label);
    const evidence = await gatherEvidence([change], {
      config: args.config,
      logger: args.logger,
      githubToken: args.githubToken,
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
    });
    const plan = buildPlan({
      repo: args.repo,
      config: args.config,
      changes: [change],
      evidence,
      breakingChanges,
      impactSites,
    });

    return {
      id: `${args.dep.name}@${args.dep.current}->${args.selected}`,
      name: args.dep.name,
      kind: args.dep.kind,
      manifestPath: args.dep.manifestPath,
      current: args.dep.current,
      range: args.dep.range,
      safeLatest: safeLatest(args.versions, args.dep.current, args.dep.range),
      selected: args.selected,
      latest: args.latest,
      versions: args.versions,
      status: breakingChanges.length > 0 ? 'ready' : 'clean',
      evidenceCount: evidence.length,
      breakingCount: breakingChanges.length,
      impactCount: impactSites.length,
      impactFiles: new Set(impactSites.map((site) => site.file)).size,
      risk: plan.risk,
      summary: summarize(breakingChanges.length, impactSites.length, args.dep.name),
      plan,
    };
  } catch (err) {
    return {
      id: `${args.dep.name}@${args.dep.current}->${args.selected}`,
      name: args.dep.name,
      kind: args.dep.kind,
      manifestPath: args.dep.manifestPath,
      current: args.dep.current,
      range: args.dep.range,
      safeLatest: safeLatest(args.versions, args.dep.current, args.dep.range),
      selected: args.selected,
      latest: args.latest,
      versions: args.versions,
      status: 'error',
      evidenceCount: 0,
      breakingCount: 0,
      impactCount: 0,
      impactFiles: 0,
      risk: 'unknown',
      summary: 'Could not inspect this upgrade',
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
 */
function summarize(breakingCount: number, impactCount: number, name: string): string {
  if (breakingCount === 0) {
    return `No breaking changes found for this version of ${name}.`;
  }
  if (impactCount === 0) {
    return `${breakingCount} breaking change${breakingCount === 1 ? '' : 's'} in ${name}, but this repository does not use any of the affected APIs. Safe to upgrade.`;
  }
  return `${impactCount} place${impactCount === 1 ? '' : 's'} in this repository use${impactCount === 1 ? 's' : ''} an API that ${name} changed.`;
}

function directDependencies(
  manifest: PackageJson,
  lock: { packages?: Record<string, { version?: string }> } | null,
  includeDev: boolean,
): { name: string; kind: DependencyKind; current: string; manifestPath: string; range: string }[] {
  // Runtime dependencies are what ship, so they are always checked. The rest are
  // opt-in: a broken test helper is a nuisance, a broken runtime import is an
  // outage, and mixing the two dilutes the signal.
  const sections: [keyof PackageJson, DependencyKind][] = includeDev
    ? [
        ['dependencies', 'runtime'],
        ['devDependencies', 'dev'],
        ['optionalDependencies', 'optional'],
        ['peerDependencies', 'peer'],
      ]
    : [['dependencies', 'runtime']];

  const out: { name: string; kind: DependencyKind; current: string; manifestPath: string; range: string }[] = [];
  const seen = new Set<string>();

  for (const [section, kind] of sections) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (seen.has(name)) continue;
      seen.add(name);

      const locked = lock?.packages?.[`node_modules/${name}`]?.version;
      const current = normalizeVersion(locked ?? range);
      if (!current) continue;
      out.push({ name, kind, current, manifestPath: 'package.json', range });
    }
  }

  return out;
}

async function availableVersions(
  name: string,
  current: string,
  range: string,
): Promise<{ latest: string; safeLatest?: string; versions: string[] } | null> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) return null;

  const packument = (await response.json()) as NpmPackument;
  const latest = normalizeVersion(packument['dist-tags']?.latest);
  if (!latest || !semver.gt(latest, current)) return null;

  const versions = Object.keys(packument.versions ?? {})
    .map((raw) => normalizeVersion(raw))
    .filter((version): version is string => Boolean(version))
    .filter((version) => semver.gt(version, current))
    .sort(semver.rcompare);

  const choices = [latest, ...versions].filter((version, index, all) => all.indexOf(version) === index);
  return { latest, safeLatest: safeLatest(choices, current, range), versions: choices.slice(0, 20) };
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

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
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
