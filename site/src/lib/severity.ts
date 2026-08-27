/*
 * GENERATED — do not edit.
 *
 * A verbatim copy of `src/upgrade/severity.ts` from the Drift core package,
 * refreshed by `site/scripts/sync-severity.mjs` before every build and dev
 * start. Edit the original; this file is overwritten.
 */

/**
 * How much a developer should care.
 *
 * This distinction is the whole point of Drift, and it must survive into the UI
 * intact. "Seven breaking changes" is a fact about the package. "None of them
 * touch your code" is the fact about *you*, and it is the one that decides
 * whether this upgrade is a five-second job or an afternoon.
 *
 * Deliberately dependency-free — no `vscode`, no imports at all — so the render
 * layer can use it and so the whole panel stays testable in plain Node.
 */

export type UpgradeSeverity =
  | 'affected'
  | 'verification-failed'
  | 'upstream-only'
  | 'unchecked'
  | 'clean'
  | 'error'
  /** Nothing has been checked yet. Not a verdict — the absence of one. */
  | 'pending';

/** The parts of an upgrade candidate that decide its severity. */
export interface SeverityInput {
  status: string;
  breakingCount: number;
  impactCount: number;
  actionableImpactCount?: number;
  actionableImpactFiles?: number;
  runtimeDeclarationSiteCount?: number;
  impactFiles: number;
  /**
   * Reasons this upgrade could not actually be checked — no declarations to
   * diff, no changelog, no release in the range.
   */
  gaps?: readonly string[];
  /**
   * The rationale's conclusion, when one was reached.
   *
   * Takes precedence over counting gaps, because it knows something counting
   * cannot: whether any source actually *answered*. A package whose exported
   * API was compared symbol by symbol and found unchanged has been checked,
   * even though it has no changelog and therefore still carries a gap. Reading
   * that as "not verified" would bury a real result under a missing one.
   */
  recommendation?: string;
  /**
   * The result of actually installing this upgrade and running the project's
   * own checks against it, when that was done.
   *
   * A `'failed'` verification is measured evidence that this upgrade breaks
   * the project, even when static analysis found zero impact sites to point
   * at — a compiler or test runner sees things a source-level diff cannot
   * (dynamic dispatch, config-driven behaviour, a peer dependency mismatch).
   * That must never be read as `'clean'` or `'upstream-only'`, both of which
   * tell the developer this is safe.
   */
  verification?: {
    status: string;
    checks?: readonly { label: string; status: string }[];
  };
  /**
   * The strongest local-impact confidence among the sites behind
   * `impactCount`, when it was computed.
   *
   * `'affected'` used to be stated with the same certainty for a direct,
   * imported usage and a bare textual match with no import edge — the two
   * things `assessLocalImpact` in `confidence/calibrate.ts` deliberately
   * scores apart. Below `'high'`, `describeSeverity` hedges to "May affect"
   * rather than "Affects", so the wording carries the same distinction the
   * scoring already makes. Absent (not `undefined` on purpose vs. omitted)
   * is treated as unhedged, so callers that have not been updated to supply
   * it keep today's wording.
   */
  impactConfidence?: 'high' | 'medium' | 'low' | 'none';
  /**
   * The affected count includes a finding a compiler could disprove, but the
   * only pass that has run for it was scoped to a batch of upgrades — which is
   * never allowed to clear one, batch-mates can compensate for each other.
   * That is a true "affects your code" exactly as much as an unverified
   * prediction is, and `describeSeverity` says so, rather than reading the
   * same way as a finding an isolated check already looked at and stood by.
   * Whether probing this dependency alone would flip the verdict to safe is
   * unknown until that isolated check actually runs — batching is what makes
   * a clean scan cheap, and re-running everything solo just to find out would
   * give up exactly the cost that batching exists to save.
   */
  impactPendingIsolatedClearance?: boolean;
  /**
   * What Drift established about this repository's runtime relative to the
   * upgrade's runtime requirements — `'compatible'`, `'incompatible'`,
   * `'partial'`, `'unknown'` — or absent when the upgrade announced none.
   *
   * This module is deliberately dependency-free (the render layer imports
   * it), so the union is spelled out rather than imported from
   * `types.ts`; `RuntimeCompatibilityState` is its definition.
   *
   * It exists because a package-wide compatibility condition is invisible to
   * every count above it. A raised Node floor Drift could not check against
   * this repository produces zero impact sites, and `breakingCount > 0` then
   * rendered "Safe for your code · N upstream changes, none used here" over
   * a question nobody answered. `upstream-only` may only ever mean *Drift
   * found upstream breaking changes and established this repository is
   * unaffected* — never *found them and failed to find a local site*.
   */
  runtimeCompatibility?: 'compatible' | 'incompatible' | 'partial' | 'unknown';
}

/**
 * Whether this candidate's prediction has been checked against the project's
 * own toolchain — a throwaway worktree, a real install, and typecheck/build/
 * test — as opposed to read off the dependency's own published declarations
 * and changelog.
 *
 * Orthogonal to {@link UpgradeSeverity}: a candidate can be `clean` and
 * `not-run` (nothing installed yet, Quick Scan only), `clean` and `passed`
 * (Deep Verification confirmed it), or `affected` and `skipped` (a location
 * was found statically, and separately an attempt to install and check it
 * did not finish). `unchecked` severity is unaffected by this — it means no
 * *static* evidence was reachable at all, which is a different gap than
 * whether the toolchain ran.
 */
export type VerificationState = 'not-run' | 'skipped' | 'passed' | 'failed';

export function verificationState(candidate: SeverityInput): VerificationState {
  if (!candidate.verification) return 'not-run';
  if (candidate.verification.status === 'passed') return 'passed';
  if (candidate.verification.status === 'failed') return 'failed';
  return 'skipped';
}

/**
 * The verdict.
 *
 * `unchecked` exists because the alternative is a lie Drift told once and must
 * never tell again: zod 3 → 4 and typescript 5 → 7 were both reported as *no
 * breaking changes found* when the truth was that nothing had been found at
 * all — the `.d.ts` surface would not resolve, no changelog was reachable, and
 * the only evidence was "the major number went up". Zero findings from a
 * complete check and zero findings from a check that never happened are
 * different facts, and a developer needs to be told which one they have.
 */
export function severityOf(candidate: SeverityInput): UpgradeSeverity {
  // A row that exists because a manifest names the package, and for no other
  // reason. Every count on it is zero because nothing has looked yet, and the
  // rules below would read those zeroes as a clean bill of health — which is
  // the one wrong answer this module exists to prevent.
  if (candidate.status === 'pending') return 'pending';
  if (candidate.status === 'error') return 'error';
  const runtimeUnresolved =
    candidate.runtimeCompatibility === 'unknown' || candidate.runtimeCompatibility === 'partial';
  // The canonical count, when the plan supplied one. The fallback for a direct
  // caller that did not is deliberately *not* `runtime unknown ? 0 : impact`:
  // zeroing the whole candidate because its runtime is unresolved would erase
  // independent API impact. Only the runtime declaration sites are held back
  // for review; the API sites still count.
  const actionableImpactCount = candidate.actionableImpactCount ?? (
    runtimeUnresolved
      ? (candidate.runtimeDeclarationSiteCount === undefined
        ? 0
        : Math.max(0, candidate.impactCount - candidate.runtimeDeclarationSiteCount))
      : candidate.impactConfidence !== undefined && candidate.impactConfidence !== 'high'
        ? 0
        : candidate.impactCount
  );
  if (actionableImpactCount > 0) return 'affected';
  // Static analysis found nothing to point at, but the project's own toolchain
  // — running for real, not predicting — disagrees. That is a stronger signal
  // than a clean diff and must outrank it, not be silently absorbed by it.
  if (candidate.verification?.status === 'failed') return 'verification-failed';

  // Local evidence that is real but not actionable — a low-confidence API
  // match, a runtime declaration under a partial/unknown result — is still
  // evidence. It cannot be `affected` (nothing here is safe to auto-edit) and
  // it must never fall through to `upstream-only` or `clean`, both of which
  // tell the developer this repository is unaffected.
  if (candidate.impactCount > 0) return 'unchecked';

  // Checked *before* `breakingCount`, and before the recommendation/gap
  // ladder below, because every verdict past this point tells the developer
  // some form of "this is fine here". A runtime requirement Drift could not
  // resolve against this repository — a dynamic CI matrix, no authoritative
  // declaration at all, an upstream range whose grammar it could not
  // evaluate — is precisely the case where zero impact sites means zero
  // knowledge, not zero risk. `partial` lands here too on the rare path where
  // it produced no site: a declared range that admits rejected versions has
  // not been shown to be safe either.
  if (candidate.runtimeCompatibility === 'unknown' || candidate.runtimeCompatibility === 'partial') {
    return 'unchecked';
  }

  if (candidate.breakingCount > 0) return 'upstream-only';

  // The assessment ran and concluded that nothing could be read. That is the
  // authoritative form of this verdict, and it is reached only when no source
  // answered at all.
  if (candidate.recommendation === 'insufficient-evidence') return 'unchecked';
  if (candidate.recommendation) return 'clean';

  if (candidate.gaps && candidate.gaps.length > 0) return 'unchecked';
  return 'clean';
}

/**
 * The line shown on a package row.
 *
 * Never leads with a raw breaking-change count when nothing here is affected —
 * that reads as an alarm, and an alarm that turns out to be nothing is how a
 * tool teaches people to ignore it.
 */
export function describeSeverity(candidate: SeverityInput): string {
  const state = verificationState(candidate);
  // Appended to a prediction that Deep Verification has not (yet, or not
  // successfully) confirmed, so a Quick Scan result never reads the same as
  // one the project's own toolchain has actually stood behind. Never applied
  // to `verification-failed`/`unchecked`, which already say something
  // stronger and more specific about why nothing here can be called safe.
  const deepNote =
    state === 'not-run'
      ? ' — not deeply verified'
      : state === 'skipped'
        ? ' — deep verification did not complete'
        : '';

  switch (severityOf(candidate)) {
    case 'pending':
      return 'Not checked yet';
    case 'error':
      return 'Could not check';
    case 'affected': {
      // "actionable" only when the plan actually separated actionable sites
      // from review-only ones. A direct caller that supplied a raw
      // `impactCount` keeps today's plain "N sites" wording.
      const hasCanonicalCounts = candidate.actionableImpactCount !== undefined;
      const files = candidate.actionableImpactFiles ?? candidate.impactFiles;
      const actionable = candidate.actionableImpactCount ?? candidate.impactCount;
      const siteNoun = hasCanonicalCounts ? 'actionable site' : 'site';
      // Hedged unless the strongest match is a direct, imported usage — a
      // textual-only or wrapper-mediated match is real enough to surface, but
      // not certain enough to tell someone flatly that their code is affected.
      // Also hedged when the only established fact is a *partial* runtime
      // overlap: the declaration was found with certainty, and what it means
      // is that this repository's declared range includes versions upstream
      // rejects — not that the version it actually runs on is one of them.
      const verb =
        (candidate.impactConfidence && candidate.impactConfidence !== 'high') ||
        candidate.runtimeCompatibility === 'partial'
          ? 'May affect'
          : 'Affects';
      // Stated whenever it applies, for the same reason `describeVerification`
      // states `measuredWith`: this exact finding could read "safe" on the
      // next scan for no reason but an unrelated dependency's install
      // happening to fail and knocking this one out of its batch and into an
      // isolated probe. Silence here is what made that look like Drift
      // contradicting itself; naming the batch scope makes it what it is —
      // still-unconfirmed, not yet disproven.
      const unconfirmed = candidate.impactPendingIsolatedClearance
        ? ' — not yet confirmed alone: a batch check passed without testing this package in isolation'
        : '';
      // A located impact site that Deep Verification also measured as
      // breaking is stronger than either fact alone — said explicitly rather
      // than left to the generic `deepNote`, which only speaks to whether
      // verification ran, not to what it found.
      const measured = state === 'failed' ? ' — and its own checks fail with this installed, measured not predicted' : deepNote;
      const runtimeReview = (candidate.runtimeDeclarationSiteCount ?? 0) > 0 &&
        (candidate.runtimeCompatibility === 'unknown' || candidate.runtimeCompatibility === 'partial')
        ? ` · ${candidate.runtimeDeclarationSiteCount} runtime declaration${candidate.runtimeDeclarationSiteCount === 1 ? '' : 's'} to review`
        : '';
      return `${verb} your code · ${actionable} ${siteNoun}${actionable === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}${runtimeReview}${unconfirmed}${measured}`;
    }
    case 'verification-failed': {
      const failing = (candidate.verification?.checks ?? [])
        .filter((check) => check.status === 'failed')
        .map((check) => check.label);
      return failing.length > 0
        ? `Verified breaking · ${failing.join(', ')} failed with this upgrade installed — measured, not predicted`
        : "Verified breaking · this upgrade broke the project's own checks — measured, not predicted";
    }
    case 'upstream-only': {
      const base = `${candidate.breakingCount} upstream change${candidate.breakingCount === 1 ? '' : 's'}, none used here`;
      return state === 'passed'
        ? `Verified safe · ${base}, and your own checks pass`
        : `Safe for your code · ${base}${deepNote}`;
    }
    case 'unchecked': {
      // Two different facts share this severity. One is "nothing was reachable
      // to check against". The other is "something local was found, but it is
      // not confirmed enough to act on" — a low-confidence API match, or a
      // runtime declaration under an unresolved compatibility result. The
      // second must not read as the first, and neither may read as safe.
      const reviewOnly =
        (candidate.actionableImpactCount ?? 0) === 0 && candidate.impactCount > 0;
      if (reviewOnly) {
        const n = candidate.impactCount;
        return `Review required · ${n} local site${n === 1 ? '' : 's'} Drift flagged but could not confirm — check before upgrading`;
      }
      return 'Not verified · Drift found nothing it could check this version against';
    }
    case 'clean': {
      // "Safe for your code" and "you should take this" are different things,
      // and an upgrade that closes a known advisory deserves the stronger word.
      const upgradeRecommended = candidate.recommendation === 'upgrade-recommended';
      if (state === 'passed') {
        return upgradeRecommended
          ? 'Verified worth taking · no breaking changes, it improves on what you have, and your own checks pass'
          : 'Verified safe · no breaking changes found, and your own checks pass';
      }
      return upgradeRecommended
        ? `Worth taking · no breaking changes, and it improves on what you have${deepNote}`
        : `Safe for your code · no breaking changes found${deepNote}`;
    }
  }
}

/**
 * Order by what the developer has to act on, not by upstream noise.
 *
 * Unverified upgrades sort above clean ones and below anything with a real
 * finding: they are not an emergency, but leaving them at the bottom of the
 * list next to the genuinely safe ones is how one gets installed by accident.
 */
export function compareSeverity(a: SeverityInput, b: SeverityInput): number {
  const rank = {
    affected: 0,
    'verification-failed': 1,
    error: 2,
    'upstream-only': 3,
    unchecked: 4,
    // Above `clean` deliberately: a package nobody has looked at yet is not a
    // package that has been cleared, and sorting it under the safe ones is how
    // it would be read as one.
    pending: 5,
    clean: 6,
  } as const;
  return rank[severityOf(a)] - rank[severityOf(b)];
}

/**
 * The name a conversation about this scan should carry in the history list.
 *
 * Not the same job as `describeSeverity`, which describes one package to
 * someone already looking at it. This describes a whole run to someone
 * scanning forty saved conversations for the one they want, where the only
 * question is *which of these is which*. Every one of them was started by
 * pressing the same button, so the command tells them nothing and the tallies
 * tell them everything.
 *
 * Leads with the affected count when there is one, because that is what a
 * developer remembers a scan by — "the one where three things broke".
 */
export function scanTitle(
  candidates: readonly SeverityInput[],
  checked = 0,
  /**
   * Dependencies whose *version lookup* never returned — a registry Drift
   * could not reach, or an ecosystem with no version API. These never became
   * candidates at all, so counting only the candidates' own `unchecked`
   * severity would title a run "all up to date" while four dependencies went
   * unlooked-at. See `UpgradeScanResult.unchecked`.
   */
  unlooked = 0,
): string {
  if (candidates.length === 0) {
    if (unlooked > 0) {
      const upToDate = Math.max(0, checked - unlooked);
      return upToDate > 0
        ? `Scan — ${upToDate} up to date, ${unlooked} could not be checked`
        : `Scan — ${unlooked} could not be checked`;
    }
    return checked > 0 ? `Scan — ${checked} up to date` : 'Scan — nothing to upgrade';
  }

  const affected = candidates.filter((c) => severityOf(c) === 'affected').length;
  // A failed verification has no located impact site, but it is still a real
  // reason this upgrade affects the repo — a title that only counted
  // `affected` would report "all safe" over a build Drift just watched fail.
  const verificationFailed = candidates.filter((c) => severityOf(c) === 'verification-failed').length;
  const unchecked = candidates.filter((c) => severityOf(c) === 'unchecked').length + unlooked;
  const total = candidates.length;

  const urgent = affected + verificationFailed;
  if (urgent > 0) return `Scan — ${urgent} of ${total} affect this repo`;
  // Kept distinct from "all safe" for the same reason the verdict is: a run
  // that could not check something did not find it safe, and a title that
  // says otherwise is the claim Drift exists to stop making.
  if (unchecked > 0) return `Scan — ${total} upgrade${total === 1 ? '' : 's'}, ${unchecked} unverified`;
  return `Scan — ${total} upgrade${total === 1 ? '' : 's'}, all safe`;
}
