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
  // from leaving recordings stamped with the old engine. See
  // `RECORDING_ENGINE_EXCLUDES` for the two files this deliberately drops.
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

/**
 * Files inside those paths that are *not* part of the engine.
 *
 * `src/util` is included whole on purpose: it is easier to over-hash a helper
 * than to notice, months later, that a utility fix left every recording
 * stamped with an engine that no longer exists. But the breadth has one cost,
 * and it is the cost this list exists to pay. A capture never draws a terminal
 * — it calls `scanUpgrades` directly — so the two files here can change every
 * byte they contain without altering a single byte of a recording, and hashing
 * them sends seventeen real repositories through an hour of re-analysis to
 * reproduce output that was already correct. That is how a freshness check
 * gets switched off by the people it is meant to protect.
 *
 * This is a claim about the import graph, not a preference, so it is enforced
 * rather than trusted: `test/recording-engine-manifest.test.ts` walks the
 * imports out of the capture pipeline's own entry points and fails if anything
 * listed here has become reachable. Adding to this list means proving the same
 * thing — an exclusion nobody can reach is a saved hour, and one somebody can
 * reach is a recording that lies about which engine produced it.
 */
export const RECORDING_ENGINE_EXCLUDES = ['src/util/prompt.ts', 'src/util/terminal.ts'];
