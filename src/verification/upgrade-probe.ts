import { basename, dirname } from 'node:path';
import { packageManagerById, type PackageManagerId } from '../detect/package-manager.js';
import { nodeWorkspaceFs, type WorkspaceFs } from '../detect/workspace.js';
import { createWorktree, type Worktree, settleWorktreeDeletions } from '../repo/worktree.js';
import { execCommand, type Exec } from '../util/exec.js';
import { count, measure, span } from '../util/profile.js';
import { createToolAvailabilityCache, toolsAvailable, type ToolAvailabilityCache } from './tool-availability.js';
import { mapWithConcurrency } from '../util/http.js';
import { localConcurrency } from '../util/parallelism.js';
import { baselineKey, noBaselineCache, type CachedCheck } from './baseline-cache.js';
import type { BaselineCache } from './baseline-cache.js';
import type { Logger } from '../util/logger.js';
import {
  availableChecks,
  runChecks,
  type CancelSignal,
  type CheckKind,
  type CheckOutcome,
  type LocalCheck,
} from './checks.js';
import { detectChecks } from '../detect/checks.js';

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
  /**
   * Which upgrades this phase is about, by `ProbeTarget.id`.
   *
   * Absent for work that belongs to the checkout rather than to any particular
   * package — creating the worktree, installing the project's own
   * dependencies, measuring the baseline. Present, and specific, for anything
   * a caller could sensibly show on one package's row: a caller that renders
   * per-package progress has no other way to tell which row "running the test
   * suite" belongs to.
   */
  targets?: readonly string[];
  /**
   * A chunk the running command just printed.
   *
   * Present *instead of* a phase change, not alongside one: a consumer appends
   * this to whatever the current phase is showing rather than treating it as a
   * new step. The install, the typecheck and the test suite are the three
   * slowest things in a scan and the only evidence that any of them is
   * progressing rather than wedged.
   */
  output?: string;
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
  /** See {@link WorktreeOptions.allowedGlobs} — `config.verify.generatedSourceGlobs`. */
  allowedGlobs?: readonly string[];
  /**
   * How many manifest groups to install and check at once.
   *
   * Each group already gets its own worktree, so groups share nothing —
   * `packages/web`'s install and `packages/api`'s install were only ever
   * serialized because the loop over them was, not because anything
   * required it. Defaults to `localConcurrency()`, which is deliberately the
   * smallest of the three parallelism budgets: an install saturates the disk
   * and a typecheck saturates every core it is given, so running many at once
   * makes each one slower without finishing the set any sooner. Git worktree
   * operations also briefly lock shared repository state, so unbounded
   * concurrency trades a slow scan for a flaky one on a large monorepo.
   */
  concurrency?: number;
  /**
   * Checkouts already being prepared when this probe starts. See {@link warmProbe}.
   *
   * A group with no warmed preparation for its directory prepares its own, so
   * this is purely an optimisation and never changes what is measured.
   */
  warm?: ProbeWarmup;
  /**
   * Where a measured baseline is remembered between runs. See
   * `verification/baseline-cache.ts`.
   *
   * Absent means measure it every time, which is what a fresh CI container and
   * every test want. Present, it removes the one part of the preparation that
   * is pure recomputation: running a project's typecheck, build and test suite
   * to learn what they said the last time nothing had changed.
   */
  baselineCache?: BaselineCache;
  /**
   * Apply a whole batch of upgrades in as few package-manager runs as possible.
   *
   * `false` means it declined — the manager takes one package per command, the
   * batch spans manifests — and the caller installs them one at a time instead.
   * A rejected promise means it tried and failed, which is a fact about the
   * batch and settles it the same way a failing loop always did.
   *
   * Optional: absent, every install goes through {@link ProbeTarget.install},
   * which is exactly the old behaviour.
   */
  installTogether?: (root: string, targets: readonly ProbeTarget[]) => Promise<boolean>;
  onProgress?: (progress: ProbeProgress) => void;
  /** Called as each target is settled, so a caller can release it one at a time. */
  onVerified?: (target: ProbeTarget, verification: UpgradeVerification) => void;
}

type ProbeRunOptions = ProbeOptions & { toolAvailability: ToolAvailabilityCache };

const DEFAULT_KINDS: readonly CheckKind[] = ['typecheck', 'build', 'test'];

/**
 * A baseline check, however it was arrived at.
 *
 * A cached entry keeps only what the decisions below actually read — the label,
 * whether it passed, and why not — while a freshly measured one carries its
 * whole output. Everything that consumes a baseline works from this narrower
 * shape so neither source needs a special case.
 */
type BaselineLike = { label: string; status: CheckOutcome['status']; output?: string; reason?: string };

/**
 * Install and check every target, and report what actually happened.
 *
 * Never throws. Every failure mode this can hit — no git, no checks, an install
 * that will not resolve, a cancelled scan — is an ordinary state of some real
 * repository, and the answer to all of them is a `skipped` verdict carrying its
 * reason rather than a scan that dies on someone's unusual setup.
 */
export async function probeUpgrades(options: ProbeOptions): Promise<Map<string, UpgradeVerification>> {
  const runOptions: ProbeRunOptions = { ...options, toolAvailability: createToolAvailabilityCache() };
  const results = new Map<string, UpgradeVerification>();
  const settle = (target: ProbeTarget, verification: UpgradeVerification) => {
    results.set(target.id, verification);
    runOptions.onVerified?.(target, verification);
  };

  if (runOptions.targets.length === 0) return results;

  const groups = [...groupByManifest(runOptions.targets)];
  let done = 0;
  const total = runOptions.targets.length;

  // Each group gets its own worktree and shares nothing with the others, so
  // nothing about correctness requires running them one at a time — only the
  // loop used to. Bounded rather than unbounded: git worktree operations
  // briefly lock shared repository state, so a monorepo with many manifests
  // benefits from running several at once without every group racing for the
  // same lock simultaneously.
  await mapWithConcurrency(groups, Math.max(1, runOptions.concurrency ?? localConcurrency()), async ([manifestPath, targets]) => {
    if (runOptions.token?.isCancellationRequested) {
      for (const target of targets) settle(target, cancelled());
      return;
    }

    const dir = memberDirOf(manifestPath);
    await probeGroup(runOptions, dir, targets, {
      report: (phase, detail, about) =>
        runOptions.onProgress?.({
          phase,
          detail,
          done,
          total,
          ...(about ? { targets: about.map((target) => target.id) } : {}),
        }),
      output: (chunk) => runOptions.onProgress?.({ phase: '', detail: '', done, total, output: chunk }),
      settle: (target, verification) => {
        done += 1;
        settle(target, verification);
      },
    });
  });

  // Each group hands its worktree over to be deleted rather than waiting for
  // it, so the deletions overlap each other and overlap the groups still
  // running. Awaited here — once, at the end — so "nothing is left on disk
  // when a scan returns" stays exactly as true as it was.
  await settleWorktreeDeletions();

  return results;
}



interface GroupHooks {
  /** `about` names the upgrades this phase belongs to, when it belongs to any. */
  report(phase: string, detail: string, about?: readonly ProbeTarget[]): void;
  /** A chunk the currently reported command printed. See {@link ProbeProgress.output}. */
  output(chunk: string): void;
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
  options: ProbeRunOptions,
  dir: string,
  targets: readonly ProbeTarget[],
  hooks: GroupHooks,
): Promise<void> {
  const exec = options.exec ?? execCommand;
  const env = scrubEnv(options.env ?? process.env);
  const project = projectLabel(options.root, dir);

  // Either the checkout this scan warmed while it was busy on the network, or
  // one prepared right here. See `warmProbe`.
  const preparation = await (options.warm?.take(dir, targets[0]!.packageManager) ??
    prepareGroup(options, dir, targets[0]!.packageManager, hooks));

  if (!preparation.ok) {
    for (const target of targets) hooks.settle(target, skipped(preparation.reason));
    return;
  }

  const { worktree, usable, manager } = preparation;

  // Reported here rather than inside the preparation: a warmed checkout is
  // prepared before anyone knows which packages it will be used for, and these
  // lines only make sense next to the group they affect.
  for (const line of preparation.notes) hooks.report(`Preparing a test checkout of ${project}`, line);

  try {
    const pass: GroupPass = {
      exec,
      env,
      dir,
      root: worktree.path,
      usable,
      install: manager?.install,
      ...(options.installTogether ? { installTogether: options.installTogether } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.token ? { token: options.token } : {}),
    };

    await attribute(pass, targets, hooks);
  } finally {
    await worktree.dispose();
  }
}

/**
 * At or below this many candidates, a red batch is cheaper to settle one at a
 * time than to keep halving.
 *
 * Halving a group of four costs up to seven passes (two halves, then each of
 * the four); testing the four costs four. The crossover is what this constant
 * is: *above* it, splitting wins because a green half settles everything in it
 * at once, and at or below it the arithmetic reverses — which is why the test
 * is `<=` and four is itself settled serially.
 */
const SERIAL_ATTRIBUTION_THRESHOLD = 4;

/**
 * Work out which candidates in a group actually break the project.
 *
 * The old shape asked the question once and then gave up on being clever: if
 * the whole batch was not green, every candidate was installed and checked on
 * its own — a typecheck, a build and a test suite *per dependency*, which on a
 * repository with forty outdated packages and one genuinely broken one is
 * thirty-nine full check runs spent confirming what a single green pass would
 * have said.
 *
 * So a red batch is halved instead. A half that comes back green settles every
 * candidate in it at once (the same verdict, and the same honest
 * `measuredWith`, that the whole-group pass already produced); a half that
 * comes back red is halved again, until the culprit is alone and gets the
 * individual verdict it deserves. Nothing is ever reported as broken without
 * having been tested by itself, which is the property that matters — this is
 * only a cheaper search for the same answer.
 *
 * Returns whether the worktree is still clean enough for the caller to keep
 * using.
 */
async function attribute(
  pass: GroupPass,
  targets: readonly ProbeTarget[],
  hooks: GroupHooks,
): Promise<boolean> {
  if (pass.token?.isCancellationRequested) {
    for (const target of targets) hooks.settle(target, cancelled());
    return true;
  }

  const only = targets.length === 1 ? targets[0] : undefined;
  if (only) return probeAlone(pass, only, hooks);

  const together = await probeTogether(pass, targets, hooks);
  if (together !== 'inconclusive') return together === 'settled';

  if (targets.length <= SERIAL_ATTRIBUTION_THRESHOLD) {
    for (const [index, target] of targets.entries()) {
      if (pass.token?.isCancellationRequested) {
        hooks.settle(target, cancelled());
        continue;
      }
      if (!(await probeAlone(pass, target, hooks))) {
        settleRemainingAsContaminated(targets, index + 1, hooks);
        return false;
      }
    }
    return true;
  }

  const middle = Math.ceil(targets.length / 2);
  const first = targets.slice(0, middle);
  const second = targets.slice(middle);

  if (!(await attribute(pass, first, hooks))) {
    settleRemainingAsContaminated(second, 0, hooks);
    return false;
  }
  return attribute(pass, second, hooks);
}

/**
 * One candidate, installed and checked by itself.
 *
 * The only place a `failed` verdict can come from: a verdict about one package
 * has to be measured with that package as the only thing that moved.
 */
async function probeAlone(pass: GroupPass, target: ProbeTarget, hooks: GroupHooks): Promise<boolean> {
  const phase = `Testing ${target.name}@${target.selected}`;
  hooks.report(phase, 'installing into the test checkout', [target]);
  try {
    await target.install(pass.root);
  } catch (err) {
    hooks.settle(
      target,
      skipped(`${target.name}@${target.selected} could not be installed, so it could not be tested. ${messageOf(err)}`),
    );
    return resetWorktree(pass);
  }

  hooks.report(phase, pass.usable.map((check) => check.label).join(', '), [target]);
  hooks.settle(target, verdictFrom(await runPass(pass, hooks, phase, [target])));
  return resetWorktree(pass);
}

/* ------------------------------------------------------------------ */
/* Preparing a checkout, before anyone needs it                        */
/* ------------------------------------------------------------------ */

/**
 * A checkout with the project's dependencies installed and its baseline
 * measured — everything that is true before any upgrade is applied.
 */
type Preparation =
  | {
      ok: true;
      worktree: Worktree;
      /** Checks that passed at baseline, so a failure later is one an upgrade caused. */
      usable: readonly LocalCheck[];
      manager: PackageManager | undefined;
      /** Things worth telling the developer about this checkout, e.g. a secret not carried over. */
      notes: string[];
    }
  | { ok: false; reason: string };

type PackageManager = NonNullable<ReturnType<typeof packageManagerById>>;

async function preflightUsableChecks(
  exec: Exec,
  checks: readonly LocalCheck[],
  env: NodeJS.ProcessEnv,
  cache: ToolAvailabilityCache,
): Promise<{ usable: readonly LocalCheck[]; missing: readonly string[] }> {
  const required = [...new Set(checks.flatMap(requiredHostCommands))];
  if (required.length === 0) return { usable: checks, missing: [] };

  const available = await toolsAvailable(exec, required, env, cache);
  const eligible = (check: LocalCheck): boolean =>
    requiredHostCommands(check).every((command) => available.get(command) === true);
  const usable = checks.filter(eligible);

  return {
    usable,
    missing: required.filter((command) => available.get(command) === false),
  };
}

function requiredHostCommands(check: LocalCheck): string[] {
  return check.commandOrigin.kind === 'host'
    ? [check.commandOrigin.command]
    : [...check.commandOrigin.requiredHostCommands];
}

function earlyPreflightChecks(
  packageManager: PackageManager,
  declared: readonly LocalCheck[],
  kinds: readonly CheckKind[],
): LocalCheck[] {
  const install = packageManager.install
    ? [
        {
          kind: 'build' as const,
          label: `${packageManager.install.command} ${packageManager.install.args.join(' ')}`.trim(),
          command: packageManager.install,
          source: `${packageManager.label} install`,
          commandOrigin: { kind: 'host' as const, command: packageManager.install.command },
          compileCapable: false,
        },
      ]
    : [];
  const intrinsic = detectChecks(packageManager.id, null).filter((check) => kinds.includes(check.kind));
  const checkout = install.length > 0 ? declared.filter((check) => kinds.includes(check.kind)) : [];
  return uniqueChecks([...install, ...intrinsic, ...checkout]);
}

function uniqueChecks(checks: readonly LocalCheck[]): LocalCheck[] {
  const out: LocalCheck[] = [];
  for (const check of checks) {
    if (!out.some((existing) => existing.label === check.label)) out.push(check);
  }
  return out;
}

function describeMissingTools(missing: readonly string[]): string {
  return missing.length === 1
    ? `\`${missing[0]}\` is`
    : `${missing.slice(0, -1).map((m) => `\`${m}\``).join(', ')} and \`${missing.at(-1)}\` are`;
}

/**
 * Create the worktree, install into it, and find out what is already red.
 *
 * Split out of `probeGroup` because none of it depends on *which* upgrades are
 * about to be tested — only on the directory and its package manager, both
 * known the moment the scan has read the manifests. That is what lets
 * `warmProbe` start it against the clock instead of after it.
 */
async function prepareGroup(
  options: ProbeRunOptions,
  dir: string,
  packageManager: PackageManagerId,
  hooks: Pick<GroupHooks, 'report' | 'output'>,
): Promise<Preparation> {
  const exec = options.exec ?? execCommand;
  const env = scrubEnv(options.env ?? process.env);
  const kinds = options.kinds ?? DEFAULT_KINDS;
  // Which project these commands run in. A monorepo runs the same three check
  // labels in every member, so "Checking the project as it is — npm run
  // typecheck, npm run build" appearing twice with nothing to tell the two
  // apart reads as one step that stalled and repeated itself.
  const project = projectLabel(options.root, dir);
  const manager = packageManagerById(packageManager);

  // Asked before anything is built, but only as a gate: if the package
  // manager needed for installation, or a manager-intrinsic check such as
  // `cargo check`, is missing, the clean worktree cannot make it appear. The
  // open checkout may have uncommitted script edits, so its checks are never
  // allowed to decide the final runnable set.
  const declared = manager
    ? await availableChecks(options.root, dir, options.fs ?? nodeWorkspaceFs(), packageManager).catch(
        () => [] as LocalCheck[],
      )
    : [];
  const possible = manager ? earlyPreflightChecks(manager, declared, kinds) : [];
  if (possible.length > 0) {
    const preflight = await preflightUsableChecks(exec, possible, env, options.toolAvailability);
    if (preflight.usable.length === 0) {
      count('verify.skipped.noTool');
      return {
        ok: false,
        reason: `${describeMissingTools(preflight.missing)} not installed, so ${project} could not be built or tested against the upgrade.`,
      };
    }
  }

  hooks.report(`Preparing a test checkout of ${project}`, 'checking out a clean copy');

  let worktree: Worktree;
  const checkout = span('verify', 'worktree', { project });
  try {
    worktree = await createWorktree(options.root, `probe-${dir || 'root'}`, {
      exec,
      env,
      ...(options.allowedGlobs ? { allowedGlobs: options.allowedGlobs } : {}),
    });
    checkout.end();
  } catch (err) {
    checkout.end({ failed: true });
    return { ok: false, reason: messageOf(err) };
  }

  const notes: string[] = [];
  if (worktree.copiedFiles.length > 0) {
    notes.push(`carried over ${describeIgnored(worktree.copiedFiles, worktree.copiedRules)} not tracked by git`);
  }
  if (worktree.oversizedFiles.length > 0) {
    notes.push(
      `skipped ${describeIgnored(worktree.oversizedFiles, worktree.oversizedRules)} — too large to carry over automatically, which may make a check fail for a reason unrelated to this upgrade`,
    );
  }
  if (worktree.skippedSecrets.length > 0) {
    notes.push(
      `never copied ${describeIgnored(worktree.skippedSecrets, worktree.skippedSecretRules)} — ${worktree.skippedSecrets.length === 1 ? 'it looked' : 'they looked'} like credentials, which may make a check fail for a reason unrelated to this upgrade; see \`verify.generatedSourceGlobs\` if the project genuinely needs ${worktree.skippedSecrets.length === 1 ? 'it' : 'one of them'}`,
    );
  }

  /** Anything that gives up after the worktree exists has to take it away again. */
  const abandon = async (reason: string): Promise<Preparation> => {
    await worktree.dispose();
    return { ok: false, reason };
  };

  // Detected in the worktree rather than in the developer's checkout, because
  // that is where they will run. Reading the open tree would offer a script
  // that only exists in someone's unsaved edits, and miss one they have just
  // deleted without committing.
  const detectedWanted = (await availableChecks(worktree.path, dir, options.fs ?? nodeWorkspaceFs(), packageManager)).filter(
    (check) => kinds.includes(check.kind),
  );
  if (detectedWanted.length === 0) {
    return abandon('This project declares no typecheck or build that Drift could run against the upgrade.');
  }
  const current = await preflightUsableChecks(exec, detectedWanted, env, options.toolAvailability);
  const wanted = current.usable;
  if (wanted.length === 0) {
    return abandon(
      current.missing.length > 0
        ? `${describeMissingTools(current.missing)} not installed, so ${project} could not be built or tested against the upgrade.`
        : 'This project declares checks, but none of them could run in the current environment.',
    );
  }

  // A worktree is the commit and nothing else: no `node_modules`, no
  // virtualenv. Without this the very first typecheck fails on every import
  // in the project and reports the whole repository as broken by an upgrade
  // that has not even been applied yet.
  const install = manager?.install;
  if (install) {
    hooks.report(
      `Installing ${project}'s dependencies`,
      `\`${install.command} ${install.args.join(' ')}\``,
    );
    count('verify.install');
    const restored = await measure('verify', 'install', () =>
      exec(install.command, install.args, {
        cwd: dir ? `${worktree.path}/${dir}` : worktree.path,
        env,
        timeoutMs: options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
        onOutput: hooks.output,
      }),
      { project, manager: install.command },
    );
    if (restored.code !== 0) {
      const detail = (restored.stderr || restored.stdout).trim().split('\n').slice(-3).join(' ');
      return abandon(
        `\`${install.command} ${install.args.join(' ')}\` failed in a clean checkout, so there was nothing to test the upgrade against. ${detail}`.trim(),
      );
    }
  }

  if (options.token?.isCancellationRequested) return abandon('Cancelled before this upgrade could be tested.');

  // What is already red before Drift touches anything. Without this, a
  // repository with one pre-existing type error would have that error
  // attributed to every dependency in it.
  //
  // Deterministic, and therefore cacheable: the same commit with the same
  // lockfile under the same runtime has the same answer it had an hour ago, and
  // re-deriving it is a full typecheck, build and test suite spent learning
  // nothing. `baselineKey` covers every input that could change it — see
  // `baseline-cache.ts` for why each one is in there.
  const cache = options.baselineCache ?? noBaselineCache();
  const key = await cacheKeyFor(options, worktree.path, dir, packageManager, wanted);
  const remembered = key ? await cache.read(key) : null;

  let baseline: readonly (CheckOutcome | CachedCheck)[];
  if (remembered) {
    count('verify.baseline.cached');
    hooks.report(
      `Checking ${project} as it is`,
      `reusing the baseline measured earlier for this commit (${remembered.filter((c) => c.status === 'passed').length} of ${remembered.length} checks green)`,
    );
    baseline = remembered;
  } else {
    count('verify.baseline.measured');
    const baselineRun = span('verify', 'baseline', { project, checks: wanted.length });
    hooks.report(`Checking ${project} as it is`, `${wanted.map((check) => check.label).join(', ')}`);
    const measured = await runChecks({
      root: worktree.path,
      dir,
      checks: wanted,
      env,
      exec,
      // Named per check rather than left as one undifferentiated phase: a
      // typecheck, a build and a test suite are different waits with different
      // reasons to be slow, and "Checking" covering all three is the reason
      // this looked stuck.
      onProgress: (check) => hooks.report(`Checking ${project} as it is`, `\`${check.label}\``),
      onOutput: (_check, chunk) => hooks.output(chunk),
      ...(options.token ? { token: options.token } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    baselineRun.end();
    baseline = measured;
    // Never a cancelled run: a check abandoned halfway is not a measurement of
    // anything, and remembering it would skip the real one for a week.
    if (key && !options.token?.isCancellationRequested) await cache.write(key, measured);
  }

  const usable = wanted.filter((check) => baseline.some((o) => o.label === check.label && o.status === 'passed'));
  if (usable.length === 0) return abandon(describeUnusableBaseline(baseline));

  return { ok: true, worktree, usable, manager, notes };
}

/**
 * The identity of this group's baseline, or `null` when it cannot be pinned down.
 *
 * `null` on any doubt, and every path to it is a case where a key would be a
 * claim the inputs do not support: no commit to name, or a manifest that could
 * not be read. A hash that quietly skipped an unreadable lockfile would match
 * across the very change it failed to see, which is worse than not caching.
 */
async function cacheKeyFor(
  options: ProbeOptions,
  worktreePath: string,
  dir: string,
  packageManager: PackageManagerId,
  checks: readonly LocalCheck[],
): Promise<string | null> {
  if (!options.baselineCache) return null;

  const exec = options.exec ?? execCommand;
  const env = scrubEnv(options.env ?? process.env);
  const head = await exec('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, env }).catch(() => null);
  if (!head || head.code !== 0) return null;

  // Read from the worktree, which is the tree the checks will actually run in —
  // including any uncommitted manifest or lockfile carried over into it. That
  // is the case `head` alone gets wrong.
  const fs = options.fs ?? nodeWorkspaceFs();
  const base = dir ? `${worktreePath}/${dir}` : worktreePath;
  const entries = await fs.readDirectory(base).catch(() => []);
  const interesting = entries.filter((name) => MANIFEST_PATTERN.test(name)).sort();
  if (interesting.length === 0) return null;

  const files: { path: string; content: string }[] = [];
  for (const name of interesting) {
    const content = await fs.readFile(`${base}/${name}`).catch(() => null);
    // An unreadable manifest is exactly the input that must not be silently
    // dropped from the hash.
    if (content === null) return null;
    files.push({ path: name, content });
  }

  return baselineKey({
    head: head.stdout.trim(),
    dir,
    packageManager,
    kinds: checks.map((check) => check.kind),
    files,
    runtime: `${process.version}/${process.platform}/${process.arch}`,
  });
}

/**
 * Files whose contents decide what an install produces.
 *
 * Manifests and lockfiles across every ecosystem Drift supports, matched by
 * name rather than enumerated per package manager: a group is keyed on
 * everything in its directory that could change the answer, and a name this
 * misses is a cache hit it should not have had.
 */
const MANIFEST_PATTERN =
  /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|pyproject\.toml|setup\.py|setup\.cfg|requirements[^/]*\.txt|poetry\.lock|uv\.lock|Pipfile(\.lock)?|go\.mod|go\.sum|Cargo\.(toml|lock)|Gemfile(\.lock)?|[^/]*\.gemspec|pom\.xml|build\.gradle(\.kts)?|gradle\.lockfile|build\.sbt|composer\.(json|lock)|mix\.(exs|lock)|pubspec\.(yaml|lock)|Package\.(swift|resolved)|Podfile(\.lock)?|[^/]*\.opam|conanfile\.(txt|py)|conan\.lock|vcpkg\.json|platformio\.ini|library\.properties|.*\.csproj|.*\.fsproj|packages\.lock\.json)$/i;

/**
 * A checkout being prepared ahead of the packages that will need it.
 *
 * `take` hands over the preparation for one directory, waiting on it if it is
 * still running. Each is handed out exactly once — a second `take` for the
 * same directory gets a fresh preparation, since the first caller now owns
 * that worktree and will dispose of it.
 */
export interface ProbeWarmup {
  take(dir: string, packageManager: PackageManagerId): Promise<Preparation> | undefined;
  /** Throw away anything prepared that nobody ever took. Never throws. */
  dispose(): Promise<void>;
}

/**
 * Start preparing test checkouts now, for a probe that will happen later.
 *
 * This is the single largest thing standing between a developer and a scan
 * result. Preparation is a `git worktree add`, a full dependency install, and
 * a baseline typecheck/build/test — minutes of disk and CPU — and it depends
 * on nothing the scan learns from the network. The analysis it used to wait
 * behind is the opposite: registry lookups, changelog fetches, type-declaration
 * downloads, all latency and no local work. Running them at the same time
 * costs nothing but a little memory and takes the *sum* of the two phases down
 * to roughly the longer of them.
 *
 * Every failure is captured rather than thrown, so a warmup that could not
 * prepare anything simply produces the same `skipped` verdict the probe would
 * have produced on its own.
 */
export function warmProbe(
  options: ProbeOptions,
  dirs: readonly { dir: string; packageManager: PackageManagerId }[],
  onProgress?: (progress: ProbeProgress) => void,
): ProbeWarmup {
  const runOptions: ProbeRunOptions = { ...options, toolAvailability: createToolAvailabilityCache() };
  const pending = new Map<string, { packageManager: PackageManagerId; prepared: Promise<Preparation> }>();
  const hooks = {
    report: (phase: string, detail: string) => onProgress?.({ phase, detail, done: 0, total: 0 }),
    output: (chunk: string) => onProgress?.({ phase: '', detail: '', done: 0, total: 0, output: chunk }),
  };

  // Bounded for the same reason `probeUpgrades` bounds its groups: git worktree
  // operations briefly lock shared repository state, and a monorepo with twenty
  // members should not start twenty installs at once on one machine.
  const limit = Math.max(1, runOptions.concurrency ?? localConcurrency());
  let active = 0;
  const queue: (() => void)[] = [];

  const slot = async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };

  for (const { dir, packageManager } of dirs) {
    if (pending.has(dir)) continue;
    pending.set(dir, {
      packageManager,
      prepared: slot(() => prepareGroup(runOptions, dir, packageManager, hooks)).catch((err) => ({
        ok: false as const,
        reason: messageOf(err),
      })),
    });
  }

  return {
    take(dir, packageManager) {
      const entry = pending.get(dir);
      if (!entry) return undefined;
      // The install and the baseline are specific to the manager they were run
      // with — a checkout prepared with `npm install` proves nothing about a
      // group that pnpm owns. Mismatches should not happen (both come from the
      // same manifest scan) but the cost of being wrong is a verdict measured
      // against the wrong toolchain, so the caller prepares its own instead.
      if (entry.packageManager !== packageManager) return undefined;
      // Handed over, not shared: the caller disposes of the worktree when it
      // is done, so a second taker would be given one that is about to vanish.
      pending.delete(dir);
      return entry.prepared;
    },
    async dispose() {
      const abandoned = [...pending.values()];
      pending.clear();
      await Promise.all(
        abandoned.map(({ prepared }) =>
          prepared.then(
            (result) => (result.ok ? result.worktree.dispose() : undefined),
            () => undefined,
          ),
        ),
      );
      // `dispose` hands the directory over to be deleted rather than deleting
      // it; this is the point where the caller is entitled to assume it is gone.
      await settleWorktreeDeletions();
    },
  };
}

/** How a project is named in progress lines: its member directory, or the repository's own folder. */
function projectLabel(root: string, dir: string): string {
  return dir || basename(root) || 'the repository';
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
  /** See {@link ProbeOptions.installTogether}. */
  installTogether?: (root: string, targets: readonly ProbeTarget[]) => Promise<boolean>;
  timeoutMs?: number;
  token?: CancelSignal;
}

/**
 * What one combined install-and-check pass established about a batch.
 *
 * `settled` means every candidate in it now has a verdict and the caller is
 * done with them; `inconclusive` means something in the batch is broken
 * without saying what, so the caller has to narrow it down; `contaminated`
 * means the worktree can no longer be trusted for anything.
 */
type BatchOutcome = 'settled' | 'inconclusive' | 'contaminated';

/**
 * Install the whole group and check it once.
 *
 * `settled` only when the combined run came back green: nothing failed, so
 * nothing in the batch broke anything, so each of them individually did not
 * either. Any other outcome — an install that would not resolve, a red check,
 * a cancellation — leaves every candidate unsettled, and the caller narrows the
 * batch down. A failure here is deliberately *not* reported against these
 * candidates: it says something in this batch is broken without saying what,
 * and naming the wrong package is worse than taking longer to name the right
 * one.
 *
 * The worktree is put back either way, so the caller's next pass starts from
 * the same clean baseline it would have had.
 */
async function probeTogether(
  pass: GroupPass,
  targets: readonly ProbeTarget[],
  hooks: GroupHooks,
): Promise<BatchOutcome> {
  hooks.report(
    `Testing ${targets.length} upgrades together`,
    targets.map((target) => `${target.name}@${target.selected}`).join(', '),
    targets,
  );

  const installed = await installBatch(pass, targets);

  const outcomes =
    installed && !pass.token?.isCancellationRequested
      ? await runPass(pass, hooks, `Testing ${targets.length} upgrades together`, targets, {
          // This pass is a search, not a report. Its only question is whether
          // the batch is clean, and the first red check has answered it — the
          // build and the test suite behind a failing typecheck are minutes
          // spent producing diagnostics about a batch that is about to be
          // halved and asked again. The one-at-a-time pass that produces the
          // verdict a developer reads still runs every check.
          stopOnFirstFailure: true,
        })
      : [];
  const green = outcomes.length > 0 && outcomes.every((outcome) => outcome.status === 'passed');

  const resetOk = await resetWorktree(pass);
  if (green) {
    for (const target of targets) hooks.settle(target, { ...verdictFrom(outcomes), measuredWith: targets.length });
    return 'settled';
  }

  // The batch was red (or never installed), so the caller is about to reuse
  // this same worktree to narrow the failure down. If the reset back to a
  // clean checkout did not actually succeed, that worktree still carries
  // whatever this batch installed — a later pass on top of it would test each
  // candidate alongside residue from every other one, exactly the cross-
  // contamination a throwaway worktree exists to prevent. Settling every
  // target here, instead of falling through, keeps that dirty tree from being
  // reused.
  if (!resetOk) {
    for (const target of targets) {
      hooks.settle(
        target,
        skipped(
          'The test checkout could not be reset to a clean state after testing these upgrades together, so they could not be attributed individually.',
        ),
      );
    }
    return 'contaminated';
  }

  return 'inconclusive';
}

/**
 * Apply every upgrade in the batch, in as few package-manager runs as the
 * ecosystem allows.
 *
 * One `npm install a@1 b@2 c@3` rather than three: the resolver runs once over
 * a graph that is the same in either case, and the lockfile is written once. A
 * manifest with twenty outdated packages used to spend most of this phase
 * re-resolving it, before a single check had run.
 *
 * Which one failed is deliberately not established here, whichever path ran.
 * Narrowing the batch down is about to install each candidate on its own and
 * will report the real reason against the candidate it belongs to.
 */
async function installBatch(pass: GroupPass, targets: readonly ProbeTarget[]): Promise<boolean> {
  if (pass.token?.isCancellationRequested) return false;
  count('verify.install');
  const batch = span('verify', 'install', { packages: targets.length });
  try {
    return await installBatchInner(pass, targets);
  } finally {
    batch.end();
  }
}

async function installBatchInner(pass: GroupPass, targets: readonly ProbeTarget[]): Promise<boolean> {

  if (pass.installTogether) {
    try {
      if (await pass.installTogether(pass.root, targets)) return true;
    } catch {
      return false;
    }
    // Declined rather than failed — this manager takes one package at a time.
  }

  for (const target of targets) {
    if (pass.token?.isCancellationRequested) return false;
    try {
      await target.install(pass.root);
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * The group's usable checks, run against whatever is installed right now.
 *
 * `phase` is what the caller is already showing, so each check can say which
 * of them is running without inventing a competing label — "Testing react@19.2
 * — `npm run build`" rather than a phase that sits unchanged for the length of
 * a typecheck, a build and a suite.
 */
function runPass(
  pass: GroupPass,
  hooks?: GroupHooks,
  phase?: string,
  about?: readonly ProbeTarget[],
  options?: { stopOnFirstFailure?: boolean },
): Promise<CheckOutcome[]> {
  count('verify.checkPass');
  return measure('verify', 'checks', () => runChecks({
    root: pass.root,
    dir: pass.dir,
    checks: pass.usable,
    env: pass.env,
    exec: pass.exec,
    ...(options?.stopOnFirstFailure ? { stopOnFirstFailure: true } : {}),
    ...(hooks && phase
      ? { onProgress: (check: LocalCheck) => hooks.report(phase, `\`${check.label}\``, about) }
      : {}),
    ...(hooks ? { onOutput: (_check: LocalCheck, chunk: string) => hooks.output(chunk) } : {}),
    ...(pass.token ? { token: pass.token } : {}),
    ...(pass.timeoutMs ? { timeoutMs: pass.timeoutMs } : {}),
  }));
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
  /** See {@link WorktreeOptions.allowedGlobs} — `config.verify.generatedSourceGlobs`. */
  allowedGlobs?: readonly string[];
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
    worktree = await createWorktree(options.workspace, `change-${short(sha)}`, {
      at: sha,
      exec,
      env,
      ...(options.allowedGlobs ? { allowedGlobs: options.allowedGlobs } : {}),
    });
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
  count('verify.reset');
  const reset = span('verify', 'reset');
  try {
    return await resetWorktreeInner(pass);
  } finally {
    reset.end();
  }
}

async function resetWorktreeInner(pass: GroupPass): Promise<boolean> {
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

  const skippedOutcomes = outcomes.filter((outcome) => outcome.status === 'not-run' || outcome.status === 'cancelled');
  if (skippedOutcomes.length > 0) {
    return {
      status: 'skipped',
      reason: skippedOutcomes.some((outcome) => outcome.status === 'cancelled')
        ? 'Cancelled before this upgrade could be tested.'
        : (skippedOutcomes.find((outcome) => outcome.reason)?.reason ??
          'One or more project checks could not run against this upgrade.'),
      checks: [...outcomes],
      failedFiles: [],
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
/**
 * Accepts a cached baseline as readily as a freshly measured one — the reason a
 * baseline is unusable does not depend on whether it was just re-derived. A
 * cached entry carries `reason` in place of the full output for exactly this,
 * so the sentence a developer reads is the same either way.
 */
function describeUnusableBaseline(baseline: readonly BaselineLike[]): string {
  const failing = baseline.filter((outcome) => outcome.status === 'failed');
  if (failing.length > 0) {
    const labels = failing.map((outcome) => outcome.label);
    // The label alone ("`build` already fails") tells a developer that
    // something is wrong and nothing about what — which, for a check that
    // passes in their own terminal, reads as Drift being wrong rather than
    // as a real difference between their checkout and the worktree's. The
    // command and its actual output are what let them tell those apart.
    const detail = failing
      .map((outcome) => `$ ${outcome.label}\n${(outcome.output ?? outcome.reason ?? '').trim() || '(no output captured)'}`)
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

/**
 * Gitignored files, named the way the reader can act on them.
 *
 * The file paths themselves are what a developer can open, check, and decide
 * about — `backend/server.key` answers "which file?" outright, where the rule
 * that matched it is one indirection away from the answer and, for a rule
 * that is simply the path spelled again, exactly the same string with
 * `.gitignore:6:` bolted on the front.
 *
 * The rule is still the better summary past a handful of files, because that
 * is the point where the paths stop being a list and become a wall — a single
 * `dist/` can match hundreds — and where "which rule do I change" is the
 * question actually being asked.
 */
function describeIgnored(files: readonly string[], rules: readonly string[]): string {
  const count = `${files.length} gitignored file${files.length === 1 ? '' : 's'}`;
  if (files.length === 0) return count;
  if (files.length <= NAMED_IGNORED_FILES) return `${count} (${files.join(', ')})`;

  const named = files.slice(0, NAMED_IGNORED_FILES).join(', ');
  const rest = rules.length > 0 ? `, matching: ${rules.join(', ')}` : '';
  return `${count} (${named}, and ${files.length - NAMED_IGNORED_FILES} more${rest})`;
}

/**
 * How many gitignored paths to name before falling back to the rules.
 *
 * Four fits on one line in the panel and covers the shape this message is
 * usually about — a certificate, a key, a generated config — without letting
 * one broad rule turn a progress line into a directory listing.
 */
const NAMED_IGNORED_FILES = 4;

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
