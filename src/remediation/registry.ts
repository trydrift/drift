import type { BreakingChange, DependencyChange } from '../types.js';
import type { CommunityRecipeCandidate } from './types.js';
import { queryCodemodRegistry, queryOpenRewriteRegistry } from './live-search.js';

export type RecipeQuery = (
  change: BreakingChange,
  dependencyChange: DependencyChange | undefined,
) => Promise<CommunityRecipeCandidate | null>;

/**
 * The registries Drift is willing to ask. Two, both fixed here — never
 * configurable, never suppliable by the repository being analysed, and
 * never fetched from a third URL discovered along the way.
 */
const DEFAULT_QUERIES: readonly RecipeQuery[] = [queryCodemodRegistry, queryOpenRewriteRegistry];

/**
 * Find a community recipe that claims to handle a breaking change, by
 * querying the trusted registries directly — see `live-search.ts` for the
 * trust boundary this stays inside. Every query runs regardless of whether
 * an earlier one already matched, so an official/verified recipe from one
 * registry can be preferred over an unverified one from another; queries
 * that error or find nothing simply contribute no candidate.
 *
 * `queries` is injectable so tests can exercise matching, preference, and
 * "nothing found" without making a real network call.
 */
export async function findCommunityRecipe(
  change: BreakingChange,
  dependencyChange: DependencyChange | undefined,
  queries: readonly RecipeQuery[] = DEFAULT_QUERIES,
): Promise<CommunityRecipeCandidate | null> {
  const results = await Promise.all(queries.map((query) => query(change, dependencyChange).catch(() => null)));
  const candidates = results.filter((c): c is CommunityRecipeCandidate => c !== null);
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => Number(b.official) - Number(a.official));
  return candidates[0]!;
}
