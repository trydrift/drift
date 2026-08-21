import type { Ecosystem } from '../types.js';

/**
 * Confidence, split into the questions it was conflating.
 *
 * A single `Confidence` field had to answer two unrelated questions at once:
 * "did this change really happen upstream?" and "does it break *this*
 * repository?". Those have different evidence and routinely different answers.
 * A machine-computed `.d.ts` diff proves the first about as well as anything
 * can while saying nothing at all about the second; a textual match in a file
 * that imports the package is decent evidence of the second and none of the
 * first.
 *
 * Collapsing them produced the failure this whole model exists to prevent: a
 * `high` that a reader takes as "safe to apply", earned entirely on upstream
 * grounds, attached to a local claim nothing verified.
 *
 * There is exactly one calculation, in `calibrate.ts`. The legacy `high` /
 * `medium` / `low` fields remain as derived accessors so existing consumers
 * keep working, but nothing computes them independently.
 */

/** Coarse label for display. `none` means not established at all. */
export type ConfidenceBand = 'high' | 'medium' | 'low' | 'none';

/**
 * One thing that moved a score, in either direction.
 *
 * Kept as records rather than folded into the number so a report can show its
 * working. "Medium confidence" is an assertion; "medium because the changelog
 * says so and nothing corroborates it" is something a reviewer can check.
 */
export interface ConfidenceReason {
  /** Stable identifier, safe to match on in tests and telemetry. */
  code: string;
  detail: string;
  /** Contribution to the score. Negative for penalties. */
  delta: number;
}

export interface ConfidenceScore {
  /** 0 to 1. */
  score: number;
  band: ConfidenceBand;
  /** What raised it. */
  evidence: ConfidenceReason[];
  /** What lowered it. */
  penalties: ConfidenceReason[];
  /** Which calibration produced this, so stored scores stay interpretable. */
  calibration: string;
}

/**
 * A surface Drift looked at, and what came of looking.
 *
 * The point of recording `unavailable` and `skipped` alongside `checked` is
 * that a report can distinguish "we looked and found nothing" from "we did not
 * look" — which are the same output otherwise, and mean opposite things.
 */
export interface CheckedSurface {
  /** e.g. `type-surface`, `changelog`, `github-releases`, `localization`. */
  surface: string;
  dependency?: string;
  ecosystem?: Ecosystem;
  /**
   * The workspace member this row is about, mirroring
   * `DependencyChange.workspace` — absent in a single-package repository,
   * `''` for the workspace root. Only set on a row that actually corresponds
   * to one `DependencyChange` (`api-surface`, `release-notes`); a row that
   * is not dependency-scoped (`localization`, `behavioural-diff`,
   * `contract-document`, which is keyed by file path, not package) leaves
   * this absent rather than guessing which member it was about.
   *
   * Without this, `dependency` + `ecosystem` alone let the same package
   * bumped in two workspace members collapse to one identity — one member's
   * checked surface reading as evidence for the other's, which never ran at
   * all. See `everyDependencySurfaceChecked` in `report/confidence.ts`, the
   * one place this is read back.
   */
  workspace?: string;
  status: 'checked' | 'unavailable' | 'skipped';
  detail: string;
}

/** Where in the pipeline a gap arose. */
export type GapStage =
  | 'detect'
  | 'evidence'
  | 'analyze'
  | 'localize'
  | 'verify'
  | 'plan';

/** How much a gap should count against acting automatically. */
export type GapSeverity = 'blocking' | 'significant' | 'minor';

/**
 * Something Drift could not establish.
 *
 * First-class records rather than prose, because these are the part of the
 * output most likely to be skimmed past — and the part that decides whether the
 * rest can be trusted. `automaticExecution` states the consequence directly so
 * nobody has to infer severity from wording.
 */
export interface AnalysisGap {
  stage: GapStage;
  ecosystem?: Ecosystem;
  dependency?: string;
  /** The surface that could not be established. */
  surface: string;
  reason: string;
  severity: GapSeverity;
  automaticExecution: 'blocks' | 'degrades' | 'none';
  /** What a person can do about it, when there is something. */
  remediation: string;
}

export interface ConfidenceAssessment {
  /** Did this change really happen upstream? */
  upstream: ConfidenceScore;
  /** Does it reach code in this repository? */
  localImpact: ConfidenceScore;
  /** Did anything actually run to confirm it? */
  verification: ConfidenceScore;
  /**
   * Whether this finding may be acted on without a human.
   *
   * Derived, never set directly, and false whenever any dimension is
   * unestablished. Absence of evidence is not eligibility.
   */
  automaticExecutionEligible: boolean;
  /** Cross-cutting notes that are not attributable to one dimension. */
  reasons: ConfidenceReason[];
  checkedSurfaces: CheckedSurface[];
  gaps: AnalysisGap[];
}

/**
 * A check that ran, or did not.
 *
 * Verification confidence is computed from these. There is deliberately no
 * default: a finding with no outcomes gets `none`, not a benefit of the doubt.
 */
export interface VerificationOutcome {
  /** e.g. `typecheck`, `test`, `build`. */
  name: string;
  command: string;
  status: 'passed' | 'failed' | 'skipped' | 'timed-out' | 'unavailable';
  /** Files the check is known to cover, when that can be established. */
  covers?: string[];
  /**
   * The dependency (and workspace, mirroring `DependencyChange.workspace`)
   * this outcome speaks to, when it is specific to one. A repo-wide check
   * (`typecheck`, `build`) that says nothing about any one dependency in
   * particular should leave this unset; a per-dependency probe (e.g. a
   * behavioural differential run) must set it, or its result will otherwise
   * be applied to every finding on the plan, not just the one it actually
   * probed.
   */
  dependency?: string;
  workspace?: string;
  /**
   * The exact `BreakingChange.id`(s) this outcome bears on, when that is
   * known. Takes precedence over `dependency`/`workspace` scoping: a
   * dependency can have several distinct findings (e.g. `formatUser` and
   * `parseUser` both changing), and a behavioural probe of one symbol says
   * nothing about the other, even though both belong to the same dependency
   * and workspace. Leave unset only for a check with no per-finding
   * granularity to report (e.g. a whole-repo `typecheck` or `build`).
   */
  breakingChangeIds?: string[];
  detail?: string;
}

/** Bands, as thresholds on the score. One place, so display cannot drift. */
export const BANDS: readonly { band: ConfidenceBand; min: number }[] = [
  { band: 'high', min: 0.8 },
  { band: 'medium', min: 0.5 },
  { band: 'low', min: 0.2 },
  { band: 'none', min: 0 },
];

export function bandFor(score: number): ConfidenceBand {
  for (const entry of BANDS) {
    if (score >= entry.min) return entry.band;
  }
  return 'none';
}

/**
 * The one number a non-expert reader sees.
 *
 * `ConfidenceAssessment` splits confidence into three questions on purpose —
 * that is the fix for the failure this whole model exists to prevent. But a
 * customer opening a report wants one thing first: how sure is Drift, overall,
 * and should that make them more or less willing to trust the verdict? This is
 * that number. It never hides the three-dimension breakdown, which stays
 * available for anyone who wants to see the working.
 */
export interface OverallConfidence {
  /** 0 to 100, for a display a non-expert reads at a glance. */
  score: number;
  band: ConfidenceBand;
  /** A short phrase, not a band name — "Very confident", not "high". */
  label: string;
}

/**
 * Words a reader trusts more than a band name.
 *
 * Deliberately says how sure Drift is, not how bad the change is — a `none`
 * finding is not "this looks terrible", it is "Drift could not tell".
 */
export const OVERALL_LABEL: Record<ConfidenceBand, string> = {
  high: 'Very confident',
  medium: 'Fairly confident',
  low: 'Not very confident',
  none: 'Not enough evidence to say',
};
