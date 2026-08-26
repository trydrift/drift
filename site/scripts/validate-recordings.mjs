#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRecording } from './recording-validation.mjs';
import { engineFingerprint } from './engine-fingerprint.mjs';

const RECORDING_SCHEMA_VERSION = 2;
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'src', 'data');
const expectedEngine = await engineFingerprint(join(here, '..', '..'));
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
    validateAuditInvariants(recording, name);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateAuditInvariants(recording, name) {
  if (recording.engine !== expectedEngine) {
    throw new Error(`stale engine fingerprint (expected ${expectedEngine}, got ${recording.engine ?? 'none'})`);
  }

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
      ? /^\d+(?:\.\d+){0,2}(?:\.x)?$/i.test(runtime.requirement ?? '')
      : false;
  if (!valid) {
    throw new Error(`malformed runtime requirement: ${runtime.requirement ?? 'missing'}`);
  }
}

function validateRuntimeSites(change) {
  if (change.kind !== 'runtime-requirement' || !change.runtime) return;
  if (change.runtime.kind === 'unsupported-runtime-range') {
    if ((change.sites ?? []).length > 0) {
      throw new Error(`unsupported ${change.runtime.runtime} range invented a local runtime-floor impact`);
    }
    return;
  }
  const runtime = change.runtime.runtime;
  const requirement = parseRequirement(change.runtime.requirement);
  for (const site of change.sites ?? []) {
    const file = site.file.toLowerCase();
    const base = file.split('/').pop();
    const excerpt = site.excerpt ?? '';
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
    node: /(?:^|\/)node:/i,
    python: /(?:^|\/)python:/i,
    ruby: /(?:^|\/)ruby:/i,
    go: /(?:^|\/)golang:/i,
    java: /(?:^|\/)(?:openjdk|eclipse-temurin|amazoncorretto):/i,
    rust: /(?:^|\/)rust:/i,
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

if (failures.length > 0) {
  process.stderr.write(`Invalid site recording artifacts:\n${failures.map((failure) => `- ${failure}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Validated ${checked} lifecycle recording(s); ${legacy} legacy artifact(s) remain hidden.\n`);
}
