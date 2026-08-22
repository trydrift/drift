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
 * Independent corroboration in a second ecosystem (npm), not a redundant
 * repeat of the Maven figure. Kept out of the primary stat row and used only
 * as a footnote/detail line.
 */
export const NPM_BREAKING_CHANGE_STUDY = {
  /** "around 12% of the dependent packages and 14% of their releases" — the paper's own abstract. */
  rate: "12–14%",
  /** "44% ... were introduced in both minor and patch releases" — the paper's own abstract. */
  minorPatchShare: "44%",
  title:
    'Ruan, H., Chen, R., Zhang, T. et al., "I Depended on You and You Broke Me: An Empirical Study of Manifesting Breaking Changes in Client Packages", ACM Transactions on Software Engineering and Methodology, 2023.',
  url: "https://doi.org/10.1145/3576037",
  scope: "npm ecosystem. Corroborates the Maven study's non-major-update finding in a second language and package manager.",
} as const;

/**
 * A real, named case study of dependency-maintenance cost at enterprise
 * scale — not an industry average, and labelled as such everywhere it's
 * shown.
 */
export const ELASTIC_DEPENDENCY_MAINTENANCE_CASE_STUDY = {
  value: "100s hrs/week",
  description:
    "of manual checking and bumping, by Elastic's own estimate, across the ~500 dependencies its core services keep actively updated.",
  sourceLine: "Elastic Engineering · Elasticsearch Labs",
  title:
    'Elastic, "CI/CD pipelines with agentic AI: How to create self-correcting monorepos", Elasticsearch Labs, September 30, 2025.',
  url: "https://www.elastic.co/search-labs/blog/ci-pipelines-claude-ai-agent",
  scope: "One company's case study of its own core services — not an industry-wide average.",
} as const;

/** BLS May 2025 OEWS, used only to convert the Elastic hours estimate into a labelled, methodology-disclosed illustration below. */
export const BLS_SOFTWARE_DEVELOPER_WAGE = {
  meanHourly: "$71.20",
  meanAnnual: "$148,100",
  title:
    "U.S. Bureau of Labor Statistics, Occupational Employment and Wage Statistics, May 2025 — Software Developers (SOC 15-1252).",
  url: "https://www.bls.gov/oes/current/oes151252.htm",
} as const;

/**
 * A transparent, labelled illustration — not a Drift savings claim and not a
 * sourced industry-spending figure. 200 h/week is a deliberately conservative
 * reading of Elastic's "hundreds of engineering hours a week": 200 × $71.20 ×
 * 52 ≈ $740,480/year, rounded to "≈$740k/year". No global dependency-
 * maintenance market size is asserted anywhere on this site because no
 * source directly quantifies one.
 */
export const WAGE_EQUIVALENT_ILLUSTRATION = {
  value: "≈$740k/year",
  label: "wage-equivalent*",
  footnote:
    'Illustration using 200 h/week (a conservative reading of Elastic’s "hundreds of engineering hours a week") and the BLS 2025 mean U.S. software-developer wage. Wages only. Not an industry TAM estimate.',
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
