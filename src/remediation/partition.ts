import type { CommitUnit, RemediationPlan } from '../types.js';

/**
 * The one remediation decision every surface shares: for a given commit, is
 * there a fix Drift can apply itself, or does it need an agent?
 *
 * `codemod` always wins when present — it is Drift's own, proven-by-anchor
 * fix (see `src/codemod/index.ts`), trusted without any extra permission on
 * every surface. `recipe` is only usable when the caller has explicitly
 * enabled community recipes (interactively, via a flag, or via
 * `remediation.communityRecipes: true`) — passing `false` here is what makes
 * "never silently execute a newly discovered community recipe" a property of
 * the shared decision rather than something each surface has to remember to
 * check itself.
 */
export type RemediationKind = 'builtin' | 'community-recipe' | 'ai';

export function remediationKindFor(commit: CommitUnit, allowCommunityRecipes: boolean): RemediationKind {
  if (commit.codemod) return 'builtin';
  if (allowCommunityRecipes && commit.recipe) return 'community-recipe';
  return 'ai';
}

/**
 * Split a plan's commits by remediation kind, in plan order.
 *
 * Used by the Action and the CLI to decide which commits can be resolved
 * directly (never dispatched to an agent) and which still need one — the
 * same split, computed the same way, on every surface that applies fixes.
 */
export function partitionCommits(
  plan: RemediationPlan,
  allowCommunityRecipes: boolean,
): { builtin: CommitUnit[]; communityRecipe: CommitUnit[]; ai: CommitUnit[] } {
  const builtin: CommitUnit[] = [];
  const communityRecipe: CommitUnit[] = [];
  const ai: CommitUnit[] = [];

  for (const commit of plan.commits) {
    switch (remediationKindFor(commit, allowCommunityRecipes)) {
      case 'builtin':
        builtin.push(commit);
        break;
      case 'community-recipe':
        communityRecipe.push(commit);
        break;
      case 'ai':
        ai.push(commit);
        break;
    }
  }

  return { builtin, communityRecipe, ai };
}

/** A copy of `plan` restricted to the given commits, for a filtered dispatch. */
export function planForCommits(plan: RemediationPlan, commits: readonly CommitUnit[]): RemediationPlan {
  const ids = new Set(commits.map((c) => c.id));
  const breakingChangeIds = new Set(commits.flatMap((c) => c.breakingChangeIds));
  return {
    ...plan,
    commits: plan.commits.filter((c) => ids.has(c.id)),
    breakingChanges: plan.breakingChanges.filter((b) => breakingChangeIds.has(b.id)),
  };
}
