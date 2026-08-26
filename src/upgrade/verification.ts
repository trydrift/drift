import { applyVerificationToPlan, provableByCompiler, verificationScope } from '../verification/apply.js';
import type { UpgradeVerification } from '../verification/upgrade-probe.js';
import type { UpgradeCandidate } from './scan.js';
import { summarize } from './summary.js';

/**
 * Folding a probe result into the candidate a developer will actually see.
 *
 * The plan-level rules live in `verification/apply.ts`, shared with the
 * push-triggered pipeline; this is the candidate's share of the same answer —
 * the counts on the row, which are what decides the severity badge and the
 * order the list is sorted in.
 */

export { describeVerification } from '../verification/apply.js';

/**
 * Returns a new candidate; the input is not modified, so a caller holding the
 * unverified version for comparison still has it.
 */
export function applyVerification(
  candidate: UpgradeCandidate,
  verification: UpgradeVerification,
): UpgradeCandidate {
  const verified: UpgradeCandidate = { ...candidate, verification };
  if (!verified.plan) return verified;

  // Recorded on the plan even when nothing was measured, and *especially* then.
  // A skipped verification carries the reason it was skipped, and the plan is
  // what travels to the fix stage and the filed issue — so leaving it off meant
  // every consumer downstream could see that predictions were unverified but
  // not why, and had nowhere to send the developer except a log. The status
  // still gates the pruning below: only a pass may drop a prediction.
  verified.plan = applyVerificationToPlan(verified.plan, verification);
  if (verification.status === 'skipped') return verified;

  // The row's own numbers, re-derived rather than adjusted: they are what
  // `severityOf` reads, so a count left stale here would show an "affected"
  // badge over a plan with nothing left in it.
  //
  // `breakingCount` is the one exception: it stays pinned to what upstream
  // actually published (`upstreamBreakingCount`), not to `plan.breakingChanges`
  // — that array shrinks as verification clears compiler-provable predictions,
  // and whether it shrinks at all depends on whether this package happened to
  // be probed alone or batched with others. Reading the post-prune length as
  // "upstream changes" is how the same commit reported 209 in one run and 2 in
  // another; the count shown to a developer must not depend on that.
  verified.breakingCount = verified.plan.upstreamBreakingCount ?? verified.plan.breakingChanges.length;
  verified.impactCount = verified.plan.impactSites.length;
  verified.impactFiles = new Set(verified.plan.impactSites.map((site) => site.file)).size;
  // Whether the "affected" verdict above rests on evidence a batch pass could
  // not give it. A compile-capable pass that ran scoped to a batch is not
  // licensed to prune a compiler-provable finding (see `applyVerificationToPlan`),
  // so that finding's impact site is still sitting in `impactCount` — not
  // because it was checked and found real, but because it was never given the
  // isolated check that could have cleared it. Left unmarked, that reads
  // identically to a finding nothing has looked at, and the exact same finding
  // flips to "safe" the moment an unrelated dependency's install happens to
  // fail and this one falls back to being probed alone. `severityOf` cannot
  // tell those two "affected" states apart on its own — it never sees the
  // plan, only these flattened counts — so the distinction has to be computed
  // here, where both are still in view, and carried across as its own field.
  verified.impactPendingIsolatedClearance =
    verificationScope(verification) === 'batch' &&
    verification.checks.some((check) => check.status === 'passed' && check.compileCapable) &&
    verified.plan.impactSites.some((site) => {
      const change = verified.plan!.breakingChanges.find((candidate) => candidate.id === site.breakingChangeId);
      return change !== undefined && provableByCompiler(change);
    });
  // And the sentence built from those numbers, for exactly the same reason.
  // Leaving it alone printed both readings of the same upgrade side by side —
  // `Safe for your code · 1 upstream change, none used here` on the badge line,
  // `66 upstream breaking changes` in the summary directly beneath it, with
  // nothing to tell a reader that the second was written before the compiler
  // disproved sixty-five of them.
  verified.summary = summarize(
    verified.breakingCount,
    verified.plan!.breakingChanges,
    verified.plan!.impactSites,
    verified.name,
    verified.rationale,
  );
  return verified;
}
