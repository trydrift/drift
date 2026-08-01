/**
 * Why an upgrade might be worth taking — the other half of the question.
 *
 * Drift's whole pipeline answers "what could this break?". That is the harder
 * half and the more useful one, but on its own it is a machine that only ever
 * argues against upgrading. A developer deciding whether to spend an afternoon
 * on `golang.org/x/sys` needs to know that the current version has a known
 * high-severity advisory and the target does not, and no amount of API diffing
 * will tell them.
 *
 * Every claim in here is a fact with a source attached, or it is labelled as an
 * inference. There is no scoring, no "package health", and no synthesised
 * prose: a benefit Drift cannot cite is a benefit Drift does not mention.
 */

/** How sure the underlying source is about a vulnerability's seriousness. */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export interface Vulnerability {
  /** OSV identifier, e.g. `GO-2025-1234` or `GHSA-xxxx-xxxx-xxxx`. */
  id: string;
  /** CVE and other identifiers for the same advisory. */
  aliases: string[];
  summary: string;
  severity: Severity;
  /** The advisory a reader can open. Always present. */
  url: string;
  /**
   * The first version that fixes this, when the advisory states one.
   *
   * `null` means the advisory records no fix — which is a materially different
   * situation from "the fix is in a version you are not taking yet", and the
   * report says which.
   */
  fixedIn: string | null;
}

/** Whether taking this upgrade improves, preserves, or worsens exposure. */
export type SecurityDirection = 'improves' | 'preserves' | 'worsens' | 'mixed' | 'unknown';

export interface SecurityAssessment {
  /** False when OSV could not be reached. Absence of data is never safety. */
  checked: boolean;
  /** Advisories affecting the installed version. */
  current: Vulnerability[];
  /** Advisories affecting the target version. */
  target: Vulnerability[];
  /** Affects the current version, fixed by the target. What the upgrade buys. */
  resolved: Vulnerability[];
  /** Affects the target but not the current version. What the upgrade costs. */
  introduced: Vulnerability[];
  /** Affects both. The upgrade neither helps nor hurts here. */
  carried: Vulnerability[];
  direction: SecurityDirection;
}

/**
 * One checkable statement about how a package is looked after.
 *
 * Deliberately a sentence and a citation rather than a metric. A mature package
 * can go a year without a commit because it is finished; scoring that as
 * neglect is how a health dashboard talks a team out of a dependency that was
 * never a problem.
 */
export interface MaintenanceFact {
  statement: string;
  /** Where a reader can verify it. Absent only for facts derived arithmetically. */
  url?: string;
  /**
   * True when this is a reason for concern rather than neutral context.
   *
   * Drives ordering and the final recommendation; never a score.
   */
  concerning?: boolean;
}

export interface MaintenanceAssessment {
  facts: MaintenanceFact[];
  /** The registry's own deprecation notice for the target version, if any. */
  deprecated?: string;
  /** The upstream repository is archived. */
  archived?: boolean;
  /** Highest stable published version, when the registry lists one. */
  latestStable?: string;
  /** ISO date the target version was published, when known. */
  targetReleasedAt?: string;
}

/**
 * A performance or reliability improvement someone actually wrote down.
 *
 * Never inferred from a version number. "Newer is faster" is a guess, and a
 * guess presented next to a computed API diff borrows credibility it has not
 * earned.
 */
export interface Improvement {
  statement: string;
  /** The release note, changelog entry, or commit that says so. */
  url?: string;
  /** Evidence record this was extracted from. */
  citation?: string;
}

export type LicenseVerdict = 'ok' | 'changed' | 'policy-violation' | 'unknown';

export interface LicenseFinding {
  verdict: LicenseVerdict;
  /** SPDX-ish identifier as the registry declares it. */
  from?: string;
  to?: string;
  /** Statement for the report. Never a legal conclusion. */
  statement: string;
  /** Dependencies this upgrade newly introduces, with their licenses. */
  introduced: { name: string; license: string | null; allowed: boolean }[];
}

/** How a release-note line was classified. */
export type ChangeCategory = 'breaking' | 'security' | 'fix' | 'performance' | 'improvement';

export interface SummarizedChange {
  category: ChangeCategory;
  /** One line, in the maintainer's words, trimmed — never paraphrased. */
  text: string;
  url?: string;
  /** Evidence record this came from. */
  citation?: string;
  /** Impact sites in this repository that this line's symbols matched. */
  affectedSites?: number;
}

export interface ReleaseSummary {
  changes: SummarizedChange[];
  /**
   * Lines that were read and judged not to concern this repository.
   *
   * Counted rather than listed: the point of saying "three CLI-only changes do
   * not affect you" is that the reader does not have to read them.
   */
  unrelated: number;
}

/** The six things Drift is willing to conclude. */
export type Recommendation =
  | 'safe-to-upgrade'
  | 'upgrade-recommended'
  | 'upgrade-after-review'
  | 'manual-migration-required'
  | 'insufficient-evidence'
  | 'do-not-upgrade-yet';

/** How much the sources agree. Reported, never used as a threshold on its own. */
export type EvidenceConfidence = 'high' | 'medium' | 'low';

export interface UpgradeAssessment {
  recommendation: Recommendation;
  /**
   * The rules that fired, in the order they were evaluated.
   *
   * This is the whole contract of the assessment: a reader must be able to see
   * why it said what it said, and disagree with a specific sentence rather than
   * with a number they cannot inspect.
   */
  reasons: string[];
  confidence: EvidenceConfidence;
  /** What the confidence rests on, named. */
  confidenceBasis: string;
}

/** Everything Drift concluded about one dependency move. */
export interface UpgradeRationale {
  dependency: string;
  from: string;
  to: string;
  security: SecurityAssessment;
  maintenance: MaintenanceAssessment;
  improvements: Improvement[];
  license: LicenseFinding;
  summary: ReleaseSummary;
  assessment: UpgradeAssessment;
  /**
   * Why this analysis is incomplete, in the developer's terms.
   *
   * Deduplicated and ordered by the caller: the same failure stated twice is
   * the bug this field exists to prevent.
   */
  gaps: string[];
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4,
};

export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_ORDER[a] - SEVERITY_ORDER[b];
}

/** The most serious severity in a set, for a one-line statement. */
export function worstSeverity(vulnerabilities: readonly Vulnerability[]): Severity {
  return vulnerabilities.reduce<Severity>(
    (worst, v) => (compareSeverity(v.severity, worst) < 0 ? v.severity : worst),
    'unknown',
  );
}
