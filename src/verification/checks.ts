import { join } from 'node:path';
import { detectChecks, type CheckKind, type LocalCheck } from '../detect/checks.js';
import { detectPackageManagers } from '../detect/package-manager.js';
import { nodeWorkspaceFs, type WorkspaceFs } from '../detect/workspace.js';
import { execCommand, type Exec } from '../util/exec.js';

/**
 * Running a project's own checks — its typecheck, its build, its tests.
 *
 * The honest question about an upgrade is not whether Drift believes it will
 * break, but whether the project's own toolchain still passes with it
 * installed. That answer already exists in every repository, costs no network,
 * and is *measured* rather than predicted, which makes it the strongest signal
 * Drift has.
 *
 * This lived in the VS Code extension, which meant the GitHub Action — the
 * consumer that files issues nobody is watching a panel for — had no way to run
 * a check at all and shipped predictions unverified. It is core now, with the
 * editor's filesystem and PATH injected rather than assumed, so a check means
 * the same thing in the panel, in CI, and in the CLI.
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
  /**
   * Everything the command printed.
   *
   * A reviewer wants the end of a failure and not a thousand lines above it. An
   * agent about to fix that failure wants the opposite — the whole thing, so it
   * can be grouped into what really went wrong rather than whatever happened to
   * be printed last.
   */
  fullOutput?: string;
  /** Why it could not run, when it did not. */
  reason?: string;
}

const MAX_OUTPUT_LINES = 40;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Something that can be cancelled mid-run. Structural, so VS Code's own token fits. */
export interface CancelSignal {
  isCancellationRequested: boolean;
}

/**
 * Which checks this directory offers.
 *
 * Scoped to the workspace member that owns the files in question, so a monorepo
 * runs the affected package's checks rather than the whole repository's.
 */
export async function availableChecks(
  root: string,
  dir = '',
  fs: WorkspaceFs = nodeWorkspaceFs(),
): Promise<LocalCheck[]> {
  const absolute = dir ? join(root, dir) : root;
  const entries = await fs.readDirectory(absolute);
  if (entries.length === 0) return [];

  const detected = detectPackageManagers({ entries });
  const checks: LocalCheck[] = [];

  for (const { manager } of detected) {
    const manifest = manager.manifests.find((f) => entries.includes(f));
    const content = manifest ? await fs.readFile(join(absolute, manifest)) : null;
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
  token?: CancelSignal;
  onProgress?: (check: LocalCheck, index: number, total: number) => void;
  /** Called as each check finishes, so a caller can report it while the rest run. */
  onResult?: (outcome: CheckOutcome, index: number, total: number) => void;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  /**
   * What to tell the developer when the command is not on PATH.
   *
   * The editor has a much better answer than a terminal does — it knows it may
   * have been launched from Finder with a login shell's PATH rather than an
   * interactive one — so it supplies its own rather than core guessing.
   */
  notFoundReason?: (command: string) => string;
}

/**
 * Run each check in order, stopping at nothing.
 *
 * A failing typecheck is not a reason to skip the build: whoever is deciding
 * what to do about this upgrade wants the whole picture, and "we stopped after
 * the first red" hides the case where the type error is trivial and everything
 * else is fine.
 */
export async function runChecks(options: RunChecksOptions): Promise<CheckOutcome[]> {
  const cwd = options.dir ? join(options.root, options.dir) : options.root;
  const exec = options.exec ?? execCommand;
  const env = options.env ?? process.env;
  const outcomes: CheckOutcome[] = [];
  const total = options.checks.length;

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
    const result = await exec(check.command.command, check.command.args, {
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
          reason:
            options.notFoundReason?.(check.command.command) ??
            `\`${check.command.command}\` was not found on PATH, so this check could not run.`,
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
        fullOutput: `${result.stdout}\n${result.stderr}`,
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

export type { CheckKind, LocalCheck };
