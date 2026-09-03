import type {
  BreakingChange,
  BreakingChangeDisposition,
  ImpactSite,
  RuntimeCompatibilityReason,
  RuntimeCompatibilityState,
  RuntimeName,
} from './types.js';

export interface RuntimeAnalysisDispositionInput {
  changeId: string;
  runtime: RuntimeName;
  state: RuntimeCompatibilityState;
  reason: RuntimeCompatibilityReason;
}

/**
 * The only predicate allowed to turn a localized fact into an edit.
 *
 * Confidence establishes an API site's identity. Runtime sites additionally
 * require the per-change analysis to prove incompatibility; partial and
 * unknown declarations remain useful locations to review but never edits.
 */
export function isActionableImpact(
  change: BreakingChange,
  site: ImpactSite,
  runtimeAnalysis?: RuntimeAnalysisDispositionInput,
): boolean {
  if (site.breakingChangeId !== change.id || site.confidence !== 'high') return false;
  if (change.kind !== 'runtime-requirement') return true;
  return (
    runtimeAnalysis?.changeId === change.id &&
    runtimeAnalysis.state === 'incompatible' &&
    site.runtimeVerdict === 'incompatible'
  );
}

export function deriveBreakingChangeDispositions(
  changes: readonly BreakingChange[],
  sites: readonly ImpactSite[],
  runtimeAnalyses: readonly RuntimeAnalysisDispositionInput[],
  localizationRan: boolean,
  localizationComplete = true,
  /**
   * Breaking-change ids an authoritative, isolated verification has shown this
   * repository builds/tests cleanly against. The only affirmative negative
   * evidence that lets a zero-hit completed search resolve to `unaffected`
   * rather than `impact-unresolved`. Compiler-provable changes an isolated
   * pass disproves are pruned from the plan upstream of this
   * (`verification/apply.ts`), so in practice this covers changes a pass
   * cleared that were never localized to a specific site.
   */
  verifiedCompatibleChangeIds: ReadonlySet<string> = new Set(),
): BreakingChangeDisposition[] {
  const analysesById = new Map<string, RuntimeAnalysisDispositionInput[]>();
  for (const analysis of runtimeAnalyses) {
    const bucket = analysesById.get(analysis.changeId);
    if (bucket) bucket.push(analysis);
    else analysesById.set(analysis.changeId, [analysis]);
  }

  return changes.map((change) => {
    const changeSites = sites.filter((site) => site.breakingChangeId === change.id);
    const analyses = analysesById.get(change.id) ?? [];
    const runtimeAnalysis = analyses.length === 1 ? analyses[0] : undefined;
    const actionableSites = changeSites.filter((site) => isActionableImpact(change, site, runtimeAnalysis));

    if (change.kind === 'runtime-requirement') {
      if (!runtimeAnalysis) {
        return { changeId: change.id, state: 'unknown', reason: 'not-localized', sites: changeSites, actionableSites };
      }
      const common = {
        changeId: change.id,
        sites: changeSites,
        actionableSites,
        runtimeAnalysis: {
          runtime: runtimeAnalysis.runtime,
          state: runtimeAnalysis.state,
          reason: runtimeAnalysis.reason,
        },
      } as const;
      if (runtimeAnalysis.state === 'incompatible') {
        return { ...common, state: 'actionable', reason: 'runtime-incompatible' };
      }
      if (runtimeAnalysis.state === 'partial') {
        return { ...common, state: 'review-only', reason: 'runtime-partial' };
      }
      if (runtimeAnalysis.state === 'unknown') {
        return { ...common, state: 'review-only', reason: 'runtime-unknown' };
      }
      return { ...common, state: 'unaffected', reason: 'runtime-compatible' };
    }

    if (actionableSites.length > 0) {
      return { changeId: change.id, state: 'actionable', reason: 'high-confidence-impact', sites: changeSites, actionableSites };
    }
    if (changeSites.length > 0) {
      return { changeId: change.id, state: 'review-only', reason: 'low-confidence-impact', sites: changeSites, actionableSites };
    }
    if (!localizationRan) {
      return { changeId: change.id, state: 'unknown', reason: 'not-localized', sites: [], actionableSites: [] };
    }
    if (!localizationComplete) {
      return { changeId: change.id, state: 'unknown', reason: 'localization-incomplete', sites: [], actionableSites: [] };
    }
    if (verifiedCompatibleChangeIds.has(change.id)) {
      return { changeId: change.id, state: 'unaffected', reason: 'no-local-impact', sites: [], actionableSites: [] };
    }
    // Localization completed and found nothing. That is not proof the change
    // cannot reach this repository — see `impact-unresolved` in `types.ts`.
    // Only an authoritative verification (which populates
    // `verifiedCompatibleChangeIds`) turns a zero-hit search into an
    // all-clear; absent one, the impact is unresolved, never `unaffected`.
    return { changeId: change.id, state: 'unknown', reason: 'impact-unresolved', sites: [], actionableSites: [] };
  });
}
