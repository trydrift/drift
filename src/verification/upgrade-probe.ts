import { dirname } from 'node:path';
import { packageManagerById, type PackageManagerId } from '../detect/package-manager.js';
import { nodeWorkspaceFs, type WorkspaceFs } from '../detect/workspace.js';
import { createWorktree } from '../repo/worktree.js';
import { execCommand, type Exec } from '../util/exec.js';
import type { Logger } from '../util/logger.js';
import {
  availableChecks,
  runChecks,
  type CancelSignal,
  type CheckKind,
  type CheckOutcome,
  type LocalCheck,
} from './checks.js';

/**
 * Testing an upgrade before anyone is told about it.
 *
 * Drift predicts breakage by diffing published type surfaces. That prediction
 * is cheap, needs no install, and is wrong often enough to matter: it sees a
 * parameter move and reports every call site, when the new signature still
 * accepts most of them. Until now the correction arrived at *fix* time — the
 * developer was shown eight concerns, pressed the button, and was told the
 * compiler had already cleared all eight. Findings that evaporate when acted on
 * are worse than no findings, and in CI, where nobody presses a button, the
 * issue was simply filed wrong.
 *
 * So the measurement moves to scan time. Each candidate is installed in a
 * throwaway worktree and the project's own checks are run against it. What the
 * developer is finally shown is not a prediction but a result.
 *
 * Two things make the cost bearable. The worktree is created once per manifest
 * and reused across every candidate that shares it, so the expensive first
 * install is paid once and each subsequent one is incremental. And the checks
 * are run once at baseline before any upgrade is applied, so a repository whose
 * build was already red does not have its own breakage attributed to the next
 * dependency Drift happens to look at.
 */

export type VerificationStatus = 'passed' | 'failed' | 'skipped';

export interface UpgradeVerification {
  status: VerificationStatus;
  /**
   * Why nothing was measured.
   *
   * Always present on `skipped`, and it is the whole value of that state: a
   * caller that renders "skipped" without it has told the developer that Drift
   * did nothing, without saying whether that was because the project has no
   * checks, because the install failed, or because they cancelled.
   */
  reason?: string;
  /** Every check that ran, in the order it ran. */
  checks: CheckOutcome[];
  /**
   * Everything the failing checks printed.
   *
   * The fix stage hands this to an agent instead of re-running the typecheck
   * itself, and the Action puts it in the issue. Measured evidence, quoted.
   */
  diagnostics?: string;
  /** Repo-relative files named by the failing output, best effort. */
  failedFiles: string[];
}

/** One upgrade to test, decoupled from the scan's own candidate shape. */
export interface ProbeTarget {
  id: string;
  name: string;
  current: string;
  selected: string;
  /** Repo-relative path of the manifest that declares it. */
  manifestPath: string;
  packageManager: PackageManagerId;
  /** Apply this upgrade inside `root`, which is the worktree and never the developer's tree. */
  install(root: string): Promise<void>;
}

export interface ProbeProgress {
  phase: string;
  detail: string;
  done: number;
  total: number;
}

export interface ProbeOptions {
  root: string;
  targets: readonly ProbeTarget[];
  /**
   * Which of the project's checks to run.
   *
   * Typecheck and build by default. Tests are excluded unless asked for: they
   * are the slowest by an order of magnitude, and a test that fails for its own
   * reasons would be read as an upgrade breaking the project.
   */
  kinds?: readonly CheckKind[];
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  fs?: WorkspaceFs;
  logger?: Logger;
  token?: CancelSignal;
  /** Per-check timeout. */
  timeoutMs?: number;
  onProgress?: (progress: ProbeProgress) => void;
  /** Called as each target is settled, so a caller can release it one at a time. */
  onVerified?: (target: ProbeTarget, verification: UpgradeVerification) => void;
}

const DEFAULT_KINDS: readonly CheckKind[] = ['typecheck', 'build'];

/**
 * Install and check every target, and report what actually happened.
 *
 * Never throws. Every failure mode this can hit — no git, no checks, an install
 * that will not resolve, a cancelled scan — is an ordinary state of some real
 * repository, and the answer to all of them is a `skipped` verdict carrying its
 * reason rather than a scan that dies on someone's unusual setup.
 */
export async function probeUpgrades(options: ProbeOptions): Promise<Map<string, UpgradeVerification>> {
  const results = new Map<string, UpgradeVerification>();
  const settle = (target: ProbeTarget, verification: UpgradeVerification) => {
    results.set(target.id, verification);
    options.onVerified?.(target, verification);
  };

  if (options.targets.length === 0) return results;

  const groups = groupByManifest(options.targets);
  let done = 0;
  const total = options.targets.length;

  for (const [manifestPath, targets] of groups) {
    if (options.token?.isCancellationRequested) {
      for (const target of targets) settle(target, cancelled());
      continue;
    }

    const dir = memberDirOf(manifestPath);
    await probeGroup(options, dir, targets, {
      report: (phase, detail) => options.onProgress?.({ phase, detail, done, total }),
      settle: (target, verification) => {
        done += 1;
        settle(target, verification);
      },
    });
  }

  return results;
}

interface GroupHooks {
  report(phase: string, detail: string): void;
  settle(target: ProbeTarget, verification: UpgradeVerification): void;
}

/**
 * Every candidate sharing one manifest, tested in one worktree.
 *
 * Serial by design, and not only to bound the cost: two upgrades installed into
 * one checkout at the same time would each be measured against the other, and a
 * failure could not be attributed to either.
 */
async function probeGroup(
  options: ProbeOptions,
  dir: string,
  targets: readonly ProbeTarget[],
  hooks: GroupHooks,
): Promise<void> {
  const exec = options.exec ?? execCommand;
  const env = options.env ?? process.env;
  const kinds = options.kinds ?? DEFAULT_KINDS;

  hooks.report('Preparing a test checkout', `${targets.length} upgrade${targets.length === 1 ? '' : 's'} to try`);

  let worktree;
  try {
    worktree = await createWorktree(options.root, `probe-${dir || 'root'}`, { exec, env });
  } catch (err) {
    for (const target of targets) hooks.settle(target, skipped(messageOf(err)));
    return;
  }

  try {
    // Detected in the worktree rather than in the developer's checkout, because
    // that is where they will run. Reading the open tree would offer a script
    // that only exists in someone's unsaved edits, and miss one they have just
    // deleted without committing.
    const wanted = (await availableChecks(worktree.path, dir, options.fs ?? nodeWorkspaceFs())).filter((check) =>
      kinds.includes(check.kind),
    );
    if (wanted.length === 0) {
      for (const target of targets) {
        hooks.settle(
          target,
          skipped('This project declares no typecheck or build that Drift could run against the upgrade.'),
        );
      }
      return;
    }

    const manager = packageManagerById(targets[0]!.packageManager);

    // A worktree is the commit and nothing else: no `node_modules`, no
    // virtualenv. Without this the very first typecheck fails on every import
    // in the project and reports the whole repository as broken by an upgrade
    // that has not even been applied yet.
    if (manager?.install) {
      hooks.report('Installing dependencies', `\`${manager.install.command} ${manager.install.args.join(' ')}\``);
      const restored = await exec(manager.install.command, manager.install.args, {
        cwd: dir ? `${worktree.path}/${dir}` : worktree.path,
        env,
        timeoutMs: options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
      });
      if (restored.code !== 0) {
        const detail = (restored.stderr || restored.stdout).trim().split('\n').slice(-3).join(' ');
        for (const target of targets) {
          hooks.settle(
            target,
            skipped(`\`${manager.install.command} ${manager.install.args.join(' ')}\` failed in a clean checkout, so there was nothing to test the upgrade against. ${detail}`.trim()),
          );
        }
        return;
      }
    }

    // What is already red before Drift touches anything. Without this, a
    // repository with one pre-existing type error would have that error
    // attributed to every dependency in it.
    hooks.report('Checking the project as it is', `${wanted.map((check) => check.label).join(', ')}`);
    const baseline = await runChecks({
      root: worktree.path,
      dir,
      checks: wanted,
      env,
      exec,
      ...(options.token ? { token: options.token } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });

    const usable = wanted.filter((check) => baseline.some((o) => o.label === check.label && o.status === 'passed'));
    if (usable.length === 0) {
      const reason = describeUnusableBaseline(baseline);
      for (const target of targets) hooks.settle(target, skipped(reason));
      return;
    }

    for (const target of targets) {
      if (options.token?.isCancellationRequested) {
        hooks.settle(target, cancelled());
        continue;
      }

      hooks.report(`Testing ${target.name}@${target.selected}`, `installing into the test checkout`);
      try {
        await target.install(worktree.path);
      } catch (err) {
        hooks.settle(
          target,
          skipped(`${target.name}@${target.selected} could not be installed, so it could not be tested. ${messageOf(err)}`),
        );
        await resetWorktree(worktree.path, exec, env, manager?.install, dir, options.timeoutMs);
        continue;
      }

      hooks.report(`Testing ${target.name}@${target.selected}`, usable.map((check) => check.label).join(', '));
      const outcomes = await runChecks({
        root: worktree.path,
        dir,
        checks: usable,
        env,
        exec,
        ...(options.token ? { token: options.token } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });

      hooks.settle(target, verdictFrom(outcomes));
      await resetWorktree(worktree.path, exec, env, manager?.install, dir, options.timeoutMs);
    }
  } finally {
    await worktree.dispose();
  }
}

const DEFAULT_INSTALL_TIMEOUT_MS = 15 * 60_000;

export interface ChangeProbeOptions {
  /** Local checkout the change has already landed in. */
  workspace: string;
  /** Member directory that owns the changed manifest. `''` is the root. */
  dir?: string;
  packageManager: PackageManagerId;
  /** Commit the change landed in. */
  afterSha: string;
  /** Commit before it, used only to tell new breakage from old. */
  beforeSha?: string;
  kinds?: readonly CheckKind[];
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  fs?: WorkspaceFs;
  logger?: Logger;
  token?: CancelSignal;
  timeoutMs?: number;
  onProgress?: (progress: ProbeProgress) => void;
}

/**
 * Verify a dependency change that has already landed.
 *
 * The scan's problem is "what would happen if we took this upgrade"; the
 * push-triggered pipeline's is "what happened when someone took it", and the
 * answer to the second is measurable without installing anything by hand — the
 * manifest in the commit already names the new version. So this installs what
 * the commit declares and runs the project's checks against it.
 *
 * The `beforeSha` pass is what keeps this honest, and it is why a red build does
 * not automatically become a finding: a repository that was already failing to
 * compile would otherwise have every one of its own errors attributed to
 * whichever dependency happened to move. It costs a second install, so it is
 * only paid when the first pass actually found something.
 */
export async function probeDependencyChange(options: ChangeProbeOptions): Promise<UpgradeVerification> {
  const exec = options.exec ?? execCommand;
  const env = options.env ?? process.env;
  const dir = options.dir ?? '';
  const after = await checkAt(options, options.afterSha, exec, env, 'with the change');
  if (after.status !== 'failed' || !options.beforeSha) return after;

  // Detected again at the base commit rather than reused: a commit that adds a
  // dependency often adds the script that checks it, and running a check the
  // old tree never declared would report it as broken for the wrong reason.
  const before = await checkAt(options, options.beforeSha, exec, env, 'without it');
  if (before.status !== 'passed') {
    const alreadyRed = before.checks.filter((check) => check.status === 'failed').map((check) => check.label);
    return skipped(
      alreadyRed.length > 0
        ? `\`${alreadyRed.join('`, `')}\` already failed at ${short(options.beforeSha)}, before this dependency moved, so the failure afterwards proves nothing about it.`
        : `The project could not be checked at ${short(options.beforeSha)}, so there is nothing to compare the failure against.`,
    );
  }

  return after;
}

/** One install-and-check pass at one commit, in a worktree of its own. */
async function checkAt(
  options: ChangeProbeOptions,
  sha: string,
  exec: Exec,
  env: NodeJS.ProcessEnv,
  label: string,
): Promise<UpgradeVerification> {
  const dir = options.dir ?? '';
  const kinds = options.kinds ?? DEFAULT_KINDS;
  options.onProgress?.({ phase: `Checking the project ${label}`, detail: short(sha), done: 0, total: 1 });

  let worktree;
  try {
    worktree = await createWorktree(options.workspace, `change-${short(sha)}`, { at: sha, exec, env });
  } catch (err) {
    return skipped(messageOf(err));
  }

  try {
    const checks = (await availableChecks(worktree.path, dir, options.fs ?? nodeWorkspaceFs())).filter((check) =>
      kinds.includes(check.kind),
    );
    if (checks.length === 0) {
      return skipped(`This project declares no typecheck or build at ${short(sha)} that Drift could run.`);
    }

    const manager = packageManagerById(options.packageManager);
    if (manager?.install) {
      const installed = await exec(manager.install.command, manager.install.args, {
        cwd: dir ? `${worktree.path}/${dir}` : worktree.path,
        env,
        timeoutMs: options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
      });
      if (installed.code !== 0) {
        const detail = (installed.stderr || installed.stdout).trim().split('\n').slice(-3).join(' ');
        return skipped(
          `\`${manager.install.command} ${manager.install.args.join(' ')}\` failed at ${short(sha)}, so the project could not be checked ${label}. ${detail}`.trim(),
        );
      }
    }

    return verdictFrom(
      await runChecks({
        root: worktree.path,
        dir,
        checks,
        env,
        exec,
        ...(options.token ? { token: options.token } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      }),
    );
  } finally {
    await worktree.dispose();
  }
}

function short(sha: string): string {
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

/**
 * Put the checkout back to the commit it was made from, ready for the next
 * candidate.
 *
 * Tracked files only. `git clean` would take `node_modules` with it and turn
 * every subsequent install back into a cold one, which is the whole cost this
 * design exists to avoid — so the manager's own restore command is what
 * reconciles the installed tree with the manifest that has just been reverted.
 */
async function resetWorktree(
  path: string,
  exec: Exec,
  env: NodeJS.ProcessEnv,
  install: { command: string; args: string[] } | undefined,
  dir: string,
  timeoutMs: number | undefined,
): Promise<void> {
  await exec('git', ['checkout', '--', '.'], { cwd: path, env }).catch(() => undefined);
  if (!install) return;
  await exec(install.command, install.args, {
    cwd: dir ? `${path}/${dir}` : path,
    env,
    timeoutMs: timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
  }).catch(() => undefined);
}

/**
 * The verdict for one candidate.
 *
 * Only checks that passed at baseline are run here, so any failure is one this
 * upgrade introduced. A check that could not run at all does not count as a
 * pass — an absent answer is not a clean bill of health, which is the same
 * distinction `severity.ts` draws between `clean` and `unchecked`.
 */
function verdictFrom(outcomes: readonly CheckOutcome[]): UpgradeVerification {
  const failed = outcomes.filter((outcome) => outcome.status === 'failed');
  if (failed.length > 0) {
    const diagnostics = failed
      .map((outcome) => `$ ${outcome.label}\n${outcome.fullOutput ?? outcome.output}`)
      .join('\n\n');
    return {
      status: 'failed',
      checks: [...outcomes],
      diagnostics,
      failedFiles: filesNamedIn(diagnostics),
    };
  }

  const ran = outcomes.filter((outcome) => outcome.status === 'passed');
  if (ran.length === 0) {
    return {
      status: 'skipped',
      reason: outcomes.some((outcome) => outcome.status === 'cancelled')
        ? 'Cancelled before this upgrade could be tested.'
        : 'None of the project’s checks could run against this upgrade.',
      checks: [...outcomes],
      failedFiles: [],
    };
  }

  return { status: 'passed', checks: [...outcomes], failedFiles: [] };
}

/**
 * Why a baseline left nothing to measure against.
 *
 * Named in the developer's terms, because this is the sentence that explains a
 * scan which verified nothing — and "we could not check" with no reason is the
 * failure mode `unchecked` exists to prevent.
 */
function describeUnusableBaseline(baseline: readonly CheckOutcome[]): string {
  const failing = baseline.filter((outcome) => outcome.status === 'failed').map((outcome) => outcome.label);
  if (failing.length > 0) {
    return `\`${failing.join('`, `')}\` already fails on this commit before any upgrade is applied, so a failure afterwards would prove nothing.`;
  }
  const reason = baseline.find((outcome) => outcome.reason)?.reason;
  return reason ?? 'None of the project’s checks could be run in a clean checkout.';
}

/**
 * Files a compiler named in its errors.
 *
 * Covers the two shapes almost every toolchain prints — `path(line,col):` from
 * tsc and MSBuild, `path:line:col:` from gcc, clang, rustc, go, and eslint —
 * and gives up quietly on anything else. Best effort on purpose: this decides
 * what to highlight, never what to believe.
 */
export function filesNamedIn(output: string): string[] {
  const found = new Set<string>();
  for (const line of output.split('\n')) {
    const match = /^\s*(?:[A-Za-z]:)?([\w./\\@+-]+\.\w+)(?:\((\d+),\d+\)|:(\d+):\d+)/.exec(line);
    const file = match?.[1];
    if (file) found.add(file.replace(/\\/g, '/').replace(/^\.\//, ''));
  }
  return [...found];
}

function groupByManifest(targets: readonly ProbeTarget[]): Map<string, ProbeTarget[]> {
  const groups = new Map<string, ProbeTarget[]>();
  for (const target of targets) {
    const existing = groups.get(target.manifestPath);
    if (existing) existing.push(target);
    else groups.set(target.manifestPath, [target]);
  }
  return groups;
}

/** `''` for a root manifest, otherwise the member directory that owns it. */
function memberDirOf(manifestPath: string): string {
  const dir = dirname(manifestPath);
  return dir === '.' || dir === '/' ? '' : dir;
}

function skipped(reason: string): UpgradeVerification {
  return { status: 'skipped', reason, checks: [], failedFiles: [] };
}

function cancelled(): UpgradeVerification {
  return skipped('Cancelled before this upgrade could be tested.');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
