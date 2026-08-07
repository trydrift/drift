/**
 * Shared remediation types.
 *
 * Every surface (CLI, GitHub Action, VS Code extension) resolves a commit's
 * fix strategy through the same priority: Drift's own deterministic codemod
 * engine first (`src/codemod/index.ts`, unchanged by this module), then a
 * community-maintained recipe if one applies and is enabled, then an AI
 * agent. This file defines the shape of the middle tier only — the codemod
 * tier already has its own types on `CommitUnit.codemod`.
 */

/** Where a community recipe comes from. Kept deliberately small for the MVP. */
export type CommunityRecipeProvider = 'codemod.com' | 'openrewrite';

/**
 * A community recipe Drift believes applies to one breaking change.
 *
 * Metadata only — matching a candidate never executes anything. Every field
 * here is shown to the person or workflow deciding whether to use it, per
 * the "never silently execute a newly discovered community recipe" rule.
 */
export interface CommunityRecipeCandidate {
  provider: CommunityRecipeProvider;
  /** Recipe identifier as the provider names it, e.g. `@scope/recipe-name` or an OpenRewrite recipe id. */
  name: string;
  /** Exact, pinned version, resolved at discovery time. Never a range or "latest". */
  version: string;
  /** Publisher, for display next to the recipe name (e.g. `Codemod.com`, `OpenRewrite`, an org name). */
  publisher: string;
  /** URL or registry locator a human can open to audit the recipe before trusting it. */
  source: string;
  /** One-line statement of the migration this recipe claims to handle. */
  migration: string;
  /**
   * Published by the registry's own vendor/maintainer org, not a third party.
   * Every OpenRewrite match is official (the group id is OpenRewrite's own);
   * a Codemod.com match is official only when the registry itself marks the
   * entry verified/first-party. Used to prefer official recipes when more
   * than one candidate matches the same breaking change.
   */
  official: boolean;
}

/** Outcome of actually running a community recipe against a worktree. */
export interface RecipeExecutionResult {
  status: 'applied' | 'no-changes' | 'failed';
  /** Repo-relative paths the recipe touched, when it touched any. */
  changedFiles: string[];
  message: string;
}
