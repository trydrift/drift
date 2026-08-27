/**
 * Single source of truth for what "the engine" is, shared by two consumers so
 * they cannot drift apart:
 *
 *   - `engine-fingerprint.mjs` hashes the contents of these paths into the
 *     `engine` field stamped on every recording.
 *   - `.github/workflows/refresh-recordings.yml` lists the same paths under
 *     `push.paths`, so a change that moves the fingerprint also triggers a
 *     recapture. `test/recording-engine-manifest.test.ts` enforces that the
 *     workflow covers every entry here.
 *
 * Lockfiles are included deliberately: Drift's own resolved dependencies (the
 * tree-sitter grammars, the semver/PEP-440 parsers, the registry clients)
 * decide what a capture detects, so a lockfile change can change a recording
 * even when no first-party source moved. `counts()` in `engine-fingerprint.mjs`
 * hashes them alongside `.ts`/`.mjs` sources.
 */
export const RECORDING_ENGINE_PATHS = [
  'src/analyze',
  'src/confidence',
  'src/detect',
  'src/evidence',
  'src/index',
  'src/localize',
  'src/plan',
  'src/rationale',
  'src/repo',
  'src/upgrade',
  'src/verification',
  'src/analysis.ts',
  'src/config/schema.ts',
  'src/disposition.ts',
  'src/pipeline.ts',
  'src/types.ts',
  // Shared I/O, archive and process helpers are imported by capture-critical
  // evidence providers; keeping this boundary broad prevents a utility fix
  // from leaving recordings stamped with the old engine.
  'src/util',
  'package-lock.json',
  'site/package-lock.json',
  'site/scripts/capture.mjs',
  'site/scripts/recording-validation.mjs',
  'site/scripts/runtime-recording-validation.mjs',
  'site/scripts/validate-recordings.mjs',
  'site/scripts/engine-fingerprint.mjs',
  'site/scripts/recording-engine-manifest.mjs',
  'site/scripts/analyzer-environment.mjs',
  'site/src/lib/recordings.ts',
];
