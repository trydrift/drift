import type { DriftConfig } from '../config/schema.js';
import type { FixPlanAssessment } from './schema.js';

/**
 * The one decision: may this plan be applied without a human looking first?
 *
 * Every surface asks this function and none of them decides for itself. That
 * is the whole reason it exists as a function rather than as three similar
 * conditionals: the CLI can prompt, the extension can render a review panel,
 * and the Action can do neither — so if each surface derived the policy from
 * `config` independently, the Action would end up with the loosest reading of
 * it by accident, which is exactly backwards. Here the surfaces differ only
 * in what they *do* with `'review'`, never in when they get it.
 *
 * The rule that does not bend, regardless of configuration: a plan Drift
 * cannot promise still parses (`assurance: 'checked'`) is never applied
 * unattended unless the project's own checks actually ran and passed against
 * it. There is no setting that turns that off. A deterministic engine
 * propagates whatever it is given to every call site at once — that is its
 * value and its hazard, and the hazard is worth exactly one unskippable
 * check.
 */

export type FixPlanAction = 'apply' | 'review' | 'skip';

export interface FixPlanDisposition {
  action: FixPlanAction;
  /** Why, in a sentence fit to show a user. Always populated. */
  reason: string;
}

export interface DispositionContext {
  /**
   * Whether the project's own checks ran and passed against this plan's
   * edits. Never assume `true` for "verification was switched off" — that is
   * the case this flag exists to distinguish.
   */
  verificationPassed?: boolean;
  /** True in `auto` mode; `approve` mode always reviews. */
  autoMode?: boolean;
}

export function dispositionFor(
  assessment: FixPlanAssessment,
  config: DriftConfig,
  context: DispositionContext = {},
): FixPlanDisposition {
  const { fixPlans } = config.remediation;

  if (assessment.verdict === 'rejected') {
    return {
      action: 'skip',
      reason: assessment.rejections[0] ?? 'The plan did not pass validation.',
    };
  }

  const total = assessment.covered + assessment.residual;
  const coverage = total === 0 ? 0 : assessment.covered / total;
  if (coverage < fixPlans.minCoverage) {
    return {
      action: 'skip',
      reason: `The plan covers ${assessment.covered} of ${total} call sites (${Math.round(coverage * 100)}%), below the configured minimum of ${Math.round(fixPlans.minCoverage * 100)}%. A rule that explains this little of a finding is a coincidence rather than a migration.`,
    };
  }

  // `approve` mode is a statement about the whole pipeline, not just about
  // agents. A repository that asks before an agent edits it is not asking to
  // be edited deterministically instead.
  if (config.mode !== 'auto' && !context.autoMode) {
    return {
      action: 'review',
      reason: 'Drift is in approve mode, so every fix plan is proposed for a human to accept.',
    };
  }

  if (fixPlans.autoApply === 'review') {
    return {
      action: 'review',
      reason: 'remediation.fixPlans.autoApply is `review`, so this plan is proposed rather than applied.',
    };
  }

  if (assessment.assurance === 'proven') {
    return {
      action: 'apply',
      reason: `Every operation swaps one token for another of the same kind, so it cannot change whether the file parses, and ${assessment.covered} call site${assessment.covered === 1 ? '' : 's'} ${assessment.covered === 1 ? 'is' : 'are'} anchored to lines Drift localized itself.`,
    };
  }

  if (fixPlans.autoApply === 'verified' && context.verificationPassed) {
    return {
      action: 'apply',
      reason: 'The plan changes expression structure, and the project’s own checks ran and passed against the result.',
    };
  }

  return {
    action: 'review',
    reason:
      fixPlans.autoApply === 'verified'
        ? 'The plan changes expression structure and the project’s own checks did not run against it, so it is proposed rather than applied.'
        : 'The plan changes expression structure, which `autoApply: proven` does not cover. Set `verified` and enable `verify` to apply plans like this automatically.',
  };
}
