import type { BreakingChange, DependencyChange, ImpactSite } from '../types.js';
import type { CommunityRecipeCandidate } from '../remediation/types.js';
import type { Logger } from '../util/logger.js';
import { withWorktree } from '../repo/worktree.js';
import { fixPlanFromRecipe } from './from-recipe.js';
import type { FixPlan } from './schema.js';

/**
 * Run a community recipe somewhere it cannot do any harm, and keep only what
 * Drift can explain.
 *
 * The isolation is the point and it is not negotiable. A recipe is
 * third-party code fetched from a registry and executed as part of an
 * automated pipeline, so it runs in a disposable worktree checked out at the
 * analysed commit — never the developer's checkout, never a directory
 * anything else will read afterwards. The worktree is removed whether the
 * recipe succeeded, failed, or hung, and what survives it is not the
 * recipe's edits but a `FixPlan` of Drift's own operations inferred from
 * them.
 *
 * Failing soft is deliberate throughout. A recipe that cannot be fetched, a
 * runner that is not installed, a worktree git will not create — none of
 * these are reasons to fail an analysis. They are reasons this finding has
 * no fix plan from this source, which is the same outcome as a registry that
 * had no matching recipe in the first place.
 */

export interface RecipeSandboxOptions {
  change: BreakingChange;
  /** The matched recipe. Absent means there is nothing to run. */
  candidate?: CommunityRecipeCandidate;
  dependencyChange?: DependencyChange;
  sites: readonly ImpactSite[];
  /** The developer's checkout. Read to create the worktree; never written to. */
  workspace: string;
  /** Commit to check the sandbox out at, so the recipe sees the analysed tree. */
  headSha: string;
  env?: NodeJS.ProcessEnv;
  logger: Logger;
}

export async function proposeFixPlanFromRecipe(options: RecipeSandboxOptions): Promise<FixPlan | null> {
  const { change, candidate, sites, workspace, headSha, logger } = options;
  if (!candidate) return null;

  // Only files this finding actually reaches are worth learning a rule from:
  // the plan will only ever be applied at this finding's own localized sites,
  // so an op inferred from anywhere else would be an op with nowhere
  // legitimate to fire.
  const relevantFiles = new Set(
    sites.filter((site) => site.breakingChangeId === change.id).map((site) => site.file),
  );
  if (relevantFiles.size === 0) return null;

  try {
    return await withWorktree(
      workspace,
      `fixplan-${candidate.provider}`,
      (worktree) =>
        fixPlanFromRecipe({
          candidate,
          change,
          dependencyChange: options.dependencyChange,
          sandbox: worktree.path,
          relevantFiles,
          logger,
        }),
      {
        at: headSha,
        ...(options.env ? { env: options.env } : {}),
        // Nothing gitignored is carried in. A recipe is being observed
        // against the committed tree, and a local, uncommitted file in the
        // sandbox would make the rule Drift infers depend on one developer's
        // working directory.
        copyIgnoredFiles: false,
      },
    );
  } catch (err) {
    logger.warn(
      `Could not observe ${candidate.name}@${candidate.version} in an isolated worktree (${(err as Error).message}); this finding gets no recipe-derived fix plan.`,
    );
    return null;
  }
}
