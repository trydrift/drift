/**
 * Kept as the module the benchmark runner imports for R2c. The implementation
 * moved into `fixplan.ts`, where the cache, recipe and model tracks share one
 * copy of everything after the proposal — validation, commit construction,
 * policy and application are production's and are identical for all three.
 */
export {
  runFixPlanCacheTrack,
  runFixPlanRecipeTrack,
  runModelFixPlanTrack,
  TRACK_VERSION,
  type FixPlanTrackOptions,
} from './fixplan.ts';
