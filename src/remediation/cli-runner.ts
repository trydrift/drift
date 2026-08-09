import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommitUnit, RemediationPlan, RepoContext } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import { execCommand, type Exec } from '../util/exec.js';
import { applyBuiltinCodemod } from './apply.js';
import { executeCommunityRecipe } from './execute-recipe.js';
import { dispatchToCopilot } from '../dispatch/copilot.js';
import { planForCommits } from './partition.js';
import type { CommunityRecipeCandidate } from './types.js';
import { ask as defaultAsk } from '../util/prompt.js';

/**
 * `drift fix`: apply a plan's commits through the same three-tier priority
 * every surface shares — Drift's own codemod, then (only when enabled) a
 * community recipe, then an AI agent — in an isolated git worktree, so the
 * developer's working tree is never touched regardless of what the run does.
 *
 * The CLI has no local interactive agent of its own (that is the VS Code
 * extension's job, built around the editor's document model and a
 * webview-rendered chat). For commits neither Drift nor a recipe can
 * resolve, this reuses the same Copilot cloud-agent dispatch the GitHub
 * Action already uses — one AI integration, not two.
 */

export interface FixOptions {
  repo: RepoContext;
  plan: RemediationPlan;
  config: DriftConfig;
  logger: Logger;
  workspace: string;
  copilotToken?: string;
  /** Explicit override; falls back to `config.remediation.communityRecipes`. */
  allowCommunityRecipes?: boolean;
  /** Never prompt; decide automatically from `allowCommunityRecipes`. */
  nonInteractive?: boolean;
  exec?: Exec;
  ask?: (question: string, options: string[]) => Promise<string>;
}

export interface FixRunResult {
  branch: string;
  builtinResolved: number;
  recipeResolved: number;
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
  const allowCommunityRecipes = options.allowCommunityRecipes ?? config.remediation.communityRecipes;
  const nonInteractive = options.nonInteractive ?? !process.stdin.isTTY;

  const worktree = await createWorktree(workspace, plan.branchName, repo.afterSha, exec);

  let builtinResolved = 0;
  let recipeResolved = 0;
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

    if (commit.recipe) {
      const candidate = commit.recipe[0]!;
      const useRecipe = await shouldUseRecipe({
        candidate,
        allowCommunityRecipes,
        nonInteractive,
        ask: options.ask,
      });

      if (useRecipe) {
        const applied = await applyRecipeCommit(worktree, commit, exec, logger);
        if (applied) {
          recipeResolved += 1;
          committedAny = true;
          continue;
        }
        logger.warn(`Community recipe for commit ${commit.order} did not apply cleanly; falling back to an agent.`);
      }
    }

    needsAgent.push(commit);
  }

  return {
    branch: plan.branchName,
    builtinResolved,
    recipeResolved,
    needsAgent,
    pushed: committedAny,
    worktree,
    teardown: () => removeWorktree(workspace, worktree, exec),
  };
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
  const result = await dispatchToCopilot({
    copilotToken: options.copilotToken,
    repo: options.repo,
    plan: agentPlan,
    config: options.config,
    logger: options.logger,
  });
  return { ok: result.ok, error: result.error };
}

async function shouldUseRecipe(args: {
  candidate: CommunityRecipeCandidate;
  allowCommunityRecipes: boolean;
  nonInteractive: boolean;
  ask?: (question: string, options: string[]) => Promise<string>;
}): Promise<boolean> {
  const { candidate, allowCommunityRecipes, nonInteractive } = args;

  if (nonInteractive) return allowCommunityRecipes;

  const ask = args.ask ?? defaultAsk;
  const answer = await ask(
    `Community recipe available:\n  ${candidate.name}@${candidate.version} — ${candidate.publisher}\n  (${candidate.migration})`,
    ['Use community recipe', 'Continue with AI'],
  );
  return /^use/i.test(answer);
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

async function applyRecipeCommit(
  worktree: string,
  commit: CommitUnit,
  exec: Exec,
  logger: Logger,
): Promise<boolean> {
  const allowed = new Set([...commit.allowedFiles, ...commit.files]);
  const touched = new Set<string>();
  const messages: string[] = [];

  for (const recipe of commit.recipe ?? []) {
    const result = await executeCommunityRecipe(recipe, worktree, { exec, logger });
    if (result.status === 'failed') return false;
    for (const file of result.changedFiles) touched.add(file);
    if (result.status === 'applied') messages.push(result.message);
  }

  if (touched.size === 0) return false;

  const outOfScope = [...touched].filter((file) => !allowed.has(file));
  if (outOfScope.length > 0) {
    logger.warn(`Community recipe touched file(s) outside commit ${commit.order}'s scope; discarding.`);
    await exec('git', ['checkout', '--', ...touched], { cwd: worktree });
    return false;
  }

  return commitFiles(
    worktree,
    [...touched],
    `${commit.message}\n\n${commit.body}\n\n${messages.join(' ')}`,
    exec,
  );
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
