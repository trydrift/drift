#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateRecording } from './recording-validation.mjs';
import { engineFingerprint } from './engine-fingerprint.mjs';
import { validateRuntimeCompatibilityState } from './runtime-recording-validation.mjs';

export const RECORDING_SCHEMA_VERSION = 2;

/**
 * Names of recordings under `dataRoot` that this run produced or changed, so
 * `--fresh-from-git` can require the current engine fingerprint on exactly
 * those. `git diff --name-only` reports only tracked modifications; a recording
 * the run newly generated is untracked and would be missed, letting it keep an
 * old fingerprint unchallenged. Porcelain status reports both.
 */
export async function freshRecordingNames(repoRoot, dataRelPath = 'site/src/data') {
  const { stdout } = await promisify(execFile)('git', ['status', '--porcelain', '--', dataRelPath], { cwd: repoRoot });
  const names = new Set();
  for (const line of stdout.split('\n').filter(Boolean)) {
    const entry = line.slice(3).trim();
    const path = entry.includes(' -> ') ? entry.slice(entry.indexOf(' -> ') + 4) : entry;
    if (path) names.add(path.split('/').at(-1));
  }
  return names;
}

export function validateAuditInvariants(recording, name, freshnessRequired, expectedEngine) {
  // ---------------------------------------------------------------------------
  // Layer A — baseline artifact validity. Always enforced, current or stale.
  //
  // A recording retained because a real-repository recapture failed is still
  // rejected if it is malformed: broken structure, a fixture manifest that
  // leaked in as a project, a runtime requirement that is not structured, a
  // known-surviving symbol reported as changed. `--allow-stale` keeps an old
  // recording alive; it never lets a corrupt one through.
  // ---------------------------------------------------------------------------
  for (const manifest of recording.manifests ?? []) {
    if (/(^|\/)tests?\/registry\/npm(?:\/|$)|(^|\/)tests?\/testdata(?:\/|$)/i.test(manifest)) {
      throw new Error(`fixture manifest was discovered as a project: ${manifest}`);
    }
  }

  for (const candidate of recording.candidates) {
    for (const change of candidate.breaking ?? []) {
      validateSurfaceSymbols(change, recording.ecosystem);
      validateRuntime(change);
      validateRuntimeSites(change);
    }
    validateCorpusRegressionTripwires(recording, candidate);
  }

  // Keep this check tied to the recording id rather than a package name in the
  // engine: it is a corpus tripwire for the exact upstream examples in the
  // audit, not a production exception.
  if (recording.id === 'flexlayout') {
    for (const candidate of recording.candidates) {
      for (const field of [candidate.current, candidate.latest, candidate.selected, candidate.safeLatest]) {
        if (field && versionFamily(candidate.current) === 'semver' && versionFamily(field) === 'calendar') {
          throw new Error(`incompatible Swift version family: ${candidate.current} -> ${field}`);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Layer B — current-engine semantic invariants. Enforced only on recordings
  // expected to be current with this engine fingerprint.
  //
  // These assert relationships this engine's capture emits — the disposition /
  // runtime-analysis bijection, the severity ⇄ recommendation ⇄ compatibility
  // agreement, `hasCompatibilityEvidence`. A stale recording predates that
  // contract, and `--allow-stale` exists precisely so it can be retained
  // without being judged by invariants that did not exist when it was made.
  // ---------------------------------------------------------------------------
  const currentByFingerprint = recording.engine === expectedEngine;
  if (!freshnessRequired && !currentByFingerprint) return;

  if (recording.engine !== expectedEngine) {
    throw new Error(`stale engine fingerprint (expected ${expectedEngine}, got ${recording.engine ?? 'none'})`);
  }

  for (const candidate of recording.candidates) {
    validateCompatibilityEvidence(candidate, name);
    validateRuntimeCompatibilityState(candidate, name);
  }
}

function validateSurfaceSymbols(change, ecosystem) {
  const symbols = Array.isArray(change.symbols) ? change.symbols : [];
  if (ecosystem === 'pypi') {
    for (const symbol of symbols) {
      // PEP 625 sdists use `{distribution}-{version}`. Accept the full PEP 440
      // family here (pre/post/dev/epoch), while requiring the transport-name
      // hyphen so a legitimate import package such as `api_v2` is not rejected.
      if (/^[^./\s]+-v?(?:\d+!)?\d+(?:[._-]\d+)*(?:(?:a|b|rc)\d*|[._-]?(?:post|dev)\d+)?\./i.test(symbol)) {
        throw new Error(`archive-root Python symbol: ${symbol}`);
      }
    }
  }
}

function validateRuntime(change) {
  if (change.kind !== 'runtime-requirement') return;
  const runtime = change.runtime;
  if (!runtime || !['node', 'python', 'go', 'ruby', 'java', 'rust'].includes(runtime.runtime)) {
    throw new Error('runtime requirement is not structured with a known runtime');
  }
  const valid = runtime.kind === 'minimum-runtime'
    ? /^(?:[<>=~^]*\s*)?\d+(?:\.\d+){0,3}$/.test(runtime.requirement ?? '')
    : runtime.kind === 'unsupported-runtime-range'
      // Either a bare dropped line normalized to its `.x` line (`16.x`), or
      // the exact operator form upstream stated (`^16`, `~16`, `<18`,
      // `<=16`) -- see `parseRuntimeRequirement` in analyze/rules.ts, which
      // deliberately keeps these distinct rather than inventing a floor for
      // every operator.
      ? /^(?:\d+(?:\.\d+){0,2}(?:\.x)?|[<>=~^]+\d+(?:\.\d+){0,3})$/i.test(runtime.requirement ?? '')
      : false;
  if (!valid) {
    throw new Error(`malformed runtime requirement: ${runtime.requirement ?? 'missing'}`);
  }
  if (runtime.kind === 'unsupported-runtime-range' && runtime.derivedMinimum !== undefined) {
    if (!/^[<>=]+\d+(?:\.\d+){0,3}$/.test(runtime.derivedMinimum)) {
      throw new Error(`malformed derived minimum: ${runtime.derivedMinimum}`);
    }
  }
}

/**
 * A candidate must never claim compatibility was verified when Drift did not
 * actually obtain evidence bearing on it. This is the corpus-level tripwire
 * for the "safe to upgrade" false-all-clear class of bug: a clean security
 * check, a fine license, or proof the target version exists are all real
 * facts, but none of them says anything about whether the repository's code
 * still works, and none may stand in for a computed surface diff or
 * compatibility prose that was actually fetched and read.
 *
 * Driven by the structured `hasCompatibilityEvidence` field the engine now
 * emits alongside the recommendation -- not by parsing `gaps` prose, which is
 * exactly the fragile approach this invariant exists to avoid needing.
 */
function validateCompatibilityEvidence(candidate, recordingName) {
  if (candidate.hasCompatibilityEvidence !== false) return;
  // `hasCompatibilityEvidence` answers "did Drift look at compatibility with
  // nothing upstream to show for it". A candidate with real breaking changes
  // already carries its own proof a comparison ran (each one cites the
  // evidence source, e.g. `type-surface-diff`) -- the flag only governs
  // whether "no breaking changes found" is allowed to stand as a finding, per
  // `decide()` in assess.ts.
  if (candidate.breakingCount > 0) return;
  if (candidate.recommendation === 'safe-to-upgrade') {
    throw new Error(
      `${recordingName}: ${candidate.name} is "safe-to-upgrade" with no compatibility evidence (no surface diff, no prose read)`,
    );
  }
}

function validateRuntimeSites(change) {
  if (change.kind !== 'runtime-requirement' || !change.runtime) return;
  if (change.runtime.kind === 'unsupported-runtime-range') {
    // Not "always zero sites" -- an unsupported range with no stated
    // replacement floor can still be checked against what the repository
    // actually declares. Trust the engine's own structured verdict rather
    // than re-deriving range intersection here: every site must be explicitly
    // marked as a genuine finding, and ownership still applies.
    for (const site of change.sites ?? []) {
      const runtime = change.runtime.runtime;
      const file = site.file.toLowerCase();
      const base = file.split('/').pop();
      const excerpt = site.excerpt ?? '';
      if (site.runtimeVerdict === 'unknown') {
        // Same rule as the minimum-runtime path: an unreadable value is still
        // this runtime's declaration only if the position names the runtime.
        if (!unresolvedPositionNames(runtime, file, base, excerpt)) {
          throw new Error(`${runtime} runtime finding marked unknown at a position that does not name ${runtime}: ${site.file}`);
        }
        continue;
      }
      if (site.runtimeVerdict !== 'incompatible' && site.runtimeVerdict !== 'partial') {
        throw new Error(`unsupported ${runtime} range site at ${site.file} has no compatibility verdict recorded`);
      }
      if (!runtimeSiteOwnedBy(runtime, file, base, excerpt)) {
        throw new Error(`${runtime} runtime finding crossed config ownership at ${site.file}`);
      }
    }
    return;
  }
  const runtime = change.runtime.runtime;
  const requirement = parseRequirement(change.runtime.requirement);
  for (const site of change.sites ?? []) {
    const file = site.file.toLowerCase();
    const base = file.split('/').pop();
    const excerpt = site.excerpt ?? '';

    if (site.runtimeVerdict === 'unknown') {
      // An unresolved declaration is unknown *because* its value could not be
      // read -- so the usual "the excerpt contains a concrete version"
      // ownership check cannot apply. What must still hold, and what this
      // checks, is that the *position* names the runtime: a field whose name
      // identifies it (`node-version:`), an image that names it
      // (`node:${NODE_VERSION}`), or a file that is inherently that runtime's
      // (`.nvmrc`, `pom.xml`, `.tool-versions`).
      //
      // `image: $DEFAULT_CI_IMAGE` passes none of those, which is exactly the
      // bug this tripwire exists for: one generic CI image used to attach
      // itself to Node, Ruby and Python simultaneously and push every
      // otherwise-clean candidate into "Upgrade after review".
      if (!unresolvedPositionNames(runtime, file, base, excerpt)) {
        throw new Error(
          `${runtime} runtime finding marked unknown at a position that does not name ${runtime}: ${site.file} (${excerpt})`,
        );
      }
      continue;
    }

    const allowed = runtimeSiteOwnedBy(runtime, file, base, excerpt);
    if (!allowed) throw new Error(`${runtime} runtime finding crossed config ownership at ${site.file}`);

    if (file.endsWith('.tool-versions')) {
      const key = site.excerpt.match(/^\s*([a-z][a-z0-9_-]*)\s+/i)?.[1]?.toLowerCase();
      const accepted = runtime === 'node' ? ['node', 'nodejs'] : runtime === 'python' ? ['python', 'python3'] : [runtime];
      if (!key || !accepted.includes(key)) throw new Error(`${runtime} runtime finding used the wrong .tool-versions key`);
    }

    const exactPin = !/[<>=~^*x|]/i.test(excerpt)
      ? excerpt.match(/\b\d+(?:\.\d+){0,3}\b/)?.[0]
      : undefined;
    if (exactPin && requirement && satisfies(exactPin, requirement)) {
      throw new Error(`compatible ${runtime} declaration was reported as an impact at ${site.file}`);
    }
  }
}

/**
 * Does this position *name* the runtime, independently of whether its value
 * could be read?
 *
 * Runtime identity is the precondition for an unresolved declaration to exist
 * at all. Where identity comes from the filename (`.nvmrc` is Node's and
 * nobody else's) or the field name (`ruby-version:`), an unreadable value is
 * still that runtime's declaration. Where it would have to come from the
 * value itself — a bare `image:` — an unreadable value names nothing.
 */
function unresolvedPositionNames(runtime, file, base, excerpt) {
  const RUNTIME_FILES = {
    node: ['.nvmrc', '.node-version', 'package.json'],
    python: ['.python-version', 'runtime.txt', 'pyproject.toml', 'setup.cfg', 'setup.py'],
    ruby: ['.ruby-version', 'gemfile'],
    go: ['go.mod'],
    java: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    rust: ['rust-toolchain', 'rust-toolchain.toml', 'cargo.toml'],
  };
  if (base === '.tool-versions') {
    const key = excerpt.match(/^\s*([a-z][a-z0-9_-]*)\s+/i)?.[1]?.toLowerCase();
    const accepted = runtime === 'node' ? ['node', 'nodejs'] : runtime === 'python' ? ['python', 'python3'] : [runtime];
    return Boolean(key && accepted.includes(key));
  }
  if ((RUNTIME_FILES[runtime] ?? []).includes(base)) return true;
  if (runtime === 'ruby' && base.endsWith('.gemspec')) return true;

  const fields = {
    node: /node-version\s*:|"node"\s*:/i,
    python: /python-version\s*:|python_requires|requires-python/i,
    ruby: /ruby-version\s*:/i,
    go: /go-version\s*:/i,
    java: /java-version\s*:|JavaLanguageVersion|sourceCompatibility|targetCompatibility/i,
    rust: /toolchain\s*:|channel\s*=/i,
  };
  if (fields[runtime]?.test(excerpt)) return true;
  // A container image only counts when the image itself names the runtime;
  // the tag is allowed to be a variable.
  return runtimeImageOwnedBy(runtime, excerpt);
}

function runtimeSiteOwnedBy(runtime, file, base, excerpt) {
  if (base === '.tool-versions') return true;
  if (runtime === 'node' && ['.nvmrc', '.node-version', 'package.json'].includes(base)) return true;
  if (runtime === 'python' && ['.python-version', 'runtime.txt', 'pyproject.toml', 'setup.cfg', 'setup.py'].includes(base)) return true;
  if (runtime === 'ruby' && (base === '.ruby-version' || base === 'gemfile' || base.endsWith('.gemspec'))) return true;
  if (runtime === 'go' && base === 'go.mod') return true;
  if (runtime === 'java' && ['pom.xml', 'build.gradle', 'build.gradle.kts'].includes(base)) return true;
  if (runtime === 'rust' && ['rust-toolchain', 'rust-toolchain.toml', 'cargo.toml'].includes(base)) return true;

  if (base.startsWith('dockerfile') || base.startsWith('containerfile')) {
    return runtimeImageOwnedBy(runtime, excerpt);
  }

  if (/^\.github\/workflows\/.+\.ya?ml$/.test(file) || /^\.(?:gitlab-ci|circleci)/.test(file)) {
    const fields = {
      node: /node-version\s*:/i,
      python: /python-version\s*:/i,
      ruby: /ruby-version\s*:/i,
      go: /go-version\s*:/i,
      java: /java-version\s*:/i,
      rust: /toolchain\s*:/i,
    };
    return (fields[runtime]?.test(excerpt) ?? false) || runtimeImageOwnedBy(runtime, excerpt);
  }
  return false;
}

function runtimeImageOwnedBy(runtime, excerpt) {
  const images = {
    node: /(?:^|[\s/])node(?=[:@\s]|$)/i,
    python: /(?:^|[\s/])python(?=[:@\s]|$)/i,
    ruby: /(?:^|[\s/])ruby(?=[:@\s]|$)/i,
    go: /(?:^|[\s/])golang(?=[:@\s]|$)/i,
    java: /(?:^|[\s/])(?:openjdk|eclipse-temurin|amazoncorretto)(?=[:@\s]|$)/i,
    rust: /(?:^|[\s/])rust(?=[:@\s]|$)/i,
  };
  return images[runtime]?.test(excerpt) ?? false;
}

/** Package/symbol-specific checks below are corpus fixtures only, never engine policy. */
function validateCorpusRegressionTripwires(recording, candidate) {
  const text = JSON.stringify((candidate.breaking ?? []).filter((change) => change.kind === 'removed-export'));
  const checks = recording.id === 'trantor'
    ? ['logger.level', 'logger.name', 'logger.sinks', 'SSL_get_error', 'OPENSSL_cleanup', 'RUN_ALL_TESTS']
    : recording.id === 'esphome'
      ? ['UISlider.uint8_t']
      : [];
  for (const symbol of checks) {
    if (text.includes(symbol)) throw new Error(`known surviving API was reported as changed: ${symbol}`);
  }
}

function versionFamily(raw) {
  const value = String(raw ?? '').trim().replace(/^[^\d]*/, '');
  if (/^\d{4}[.-]\d{1,2}[.-]\d{1,2}(?:[.-]\d+)?(?:$|[-+])/.test(value)) return 'calendar';
  return /^\d+(?:\.\d+){0,3}(?:[-+].*)?$/.test(value) ? 'semver' : 'unknown';
}

function parseRequirement(raw) {
  const match = String(raw ?? '').match(/^\s*([<>=~^]*)\s*(\d+(?:\.\d+){0,3})\s*$/);
  return match ? { operator: match[1] || '>=', version: match[2] } : null;
}

function compareVersions(left, right) {
  const a = String(left).split('.').map(Number);
  const b = String(right).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

function satisfies(version, requirement) {
  const compared = compareVersions(version, requirement.version);
  if (requirement.operator === '>') return compared > 0;
  if (requirement.operator === '>=') return compared >= 0;
  if (requirement.operator === '<') return compared < 0;
  if (requirement.operator === '<=') return compared <= 0;
  if (requirement.operator === '=' || requirement.operator === '==') return compared === 0;
  return compared >= 0;
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, '..', '..');
  const dataDir = join(here, '..', 'src', 'data');
  const expectedEngine = await engineFingerprint(repoRoot);
  const allowStale = process.argv.includes('--allow-stale');
  const freshFromGit = process.argv.includes('--fresh-from-git');
  const requireFresh = freshFromGit ? await freshRecordingNames(repoRoot) : new Set();
  const names = (await readdir(dataDir)).filter((name) => name.endsWith('.json')).sort();

  let checked = 0;
  let legacy = 0;
  const failures = [];

  for (const name of names) {
    let recording;
    try {
      recording = JSON.parse(await readFile(join(dataDir, name), 'utf8'));
    } catch (error) {
      failures.push(`${name}: could not parse (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }

    // Pre-lifecycle artifacts are intentionally hidden by loadRecordings(). They
    // remain allowed until the refresh workflow regenerates them; every artifact
    // that is eligible to render must pass the strict lifecycle validator below.
    if (recording?.schemaVersion !== RECORDING_SCHEMA_VERSION) {
      legacy += 1;
      continue;
    }

    checked += 1;
    try {
      validateRecording(recording, RECORDING_SCHEMA_VERSION);
      validateAuditInvariants(recording, name, !allowStale || requireFresh.has(name), expectedEngine);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    process.stderr.write(`Invalid site recording artifacts:\n${failures.map((failure) => `- ${failure}`).join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Validated ${checked} lifecycle recording(s); ${legacy} legacy artifact(s) remain hidden.\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
