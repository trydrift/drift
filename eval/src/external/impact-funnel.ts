import { z } from 'zod';
import {
  isLocallyUnprovable,
  taxonomyOf,
  VERIFICATION_FAILURE_BLOCKER_PREFIX,
  type BreakingChange,
  type RemediationPlan,
} from '../../../dist/index.js';
import type { LocalizationDiagnostic } from '../../../dist/analysis.js';

/**
 * Why a scored positive case did not end at `locally-affected`, in one word.
 *
 * The consumer-impact benchmarks answer "does Drift catch this break, and can
 * it point at the code". When Drift does not, the aggregate rate says how
 * often — never where in the pipeline the answer was lost. Reconstructing that
 * has meant opening `cases.jsonl.gz` and reverse-engineering each miss by
 * hand. This taxonomy makes every miss land in exactly one stage, so a
 * proposed engine change can be sized against the funnel before it is built:
 * "semantic localization is 22 of 41 npm misses" is a number the report should
 * produce, not one an investigation should have to.
 *
 * The stages run in pipeline order. A case is charged to the *first* stage
 * that failed — a break with no upstream surface cannot also be charged to
 * localization, because localization never had anything to search for.
 */
export const IMPACT_MISS_REASONS = [
  /** Drift never saw the dependency version move. Upstream of everything else. */
  'dependency-update-not-detected',
  /**
   * The manifest states a range and no lockfile or authoritative resolution
   * pinned it, so there is no concrete before/after pair to analyse. A
   * corpus/benchmark limitation as often as an engine one — kept separate so
   * the two do not blur.
   */
  'exact-version-unresolved',
  /** No computed API-surface diff was available for this ecosystem or version pair. */
  'upstream-surface-unavailable',
  /** A surface was computed (or prose retrieved) but Drift derived no breaking change from it. */
  'no-breaking-change-derived',
  /** A breaking change was derived but its upstream evidence is too weak to stand behind. */
  'breaking-change-low-confidence',
  /** Nothing in the repository imports the changed dependency (no importer, direct or re-exported). */
  'dependency-import-not-found',
  /**
   * Importers exist, but the changed symbol never resolved to a consumer
   * reference — an alias, a re-export, an inferred or structural type the
   * current localizer cannot follow. The bucket a semantic consumer analyzer
   * is meant to drain.
   */
  'consumer-symbol-not-resolved',
  /** Importers were searched and simply contained no usage of the affected symbols. */
  'consumer-usage-not-found',
  /**
   * A consumer match was found but was too weak to carry the verdict — textual
   * only, wrapper-mediated, or dynamic — so the plan stayed hedged.
   */
  'consumer-match-insufficient-confidence',
  /** Verification could not run: a tool or runtime it needs is absent. */
  'verification-unavailable',
  /** The project's own checks were already failing on the baseline, so a later failure proves nothing. */
  'verification-baseline-failed',
  /** Verification reached the project but its dependency install step failed. */
  'verification-install-failed',
  /** Verification ran and failed, but not in a way that isolates the regression to this dependency. */
  'verification-inconclusive',
  /**
   * The change is only observable at runtime (behaviour/default), no static
   * signal is possible, and no verification established it either.
   */
  'behavioural-change-without-static-signal',
  /** Several dependencies moved together and a failure could not be pinned on one. */
  'multi-dependency-attribution-ambiguous',
  /** None of the above fit. Should stay small; a growing count is a taxonomy gap. */
  'other',
] as const;

export type ImpactMissReason = (typeof IMPACT_MISS_REASONS)[number];
export const impactMissReasonSchema = z.enum(IMPACT_MISS_REASONS);

/** The verification status the funnel reasons about, flattened from `UpgradeVerification` plus "never attempted". */
export type FunnelVerificationStatus = 'passed' | 'failed' | 'skipped' | 'not-run';

/**
 * Secondary per-case diagnostics.
 *
 * Recorded on every scored positive case, not only the misses — a hit's funnel
 * shape (was it static or measured, how many candidate files) is as useful for
 * spotting a fragile pass as a miss's is for triage.
 */
export const impactDiagnosticsSchema = z.object({
  dependencyChangeCount: z.number().int().nonnegative(),
  /** Upstream surface/prose findings the evidence stage produced. Not the same as `breakingChangeCount`. */
  upstreamSurfaceChangeCount: z.number().int().nonnegative(),
  breakingChangeCount: z.number().int().nonnegative(),
  /** Files importing the changed dependency (direct or re-exported). `-1` when localization did not record it. */
  candidateConsumerFileCount: z.number().int(),
  impactSiteCount: z.number().int().nonnegative(),
  semanticAnalysisRan: z.boolean(),
  verificationRan: z.boolean(),
  verificationStatus: z.enum(['passed', 'failed', 'skipped', 'not-run']),
  confirmedRegression: z.boolean(),
});
export type ImpactDiagnostics = z.infer<typeof impactDiagnosticsSchema>;

export const impactFunnelSchema = z.object({
  /** `null` exactly when the case reached `locally-affected`. */
  missReason: impactMissReasonSchema.nullable(),
  diagnostics: impactDiagnosticsSchema,
});
export type ImpactFunnel = z.infer<typeof impactFunnelSchema>;

/**
 * The normalized view the classifier reasons over.
 *
 * Built by {@link deriveImpactFunnelSignals} from a Drift plan, plus the two
 * facts the plan cannot carry: whether *this benchmark* considers the update
 * detected, and whether an exact version pair was resolvable (a corpus
 * property for swe-bump and timemachine).
 */
export interface ImpactFunnelSignals {
  updateDetected: boolean;
  exactVersionResolved: boolean;
  surfaceComputedForTarget: boolean;
  breakingChangeCount: number;
  maxUpstreamBand: 'none' | 'low' | 'medium' | 'high';
  localizationRan: boolean;
  /** `-1` when unknown. */
  importerCandidateFiles: number;
  impactSiteCount: number;
  localImpactPenaltyCodes: readonly string[];
  onlyLocallyUnprovable: boolean;
  verificationStatus: FunnelVerificationStatus;
  verificationReason: string;
  confirmedRegression: boolean;
  multiDependencyAmbiguous: boolean;
}

const BAND_RANK: Record<ImpactFunnelSignals['maxUpstreamBand'], number> = { none: 0, low: 1, medium: 2, high: 3 };

/**
 * Charge a miss to the first pipeline stage that failed.
 *
 * Only ever called for a case that did *not* reach `locally-affected`, so a
 * confirmed regression (which forces that verdict) is never seen here.
 */
export function classifyImpactMiss(signals: ImpactFunnelSignals): ImpactMissReason {
  if (!signals.updateDetected) return 'dependency-update-not-detected';
  if (!signals.exactVersionResolved) return 'exact-version-unresolved';
  if (!signals.surfaceComputedForTarget) return 'upstream-surface-unavailable';
  if (signals.breakingChangeCount === 0) return 'no-breaking-change-derived';
  if (BAND_RANK[signals.maxUpstreamBand] <= BAND_RANK.low) return 'breaking-change-low-confidence';

  // Verification only pre-empts the localization stages when it actively
  // failed or was actively prevented. A benign skip ("project declares no
  // checks") is not why the case is a miss — static localization is — so it
  // falls through.
  if (signals.verificationStatus === 'failed') {
    return signals.multiDependencyAmbiguous
      ? 'multi-dependency-attribution-ambiguous'
      : 'verification-inconclusive';
  }
  if (signals.verificationStatus === 'skipped') {
    const reason = signals.verificationReason.toLowerCase();
    if (/before any upgrade is applied|already fails|prove nothing|already red/.test(reason)) {
      return 'verification-baseline-failed';
    }
    if (/not installed|missing|could not run in the current environment/.test(reason)) {
      return 'verification-unavailable';
    }
    if (/install/.test(reason)) return 'verification-install-failed';
    // else: no checks to run — a localization miss, keep going.
  }

  if (signals.onlyLocallyUnprovable) return 'behavioural-change-without-static-signal';

  if (signals.localizationRan && signals.importerCandidateFiles === 0) {
    return 'dependency-import-not-found';
  }

  const weakMatch = signals.localImpactPenaltyCodes.some((code) =>
    ['textual-only', 'wrapper-mediated', 'dynamic-access', 'generated-only', 'some-generated'].includes(code),
  );
  if (signals.impactSiteCount > 0 || weakMatch) return 'consumer-match-insufficient-confidence';

  if (signals.localizationRan) {
    return signals.localImpactPenaltyCodes.includes('no-usage-found')
      ? 'consumer-usage-not-found'
      : 'consumer-symbol-not-resolved';
  }

  return 'other';
}

/** Highest upstream confidence band across a plan's breaking changes. */
function maxUpstreamBand(changes: readonly BreakingChange[]): ImpactFunnelSignals['maxUpstreamBand'] {
  let best: ImpactFunnelSignals['maxUpstreamBand'] = 'none';
  for (const change of changes) {
    const band = change.assessment?.upstream.band ?? change.confidence;
    const normalized: ImpactFunnelSignals['maxUpstreamBand'] =
      band === 'high' ? 'high' : band === 'medium' ? 'medium' : band === 'low' ? 'low' : 'none';
    if (BAND_RANK[normalized] > BAND_RANK[best]) best = normalized;
  }
  return best;
}

export interface DeriveFunnelInput {
  plan: RemediationPlan | null | undefined;
  localizationDiagnostics?: readonly LocalizationDiagnostic[];
  /** True for a plan `changes` entry that is the dependency this case is about. */
  isTargetDependency: (name: string) => boolean;
  updateDetected: boolean;
  exactVersionResolved: boolean;
}

/** Read the plan and localization diagnostics into the classifier's normalized view. */
export function deriveImpactFunnelSignals(input: DeriveFunnelInput): ImpactFunnelSignals {
  const { plan } = input;
  const breakingChanges = plan?.breakingChanges ?? [];

  const apiSurfaceRows = (plan?.checkedSurfaces ?? []).filter((surface) => surface.surface === 'api-surface');
  const targetRows = apiSurfaceRows.filter((surface) => surface.dependency && input.isTargetDependency(surface.dependency));
  const rowsToConsult = targetRows.length > 0 ? targetRows : apiSurfaceRows;
  const surfaceComputedForTarget =
    rowsToConsult.length > 0 && rowsToConsult.some((surface) => surface.status === 'checked');

  const targetDiagnostics = (input.localizationDiagnostics ?? []).filter((row) => input.isTargetDependency(row.dependency));
  const importerCandidateFiles =
    input.localizationDiagnostics === undefined
      ? -1
      : targetDiagnostics.length > 0
        ? targetDiagnostics.reduce((sum, row) => sum + row.importerCandidateFiles, 0)
        : (input.localizationDiagnostics.reduce((sum, row) => sum + row.importerCandidateFiles, 0) || 0);

  const localImpactPenaltyCodes = [
    ...new Set(breakingChanges.flatMap((change) => (change.assessment?.localImpact.penalties ?? []).map((p) => p.code))),
  ];

  const verificationStatus: FunnelVerificationStatus = plan?.verification ? plan.verification.status : 'not-run';
  const confirmedRegression = (plan?.confirmedRegressions?.length ?? 0) > 0;
  const verificationFailedBlocker = (plan?.blockers ?? []).some((blocker) =>
    blocker.startsWith(VERIFICATION_FAILURE_BLOCKER_PREFIX),
  );

  return {
    updateDetected: input.updateDetected,
    exactVersionResolved: input.exactVersionResolved,
    surfaceComputedForTarget,
    breakingChangeCount: plan?.upstreamBreakingCount ?? breakingChanges.length,
    maxUpstreamBand: maxUpstreamBand(breakingChanges),
    localizationRan: plan?.localizationRan ?? true,
    importerCandidateFiles,
    impactSiteCount: plan?.impactSites.length ?? 0,
    localImpactPenaltyCodes,
    onlyLocallyUnprovable:
      breakingChanges.length > 0 && breakingChanges.every((change) => isLocallyUnprovable(taxonomyOf(change))),
    verificationStatus,
    verificationReason: plan?.verification?.reason ?? '',
    confirmedRegression,
    multiDependencyAmbiguous:
      verificationFailedBlocker && !confirmedRegression && (plan?.changes.length ?? 0) > 1,
  };
}

/** The secondary diagnostics block, from the same inputs. */
export function deriveImpactDiagnostics(input: DeriveFunnelInput): ImpactDiagnostics {
  const { plan } = input;
  const signals = deriveImpactFunnelSignals(input);
  const upstreamSurfaceChangeCount = (plan?.evidence ?? []).reduce(
    (sum, record) => sum + (record.findings?.length ?? 0),
    0,
  );
  return {
    dependencyChangeCount: plan?.changes.length ?? 0,
    upstreamSurfaceChangeCount,
    breakingChangeCount: signals.breakingChangeCount,
    candidateConsumerFileCount: signals.importerCandidateFiles,
    impactSiteCount: signals.impactSiteCount,
    // Until a dedicated semantic consumer analyzer exists, "semantic analysis
    // ran" is exactly "a source search ran". Kept as its own field so the
    // meaning can tighten without the schema moving. False when there was no
    // plan at all — nothing analysed anything.
    semanticAnalysisRan: Boolean(plan) && signals.localizationRan,
    verificationRan: signals.verificationStatus === 'passed' || signals.verificationStatus === 'failed',
    verificationStatus: signals.verificationStatus,
    confirmedRegression: signals.confirmedRegression,
  };
}

/**
 * A funnel with zeroed diagnostics.
 *
 * For the paths with no plan to read (a case that failed before analysis) and
 * for adapter tests that exercise scoring without a real pipeline run.
 */
export function blankImpactFunnel(missReason: ImpactMissReason | null): ImpactFunnel {
  return {
    missReason,
    diagnostics: {
      dependencyChangeCount: 0,
      upstreamSurfaceChangeCount: 0,
      breakingChangeCount: 0,
      candidateConsumerFileCount: -1,
      impactSiteCount: 0,
      semanticAnalysisRan: false,
      verificationRan: false,
      verificationStatus: 'not-run',
      confirmedRegression: false,
    },
  };
}

/** Build the full funnel record for one case. `identifiedAffected` decides whether `missReason` is `null`. */
export function buildImpactFunnel(input: DeriveFunnelInput & { identifiedAffected: boolean }): ImpactFunnel {
  const diagnostics = deriveImpactDiagnostics(input);
  if (input.identifiedAffected) return { missReason: null, diagnostics };
  return { missReason: classifyImpactMiss(deriveImpactFunnelSignals(input)), diagnostics };
}
