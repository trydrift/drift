import { applyVerificationToPlan } from '../verification/apply.js';
import type { UpgradeVerification } from '../verification/upgrade-probe.js';
import type { UpgradeCandidate } from './scan.js';

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
  if (!verified.plan || verification.status === 'skipped') return verified;

  verified.plan = applyVerificationToPlan(verified.plan, verification);

  // The row's own numbers, re-derived rather than adjusted: they are what
  // `severityOf` reads, so a count left stale here would show an "affected"
  // badge over a plan with nothing left in it.
  verified.breakingCount = verified.plan.breakingChanges.length;
  verified.impactCount = verified.plan.impactSites.length;
  verified.impactFiles = new Set(verified.plan.impactSites.map((site) => site.file)).size;
  return verified;
}
