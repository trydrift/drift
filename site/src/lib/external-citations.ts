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
