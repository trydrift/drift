import type { CommitUnit, RemediationPlan } from '../types.js';

/**
 * The one remediation decision every surface shares: for a given commit, is
 * there a fix Drift can apply itself, or does it need an agent?
 *
 * Three tiers, in descending order of what Drift can promise:
 *
 * `builtin` — Drift's own codemod (`src/codemod/index.ts`), derived unaided
 * from a computed API diff. It needed no model and no validation because it
 * could not have been wrong by construction, so it wins whenever present.
 *
 * `fix-plan` — a validated deterministic rule (`src/fixplan/`). Proposed by
 * a cache hit, by a community recipe's observed edits, or by one model call
 * for the whole finding, and then put through a gate that checks it is
 * grounded in the finding, that every name it introduces is attested by
 * cited evidence, and that it converges and preserves lines. Whether it may
 * be applied *unattended* is a separate question with a separate answer —
 * see `dispositionFor` in `src/fixplan/policy.ts`. This function says what
 * kind of fix exists, not whether to run it without asking.
 *
 * `ai` — everything else, per call site.
 *
 * Community recipes are deliberately absent as a tier. They used to be one:
 * a matching recipe's edits were scope-checked and committed. Scope checking
 * answers "did it stay in its lane" and never answers "is this the right
 * edit", so a recipe is now a *proposal source* feeding `fix-plan` instead,
 * subject to the same gate as everything else. `CommitUnit.recipe` survives
 * as a record of what was consulted, not as something to execute.
 */
export type RemediationKind = 'builtin' | 'fix-plan' | 'ai';

export function remediationKindFor(commit: CommitUnit): RemediationKind {
  if (commit.codemod) return 'builtin';
  if (commit.fixPlan) return 'fix-plan';
  return 'ai';
}

/**
 * Split a plan's commits by remediation kind, in plan order.
 *
 * Used by the Action and the CLI to decide which commits can be resolved
 * directly and which still need an agent — the same split, computed the same
 * way, on every surface that applies fixes.
 *
 * A commit in `fixPlan` may *still* need an agent afterwards, for the sites
 * its plan did not cover. That is `residual` work rather than a different
 * tier, and `commitsNeedingAgent` is what reports it.
 */
export function partitionCommits(plan: RemediationPlan): {
  builtin: CommitUnit[];
  fixPlan: CommitUnit[];
  ai: CommitUnit[];
} {
  const builtin: CommitUnit[] = [];
  const fixPlan: CommitUnit[] = [];
  const ai: CommitUnit[] = [];

  for (const commit of plan.commits) {
    switch (remediationKindFor(commit)) {
      case 'builtin':
        builtin.push(commit);
        break;
      case 'fix-plan':
        fixPlan.push(commit);
        break;
      case 'ai':
        ai.push(commit);
        break;
    }
  }

  return { builtin, fixPlan, ai };
}

/**
 * True when a commit still has work an agent has to do after every
 * deterministic path has run.
 *
 * The per-site partition is the reason this is not simply "has no codemod
 * and no fix plan": a plan covering nine of ten call sites resolves nine and
 * leaves one, and that one is real work that must not be dropped just
 * because the commit counts as deterministically handled.
 */
export function hasResidualWork(commit: CommitUnit): boolean {
  if (commit.codemod) return false;
  if (commit.fixPlan) return commit.fixPlan.residual > 0;
  return true;
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
