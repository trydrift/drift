/**
 * A hash of the engine and recording contract that produced the recordings.
 *
 * The landing page replays real analyses of real repositories, and those
 * recordings are committed output — which means they go stale in two different
 * ways and only one of them is obvious. The obvious one is that the repositories
 * move: Kubernetes takes a new dependency, a package publishes a new major. The
 * quiet one is that *Drift* moves. A better surface diff, a new evidence source,
 * a change to how impact is localized, and the page is now showing what Drift
 * said last month next to a claim that this is what Drift does.
 *
 * The recording pipeline itself is part of that contract too. A lifecycle or
 * capture change can make an otherwise current artifact obsolete even when the
 * scan engine and upstream repository did not move. Hashing those inputs makes
 * the refresh workflow's path triggers meaningful: if a producer or lifecycle
 * contract changes, `--check` sees a different fingerprint and re-captures.
 *
 * What is hashed is deliberately narrower than "the repository". A change to the
 * CLI's colours or the extension's panel cannot alter a single byte of a
 * recording, and re-capturing seventeen real projects over an hour because
 * somebody renamed a variable in `src/cli.ts` is how a freshness check gets
 * turned off. Only scan-output code and the recording contract are counted.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * The engine, as far as a recording is concerned.
 *
 * Core paths determine the analysis result. The site paths determine how that
 * result is captured, validated, and interpreted as a lifecycle-valid artifact.
 * `cli/`, `runners/`, `github/`, `dispatch/` and the extension remain absent:
 * they decide how a result is presented or delivered, never what is recorded.
 */
const ENGINE_PATHS = [
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
  'src/pipeline.ts',
  'src/types.ts',
  'site/scripts/capture.mjs',
  'site/scripts/recording-validation.mjs',
  'site/scripts/engine-fingerprint.mjs',
  'site/src/lib/recordings.ts',
];

/** Source files whose contents can change a recording or its lifecycle contract. */
function counts(path) {
  return (path.endsWith('.ts') && !path.endsWith('.d.ts')) || path.endsWith('.mjs');
}

async function filesUnder(root, relPath) {
  const absolute = join(root, relPath);
  if (counts(relPath)) return [relPath];

  const found = [];
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const at = join(dir, entry.name);
      if (entry.isDirectory()) await walk(at);
      else if (counts(entry.name)) found.push(relative(root, at).split(sep).join('/'));
    }
  };
  await walk(absolute);
  return found;
}

/**
 * The fingerprint, as a short hex string.
 *
 * Sorted before hashing so two machines walking the tree in a different order
 * agree, and each file's path is hashed alongside its contents so that moving a
 * module is a change rather than a coincidence.
 */
export async function engineFingerprint(repoRoot) {
  const paths = (await Promise.all(ENGINE_PATHS.map((path) => filesUnder(repoRoot, path)))).flat().sort();

  const hash = createHash('sha256');
  for (const path of paths) {
    const content = await readFile(join(repoRoot, path), 'utf8');
    hash.update(path);
    hash.update('\0');
    hash.update(createHash('sha256').update(content).digest('hex'));
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, 16);
}
