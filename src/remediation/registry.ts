import type { BreakingChange, DependencyChange } from '../types.js';
import type { CommunityRecipeCandidate, CommunityRecipeSource } from './types.js';

/**
 * The curated list of community recipes Drift is willing to offer.
 *
 * Deliberately not a live registry search: Drift does not query Codemod.com
 * or OpenRewrite over the network to discover recipes at analysis time, and
 * does not let a repository or its dependencies influence which recipes are
 * eligible. Every entry here was added by a Drift maintainer, pins an exact
 * version, and can be audited by reading this file — the "small, conservative
 * set of eligible community recipe sources" the MVP calls for, not a trust
 * management system.
 *
 * Empty by default. Populating it with real, version-pinned, audited recipes
 * is a curation task for maintainers, not something to guess at — an entry
 * here is a claim that a specific recipe version was reviewed and is safe to
 * offer, and that claim should never be manufactured to make this list look
 * more complete than it is. Until an entry is added for a given migration,
 * `findCommunityRecipe` simply returns no candidate and callers fall through
 * to Drift's built-in codemod or an AI agent, exactly as before this module
 * existed.
 */
export const COMMUNITY_RECIPES: readonly CommunityRecipeSource[] = [];

/**
 * Find a community recipe that claims to handle a breaking change.
 *
 * Returns the first match in `sources` (defaulting to the curated registry
 * above) — never a live lookup, never something the caller can influence by
 * passing untrusted data. Exposed with an injectable `sources` parameter so
 * tests can exercise the resolution/offer/execute machinery with fixture
 * recipes without needing a real, populated registry.
 */
export function findCommunityRecipe(
  change: BreakingChange,
  dependencyChange: DependencyChange | undefined,
  sources: readonly CommunityRecipeSource[] = COMMUNITY_RECIPES,
): CommunityRecipeCandidate | null {
  for (const source of sources) {
    if (source.matches(change, dependencyChange)) return source.candidate;
  }
  return null;
}
