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
  UpgradeCandidate,
  UpgradeScanResult,
  UpgradeStatus,
} from '../../src/upgrade/scan.js';
import { envWithShellPath } from './shell-path.js';
import { auditCurrentUsage, type AuditResult } from '../../src/audit/index.js';

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

function scanLogger() {
  return createLogger(vscode.workspace.getConfiguration('drift').get('logLevel', 'info'));
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
  return vscode.workspace.getConfiguration('drift').get<number>('analysis.concurrency', 8);
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
  token?: { isCancellationRequested: boolean };
  repoLabel?: string;
}): Promise<UpgradeScanResult> {
  return core.scanUpgrades({
    ...args,
    logger: scanLogger(),
    fs: vscodeWorkspaceFs(),
    env: await envWithShellPath(),
    concurrency: concurrency(),
  });
}

/**
 * The present-tense check, run over the workspace as it stands.
 *
 * Sits beside `scanUpgrades` because the two answer opposite halves of the
 * same question and a developer wants both from one press: the scan says what
 * would break if you moved forward, this says what is broken where you are.
 * The versions come from the manifest and lockfile already in the checkout, so
 * unlike the scan it needs no registry round trip per package to get started.
 */
export async function auditInstalled(args: {
  root: string;
  repo: RepoContext;
  config: DriftConfig;
  githubToken?: string;
  includeDev?: boolean;
  onProgress?: (phase: string, detail: string, done: number, total: number) => void;
  token?: { isCancellationRequested: boolean };
}): Promise<AuditResult> {
  return auditCurrentUsage({
    ...args,
    logger: scanLogger(),
    fs: vscodeWorkspaceFs(),
    env: await envWithShellPath(),
    concurrency: concurrency(),
    maxSites: args.config.audit.maxSites,
    maxPackages: args.config.audit.maxPackages,
    includeDev: args.includeDev ?? args.config.audit.includeDev,
  });
}

export type { AuditResult };

export async function reanalyzeUpgrade(args: {
  candidate: UpgradeCandidate;
  version: string;
  root: string;
  repo: RepoContext;
  config: DriftConfig;
  githubToken?: string;
  refreshVersions?: boolean;
  onProgress?: (phase: string, detail: string) => void;
}): Promise<UpgradeCandidate> {
  return core.reanalyzeUpgrade({
    ...args,
    logger: scanLogger(),
    fs: vscodeWorkspaceFs(),
    env: await envWithShellPath(),
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
