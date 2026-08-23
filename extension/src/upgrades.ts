import * as vscode from 'vscode';
import type { RepoContext } from '../../src/types.js';
import type { DriftConfig } from '../../src/config/schema.js';
import type { WorkspaceFs } from '../../src/detect/workspace.js';
import { createLogger } from '../../src/util/logger.js';
import * as core from '../../src/upgrade/scan.js';
import type {
  DirectoryAmbiguity,
  EcosystemTarget,
  ManagerPreferences,
  ScanBreadth,
  ScanProgress,
  UncheckedDependency,
  UpgradeCandidate,
  UpgradeScanResult,
  UpgradeStatus,
} from '../../src/upgrade/scan.js';
// Re-exported so callers (and the benchmark suite) share one source for the
// panel's Quick Scan breadth rather than hand-copying the number — see the
// constant's own doc comment in `src/upgrade/scan.ts`.
export { QUICK_SCAN_MAX_SITES } from '../../src/upgrade/scan.js';
import { envWithShellPath } from './shell-path.js';

/**
 * The extension's half of dependency scanning: everything that actually needs
 * VS Code — its virtual filesystem (so a remote/SSH/Codespaces workspace works
 * the same as a local one), its settings, and its PATH-corrected environment.
 *
 * The scan itself — walking manifests, querying registries, running the
 * breaking-change pipeline on every outdated package — lives in
 * `src/upgrade/scan.js`, shared with the CLI's `drift outdated` so both
 * surfaces answer "what upgrades are available" identically.
 */

export type {
  DirectoryAmbiguity,
  EcosystemTarget,
  ManagerPreferences,
  ScanBreadth,
  ScanProgress,
  UncheckedDependency,
  UpgradeCandidate,
  UpgradeScanResult,
  UpgradeStatus,
};

export const ambiguityKey = core.ambiguityKey;
export const upgradeCommandFor = core.upgradeCommandFor;
export const NoUpgradeCommandError = core.NoUpgradeCommandError;
export const describeSeverity = core.describeSeverity;
export const severityOf = core.severityOf;
export type { UpgradeSeverity } from '../../src/upgrade/severity.js';

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

/**
 * A scan-time logger, mirrored to the visible "Drift" output channel when one
 * is given.
 *
 * `createLogger` alone writes to `console.log`, which lands in the Extension
 * Host devtools console — somewhere no developer looks in normal use. That
 * made a scan's own actions (installing a missing helper, a toolchain
 * command failing) invisible: a gap that only reads as prose (e.g. "the
 * helper is missing") gives no sign of what was actually tried, or why it
 * didn't work. `warn`/`error` mirror there always, since either means
 * something the developer should be able to see; `info` mirrors only for the
 * helper-install path, which is the one case a developer watches happen.
 */
function scanLogger(output?: vscode.LogOutputChannel) {
  const base = createLogger(vscode.workspace.getConfiguration('drift').get('logLevel', 'info'));
  if (!output) return base;
  return {
    ...base,
    info: (msg: string, meta?: unknown) => {
      base.info(msg, meta);
      if (/install/i.test(msg)) output.info(msg);
    },
    warn: (msg: string, meta?: unknown) => {
      base.warn(msg, meta);
      output.warn(msg);
    },
    error: (msg: string, meta?: unknown) => {
      base.error(msg, meta);
      output.error(msg);
    },
  };
}

/**
 * Where measured baselines are kept, set once at activation.
 *
 * Under the extension's own global storage rather than `~/.drift`, so
 * uninstalling takes it with it — the same place the HTTP evidence cache lives.
 */
let baselineCacheDir: string | null = null;

export function configureBaselineCache(dir: string | null): void {
  baselineCacheDir = dir;
}

/**
 * How many packages to analyse at once, or `undefined` to let the core size it
 * from the machine.
 *
 * `0` is the default and means "you decide" — see `src/util/parallelism.ts`.
 * The setting used to default to a literal 8, which was the same number on a
 * two-core laptop and a workstation and wrong on both.
 */
function concurrency(): number | undefined {
  const configured = vscode.workspace.getConfiguration('drift').get<number>('analysis.concurrency', 0);
  return configured > 0 ? configured : undefined;
}

/**
 * Every directory the scan will read, through VS Code's own filesystem so a
 * remote/SSH/Codespaces workspace answers the same as a local one.
 */
export async function scanDirectories(root: string): Promise<string[]> {
  return core.scanDirectories(root, vscodeWorkspaceFs());
}

export async function discoverTargets(
  root: string,
  dirs: readonly string[] = [''],
  preferences: ManagerPreferences = new Map(),
): Promise<{ targets: EcosystemTarget[]; ambiguities: DirectoryAmbiguity[] }> {
  return core.discoverTargets(root, dirs, preferences, vscodeWorkspaceFs());
}

export async function scanUpgrades(args: {
  root: string;
  repo: RepoContext;
  config: DriftConfig;
  githubToken?: string;
  breadth?: ScanBreadth;
  dirs?: readonly string[];
  managers?: ManagerPreferences;
  onProgress?: (progress: ScanProgress) => void;
  onCandidate?: (candidate: UpgradeCandidate) => void;
  onDropped?: (id: string) => void;
  token?: { isCancellationRequested: boolean };
  repoLabel?: string;
  output?: vscode.LogOutputChannel;
  /**
   * Defaults to `{ enabled: false }` — Quick Scan. Deep Verification runs
   * separately, on demand, via `verifyUpgradeCandidates`.
   */
  verify?: { enabled?: boolean };
}): Promise<UpgradeScanResult> {
  const limit = concurrency();
  return core.scanUpgrades({
    ...args,
    logger: scanLogger(args.output),
    fs: vscodeWorkspaceFs(),
    env: await envWithShellPath(),
    ...(limit === undefined ? {} : { concurrency: limit }),
    verify: {
      enabled: false,
      ...args.verify,
      // Scanning the same commit twice — which the panel's refresh button does
      // constantly — used to re-run the project's whole typecheck, build and
      // test suite each time just to re-establish what was already green.
      ...(baselineCacheDir ? { baselineCache: core.createBaselineCache(baselineCacheDir) } : {}),
    },
  });
}

export async function reanalyzeUpgrade(args: {
  candidate: UpgradeCandidate;
  version: string;
  root: string;
  repo: RepoContext;
  config: DriftConfig;
  githubToken?: string;
  refreshVersions?: boolean;
  onProgress?: (phase: string, detail: string) => void;
  output?: vscode.LogOutputChannel;
}): Promise<UpgradeCandidate> {
  return core.reanalyzeUpgrade({
    ...args,
    logger: scanLogger(args.output),
    fs: vscodeWorkspaceFs(),
    env: await envWithShellPath(),
  });
}

/**
 * Deep Verification, on its own: install one or more already-scanned
 * candidates in a throwaway worktree and run this project's own checks
 * against them, without repeating the scan that produced them.
 *
 * This is what "Deep Verify" (one row) and "Deep Verify All" call — the panel's Quick
 * Scan already ran with verification off, so this is the only place in the
 * extension that creates a worktree, installs anything, or runs a project's
 * own typecheck/build/test for the dependency-scan flow.
 */
export async function verifyUpgradeCandidates(args: {
  root: string;
  candidates: UpgradeCandidate[];
  config: DriftConfig;
  token?: { isCancellationRequested: boolean };
  onProgress?: (progress: ScanProgress) => void;
  onCandidate?: (candidate: UpgradeCandidate) => void;
  output?: vscode.LogOutputChannel;
}): Promise<void> {
  return core.verifyUpgradeCandidates({
    root: args.root,
    candidates: args.candidates,
    checks: args.config.verify.checks,
    timeoutMs: args.config.verify.timeoutMs,
    ...(args.config.verify.generatedSourceGlobs.length > 0
      ? { generatedSourceGlobs: args.config.verify.generatedSourceGlobs }
      : {}),
    ...(baselineCacheDir ? { baselineCache: core.createBaselineCache(baselineCacheDir) } : {}),
    env: await envWithShellPath(),
    logger: scanLogger(args.output),
    ...(args.token ? { token: args.token } : {}),
    ...(args.onProgress ? { onProgress: args.onProgress } : {}),
    ...(args.onCandidate ? { onCandidate: args.onCandidate } : {}),
  });
}

export async function installUpgrade(
  root: string,
  candidate: UpgradeCandidate,
  mode: 'safe' | 'force' = 'safe',
): Promise<void> {
  return core.installUpgrade(root, candidate, mode, await envWithShellPath());
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
