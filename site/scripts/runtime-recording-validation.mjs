const RUNTIME_STATES = ['compatible', 'incompatible', 'partial', 'unknown'];
const SEVERITIES = ['affected', 'verification-failed', 'upstream-only', 'unchecked', 'clean', 'error', 'pending'];
const STATE_ORDER = ['incompatible', 'partial', 'unknown', 'compatible'];

/** Validate recorded runtime answers without reconstructing production logic. */
export function validateRuntimeCompatibilityState(candidate, recordingName) {
  const state = candidate.runtimeCompatibility ?? null;
  const analyses = candidate.runtimeAnalyses ?? [];
  const where = `${recordingName}: ${candidate.name}`;

  const runtimeChanges = (candidate.breaking ?? []).filter((change) => change.kind === 'runtime-requirement');
  if (runtimeChanges.length > 0 && state === null) {
    throw new Error(`${where} has a runtime requirement but recorded no runtime compatibility state`);
  }
  if (state !== null && !RUNTIME_STATES.includes(state)) {
    throw new Error(`${where} recorded an unknown runtime compatibility state: ${state}`);
  }
  if (state !== null && analyses.length === 0) {
    throw new Error(`${where} recorded runtime compatibility ${state} without analyses`);
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
    if (analysis.state === 'compatible') {
      if (analysis.reason !== 'satisfies') {
        throw new Error(`${where} claims ${analysis.runtime} compatible for reason ${analysis.reason}`);
      }
      if (analysis.declarationCount === 0) {
        throw new Error(`${where} claims ${analysis.runtime} compatible without an actual declaration`);
      }
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
  }

  if (state !== null) {
    const aggregate = STATE_ORDER.find((candidateState) => analyses.some((analysis) => analysis.state === candidateState));
    if (aggregate !== state) {
      throw new Error(`${where} records aggregate runtime state ${state}, expected ${aggregate ?? 'none'}`);
    }
  }

  if (state === 'unknown' || state === 'partial') {
    if (candidate.recommendation === 'safe-to-upgrade') {
      throw new Error(`${where} is "safe-to-upgrade" with runtime compatibility ${state}`);
    }
    if (candidate.severity === 'upstream-only' || candidate.severity === 'clean') {
      throw new Error(`${where} recorded severity ${candidate.severity} with runtime compatibility ${state}`);
    }
    if (
      candidate.recommendation === 'manual-migration-required' &&
      (candidate.independentActionableFindingCount ?? 0) === 0
    ) {
      throw new Error(`${where} headlines as "manual-migration-required" on ${state} runtime compatibility alone`);
    }
  }
}

