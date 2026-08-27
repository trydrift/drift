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
 *
 * Source and lockfiles are not the whole engine, either (#138). A few
 * evidence surfaces hand the analysed package to an external interpreter or
 * toolchain and let it do the parsing, so a materially different installed
 * version of that tool is a materially different analyzer even when not one
 * byte of Drift's own source moved. `analyzerEnvironmentIdentity()` below
 * folds each such tool's *semantically normalized* version — see
 * `analyzer-environment.mjs` for the full reproducibility contract — into
 * this same fingerprint, so two equivalent environments agree and two
 * materially different ones do not.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { RECORDING_ENGINE_PATHS } from './recording-engine-manifest.mjs';
import { RECORDING_ANALYZER_ENVIRONMENT } from './analyzer-environment.mjs';

const execFileAsync = promisify(execFile);

/**
 * The analyzer environment's contribution to the fingerprint: one
 * `tool=majorMinor` entry per manifest tool, normalized identically wherever
 * this runs — see the reproducibility contract documented in
 * `analyzer-environment.mjs`.
 *
 * A tool that cannot be run at all, or whose version output this cannot
 * parse, throws rather than folding into a shared placeholder identity: a
 * recording captured without a required analyzer available is not evidence
 * of what Drift actually does, and every environment missing the same tool
 * must not silently collide on one fingerprint.
 *
 * `manifest` and `runVersionCommand` are parameters (defaulting to the real
 * contract and a real subprocess call) so tests can exercise the
 * equivalent/materially-different/missing-tool behavior against a fake
 * environment without needing to control which interpreters are actually
 * installed on the machine running the test.
 */
export async function analyzerEnvironmentIdentity(
  manifest = RECORDING_ANALYZER_ENVIRONMENT,
  runVersionCommand = (executable, args) => execFileAsync(executable, args, { timeout: 5000 }),
) {
  const entries = [];
  for (const [tool, contract] of Object.entries(manifest)) {
    let rawOutput;
    try {
      const { stdout, stderr } = await runVersionCommand(contract.executable, contract.versionArgs);
      rawOutput = `${stdout}${stderr}`;
    } catch (error) {
      throw new Error(
        `Recording capture/validation requires \`${contract.executable}\` (the ${tool} analyzer contract in analyzer-environment.mjs) and it could not be run: ${error.message}`,
      );
    }
    const normalized = contract.normalize(rawOutput);
    if (!normalized) {
      throw new Error(
        `Could not read a ${tool} version out of \`${contract.executable} ${contract.versionArgs.join(' ')}\` output: ${JSON.stringify(rawOutput.trim())}`,
      );
    }
    entries.push(`${tool}=${normalized}`);
  }
  return entries.sort();
}

/**
 * The engine, as far as a recording is concerned.
 *
 * Core paths determine the analysis result. The site paths determine how that
 * result is captured, validated, and interpreted as a lifecycle-valid artifact.
 * `cli/`, `runners/`, `github/`, `dispatch/` and the extension remain absent:
 * they decide how a result is presented or delivered, never what is recorded.
 */
/** Source files whose contents can change a recording or its lifecycle contract. */
function counts(path) {
  return (path.endsWith('.ts') && !path.endsWith('.d.ts')) || path.endsWith('.mjs') || path.endsWith('package-lock.json');
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
  const paths = (await Promise.all(RECORDING_ENGINE_PATHS.map((path) => filesUnder(repoRoot, path)))).flat().sort();

  const hash = createHash('sha256');
  for (const identity of await analyzerEnvironmentIdentity()) {
    hash.update('environment\0');
    hash.update(identity);
    hash.update('\n');
  }
  for (const path of paths) {
    const content = await readFile(join(repoRoot, path), 'utf8');
    hash.update(path);
    hash.update('\0');
    hash.update(createHash('sha256').update(content).digest('hex'));
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, 16);
}
