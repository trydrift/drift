import { execCommand, type Exec } from '../util/exec.js';
import type { Logger } from '../util/logger.js';
import type { CommunityRecipeCandidate, RecipeExecutionResult } from './types.js';

/**
 * Run a pinned community recipe against a worktree.
 *
 * Every caller (CLI, Action, extension) is responsible for the isolation
 * around this call — an already-checked-out, disposable worktree — and for
 * everything that happens after it returns: inspecting the actual diff,
 * enforcing scope/safety checks, and running verification through the same
 * path an agent's output goes through. This function only runs the recipe
 * and reports what changed; it never decides whether the result is safe to
 * keep.
 *
 * Recipes are executed by exact pinned version, never a range or "latest" —
 * `candidate.version` is interpolated directly into the package spec passed
 * to the runner, so what runs is exactly what was shown to the user before
 * they chose it.
 */
export async function executeCommunityRecipe(
  candidate: CommunityRecipeCandidate,
  worktreeDir: string,
  options: { exec?: Exec; logger?: Logger } = {},
): Promise<RecipeExecutionResult> {
  const exec = options.exec ?? execCommand;

  const before = await exec('git', ['status', '--porcelain'], { cwd: worktreeDir });
  if (before.failure) {
    return { status: 'failed', changedFiles: [], message: 'Could not inspect the worktree before running the recipe.' };
  }

  const command = commandFor(candidate);
  if (!command) {
    return {
      status: 'failed',
      changedFiles: [],
      message: `Drift does not know how to run a "${candidate.provider}" recipe.`,
    };
  }

  options.logger?.info(`Running community recipe ${candidate.name}@${candidate.version} (${candidate.provider})`);
  const result = await exec(command.bin, command.args, { cwd: worktreeDir, timeoutMs: 300_000 });

  if (result.failure || result.code !== 0) {
    const reason = result.failure === 'not-found' ? `${command.bin} is not installed` : result.stderr.trim() || result.stdout.trim();
    return {
      status: 'failed',
      changedFiles: [],
      message: `Recipe ${candidate.name}@${candidate.version} failed: ${reason || `exit code ${result.code}`}`.trim(),
    };
  }

  const after = await exec('git', ['status', '--porcelain'], { cwd: worktreeDir });
  const changedFiles = (after.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[AMDRC?!\s]+/, '').trim())
    .filter(Boolean);

  if (changedFiles.length === 0) {
    return {
      status: 'no-changes',
      changedFiles: [],
      message: `Recipe ${candidate.name}@${candidate.version} made no changes here.`,
    };
  }

  return {
    status: 'applied',
    changedFiles,
    message: `Applied community recipe ${candidate.name}@${candidate.version} from ${candidate.publisher} — no agent call was made.`,
  };
}

function commandFor(candidate: CommunityRecipeCandidate): { bin: string; args: string[] } | null {
  switch (candidate.provider) {
    case 'codemod.com':
      // The Codemod.com CLI resolves `<name>@<version>` against its registry
      // and applies it in `cwd`. `--yes` avoids an interactive npx install
      // prompt, which would otherwise hang a non-interactive run.
      return {
        bin: 'npx',
        args: ['--yes', 'codemod@latest', 'run', `${candidate.name}@${candidate.version}`],
      };
    case 'openrewrite':
      // `recipeArtifactCoordinates` pins the exact recipe module; `activeRecipes`
      // selects the one recipe to run rather than a whole module's defaults.
      return {
        bin: 'mvn',
        args: [
          '-q',
          'org.openrewrite.maven:rewrite-maven-plugin:run',
          `-Drewrite.activeRecipes=${candidate.name}`,
          `-Drewrite.recipeArtifactCoordinates=${candidate.source}:${candidate.version}`,
        ],
      };
    default:
      return null;
  }
}
