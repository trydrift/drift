import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommitUnit, RemediationPlan, RepoContext } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import type { GitHubClient } from './client.js';
import { execCommand, type Exec } from '../util/exec.js';
import { remediationKindFor } from '../remediation/partition.js';
import { applyBuiltinCodemod } from '../remediation/apply.js';
import { executeCommunityRecipe } from '../remediation/execute-recipe.js';
import type { CommunityRecipeCandidate } from '../remediation/types.js';

/**
 * Apply the commits of a plan that Drift can resolve itself — built-in
 * codemod first, then (only when `remediation.communityRecipes` is enabled)
 * a matching community recipe — directly to the Action's remediation branch.
 *
 * This is what lets `dispatch()` skip Copilot entirely for a plan it can
 * fully resolve on its own, and dispatch only the commits it could not
 * resolve for the rest. Each commit is applied and committed independently,
 * in plan order, against `repo.workspace` (the Action's own checkout) — later
 * commits see earlier ones' edits on disk, the same layering the codemod
 * engine's anchor design and the VS Code extension's worktree batching both
 * already rely on. A commit this function could not safely resolve is left
 * untouched on disk and reported as unresolved so the caller can fall back
 * to an agent for it, never guessed at.
 */
export async function applyDeterministicRemediation(options: {
  repo: RepoContext;
  plan: RemediationPlan;
  config: DriftConfig;
  github: GitHubClient;
  logger: Logger;
  exec?: Exec;
}): Promise<{ committedIds: Set<string> }> {
  const { repo, plan, config, github, logger } = options;
  const exec = options.exec ?? execCommand;
  const committedIds = new Set<string>();

  if (!repo.workspace) return { committedIds };

  for (const commit of plan.commits) {
    const kind = remediationKindFor(commit, config.remediation.communityRecipes);
    if (kind === 'ai') continue;

    try {
      const resolved =
        kind === 'builtin'
          ? await applyBuiltinCommit(repo.workspace, commit)
          : await applyRecipeCommit(repo.workspace, commit, exec, logger);

      if (!resolved) {
        await revertWorkspaceFiles(repo.workspace, commit.files, exec);
        continue;
      }

      const committed = await github.commitFiles(
        repo,
        plan.branchName,
        resolved.edits,
        `${commit.message}\n\n${commit.body}`,
      );

      if (committed) {
        committedIds.add(commit.id);
        logger.info(`Resolved commit ${commit.order} directly (${kind}): ${resolved.message}`);
      } else {
        await revertWorkspaceFiles(repo.workspace, commit.files, exec);
      }
    } catch (err) {
      logger.warn(
        `Deterministic remediation failed for commit ${commit.order}, falling back to an agent: ${(err as Error).message}`,
      );
      await revertWorkspaceFiles(repo.workspace, commit.files, exec);
    }
  }

  return { committedIds };
}

async function applyBuiltinCommit(
  workspace: string,
  commit: CommitUnit,
): Promise<{ edits: { path: string; content: string }[]; message: string } | null> {
  const contents = new Map<string, string>();
  for (const file of commit.files) {
    try {
      contents.set(file, await readFile(join(workspace, file), 'utf8'));
    } catch {
      // Missing file — applyBuiltinCodemod skips anything it wasn't given.
    }
  }

  const result = applyBuiltinCodemod(commit, contents);
  if (result.status !== 'applied') return null;

  for (const edit of result.edits) {
    await writeFile(join(workspace, edit.path), edit.content, 'utf8');
  }

  return { edits: result.edits, message: result.message };
}

async function applyRecipeCommit(
  workspace: string,
  commit: CommitUnit,
  exec: Exec,
  logger: Logger,
): Promise<{ edits: { path: string; content: string }[]; message: string } | null> {
  const recipes = dedupeRecipes(commit.recipe ?? []);
  if (recipes.length === 0) return null;

  const allowed = new Set([...commit.allowedFiles, ...commit.files]);
  const touched = new Set<string>();
  const messages: string[] = [];

  for (const recipe of recipes) {
    const result = await executeCommunityRecipe(recipe, workspace, { exec, logger });
    if (result.status === 'failed') {
      logger.warn(`Community recipe ${recipe.name}@${recipe.version} failed: ${result.message}`);
      return null;
    }
    for (const file of result.changedFiles) touched.add(file);
    if (result.status === 'applied') messages.push(result.message);
  }

  if (touched.size === 0) return null;

  // Scope enforcement: a recipe is never trusted to stay inside the commit's
  // declared files the way a built-in codemod is proven to. Any edit outside
  // scope voids the whole commit rather than being partially accepted.
  const outOfScope = [...touched].filter((file) => !allowed.has(file));
  if (outOfScope.length > 0) {
    logger.warn(
      `Community recipe for commit ${commit.order} touched file(s) outside its scope (${outOfScope.join(', ')}); discarding and falling back to an agent.`,
    );
    return null;
  }

  const edits: { path: string; content: string }[] = [];
  for (const file of touched) {
    try {
      edits.push({ path: file, content: await readFile(join(workspace, file), 'utf8') });
    } catch {
      // Deleted by the recipe — nothing to commit for this path.
    }
  }

  if (edits.length === 0) return null;

  return { edits, message: messages.join(' ') || 'Applied community recipe(s).' };
}

function dedupeRecipes(recipes: readonly CommunityRecipeCandidate[]): CommunityRecipeCandidate[] {
  const seen = new Map<string, CommunityRecipeCandidate>();
  for (const recipe of recipes) {
    seen.set(`${recipe.provider}:${recipe.name}@${recipe.version}`, recipe);
  }
  return [...seen.values()];
}

async function revertWorkspaceFiles(workspace: string, files: readonly string[], exec: Exec): Promise<void> {
  if (files.length === 0) return;
  await exec('git', ['checkout', '--', ...files], { cwd: workspace });
}
