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
  const beforeStatus = parseGitStatus(before.stdout || '');
  // A file that was already dirty before the recipe ran keeps the same status
  // code even if the recipe edits it further (still `M`, still `??`) — status
  // alone can't see that. Content hashes of the already-dirty files catch it.
  const beforeHashes = await hashFiles(worktreeDir, [...beforeStatus.keys()], exec);

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
    // A recipe that fails partway can still have written files before it
    // exited non-zero — report the true touched set so a caller can clean up
    // exactly what changed, rather than being left with an empty list and no
    // way to know what to revert.
    const changedFiles = await touchedFiles(worktreeDir, beforeStatus, beforeHashes, exec);
    return {
      status: 'failed',
      changedFiles,
      message: `Recipe ${candidate.name}@${candidate.version} failed: ${reason || `exit code ${result.code}`}`.trim(),
    };
  }

  const changedFiles = await touchedFiles(worktreeDir, beforeStatus, beforeHashes, exec);

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

/**
 * Parse `git status --porcelain` into a path → status-code map.
 *
 * A rename line (`R  old -> new`) is keyed by the new path, since that is
 * the file that exists in the worktree afterwards; the status code is kept
 * as-is so a genuine status change (e.g. untracked becoming modified) is
 * still detected as a change between two snapshots.
 */
function parseGitStatus(porcelain: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const raw of porcelain.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    let path = line.slice(2).trim();
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4).trim();
    // Porcelain quotes paths containing unusual characters in double quotes.
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (path) entries.set(path, status);
  }
  return entries;
}

/** `git hash-object`'s blob hash for each path that currently exists, keyed by path. */
async function hashFiles(worktreeDir: string, paths: readonly string[], exec: Exec): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const path of paths) {
    const result = await exec('git', ['hash-object', '--', path], { cwd: worktreeDir });
    if (!result.failure && result.code === 0) hashes.set(path, result.stdout.trim());
  }
  return hashes;
}

/**
 * Which files actually changed since `beforeStatus`/`beforeHashes` were
 * captured. A status-code diff alone misses a file that was already dirty
 * and got edited further by the recipe (status stays the same); a content
 * hash comparison on those files catches it.
 */
async function touchedFiles(
  worktreeDir: string,
  beforeStatus: ReadonlyMap<string, string>,
  beforeHashes: ReadonlyMap<string, string>,
  exec: Exec,
): Promise<string[]> {
  const after = await exec('git', ['status', '--porcelain'], { cwd: worktreeDir });
  const afterStatus = parseGitStatus(after.stdout || '');

  const changed = new Set<string>();
  const alreadyDirtySamePath: string[] = [];
  for (const [path, status] of afterStatus) {
    if (beforeStatus.get(path) !== status) {
      changed.add(path);
    } else {
      alreadyDirtySamePath.push(path);
    }
  }

  const afterHashes = await hashFiles(worktreeDir, alreadyDirtySamePath, exec);
  for (const path of alreadyDirtySamePath) {
    if (beforeHashes.get(path) !== afterHashes.get(path)) changed.add(path);
  }

  return [...changed];
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
