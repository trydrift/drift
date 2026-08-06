import type { BreakingChange, Evidence, ImpactSite } from '../types.js';
import type {
  EvidenceConfidence,
  LicenseFinding,
  MaintenanceAssessment,
  Recommendation,
  SecurityAssessment,
  UpgradeAssessment,
} from './types.js';
import { worstSeverity } from './types.js';

/**
 * The one thing Drift is willing to conclude, and why.
 *
 * This is deliberately a ladder of `if` statements rather than a score. A
 * weighted number would be easier to tune and impossible to argue with: a
 * developer who disagrees with "0.72 — upgrade after review" has nothing to
 * push back on, whereas a developer who disagrees with "one change requires a
 * decision about behaviour, so a person should look" can point at the sentence
 * and say why it is wrong. Every rule that fires records the sentence it fired
 * with, and those sentences are the entire output.
 *
 * The order matters and encodes a priority: *don't make things worse* beats
 * *fix your code* beats *take the security fix* beats *this is fine*.
 */

export interface AssessmentInput {
  dependency: string;
  workspace?: string;
  breakingChanges: readonly BreakingChange[];
  impactSites: readonly ImpactSite[];
  evidence: readonly Evidence[];
  security: SecurityAssessment;
  maintenance: MaintenanceAssessment;
  license: LicenseFinding;
  /** Reasons this analysis is incomplete. Non-empty is itself a finding. */
  gaps: readonly string[];
  /** True when a computed API diff actually ran for this dependency. */
  surfaceCompared: boolean;
}

/**
 * Changes whose fix is a decision, not a substitution.
 *
 * A rename can be applied mechanically and reviewed in a diff. A behaviour
 * change cannot: someone has to decide what the code should now do, and no
 * amount of evidence removes that.
 */
const NEEDS_A_DECISION = new Set([
  'behaviour-change',
  'signature-change',
  'default-change',
  'moved-export',
  'runtime-requirement',
]);

export function assessUpgrade(input: AssessmentInput): UpgradeAssessment {
  const reasons: string[] = [];
  const { security, maintenance, license, impactSites } = input;

  const affected = impactSites.length;
  const files = new Set(impactSites.map((site) => site.file)).size;
  const decisions = input.breakingChanges.filter((change) => NEEDS_A_DECISION.has(change.kind));
  const mechanical = input.breakingChanges.length - decisions.length;

  /* Facts first, in the order a reader needs them. */

  if (security.checked) {
    if (security.resolved.length > 0) {
      reasons.push(
        `Fixes ${security.resolved.length} known ${plural(security.resolved.length, 'vulnerability', 'vulnerabilities')} (worst: ${worstSeverity(security.resolved)}).`,
      );
    }
    if (security.introduced.length > 0) {
      reasons.push(
        `Introduces ${security.introduced.length} known ${plural(security.introduced.length, 'vulnerability', 'vulnerabilities')} not present in the installed version (worst: ${worstSeverity(security.introduced)}).`,
      );
    }
    if (security.carried.length > 0) {
      reasons.push(
        `${security.carried.length} known ${plural(security.carried.length, 'vulnerability affects', 'vulnerabilities affect')} both versions; this upgrade does not address ${security.carried.length === 1 ? 'it' : 'them'}.`,
      );
    }
    if (security.resolved.length === 0 && security.target.length === 0) {
      reasons.push('No known vulnerabilities were found for the target version.');
    }
  }

  if (affected > 0) {
    reasons.push(
      `${affected} ${plural(affected, 'place', 'places')} in ${files} ${plural(files, 'file', 'files')} ${plural(affected, 'uses', 'use')} an API this upgrade changes.`,
    );
    if (mechanical > 0) {
      reasons.push(`${mechanical} of the changes can be applied mechanically.`);
    }
    if (decisions.length > 0) {
      reasons.push(
        `${decisions.length} ${plural(decisions.length, 'change requires', 'changes require')} a developer decision rather than a substitution.`,
      );
    }
  } else if (input.breakingChanges.length > 0) {
    reasons.push(
      `${input.breakingChanges.length} upstream breaking ${plural(input.breakingChanges.length, 'change', 'changes')}, none of which this repository uses.`,
    );
  }

  for (const fact of maintenance.facts) {
    if (fact.concerning) reasons.push(fact.statement);
  }

  if (license.verdict === 'policy-violation' || license.verdict === 'changed') {
    reasons.push(license.statement);
  }

  /* Then the conclusion those facts support. */

  const recommendation = decide(input, { affected, decisions: decisions.length });
  const confidence = judgeConfidence(input);

  if (input.gaps.length > 0) {
    reasons.push(...input.gaps);
  }

  return {
    recommendation,
    reasons,
    confidence: confidence.level,
    confidenceBasis: confidence.basis,
  };
}

function decide(
  input: AssessmentInput,
  counts: { affected: number; decisions: number },
): Recommendation {
  const { security, maintenance, license } = input;

  // Nothing outranks making the repository's position worse.
  if (security.checked && security.introduced.length > 0) return 'do-not-upgrade-yet';
  if (maintenance.deprecated) return 'do-not-upgrade-yet';
  if (license.verdict === 'policy-violation') return 'do-not-upgrade-yet';

  if (counts.affected > 0) {
    return counts.decisions > 0 ? 'manual-migration-required' : 'upgrade-after-review';
  }

  // No evidence is not the same as no findings, and must never read as one.
  // Checked last among the negative outcomes so that a genuine finding — which
  // proves something *was* readable — always wins over the absence of others.
  if (input.gaps.length > 0 && input.breakingChanges.length === 0 && !answeredSomething(input)) {
    return 'insufficient-evidence';
  }

  if (
    (security.checked && security.resolved.length > 0) ||
    maintenance.facts.some((fact) => fact.concerning)
  ) {
    return 'upgrade-recommended';
  }

  return 'safe-to-upgrade';
}

/**
 * Did any source actually answer for this dependency?
 *
 * A surface diff that ran and found nothing is an answer. So is OSV replying
 * "no advisories". Both are the difference between "Drift checked and this is
 * clean" and "Drift could not check", and conflating them is the specific lie
 * this codebase already had to be corrected for once.
 */
function answeredSomething(input: AssessmentInput): boolean {
  return input.surfaceCompared || input.security.checked;
}

/**
 * How much the sources agree, and about what.
 *
 * Reported alongside the recommendation rather than folded into it. A
 * high-confidence "safe to upgrade" and a low-confidence one are the same
 * advice resting on different amounts of ground, and the reader deserves to
 * know which they are looking at.
 */
function judgeConfidence(input: AssessmentInput): { level: EvidenceConfidence; basis: string } {
  const prose = input.evidence.filter(
    (record) =>
      record.dependency === input.dependency &&
      record.workspace === input.workspace &&
      (record.source === 'github-release' ||
        record.source === 'changelog' ||
        record.source === 'migration-guide'),
  );

  const sources: string[] = [];
  if (input.surfaceCompared) sources.push('the computed API diff');
  if (prose.length > 0) sources.push(prose.length === 1 ? 'release notes' : 'release notes and changelog');
  if (input.security.checked) sources.push('the OSV advisory database');

  if (sources.length === 0) {
    return {
      level: 'low',
      basis: 'Nothing but the version numbers could be read for this dependency.',
    };
  }

  // A computed diff is a direct observation of the shipped artefact; anything
  // else is somebody's account of it. Two independent sources agreeing is the
  // only thing that earns "high" without one.
  const level: EvidenceConfidence =
    input.surfaceCompared || sources.length >= 2 ? 'high' : 'medium';

  return { level, basis: `${capitalize(joinList(sources))} agree.` };
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The headline shown against the recommendation. */
export const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  'safe-to-upgrade': 'Safe to upgrade',
  'upgrade-recommended': 'Upgrade recommended',
  'upgrade-after-review': 'Upgrade after review',
  'manual-migration-required': 'Manual migration required',
  'insufficient-evidence': 'Insufficient evidence',
  'do-not-upgrade-yet': 'Do not upgrade yet',
};
