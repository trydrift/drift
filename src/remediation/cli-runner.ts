import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommitUnit, RemediationPlan, RepoContext } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import { execCommand, type Exec } from '../util/exec.js';
import { applyBuiltinCodemod, applyCommitFixPlan } from './apply.js';
import { planForCommits } from './partition.js';
import { dispositionFor } from '../fixplan/policy.js';
import { renderFixPlanDocument } from '../fixplan/document.js';
import type { FixPlanAssessment } from '../fixplan/schema.js';
import { ask as defaultAsk } from '../util/prompt.js';
import { CopilotCloudAgent } from '../agents/copilot-cloud.js';

/**
 * `drift fix`: apply a plan's commits through the same three-tier priority
 * every surface shares — Drift's own codemod, then a validated deterministic
 * fix plan, then an AI agent — in an isolated git worktree, so the
 * developer's working tree is never touched regardless of what the run does.
 *
 * The interactive step is the fix plan review. A plan is a rule plus a
 * document describing exactly what it will do to every call site, which is
 * something a developer can meaningfully accept or decline *before* anything
 * happens — unlike an agent's output, which can only be reviewed afterwards.
 * `--plan` stops after printing those documents; the default prints each one
 * and asks; `--non-interactive` applies whatever `dispositionFor` clears for
 * unattended use and leaves the rest to an agent.
 *
 * The CLI has no local interactive agent of its own (that is the VS Code
 * extension's job, built around the editor's document model and a
 * webview-rendered chat). For commits no deterministic path resolved, this
 * reuses the same Copilot cloud-agent dispatch the GitHub Action already
 * uses — one AI integration, not two.
 */

export interface FixOptions {
  repo: RepoContext;
  plan: RemediationPlan;
  config: DriftConfig;
  logger: Logger;
  workspace: string;
  copilotToken?: string;
  /**
   * Print every fix plan document and stop without applying anything.
   *
   * The read-only half of `fix`, and the reason a plan is worth having as a
   * document rather than only as a mechanism: a developer can read exactly
   * what would happen to every call site, and to which call sites nothing
   * would happen, before granting any of it.
   */
  planOnly?: boolean;
  /** Never prompt; apply only what `dispositionFor` clears unattended. */
  nonInteractive?: boolean;
  exec?: Exec;
  ask?: (question: string, options: string[]) => Promise<string>;
}

export interface FixRunResult {
  branch: string;
  builtinResolved: number;
  fixPlanResolved: number;
  /** Fix plan documents, in plan order — printed by `--plan` and after a run. */
  documents: string[];
  /**
   * Commits still needing an agent, including ones whose fix plan was applied
   * but left residual call sites. A plan covering nine of ten sites resolves
   * nine; the tenth is real work and must not vanish because the commit
   * counted as deterministically handled.
   */
  needsAgent: CommitUnit[];
  pushed: boolean;
  worktree: string;
}

/**
 * Run the fix flow inside a disposable worktree. The caller is responsible
 * for pushing the branch (if `pushed` — i.e. anything was committed) and for
 * dispatching `needsAgent` to Copilot, then for cleanup: `teardown()` must be
 * called (in a `finally`) regardless of outcome.
 */
export async function runFix(options: FixOptions): Promise<FixRunResult & { teardown: () => Promise<void> }> {
  const { repo, plan, config, logger, workspace } = options;
  const exec = options.exec ?? execCommand;
  const nonInteractive = options.nonInteractive ?? !process.stdin.isTTY;

  const worktree = await createWorktree(workspace, plan.branchName, repo.afterSha, exec);

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
      if (outcome === 'no-changes') {
        // Genuinely nothing to apply (already applied by an earlier commit,
        // or the file moved out from under it) — nothing more this commit
        // needs, and it must not be reported as unresolved work.
        continue;
      }
      // The codemod produced edits but they could not be committed to disk
      // (e.g. `git add`/`git commit` failed) — this commit is not resolved
      // and must not be silently dropped; it needs an agent's attention the
      // same way the GitHub Action path (`local-commit.ts`) falls back.
      needsAgent.push(commit);
      continue;
    }

    if (commit.fixPlan) {
      const assessment = assessmentOf(commit);
      const document = renderFixPlanDocument(assessment);
      documents.push(document);

      // `--plan` is the whole read-only half of this command: print what
      // would happen and stop, without a worktree edit or a commit.
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
          // A partially covering plan leaves real work behind. The commit is
          // resolved for its covered sites and still needs an agent for the
          // rest — reporting it as fully handled is how a call site silently
          // never gets fixed.
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
    teardown: () => removeWorktree(workspace, worktree, exec),
  };
}

/**
 * Rebuild the assessment a commit's attached plan came from.
 *
 * `CommitUnit.fixPlan` is the serialization-safe subset that survives being
 * written into a stored plan; `dispositionFor` and the document renderer both
 * read the fuller shape. Reconstructing it here keeps one policy function and
 * one renderer rather than a second pair that take the narrower type and
 * gradually disagree with the first.
 */
function assessmentOf(commit: CommitUnit): FixPlanAssessment {
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

/**
 * Show the plan and decide.
 *
 * A terminal can ask, so it asks — a fix plan is precisely the artefact worth
 * asking about, because the question ("may Drift make this exact edit to
 * these exact lines?") is answerable in advance. Non-interactive runs fall
 * back to `dispositionFor` alone, which is the same answer the Action would
 * reach for the same config, so a CI `drift fix` and a `drift action` run do
 * not quietly differ.
 */
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

/** Dispatch commits the deterministic paths could not resolve to Copilot. */
export async function dispatchRemainingToCopilot(options: {
  copilotToken: string;
  repo: RepoContext;
  plan: RemediationPlan;
  commits: readonly CommitUnit[];
  config: DriftConfig;
  logger: Logger;
}): Promise<{ ok: boolean; error?: string }> {
  if (options.commits.length === 0) return { ok: true };
  const agentPlan = planForCommits(options.plan, options.commits);
  const agent = new CopilotCloudAgent({
    repo: options.repo,
    config: options.config,
    token: options.copilotToken,
    logger: options.logger,
  });
  const result = await agent.run(
    {
      plan: agentPlan,
      commit: agentPlan.commits[0]!,
      workspaceRoot: options.repo.workspace ?? '',
      files: [],
      customInstructions: options.config.remediation.customInstructions,
      model: options.config.remediation.agent.model ?? options.config.remediation.model,
      effort: options.config.remediation.agent.effort,
      fast: options.config.remediation.agent.fast,
    },
    { report: (message) => options.logger.info(message), signal: new AbortController().signal },
  );
  return result.status === 'failed' ? { ok: false, error: result.message } : { ok: true };
}

async function applyBuiltinCommit(
  worktree: string,
  commit: CommitUnit,
  exec: Exec,
): Promise<'applied' | 'no-changes' | 'failed'> {
  const contents = new Map<string, string>();
  for (const file of commit.files) {
    try {
      contents.set(file, await readFile(join(worktree, file), 'utf8'));
    } catch {
      // Missing file — skipped by applyBuiltinCodemod.
    }
  }

  const result = applyBuiltinCodemod(commit, contents);
  if (result.status !== 'applied') return 'no-changes';

  for (const edit of result.edits) {
    await writeFile(join(worktree, edit.path), edit.content, 'utf8');
  }

  const committed = await commitFiles(worktree, result.edits.map((e) => e.path), `${commit.message}\n\n${commit.body}`, exec);
  return committed ? 'applied' : 'failed';
}

/**
 * Apply a commit's validated fix plan in the worktree and commit it.
 *
 * The commit message carries the plan document itself, not a summary of it.
 * A `git log` entry that says "applied a deterministic fix" is exactly the
 * unclear artefact this tier exists to replace — the rule, its evidence, and
 * the call sites it declined belong in the history alongside the diff.
 */
async function applyFixPlanCommit(
  worktree: string,
  commit: CommitUnit,
  exec: Exec,
): Promise<'applied' | 'no-changes' | 'failed'> {
  const contents = new Map<string, string>();
  for (const file of commit.fixPlan?.files ?? []) {
    try {
      contents.set(file, await readFile(join(worktree, file), 'utf8'));
    } catch {
      // Missing file — skipped by applyCommitFixPlan.
    }
  }

  const result = applyCommitFixPlan(commit, contents);
  if (result.status !== 'applied') return 'no-changes';

  for (const edit of result.edits) {
    await writeFile(join(worktree, edit.path), edit.content, 'utf8');
  }

  const committed = await commitFiles(
    worktree,
    result.edits.map((e) => e.path),
    [commit.message, '', commit.body, '', result.message, '', renderFixPlanDocument(assessmentOf(commit), { sites: false, headingLevel: 2 })].join('\n'),
    exec,
  );
  return committed ? 'applied' : 'failed';
}

async function commitFiles(worktree: string, files: readonly string[], message: string, exec: Exec): Promise<boolean> {
  if (files.length === 0) return false;
  const add = await exec('git', ['add', '--', ...files], { cwd: worktree });
  if (add.code !== 0) return false;
  const commit = await exec('git', ['commit', '-m', message], { cwd: worktree });
  return commit.code === 0;
}

async function createWorktree(workspace: string, branch: string, atSha: string, exec: Exec): Promise<string> {
  const common = await exec('git', ['rev-parse', '--git-common-dir'], { cwd: workspace });
  const gitDir = common.stdout.trim() || '.git';
  const dir = join(workspace, gitDir, 'drift-worktrees', branch.replace(/[^\w.-]+/g, '-'));

  // Reusing a stale worktree directory from a previous, interrupted run is
  // not safe to assume clean — remove any trace before adding a fresh one.
  await exec('git', ['worktree', 'remove', '--force', dir], { cwd: workspace });

  const result = await exec('git', ['worktree', 'add', '-B', branch, dir, atSha], { cwd: workspace });
  if (result.code !== 0) {
    throw new Error(`Could not create an isolated worktree for the fix: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return dir;
}

async function removeWorktree(workspace: string, dir: string, exec: Exec): Promise<void> {
  await exec('git', ['worktree', 'remove', '--force', dir], { cwd: workspace });
}
