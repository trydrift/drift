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

export const NPM_BREAKING_CHANGE_STUDY = {
  /** "around 12% of the dependent packages and 14% of their releases" — the paper's own abstract. */
  rate: "12–14%",
  title: 'Ruan, H. et al., "I Depended on You and You Broke Me: An Empirical Study of Manifesting Breaking Changes in Client Packages", ACM TOSEM, 2023.',
  url: "https://arxiv.org/abs/2301.04563",
} as const;

/**
 * General developer-maintenance time, not dependency-specific. The report
 * puts the average developer's week at 17.3 hours on maintenance work —
 * "debugging, refactoring code, or improving code quality" — of a 41.1-hour
 * week. Quoted as a rounded "17+ hours" so the figure reads as what the
 * report actually measured rather than a suspiciously precise decimal.
 */
export const DEVELOPER_MAINTENANCE_TIME_STUDY = {
  value: "17+ hours/week",
  description: "the average developer spends on maintenance such as debugging and refactoring.",
  sourceLine: "Stripe, The Developer Coefficient",
  title: 'Stripe, "The Developer Coefficient", 2018.',
  url: "https://stripe.com/files/reports/the-developer-coefficient.pdf",
  scope: "Survey of ~1,000 senior software developers and C-suite executives across the US, UK, France, Germany, Singapore, Ireland and India.",
} as const;

/**
 * The same report's global opportunity-cost estimate from time spent on
 * "bad code" — not narrowed to dependency upgrades specifically, because the
 * report does not narrow it either.
 */
export const BAD_CODE_OPPORTUNITY_COST_STUDY = {
  value: "~$85B/year",
  description: 'estimated annual opportunity cost from developer time spent dealing with "bad code."',
  sourceLine: "Stripe, The Developer Coefficient",
  title: 'Stripe, "The Developer Coefficient", 2018.',
  url: "https://stripe.com/files/reports/the-developer-coefficient.pdf",
  scope: "Survey of ~1,000 senior software developers and C-suite executives across the US, UK, France, Germany, Singapore, Ireland and India.",
} as const;

/**
 * Optional third figure. Kept out of the primary problem-scale pairing so
 * the section doesn't grow past two numbers unless there's room for it.
 */
export const TECH_DEBT_BUDGET_DIVERSION_STUDY = {
  value: "10–20%",
  description: "of new-product technology budgets that CIOs report being diverted to resolving technical-debt issues.",
  sourceLine: "McKinsey, Tech debt: Reclaiming tech equity",
  title: 'McKinsey & Company, "Tech debt: Reclaiming tech equity", 2020.',
  url: "https://www.mckinsey.com/capabilities/tech-and-ai/our-insights/tech-debt-reclaiming-tech-equity",
  scope: "Survey of 50 CIOs at financial-services and technology firms with more than $1B in annual revenue.",
} as const;
