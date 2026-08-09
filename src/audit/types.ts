import type { BreakingChange, Ecosystem, ImpactSite } from '../types.js';
import type { AnalysisGap, CheckedSurface } from '../confidence/types.js';

/**
 * Why a dependency's current state is a problem, as opposed to a future one.
 *
 * `unreviewed-drift` — the installed version is ahead of the oldest version the
 * manifest range admits, and code in this repository still uses an API that
 * changed somewhere in that window. Nobody chose this: the range permitted it
 * and a resolver took it. The code is out of step with the dependency that is
 * on disk right now.
 *
 * `range-violation` — the installed version does not satisfy the declared range
 * at all. A fresh install on another machine would resolve something different
 * from what is being developed against, which makes every other finding in the
 * run conditional on whose lockfile you happen to be holding.
 */
export type LatentKind = 'unreviewed-drift' | 'range-violation';

/**
 * One piece of the repository that is already at odds with what is installed.
 *
 * Deliberately built out of `BreakingChange` and `ImpactSite` rather than a
 * parallel vocabulary: a break is a break, and a reviewer who has learned to
 * read one of Drift's reports should not have to learn a second dialect for
 * the findings that happen to be present-tense. The audit's contribution is
 * the *window* it evaluates, not a new kind of fact.
 */
export interface LatentFinding {
  id: string;
  kind: LatentKind;
  dependency: string;
  ecosystem: Ecosystem;
  /** Workspace member this belongs to. Absent in a single-package repository. */
  workspace?: string;
  manifestPath: string;
  /** The constraint as written in the manifest, e.g. `^4.0.0`. */
  declaredRange: string;
  /** Oldest version that range admits — see `rangeFloor`. */
  rangeFloor: string;
  /** What is actually resolved on disk, from the lockfile where one exists. */
  installedVersion: string;
  /**
   * The upstream change this repository is on the wrong side of.
   *
   * Absent on `range-violation`, which is a fact about the resolution itself
   * and needs no upstream change to be true.
   */
  breakingChange?: BreakingChange;
  /** Where it bites, today. Empty on `range-violation`. */
  sites: ImpactSite[];
  /** One line a reviewer can act on. */
  summary: string;
}

export interface AuditResult {
  findings: LatentFinding[];
  /** Direct dependencies examined. */
  checked: number;
  /**
   * Dependencies that had a non-empty window to analyse.
   *
   * The difference between this and `checked` is the pinned and unparseable
   * majority, and stating it is what keeps "no findings" from reading as "all
   * clear" when most of the project was never eligible to produce one.
   */
  analysed: number;
  gaps: AnalysisGap[];
  checkedSurfaces: CheckedSurface[];
}

/** An empty result, for the paths where the audit could not run at all. */
export function emptyAudit(): AuditResult {
  return { findings: [], checked: 0, analysed: 0, gaps: [], checkedSurfaces: [] };
}

/** Distinct repository files touched by a set of findings. */
export function affectedFiles(findings: readonly LatentFinding[]): number {
  return new Set(findings.flatMap((f) => f.sites.map((s) => s.file))).size;
}
