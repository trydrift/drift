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
  /**
   * How many upgrades were installed together when this was measured.
   *
   * Absent, or `1`, means this upgrade was the only thing applied and the
   * verdict is about it alone. Anything higher means the verdict came from the
   * combined pass in `probeGroup`, where one green run clears the whole batch.
   * That is worth stating rather than hiding: it is a true statement about
   * taking these upgrades together — which is what "upgrade all" does — and a
   * very slightly weaker one about taking this upgrade by itself.
   */
  measuredWith?: number;
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
   * Typecheck, build, and tests. The tests are not optional garnish: a compiler
   * proves things about signatures and nothing about behaviour, so a default
   * that moved or a method that now throws passes every static check and breaks
   * at runtime. A suite already failing at baseline is dropped from the verdict
   * rather than blamed on the upgrade.
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

const DEFAULT_KINDS: readonly CheckKind[] = ['typecheck', 'build', 'test'];

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
 * The cost that matters here is the check run, not the install: a typecheck, a
 * build and a suite, per candidate, is minutes of a developer's scan multiplied
 * by every dependency in the manifest. So the group is measured the cheap way
 * first — install all of them, run the checks once — and a green result settles
 * every candidate in the batch at once.
 *
 * The expensive one-at-a-time pass still exists and still does the real work,
 * but only when it has something to answer: two upgrades in one checkout cannot
 * be told apart when the checks go red, so a failing (or uninstallable) batch
 * falls back to attributing each candidate on its own. Repositories where most
 * upgrades are clean — which is most repositories — pay one check run instead of
 * one per package, and the ones that are actually broken pay what they did
 * before, plus a batch pass that told us where to look.
 */
async function probeGroup(
  options: ProbeOptions,
  dir: string,
  targets: readonly ProbeTarget[],
  hooks: GroupHooks,
): Promise<void> {
  const exec = options.exec ?? execCommand;
  const env = scrubEnv(options.env ?? process.env);
  const kinds = options.kinds ?? DEFAULT_KINDS;

  hooks.report('Preparing a test checkout', `${targets.length} upgrade${targets.length === 1 ? '' : 's'} to try`);

  let worktree;
  try {
    worktree = await createWorktree(options.root, `probe-${dir || 'root'}`, { exec, env });
  } catch (err) {
    for (const target of targets) hooks.settle(target, skipped(messageOf(err)));
    return;
  }

  if (worktree.copiedFiles.length > 0) {
    hooks.report(
      'Preparing a test checkout',
      `carried over ${worktree.copiedFiles.length} gitignored file${worktree.copiedFiles.length === 1 ? '' : 's'} not tracked by git: ${worktree.copiedFiles.join(', ')}`,
    );
  }
  if (worktree.oversizedFiles.length > 0) {
    hooks.report(
      'Preparing a test checkout',
      `skipped ${worktree.oversizedFiles.length} gitignored file${worktree.oversizedFiles.length === 1 ? '' : 's'} too large to carry over automatically, which may make a check fail for a reason unrelated to this upgrade: ${worktree.oversizedFiles.join(', ')}`,
    );
  }

  try {
    const manager = packageManagerById(targets[0]!.packageManager);

    // Detected in the worktree rather than in the developer's checkout, because
    // that is where they will run. Reading the open tree would offer a script
    // that only exists in someone's unsaved edits, and miss one they have just
    // deleted without committing.
    const wanted = (
      await availableChecks(worktree.path, dir, options.fs ?? nodeWorkspaceFs(), targets[0]!.packageManager)
    ).filter((check) => kinds.includes(check.kind));
    if (wanted.length === 0) {
      for (const target of targets) {
        hooks.settle(
          target,
          skipped('This project declares no typecheck or build that Drift could run against the upgrade.'),
        );
      }
      return;
    }

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

    const pass: GroupPass = {
      exec,
      env,
      dir,
      root: worktree.path,
      usable,
      install: manager?.install,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.token ? { token: options.token } : {}),
    };

    // The cheap answer first. Only worth attempting for more than one candidate
    // — a single upgrade is already its own attribution — and only conclusive
    // when it comes back green.
    if (targets.length > 1 && (await probeTogether(pass, targets, hooks))) return;

    for (const [index, target] of targets.entries()) {
      if (pass.token?.isCancellationRequested) {
        hooks.settle(target, cancelled());
        continue;
      }

      hooks.report(`Testing ${target.name}@${target.selected}`, `installing into the test checkout`);
      try {
        await target.install(pass.root);
      } catch (err) {
        hooks.settle(
          target,
          skipped(`${target.name}@${target.selected} could not be installed, so it could not be tested. ${messageOf(err)}`),
        );
        if (!(await resetWorktree(pass))) {
          settleRemainingAsContaminated(targets, index + 1, hooks);
          break;
        }
        continue;
      }

      hooks.report(`Testing ${target.name}@${target.selected}`, usable.map((check) => check.label).join(', '));
      hooks.settle(target, verdictFrom(await runPass(pass)));
      if (!(await resetWorktree(pass))) {
        settleRemainingAsContaminated(targets, index + 1, hooks);
        break;
      }
    }
  } finally {
    await worktree.dispose();
  }
}

/** Everything a pass over the prepared worktree needs, gathered once. */
interface GroupPass {
  exec: Exec;
  env: NodeJS.ProcessEnv;
  /** Member directory the checks and installs run in. `''` is the root. */
  dir: string;
  /** The worktree, never the developer's checkout. */
  root: string;
  /** Checks that passed at baseline, so a failure here is one an upgrade caused. */
  usable: readonly LocalCheck[];
  install: { command: string; args: string[] } | undefined;
  timeoutMs?: number;
  token?: CancelSignal;
}

/**
 * Install the whole group and check it once.
 *
 * Returns `true` only when every candidate was settled from this pass, which is
 * exactly when the combined run came back green: nothing failed, so nothing in
 * the batch broke anything, so each of them individually did not either. Any
 * other outcome — an install that would not resolve, a red check, a
 * cancellation — leaves every candidate unsettled and returns `false`, and the
 * caller attributes them one at a time. A failure here is deliberately *not*
 * reported: it says something in this batch is broken without saying what, and
 * naming the wrong package is worse than taking longer to name the right one.
 *
 * The worktree is put back either way, so the caller's serial pass starts from
 * the same clean baseline it would have had.
 */
async function probeTogether(
  pass: GroupPass,
  targets: readonly ProbeTarget[],
  hooks: GroupHooks,
): Promise<boolean> {
  hooks.report(
    `Testing ${targets.length} upgrades together`,
    targets.map((target) => `${target.name}@${target.selected}`).join(', '),
  );

  let installed = true;
  for (const target of targets) {
    if (pass.token?.isCancellationRequested) return false;
    try {
      await target.install(pass.root);
    } catch {
      // Which one failed does not matter: the serial pass is about to install
      // each of them on its own and will report the real reason against the
      // candidate it actually belongs to.
      installed = false;
      break;
    }
  }

  const outcomes = installed && !pass.token?.isCancellationRequested ? await runPass(pass) : [];
  const green = outcomes.length > 0 && outcomes.every((outcome) => outcome.status === 'passed');

  const resetOk = await resetWorktree(pass);
  if (green) {
    for (const target of targets) hooks.settle(target, { ...verdictFrom(outcomes), measuredWith: targets.length });
    return true;
  }

  // The batch was red (or never installed), so the caller's serial pass is
  // about to reuse this same worktree to attribute the failure to one
  // candidate at a time. If the reset back to a clean checkout did not
  // actually succeed, that worktree still carries whatever this batch
  // installed — a serial pass on top of it would test each candidate
  // alongside residue from every other one, exactly the cross-contamination
  // a throwaway worktree exists to prevent. Settling every target here,
  // instead of falling through, keeps that dirty tree from being reused.
  if (!resetOk) {
    for (const target of targets) {
      hooks.settle(
        target,
        skipped(
          'The test checkout could not be reset to a clean state after testing these upgrades together, so they could not be attributed individually.',
        ),
      );
    }
    return true;
  }

  return false;
}

/** The group's usable checks, run against whatever is installed right now. */
function runPass(pass: GroupPass): Promise<CheckOutcome[]> {
  return runChecks({
    root: pass.root,
    dir: pass.dir,
    checks: pass.usable,
    env: pass.env,
    exec: pass.exec,
    ...(pass.token ? { token: pass.token } : {}),
    ...(pass.timeoutMs ? { timeoutMs: pass.timeoutMs } : {}),
  });
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
  const env = scrubEnv(options.env ?? process.env);
  const after = await checkAt(options, options.afterSha, exec, env, 'with the change');
  if (after.status !== 'failed' || !options.beforeSha) return after;

  // Detected again at the base commit rather than reused: a commit that adds a
  // dependency often adds the script that checks it, and running a check the
  // old tree never declared would report it as broken for the wrong reason.
  const before = await checkAt(options, options.beforeSha, exec, env, 'without it');
  return reconcileAgainstBaseline(after, before, options.beforeSha);
}

/**
 * Decide, check by check, which of `after`'s failures are new.
 *
 * The old rule compared one aggregate verdict to another: if the baseline was
 * not a clean `passed`, the whole `after` failure was thrown away as
 * inconclusive. That is wrong in both directions. A repository whose tests
 * were already red at baseline but whose typecheck was clean would, on a
 * dependency that broke the typecheck, have that real regression discarded
 * because the *aggregate* baseline verdict was `failed` — even though the one
 * check that matters here has a clean baseline of its own. The fix compares
 * each failing check in `after` against the *same* check at baseline: it only
 * counts as breakage this dependency caused when that check passed before and
 * fails now.
 */
function reconcileAgainstBaseline(
  after: UpgradeVerification,
  before: UpgradeVerification,
  beforeSha: string,
): UpgradeVerification {
  if (before.checks.length === 0) {
    return skipped(
      `The project could not be checked at ${short(beforeSha)}, so there is nothing to compare the failure against.`,
    );
  }

  const beforeByLabel = new Map(before.checks.map((check) => [check.label, check]));
  const genuine = after.checks.filter(
    (check) => check.status === 'failed' && beforeByLabel.get(check.label)?.status === 'passed',
  );

  if (genuine.length === 0) {
    const alreadyRed = [
      ...new Set(
        after.checks
          .filter((check) => check.status === 'failed')
          .map((check) => {
            const atBaseline = beforeByLabel.get(check.label);
            return atBaseline
              ? `\`${check.label}\` already failed at ${short(beforeSha)}`
              : `\`${check.label}\` has no baseline at ${short(beforeSha)} to compare against`;
          }),
      ),
    ];
    return skipped(`${alreadyRed.join('; ')}, so the failure afterwards proves nothing about this dependency.`);
  }

  const diagnostics = genuine.map((outcome) => `$ ${outcome.label}\n${outcome.fullOutput ?? outcome.output}`).join('\n\n');
  return {
    status: 'failed',
    checks: after.checks,
    diagnostics,
    failedFiles: filesNamedIn(diagnostics),
  };
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
    const checks = (
      await availableChecks(worktree.path, dir, options.fs ?? nodeWorkspaceFs(), options.packageManager)
    ).filter((check) =>
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
/**
 * Put the worktree back, and say whether it actually worked.
 *
 * `Exec` resolves with a nonzero `code` on failure rather than rejecting, so
 * the old `.catch(() => undefined)` here only ever caught the rare case of
 * the command not existing at all — an ordinary failed `git checkout` (a
 * merge conflict with whatever the install just wrote, a permissions error)
 * returned normally and was read as success. The next candidate would then
 * install on top of whatever the previous one left behind. Both steps must
 * report a real zero exit for the worktree to count as clean.
 */
async function resetWorktree(pass: GroupPass): Promise<boolean> {
  const checkout = await pass
    .exec('git', ['checkout', '--', '.'], { cwd: pass.root, env: pass.env })
    .catch(() => ({ code: 1 }) as Awaited<ReturnType<Exec>>);
  if (checkout.code !== 0) return false;
  if (!pass.install) return true;

  const restored = await pass
    .exec(pass.install.command, pass.install.args, {
      cwd: pass.dir ? `${pass.root}/${pass.dir}` : pass.root,
      env: pass.env,
      timeoutMs: pass.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
    })
    .catch(() => ({ code: 1 }) as Awaited<ReturnType<Exec>>);
  return restored.code === 0;
}

/** Settle every not-yet-tested target in a group once its worktree can no longer be trusted. */
function settleRemainingAsContaminated(
  targets: readonly ProbeTarget[],
  fromIndex: number,
  hooks: GroupHooks,
): void {
  for (const target of targets.slice(fromIndex)) {
    hooks.settle(
      target,
      skipped(
        'The test checkout could not be reset to a clean state after testing an earlier upgrade in this group, so testing stopped rather than risk attributing one candidate’s breakage to another.',
      ),
    );
  }
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
  const failing = baseline.filter((outcome) => outcome.status === 'failed');
  if (failing.length > 0) {
    const labels = failing.map((outcome) => outcome.label);
    // The label alone ("`build` already fails") tells a developer that
    // something is wrong and nothing about what — which, for a check that
    // passes in their own terminal, reads as Drift being wrong rather than
    // as a real difference between their checkout and the worktree's. The
    // command and its actual output are what let them tell those apart.
    const detail = failing
      .map((outcome) => `$ ${outcome.label}\n${outcome.output.trim() || '(no output captured)'}`)
      .join('\n\n');
    return `\`${labels.join('`, `')}\` already fails on this commit before any upgrade is applied, so a failure afterwards would prove nothing.\n\n${detail}`;
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

/**
 * Strip credentials before a candidate dependency's install/build/test
 * scripts run.
 *
 * This is the one place in the scan where code Drift did not choose —
 * whatever a newly-published version's lifecycle scripts, or the project's
 * own build, decide to run — executes with real permission to do so. The
 * worktree keeps that code off the developer's working tree, but does nothing
 * about the process's environment: left alone, it inherits every credential
 * Drift itself was given, including the GitHub token and, in the Action, the
 * `repo-token`/`copilot-token` inputs GitHub exposes as `INPUT_*` variables.
 * A compromised package version could read and exfiltrate those before a
 * human ever chose to install it. Only variables that look like a secret are
 * removed — `PATH`, proxy settings, and everything else a package manager or
 * compiler legitimately needs stay put.
 */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const SENSITIVE = /token|secret|password|passwd|credential|api[_-]?key|private[_-]?key|_key$/i;
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('INPUT_') || key === 'GITHUB_TOKEN' || SENSITIVE.test(key)) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}
