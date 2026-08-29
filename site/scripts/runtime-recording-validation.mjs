const RUNTIME_STATES = ['compatible', 'incompatible', 'partial', 'unknown'];
// `unchecked` is accepted only for the pre-#170 generated corpus. PR 4
// regenerates that corpus and removes this migration allowance; live severity
// computation no longer produces the overloaded value.
const SEVERITIES = ['affected', 'verification-failed', 'review-required', 'runtime-unresolved', 'evidence-missing', 'upstream-only', 'clean', 'error', 'pending', 'unchecked'];
const STATE_ORDER = ['incompatible', 'partial', 'unknown', 'compatible'];

/** Validate recorded runtime answers without reconstructing production logic. */
export function validateRuntimeCompatibilityState(candidate, recordingName) {
  const state = candidate.runtimeCompatibility ?? null;
  const analyses = candidate.runtimeAnalyses ?? [];
  const where = `${recordingName}: ${candidate.name}`;

  const runtimeChanges = candidate.runtimeChanges ??
    (candidate.breaking ?? [])
      .filter((change) => change.kind === 'runtime-requirement')
      .map((change) => ({ id: change.id, runtime: change.runtime?.runtime }));
  if (runtimeChanges.length > 0 && state === null) {
    throw new Error(`${where} has a runtime requirement but recorded no runtime compatibility state`);
  }
  if (state !== null && !RUNTIME_STATES.includes(state)) {
    throw new Error(`${where} recorded an unknown runtime compatibility state: ${state}`);
  }
  if (state !== null && analyses.length === 0) {
    throw new Error(`${where} recorded runtime compatibility ${state} without analyses`);
  }
  const runtimeIds = runtimeChanges.map((change) => change.id);
  const analysisIds = analyses.map((analysis) => analysis.changeId);
  if (new Set(runtimeIds).size !== runtimeIds.length) {
    throw new Error(`${where} records duplicate runtime breaking-change IDs`);
  }
  if (new Set(analysisIds).size !== analysisIds.length) {
    throw new Error(`${where} records duplicate runtime analysis IDs`);
  }
  const missing = runtimeIds.filter((id) => !analysisIds.includes(id));
  const orphaned = analysisIds.filter((id) => !runtimeIds.includes(id));
  if (missing.length > 0 || orphaned.length > 0) {
    throw new Error(`${where} runtime change/analysis IDs are not a bijection (missing: ${missing.join(', ') || 'none'}; orphaned: ${orphaned.join(', ') || 'none'})`);
  }
  if (!SEVERITIES.includes(candidate.severity)) {
    throw new Error(`${where} did not record the application's structural severity`);
  }

  for (const analysis of analyses) {
    if (!RUNTIME_STATES.includes(analysis.state)) {
      throw new Error(`${where} runtime analysis for ${analysis.changeId} has state ${analysis.state}`);
    }
    for (const field of ['siteCount', 'declarationCount', 'unresolvedCount']) {
      if (!Number.isInteger(analysis[field]) || analysis[field] < 0) {
        throw new Error(`${where} runtime analysis for ${analysis.changeId} has invalid ${field}`);
      }
    }
    const expectedReasons = {
      compatible: ['satisfies'],
      incompatible: ['violates'],
      partial: ['overlaps'],
      unknown: ['dynamic', 'no-declaration', 'unparseable', 'not-analyzed'],
    };
    if (!expectedReasons[analysis.state].includes(analysis.reason)) {
      throw new Error(`${where} claims ${analysis.runtime} ${analysis.state} for reason ${analysis.reason}`);
    }
    const change = runtimeChanges.find((runtimeChange) => runtimeChange.id === analysis.changeId);
    if (change?.runtime !== analysis.runtime) {
      throw new Error(`${where} runtime analysis ${analysis.changeId} names ${analysis.runtime}, expected ${change?.runtime ?? 'none'}`);
    }
    if (analysis.state === 'compatible') {
      if (analysis.declarationCount === 0) {
        throw new Error(`${where} claims ${analysis.runtime} compatible without an actual declaration`);
      }
    }
    if ((analysis.state === 'incompatible' || analysis.state === 'partial') && analysis.declarationCount === 0) {
      throw new Error(`${where} records ${analysis.state} without an evaluated declaration`);
    }
    if (analysis.reason === 'no-declaration') {
      if (analysis.state !== 'unknown') {
        throw new Error(`${where} found no ${analysis.runtime} declaration but recorded ${analysis.state}`);
      }
      if (analysis.declarationCount !== 0) {
        throw new Error(`${where} records no-declaration with ${analysis.declarationCount} declarations`);
      }
    }
    if (analysis.reason === 'dynamic' && analysis.unresolvedCount === 0) {
      throw new Error(`${where} records a dynamic ${analysis.runtime} analysis without an unresolved declaration`);
    }
    if (analysis.reason === 'not-analyzed' && (analysis.siteCount !== 0 || analysis.declarationCount !== 0 || analysis.unresolvedCount !== 0)) {
      throw new Error(`${where} records not-analyzed with derived runtime evidence`);
    }
  }

  if (state !== null) {
    const aggregate = STATE_ORDER.find((candidateState) => analyses.some((analysis) => analysis.state === candidateState));
    if (aggregate !== state) {
      throw new Error(`${where} records aggregate runtime state ${state}, expected ${aggregate ?? 'none'}`);
    }
  }

  if (state === 'unknown' || state === 'partial') {
    const allowed = new Set(['upgrade-after-review', 'do-not-upgrade-yet']);
    if (candidate.recommendation === 'manual-migration-required') {
      const dispositions = candidate.dispositions ?? [];
      const independentlyActionable = dispositions.filter((d) => d.state === 'actionable' && d.actionableSiteCount > 0 && !runtimeIds.includes(d.changeId)).length;
      if (independentlyActionable > 0) allowed.add('manual-migration-required');
    }
    if (!allowed.has(candidate.recommendation)) {
      throw new Error(`${where} records recommendation ${candidate.recommendation} with runtime compatibility ${state}`);
    }
    if (candidate.severity === 'upstream-only' || candidate.severity === 'clean') {
      throw new Error(`${where} recorded severity ${candidate.severity} with runtime compatibility ${state}`);
    }
    const dispositions = candidate.dispositions ?? [];
    const independentlyActionable = dispositions.filter((disposition) => {
      if (disposition.state !== 'actionable' || disposition.actionableSiteCount === 0) return false;
      return !runtimeIds.includes(disposition.changeId);
    }).length;
    if ((candidate.independentActionableFindingCount ?? 0) !== independentlyActionable) {
      throw new Error(`${where} independent actionable count disagrees with canonical dispositions`);
    }
    if (
      candidate.recommendation === 'manual-migration-required' &&
      independentlyActionable === 0
    ) {
      throw new Error(`${where} headlines as "manual-migration-required" on ${state} runtime compatibility alone`);
    }
  }
}
