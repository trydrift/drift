import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommitUnit, RemediationPlan, RepoContext } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import { UPGRADE_UNIT_ID, type FixAgent, type FileSnapshot } from '../agents/types.js';
import { changedPaths, DEFAULT_PROTECTED_PATHS, validateAgentWorktree, validateUpgradeFix, type UpgradeFixOffender } from '../agents/scope.js';
import type { Logger } from '../util/logger.js';
import { execCommand, type Exec } from '../util/exec.js';
import { applyBuiltinCodemod, applyCommitFixPlan } from './apply.js';
import { planForCommits } from './partition.js';
import { renderFixPlanDocument } from '../fixplan/document.js';
import type { FixPlanAssessment } from '../fixplan/schema.js';
import { dispositionFor } from '../fixplan/policy.js';
import { ask as defaultAsk, canPrompt } from '../util/prompt.js';

export interface WorktreeRunOptions {
  repo: RepoContext;
  plan: RemediationPlan;
  workspace: string;
  exec?: Exec;
}

export interface WorktreeAgentRunOptions {
  repo: RepoContext;
  plan: RemediationPlan;
  config: DriftConfig;
  worktree: string;
  commits: readonly CommitUnit[];
  agent: FixAgent;
  logger: Logger;
  exec?: Exec;
}

export interface WorktreeAgentFailure {
  commit: CommitUnit;
  message: string;
}

export interface WorktreeAgentRunResult {
  resolved: CommitUnit[];
  unresolved: WorktreeAgentFailure[];
  committed: boolean;
}

export interface WorktreeRemediationOptions {
  repo: RepoContext;
  plan: RemediationPlan;
  config: DriftConfig;
  logger: Logger;
  workspace: string;
  planOnly?: boolean;
  nonInteractive?: boolean;
  exec?: Exec;
  ask?: (question: string, options: string[]) => Promise<string>;
}

export interface WorktreeRemediationResult {
  branch: string;
  builtinResolved: number;
  fixPlanResolved: number;
  documents: string[];
  needsAgent: CommitUnit[];
  pushed: boolean;
  worktree: string;
}

export async function runWorktreeRemediation(
  options: WorktreeRemediationOptions,
): Promise<WorktreeRemediationResult & { teardown: () => Promise<void> }> {
  const { repo, plan, config, logger, workspace } = options;
  const exec = options.exec ?? execCommand;
  const nonInteractive = options.nonInteractive ?? !canPrompt();

  const worktree = await createRemediationWorktree({ repo, plan, workspace, exec });

  let builtinResolved = 0;
  let fixPlanResolved = 0;
  const documents: string[] = [];
  const needsAgent: CommitUnit[] = [];
  let committedAny = false;

  for (const commit of plan.commits) {
    if (commit.codemod) {
      const outcome = await applyBuiltinCommit(worktree, commit, exec);
      if (outcome === 'applied') {
        builtinResolved += 1;
        committedAny = true;
        continue;
      }
      if (outcome === 'no-changes') continue;
      needsAgent.push(commit);
      continue;
    }

    if (commit.fixPlan) {
      const assessment = assessmentOf(commit);
      const document = renderFixPlanDocument(assessment);
      documents.push(document);

      if (options.planOnly) {
        if (commit.fixPlan.residual > 0) needsAgent.push(commit);
        continue;
      }

      const disposition = dispositionFor(assessment, config, {
        verificationPassed: plan.verification?.status === 'passed',
      });

      const approved = await shouldApplyFixPlan({
        disposition,
        document,
        nonInteractive,
        ask: options.ask,
      });

      if (approved) {
        const outcome = await applyFixPlanCommit(worktree, commit, exec);
        if (outcome === 'applied') {
          fixPlanResolved += 1;
          committedAny = true;
          if (commit.fixPlan.residual > 0) needsAgent.push(commit);
          continue;
        }
        if (outcome === 'no-changes') continue;
        logger.warn(`The fix plan for commit ${commit.order} could not be committed; falling back to an agent.`);
      }
    }

    needsAgent.push(commit);
  }

  return {
    branch: plan.branchName,
    builtinResolved,
    fixPlanResolved,
    documents,
    needsAgent,
    pushed: committedAny,
    worktree,
    teardown: () => removeRemediationWorktree(workspace, worktree, exec),
  };
}

export async function createRemediationWorktree(options: WorktreeRunOptions): Promise<string> {
  const exec = options.exec ?? execCommand;
  const common = await exec('git', ['rev-parse', '--git-common-dir'], { cwd: options.workspace });
  const gitDir = common.stdout.trim() || '.git';
  const dir = join(options.workspace, gitDir, 'drift-worktrees', options.plan.branchName.replace(/[^\w.-]+/g, '-'));

  await exec('git', ['worktree', 'remove', '--force', dir], { cwd: options.workspace });

  const result = await exec('git', ['worktree', 'add', '-B', options.plan.branchName, dir, options.repo.afterSha], {
    cwd: options.workspace,
  });
  if (result.code !== 0) {
    throw new Error(`Could not create an isolated worktree for the fix: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return dir;
}

export async function removeRemediationWorktree(workspace: string, dir: string, exec: Exec = execCommand): Promise<void> {
  await exec('git', ['worktree', 'remove', '--force', dir], { cwd: workspace });
}

export async function applyBuiltinCommit(
  worktree: string,
  commit: CommitUnit,
  exec: Exec = execCommand,
): Promise<'applied' | 'no-changes' | 'failed'> {
  const contents = new Map<string, string>();
  for (const file of commit.files) {
    try {
      contents.set(file, await readFile(join(worktree, file), 'utf8'));
    } catch {
      // Missing file: the codemod skips it.
    }
  }

  const result = applyBuiltinCodemod(commit, contents);
  if (result.status !== 'applied') return 'no-changes';

  for (const edit of result.edits) {
    await writeFile(join(worktree, edit.path), edit.content, 'utf8');
  }

  const committed = await commitFiles(worktree, result.edits.map((edit) => edit.path), `${commit.message}\n\n${commit.body}`, exec);
  return committed ? 'applied' : 'failed';
}

export async function applyFixPlanCommit(
  worktree: string,
  commit: CommitUnit,
  exec: Exec = execCommand,
): Promise<'applied' | 'no-changes' | 'failed'> {
  const contents = new Map<string, string>();
  for (const file of commit.fixPlan?.files ?? []) {
    try {
      contents.set(file, await readFile(join(worktree, file), 'utf8'));
    } catch {
      // Missing file: the fix-plan applier skips it.
    }
  }

  const result = applyCommitFixPlan(commit, contents);
  if (result.status !== 'applied') return 'no-changes';

  for (const edit of result.edits) {
    await writeFile(join(worktree, edit.path), edit.content, 'utf8');
  }

  const committed = await commitFiles(
    worktree,
    result.edits.map((edit) => edit.path),
    [commit.message, '', commit.body, '', result.message, '', renderFixPlanDocument(assessmentOf(commit), { sites: false, headingLevel: 2 })].join('\n'),
    exec,
  );
  return committed ? 'applied' : 'failed';
}

export async function runAgentCommitsInWorktree(options: WorktreeAgentRunOptions): Promise<WorktreeAgentRunResult> {
  const exec = options.exec ?? execCommand;
  const resolved: CommitUnit[] = [];
  const unresolved: WorktreeAgentFailure[] = [];
  let committed = false;

  if (options.agent.capabilities.execution !== 'workspace') {
    return {
      resolved,
      unresolved: options.commits.map((commit) => ({
        commit,
        message: `${options.agent.label} is a cloud agent and cannot run inside Drift's transactional worktree runner.`,
      })),
      committed,
    };
  }

  for (const commit of options.commits) {
    const baseline = await currentHead(options.worktree, exec);
    options.logger.info(`Running ${options.agent.label} for commit ${commit.order} in an isolated worktree.`);

    const result = await options.agent.run(
      {
        plan: planForCommits(options.plan, [commit]),
        commit,
        workspaceRoot: options.worktree,
        files: await snapshotsForCommit(options.worktree, commit),
        customInstructions: options.config.remediation.customInstructions,
        model: options.config.remediation.agent.model ?? options.config.remediation.model,
        effort: options.config.remediation.agent.effort,
        fast: options.config.remediation.agent.fast,
      },
      { report: (message) => options.logger.info(message), signal: new AbortController().signal },
    );

    if (result.status === 'failed') {
      await resetAttempt(options.worktree, baseline, exec);
      unresolved.push({ commit, message: result.message });
      continue;
    }

    const validation = await validateAgentWorktree({
      root: options.worktree,
      baselineRef: baseline,
      commit,
    });

    if (!validation.ok) {
      await resetAttempt(options.worktree, baseline, exec);
      unresolved.push({ commit, message: validation.reasons.join('\n') });
      continue;
    }

    if (validation.changed.length === 0) {
      unresolved.push({ commit, message: `${options.agent.label} completed without changing any files.` });
      continue;
    }

    for (const warning of validation.warnings) options.logger.warn(warning);

    const paths = [...new Set(validation.changed.flatMap((entry) => [entry.oldPath, entry.path].filter((path): path is string => Boolean(path))))];
    const didCommit = await commitFiles(options.worktree, paths, `${commit.message}\n\n${commit.body}`, exec);
    if (!didCommit) {
      await resetAttempt(options.worktree, baseline, exec);
      unresolved.push({ commit, message: `Could not commit ${options.agent.label}'s accepted edits.` });
      continue;
    }

    committed = true;
    resolved.push(commit);
    if (result.warnings?.length) {
      for (const warning of result.warnings) options.logger.warn(warning);
    }
  }

  return { resolved, unresolved, committed };
}

export interface AgentUpgradeFixOptions {
  plan: RemediationPlan;
  config: DriftConfig;
  worktree: string;
  agent: FixAgent;
  logger: Logger;
  exec?: Exec;
}

export interface AgentUpgradeFixResult {
  /** `committed`: the kept edits are one commit on the worktree. */
  status: 'committed' | 'no-changes' | 'failed';
  message: string;
  /** Files whose own change broke a rule, reverted before committing. */
  reverted: UpgradeFixOffender[];
  /** Files kept. */
  kept: string[];
  warnings: string[];
}

/**
 * Fix an upgrade with one agent session over the whole repository.
 *
 * `runAgentCommitsInWorktree` hands an agent one planned unit at a time, may
 * edit only the files that unit names, and discards the unit whole if any
 * rule trips. Measured on ten real upgrades against the same agent with no
 * Drift at all, that pipeline fixed none of them and the plain agent fixed
 * nearly all: six upgrades were never attempted because a measured failure
 * with no localized site produces no unit; two had every edit accepted and
 * still did not build, because the rest of the migration was in files no unit
 * could touch; two lost correct source edits because the same session also
 * touched a CI workflow.
 *
 * So this is the path a workspace agent takes for an upgrade:
 *
 *   - it runs whenever the upgrade needs work, including when Drift planned no
 *     unit, with the project's own failing output as the measured evidence;
 *   - the prompt is the plain task a developer would give the agent, not
 *     Drift's findings, which anchored it on the listed items;
 *   - the agent verifies its own work with the project's checks, since
 *     nothing here re-runs them;
 *   - each changed file is validated on its own, and only the ones that break
 *     a rule — a protected path, a weakened test or configuration, a
 *     downgraded dependency, a secret — are reverted. The rest is kept.
 *
 * The result is never less than an unconstrained agent would have produced,
 * minus exactly the edits Drift can name a reason to refuse.
 */
export async function runAgentUpgradeFix(options: AgentUpgradeFixOptions): Promise<AgentUpgradeFixResult> {
  const exec = options.exec ?? execCommand;
  const { plan, config, worktree, agent } = options;

  if (agent.capabilities.execution !== 'workspace') {
    return { status: 'failed', message: `${agent.label} is a cloud agent and cannot run in a local worktree.`, reverted: [], kept: [], warnings: [] };
  }

  // Both lists, not the configured one alone: passing any list replaces the
  // validator's defaults, and those are the paths no fix may touch whatever a
  // repository configures — `node_modules`, `.git`, `.env`. An agent in the
  // benchmark's development runs once made its checks pass by editing
  // `node_modules/logform` directly.
  const protectedPaths = upgradeFixProtectedPaths(config.guardrails.protectedPaths);
  const baseline = await currentHead(worktree, exec);
  const commit = wholeUpgradeUnit(plan);
  options.logger.info(`Running ${agent.label} on the whole upgrade.`);

  const result = await agent.run(
    {
      plan,
      commit,
      workspaceRoot: worktree,
      files: [],
      customInstructions: config.remediation.customInstructions,
      model: config.remediation.agent.model ?? config.remediation.model,
      effort: config.remediation.agent.effort,
      fast: config.remediation.agent.fast,
      diagnostics: plan.verification?.diagnostics,
      mode: 'upgrade',
      protectedPaths,
    },
    { report: (message) => options.logger.info(message), signal: new AbortController().signal },
  );

  // A session that ended badly — a timeout, a crash — can still have left a
  // correct partial migration behind, and an agent with no Drift around it
  // keeps whatever it wrote. So its edits are validated and kept on the same
  // terms as a clean finish, and the failure is reported alongside them.
  const validation = await validateUpgradeFix({
    root: worktree,
    baselineRef: baseline,
    protectedPaths,
    upgradedDependencies: plan.changes.map((change) => change.name),
  });
  for (const offender of validation.offenders) {
    await revertFile(worktree, baseline, offender, exec);
    options.logger.warn(`Reverted ${offender.path}: ${offender.reasons.join(' ')}`);
  }

  const kept = (await changedPaths(worktree)).map((entry) => entry.path);
  for (const warning of validation.warnings) options.logger.warn(warning);
  const note = result.status === 'failed' ? `${agent.label} did not finish cleanly: ${result.message}` : result.message;

  if (kept.length === 0) {
    return { status: result.status === 'failed' ? 'failed' : 'no-changes', message: note, reverted: validation.offenders, kept, warnings: validation.warnings };
  }

  const add = await exec('git', ['add', '-A'], { cwd: worktree });
  const committed = add.code === 0 && (await exec('git', ['commit', '-m', upgradeCommitMessage(plan)], { cwd: worktree })).code === 0;
  if (!committed) {
    return { status: 'failed', message: `Could not commit ${agent.label}'s edits. ${note}`, reverted: validation.offenders, kept, warnings: validation.warnings };
  }
  return { status: 'committed', message: note, reverted: validation.offenders, kept, warnings: validation.warnings };
}

/**
 * The guardrail paths, minus lockfiles. A migration that moves a companion
 * package — a bundler plugin that must match the new major, a types package
 * the new release's declarations need — changes the lockfile with the
 * manifest, and refusing that leaves the manifest and the lockfile
 * disagreeing. Reverting or downgrading the upgraded dependency itself is
 * still refused, by the manifest check.
 */
export function upgradeProtectedPaths(paths: readonly string[]): string[] {
  return paths.filter((pattern) => !/(^|\/|\*)(\*\.lock|[\w-]*lock[\w.-]*\.(json|yaml|yml)|yarn\.lock)$/i.test(pattern));
}

/**
 * The paths a whole-upgrade fix may never keep an edit to: the validator's own
 * defaults (`node_modules`, `.git`, `.env`, workflows) together with the
 * repository's configured guardrails — both, because passing any list to the
 * validator replaces its defaults — minus lockfiles, which a migration moves
 * with its manifest. Shared by every surface that runs a whole-upgrade fix.
 */
export function upgradeFixProtectedPaths(configured: readonly string[]): string[] {
  return [...new Set(upgradeProtectedPaths([...DEFAULT_PROTECTED_PATHS, ...configured]))];
}

export { UPGRADE_UNIT_ID } from '../agents/types.js';

/**
 * Every planned unit folded into one: the whole upgrade as a single task.
 * `layer` places it after any deterministic units a surface still runs first.
 */
export function wholeUpgradeUnit(plan: RemediationPlan, layer = 0): CommitUnit {
  const breakingChangeIds = [...new Set([
    ...plan.commits.flatMap((commit) => commit.breakingChangeIds),
    ...plan.impactSites.map((site) => site.breakingChangeId),
  ])];
  const files = [...new Set(plan.impactSites.map((site) => site.file))];
  return {
    id: UPGRADE_UNIT_ID,
    order: 1,
    message: upgradeCommitMessage(plan),
    body: '',
    breakingChangeIds,
    files,
    allowedFiles: files,
    instructions: 'Make this repository work with the upgraded dependencies.',
    dependsOn: [],
    dependencyReasons: [],
    executionLayer: layer,
    expectedChecks: [],
    invalidationTriggers: [],
  };
}

function upgradeCommitMessage(plan: RemediationPlan): string {
  const moved = plan.changes.filter((change) => change.to).map((change) => `${change.name} ${change.to}`);
  return `fix(deps): migrate to ${moved.join(', ') || 'the upgraded dependencies'}`;
}

async function revertFile(worktree: string, baseline: string, offender: UpgradeFixOffender, exec: Exec): Promise<void> {
  for (const path of [offender.path, offender.oldPath].filter((p): p is string => Boolean(p))) {
    const existed = (await exec('git', ['cat-file', '-e', `${baseline}:${path}`], { cwd: worktree })).code === 0;
    if (existed) await exec('git', ['checkout', baseline, '--', path], { cwd: worktree });
    else await exec('git', ['rm', '-rf', '--cached', '--ignore-unmatch', '--', path], { cwd: worktree }).then(() => exec('rm', ['-rf', '--', path], { cwd: worktree }));
  }
}

export function assessmentOf(commit: CommitUnit): FixPlanAssessment {
  const fixPlan = commit.fixPlan!;
  return {
    plan: fixPlan.plan,
    verdict: fixPlan.residual === 0 ? 'accepted' : 'partial',
    assurance: fixPlan.assurance,
    sites: fixPlan.residualSites.map((site) => ({
      file: site.file,
      line: site.line,
      before: '',
      status: 'residual' as const,
      reason: site.reason,
    })),
    covered: fixPlan.covered,
    residual: fixPlan.residual,
    rejections: [],
    anchors: fixPlan.anchors,
  };
}

export async function commitFiles(worktree: string, files: readonly string[], message: string, exec: Exec = execCommand): Promise<boolean> {
  if (files.length === 0) return false;
  const add = await exec('git', ['add', '--', ...files], { cwd: worktree });
  if (add.code !== 0) return false;
  const commit = await exec('git', ['commit', '-m', message], { cwd: worktree });
  return commit.code === 0;
}

async function snapshotsForCommit(worktree: string, commit: CommitUnit): Promise<FileSnapshot[]> {
  const paths = [...new Set(commit.allowedFiles?.length ? commit.allowedFiles : commit.files)];
  const snapshots: FileSnapshot[] = [];
  for (const path of paths) {
    try {
      snapshots.push({ path, content: await readFile(join(worktree, path), 'utf8') });
    } catch {
      // A deleted or generated file may still be a valid migration target.
    }
  }
  return snapshots;
}

async function currentHead(worktree: string, exec: Exec): Promise<string> {
  const result = await exec('git', ['rev-parse', 'HEAD'], { cwd: worktree });
  if (result.code !== 0) throw new Error(`Could not read worktree HEAD: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim() || 'HEAD';
}

async function resetAttempt(worktree: string, baseline: string, exec: Exec): Promise<void> {
  await exec('git', ['reset', '--hard', baseline], { cwd: worktree });
  await exec('git', ['clean', '-fd'], { cwd: worktree });
}

export async function worktreeHasChanges(worktree: string): Promise<boolean> {
  return (await changedPaths(worktree)).length > 0;
}

async function shouldApplyFixPlan(args: {
  disposition: ReturnType<typeof dispositionFor>;
  document: string;
  nonInteractive: boolean;
  ask?: (question: string, options: string[]) => Promise<string>;
}): Promise<boolean> {
  const { disposition, nonInteractive } = args;

  if (disposition.action === 'skip') return false;
  if (nonInteractive) return disposition.action === 'apply';

  const ask = args.ask ?? defaultAsk;
  const answer = await ask(
    `${args.document}\n\n${disposition.action === 'apply' ? 'Drift can apply this without asking.' : disposition.reason}`,
    ['Apply this fix plan', 'Skip it and use AI'],
  );
  return /^apply/i.test(answer);
}
