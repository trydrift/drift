import { join } from 'node:path';
import * as vscode from 'vscode';
import { detectChecks, type CheckKind, type LocalCheck } from '../../src/detect/checks.js';
import { detectPackageManagers } from '../../src/detect/package-manager.js';
import { execCommand } from '../../src/util/exec.js';
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
 */

export type CheckStatus = 'passed' | 'failed' | 'cancelled' | 'not-run';

export interface CheckOutcome {
  kind: CheckKind;
  label: string;
  status: CheckStatus;
  /** Milliseconds the command took. */
  durationMs: number;
  /** Tail of combined output, kept short enough to render inline. */
  output: string;
  /** Why it could not run, when it did not. */
  reason?: string;
}

const MAX_OUTPUT_LINES = 40;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * Which checks this directory offers.
 *
 * Scoped to the workspace member that owns the edited files, so a monorepo runs
 * the affected package's tests rather than the whole repository's.
 */
export async function availableChecks(root: string, dir = ''): Promise<LocalCheck[]> {
  const absolute = dir ? join(root, dir) : root;
  const entries = await readDirectory(absolute);
  if (entries.length === 0) return [];

  const detected = detectPackageManagers({ entries });
  const checks: LocalCheck[] = [];

  for (const { manager } of detected) {
    const manifest = manager.manifests.find((f) => entries.includes(f));
    const content = manifest ? await readText(join(absolute, manifest)) : null;
    for (const check of detectChecks(manager.id, content)) {
      if (!checks.some((existing) => existing.label === check.label)) checks.push(check);
    }
  }

  return checks;
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
  const cwd = options.dir ? join(options.root, options.dir) : options.root;
  const outcomes: CheckOutcome[] = [];
  const total = options.checks.length;

  // The same PATH the upgrade itself runs with. A GUI-launched VS Code inherits
  // the login environment, not the interactive shell's, so `npm` installed by
  // nvm, volta, fnm, or asdf is invisible to a bare `execFile` — which turned
  // every check into "not run" immediately after an upgrade that had just used
  // that very same npm successfully.
  const env = await envWithShellPath();

  for (const [index, check] of options.checks.entries()) {
    if (options.token?.isCancellationRequested) {
      outcomes.push(
        record(options, index, {
          kind: check.kind,
          label: check.label,
          status: 'cancelled',
          durationMs: 0,
          output: '',
          reason: 'Cancelled before this check ran.',
        }),
      );
      continue;
    }

    options.onProgress?.(check, index, total);

    const started = Date.now();
    const result = await execCommand(check.command.command, check.command.args, {
      cwd,
      env,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const durationMs = Date.now() - started;

    if (result.failure === 'not-found') {
      outcomes.push(
        record(options, index, {
          kind: check.kind,
          label: check.label,
          status: 'not-run',
          durationMs,
          output: '',
          reason: `\`${check.command.command}\` was not found. Drift asked your login shell for its PATH and looked in nvm, volta, fnm and asdf's install directories, and still could not find it. Run \`command -v ${check.command.command}\` in a terminal — if that finds one, restart VS Code from that terminal so it inherits the same PATH.`,
        }),
      );
      continue;
    }

    outcomes.push(
      record(options, index, {
        kind: check.kind,
        label: check.label,
        status: result.code === 0 ? 'passed' : 'failed',
        durationMs,
        // The end of the output is where the failure is. A hundred lines of
        // passing test names above it is exactly what a reviewer scrolls past.
        output: tail(`${result.stdout}\n${result.stderr}`),
        ...(result.failure === 'timeout' ? { reason: 'Timed out.' } : {}),
      }),
    );
  }

  return outcomes;
}

function record(options: RunChecksOptions, index: number, outcome: CheckOutcome): CheckOutcome {
  options.onResult?.(outcome, index, options.checks.length);
  return outcome;
}

/**
 * One line, for a status area or a notification.
 *
 * "3 not run" on its own is the least useful sentence this could produce: it
 * reads as a progress state rather than a result, and it hides the one thing
 * the developer needs, which is *why*. Anything that did not run says so in the
 * words of the reason it carries.
 */
export function describeOutcomes(outcomes: readonly CheckOutcome[]): string {
  if (outcomes.length === 0) return 'No local checks to run.';

  const failed = outcomes.filter((o) => o.status === 'failed');
  const passed = outcomes.filter((o) => o.status === 'passed');
  const skipped = outcomes.filter((o) => o.status === 'not-run' || o.status === 'cancelled');

  const parts: string[] = [];
  if (passed.length > 0) parts.push(`${passed.length} passed`);
  if (failed.length > 0) parts.push(`${failed.map((o) => o.label).join(', ')} failed`);
  if (skipped.length > 0) {
    const cancelled = skipped.every((o) => o.status === 'cancelled');
    parts.push(
      `${skipped.length === outcomes.length ? `none of your ${outcomes.length} check${outcomes.length === 1 ? '' : 's'} could run` : `${skipped.length} could not run`}${
        cancelled ? ' (cancelled)' : ''
      }`,
    );
  }

  return parts.join(' · ');
}

/**
 * The distinct reasons checks did not run, for the message under the summary.
 *
 * Kept separate from `describeOutcomes` because a status line has room for a
 * count and a notification has room for the explanation.
 */
export function unrunReasons(outcomes: readonly CheckOutcome[]): string[] {
  const reasons = outcomes
    .filter((o) => o.status === 'not-run')
    .map((o) => o.reason)
    .filter((reason): reason is string => Boolean(reason));
  return [...new Set(reasons)];
}

function tail(output: string): string {
  const lines = output.split('\n').filter((line) => line.trim().length > 0);
  const kept = lines.slice(-MAX_OUTPUT_LINES);
  return kept.length < lines.length
    ? [`…${lines.length - kept.length} earlier line(s) omitted`, ...kept].join('\n')
    : kept.join('\n');
}

async function readDirectory(path: string): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path));
    return entries.map(([name]) => name);
  } catch {
    return [];
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return null;
  }
}

export type { CheckKind, LocalCheck };
