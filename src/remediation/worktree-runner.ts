import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommitUnit, RemediationPlan, RepoContext } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { FixAgent, FileSnapshot } from '../agents/types.js';
import { changedPaths, validateAgentWorktree } from '../agents/scope.js';
import type { Logger } from '../util/logger.js';
import { execCommand, type Exec } from '../util/exec.js';
import { applyBuiltinCodemod, applyCommitFixPlan } from './apply.js';
import { planForCommits } from './partition.js';
import { renderFixPlanDocument } from '../fixplan/document.js';
import type { FixPlanAssessment } from '../fixplan/schema.js';

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
