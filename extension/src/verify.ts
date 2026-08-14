import * as vscode from 'vscode';
import type { CheckKind, LocalCheck } from '../../src/detect/checks.js';
import {
  availableChecks as coreAvailableChecks,
  describeOutcomes,
  runChecks as coreRunChecks,
  unrunReasons,
  type CheckOutcome,
  type CheckStatus,
} from '../../src/verification/checks.js';
import { envWithShellPath } from './shell-path.js';

/**
 * Local verification, after an agent has edited the tree.
 *
 * The honest question after a fix is not whether Drift believes it, but whether
 * the project's own toolchain still passes. That answer already exists in every
 * repository, costs nothing, and reaches no network — which makes it the
 * strongest signal Drift can put in front of a reviewer without asking them to
 * read every line.
 *
 * A failure never blocks Keep. It is shown next to the group it belongs to and
 * the decision stays with the human, which is the same shape as every other
 * guardrail here: downgrade the confidence, never remove the choice.
 *
 * The running itself is core (`src/verification/checks.ts`), because the scan
 * now runs the same checks against an upgrade installed in a worktree, and the
 * GitHub Action needs them too. What stays here is the two things only an
 * editor knows: which filesystem to read, and why a command it cannot find is
 * probably still installed.
 */

export type { CheckStatus, CheckOutcome };
export { describeOutcomes, unrunReasons };

/**
 * Which checks this directory offers.
 *
 * Scoped to the workspace member that owns the edited files, so a monorepo runs
 * the affected package's tests rather than the whole repository's.
 */
export async function availableChecks(root: string, dir = ''): Promise<LocalCheck[]> {
  return coreAvailableChecks(root, dir, vscodeFs);
}

export interface RunChecksOptions {
  root: string;
  /** Workspace member directory the checks run in. */
  dir?: string;
  checks: readonly LocalCheck[];
  token?: vscode.CancellationToken;
  onProgress?: (check: LocalCheck, index: number, total: number) => void;
  /** Called as each check finishes, so a caller can report it while the rest run. */
  onResult?: (outcome: CheckOutcome, index: number, total: number) => void;
  timeoutMs?: number;
}

/**
 * Run each check in order, stopping at nothing.
 *
 * A failing typecheck is not a reason to skip the tests: a reviewer deciding
 * whether to keep an edit wants the whole picture, and "we stopped after the
 * first red" hides the case where the type error is trivial and the tests are
 * fine.
 */
export async function runChecks(options: RunChecksOptions): Promise<CheckOutcome[]> {
  // The same PATH the upgrade itself runs with. A GUI-launched VS Code inherits
  // the login environment, not the interactive shell's, so `npm` installed by
  // nvm, volta, fnm, or asdf is invisible to a bare `execFile` — which turned
  // every check into "not run" immediately after an upgrade that had just used
  // that very same npm successfully.
  const env = await envWithShellPath();

  return coreRunChecks({
    ...options,
    env,
    notFoundReason: (command) =>
      `\`${command}\` was not found. Drift asked your login shell for its PATH and looked in nvm, volta, fnm and asdf's install directories, and still could not find it. Run \`command -v ${command}\` in a terminal — if that finds one, restart VS Code from that terminal so it inherits the same PATH.`,
  });
}

/**
 * The editor's own filesystem, so a check is detected in a virtual workspace,
 * a remote container, or over SSH exactly as it is on local disk.
 */
const vscodeFs = {
  async readFile(path: string): Promise<string | null> {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return null;
    }
  },
  async readDirectory(path: string): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path));
      return entries.map(([name]) => name);
    } catch {
      return [];
    }
  },
  async isDirectory(path: string): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(path));
      return stat.type === vscode.FileType.Directory;
    } catch {
      return false;
    }
  },
};

export type { CheckKind, LocalCheck };
