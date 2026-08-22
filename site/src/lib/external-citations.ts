/**
 * Numbers quoted on the site that are not Drift's own results.
 *
 * `check-benchmark-copy.mjs` bans a bare metric-shaped literal (a fraction,
 * a percentage, a three-decimal figure) anywhere in `src/app/page.tsx` or
 * `src/app/benchmarks/page.tsx` — the rule exists to stop one of *Drift's*
 * numbers going stale unnoticed, by forcing every such figure to be read out
 * of `loadBenchmarks()`/`buildNarrative()` through a JSX expression rather
 * than typed into the page. An external citation isn't one of Drift's
 * numbers and never comes from a run artifact, but the same discipline still
 * applies to it for a different reason: living here, once, named, and
 * imported — rather than typed inline in the page — is what keeps a second
 * mention of the same study from silently drifting to a different figure.
 *
 * Update a value here only by re-reading the cited source, the same way a
 * Drift number only changes by re-running the benchmark it comes from.
 */

/**
 * The primary problem-scale source. A peer-reviewed, large-sample study of
 * real dependency updates — not a survey, not an opinion piece.
 */
export const MAVEN_BREAKING_CHANGE_STUDY = {
  /** "11.58% of the ... dependency updates resulted in breaking changes" — the paper's own results. */
  clientBreakRate: "11.58%",
  /** Same figure as a number, for the 100-unit unaffected/breaking split visualization. */
  clientBreakRateValue: 11.58,
  /** "almost half of them were introduced during a non-major update" — refined to the paper's exact figure. */
  nonMajorShare: "41.58%",
  title:
    'Jayasuriya, D., Ou, S., Hegde, S., Terragni, V., Dietrich, J., Blincoe, K., "An Extended Study of Syntactic Breaking Changes in the Wild", Empirical Software Engineering, 2024.',
  url: "https://doi.org/10.1007/s10664-024-10563-4",
  scope: "18,415 Maven artifacts · 142,355 direct dependencies. Java/Maven only — not a claim about every ecosystem.",
} as const;

/**
 * Macro cost of outdated, poorly-maintained software across the US economy —
 * cybersecurity incidents, operational failures, and technical-debt
 * maintenance combined. A US-wide estimate, not a per-company figure, and
 * labelled as such everywhere it's shown.
 */
export const OUTDATED_SOFTWARE_COST_STUDY = {
  value: "$2.41T/year",
  description:
    "in cybersecurity incidents, operational failures, and maintenance of outdated systems, annually in the US.",
  sourceLine: "CISQ / Synopsys, via American Enterprise Institute",
  title:
    'Consortium for Information & Software Quality (CISQ) and Synopsys research, as reported by the American Enterprise Institute, "Inside Tech’s $2 Trillion Technical Debt", January 2026.',
  url: "https://www.aei.org/technology-and-innovation/inside-techs-2-trillion-technical-debt/",
  scope: "US-wide estimate across the economy — not a claim about any single company or dependency.",
} as const;

/**
 * Open-source dependency risk at the codebase level — the security
 * complement to the Maven/npm breaking-change studies above, which measure
 * risk at the update level.
 */
export const VULNERABLE_DEPENDENCIES_STUDY = {
  value: "86%",
  description: "of commercial codebases contain at least one vulnerable open-source dependency.",
  sourceLine: "Black Duck 2025 OSSRA report",
  title: 'Black Duck Software, "2025 Open Source Security and Risk Analysis (OSSRA) Report", February 25, 2025.',
  url: "https://news.blackduck.com/2025-02-25-New-Black-Duck-Report-86-of-Commercial-Codebases-Contain-Vulnerable-Open-Source,-Exposing-Organizations-to-Security-Risks",
  scope:
    "Audit of commercial codebases across industries. A vulnerable dependency, not necessarily a breaking or actively exploited one.",
} as const;

/**
 * Support for structured dependency context as a useful input to automated
 * repair — not a claim that Drift has been evaluated head-to-head against
 * this benchmark.
 */
export const BYAM_LLM_REPAIR_STUDY = {
  /** "a build success rate of 27%" — the paper's best-performing tested model. */
  buildRepairRate: "27%",
  /** "repairing roughly 78% of individual compilation errors" per the same run. */
  errorRepairRate: "~78%",
  title:
    'Reyes, F., Mahmoud, M., Bono, F., Nadi, S., Baudry, B., Monperrus, M., "Byam: Fixing Breaking Dependency Updates with Large Language Models", Empirical Software Engineering, 2026.',
  url: "https://doi.org/10.1007/s10664-026-10835-1",
  scope:
    "Best-performing tested model on the BUMP Java benchmark, given the erroneous line and computed API diff. Not a head-to-head comparison with Drift.",
} as const;
