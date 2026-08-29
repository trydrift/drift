/**
 * Semantic invariants over a canonical recording.
 *
 * The structural validator already rejects a malformed recording. It accepted
 * a *coherent* one that said false things: a target version the registry never
 * published, a Ruby platform suffix rendered as a version movement, a
 * transport failure phrased as a fact about what a package publishes, a
 * progress line recorded as the cause of a build failure, a clean verdict
 * standing on an unanswered question.
 *
 * Every check here reads structured fields. Where prose is examined at all, it
 * is only ever to prove that the prose does not overstate the code beside it —
 * the code is the authority, never the sentence.
 */

/** Evidence-gap codes that mean "Drift did not inspect the artifact". */
const UNINSPECTED_CODES = new Set([
  'artifact-unavailable',
  'artifact-corrupt',
  'version-unavailable',
  'tool-missing',
  'toolchain-failed',
  'parse-failed',
  'provider-unavailable',
]);

/** Gap codes that describe the package's role rather than a missing artifact. */
const ROLE_CODES = new Set(['artifact-role-unsupported', 'unsupported-ecosystem']);

/** Prose that asserts the package itself publishes nothing. */
const ABSENCE_CLAIM =
  /publishes no (?:TypeScript declarations|managed assembly|public Dart|declarations)|ships no declarations|has no (?:public )?API surface/i;

/** Prose that asserts an artifact that should exist is missing. */
const MISSING_ARTIFACT_CLAIM = /has no jar|no managed assembly|artefact is missing|artifact is missing/i;

/** Cargo's progress narration, which is never a cause of failure on its own. */
const CARGO_PROGRESS =
  /^(Updating|Downloading|Downloaded|Compiling|Checking|Building|Blocking|Waiting|Adding|Locking|Installing|Fresh|Finished)\b/i;

/**
 * How many unrelated packages may share one unresolved runtime site before it
 * stops looking like a coincidence.
 *
 * Not a prohibition: one malformed CI matrix legitimately affects every
 * package in a repository. The threshold catches the analyzer-wide bug shape —
 * the same file, line and excerpt copied across dozens of results — while
 * leaving a handful of genuine repeats alone.
 */
const RUNTIME_REPETITION_THRESHOLD = 12;

/** Ecosystems whose registries enumerate versions exactly. */
const EXACT_IDENTITY_ECOSYSTEMS = new Set([
  'npm',
  'pypi',
  'cargo',
  'rubygems',
  'maven',
  'nuget',
  'packagist',
  'hex',
  'pub',
  'go',
]);

/**
 * Check one recording. Throws on a violation; returns diagnostics that are
 * worth a reader's attention but are not, on their own, wrong.
 */
export function validateSemanticInvariants(recording, name) {
  const problems = [];
  const at = (candidate, message) => problems.push(`${name}: ${candidate.name} — ${message}`);

  for (const candidate of recording.candidates ?? []) {
    checkVersionMovement(candidate, at);
    checkRubyPlatform(candidate, at);
    checkRemovalEvidence(candidate, at);
    checkEvidenceGaps(candidate, at);
    checkLocalizationClaims(candidate, at);
    checkCleanVerdict(candidate, at);
  }

  const diagnostics = runtimeRepetitionDiagnostics(recording, name);

  if (problems.length > 0) throw new Error(problems.join('\n  '));
  return diagnostics;
}

/**
 * Invariant 1 — a selected target is a real published release.
 *
 * Nothing here can enumerate the registry, so it checks the shape the bug
 * actually took: a "movement" between two spellings of the same release.
 * `0.23 -> 0.23.0` and `v0.17.0 -> 0.17.0` are not upgrades, they are
 * normalization leaking into an identity.
 */
function checkVersionMovement(candidate, at) {
  const { current, selected } = candidate;
  if (!current || !selected || current === selected) return;
  if (!EXACT_IDENTITY_ECOSYSTEMS.has(candidate.ecosystem)) return;
  if (canonicalRelease(current) === canonicalRelease(selected)) {
    at(candidate, `selected ${selected} is a normalization of the installed ${current}, not a published release`);
  }
}

/** `v1.2.0` / `1.2` / `1.2.0` all name the same release; a prerelease does not. */
function canonicalRelease(version) {
  const trimmed = String(version).trim().replace(/^v(?=\d)/, '');
  const numeric = /^(\d+(?:\.\d+)*)$/.exec(trimmed);
  if (!numeric) return trimmed;
  const parts = numeric[1].split('.').map(Number);
  while (parts.length > 1 && parts.at(-1) === 0) parts.pop();
  return parts.join('.');
}

/**
 * Invariant 2 — a Ruby platform is not a version movement.
 *
 * `google-protobuf 4.36.0-x86_64-linux-gnu -> 4.36.0` is the same gem version
 * built for a different platform, and it appeared in the corpus as an upgrade
 * forty times.
 */
const GEM_PLATFORM_SUFFIX =
  /-(?:aarch64|arm64|arm|x86_64|x86|x64|universal|powerpc64|ppc64|s390x|riscv64|sparcv9|i686|i386)-(?:linux|darwin|mingw|mswin|freebsd|solaris|aix|windows|java|wasi)[\w.-]*$|-java$/i;

function checkRubyPlatform(candidate, at) {
  if (candidate.ecosystem !== 'rubygems') return;
  for (const field of ['current', 'selected', 'latest', 'safeLatest']) {
    const value = candidate[field];
    if (typeof value === 'string' && GEM_PLATFORM_SUFFIX.test(value)) {
      at(candidate, `${field} "${value}" carries a Gem::Platform suffix; platform is not part of a RubyGems version`);
    }
  }
}

/**
 * Invariant 3 — a confident claim of removal rests on evidence that could
 * establish it.
 *
 * A removal is an absence claim about the published artifact. Prose can
 * corroborate one; only an artifact comparison can establish one, and a
 * high-confidence removal with nothing computed behind it is a conclusion that
 * outruns its own evidence. Module-system findings additionally have to agree
 * with their own structured metadata.
 */
const COMPUTED_EVIDENCE = new Set(['type-surface-diff', 'surface-diff', 'computed-artifact']);

function checkRemovalEvidence(candidate, at) {
  for (const change of candidate.breaking ?? []) {
    const removal = /removed|no longer/i.test(change.kind) || /no longer/i.test(change.summary ?? '');
    if (!removal || change.confidence !== 'high') continue;
    const sources = (change.evidence ?? []).map((evidence) => evidence.source);
    if (sources.length > 0 && !sources.some((source) => COMPUTED_EVIDENCE.has(source))) {
      at(
        candidate,
        `high-confidence removal "${change.summary}" cites only ${sources.join(', ')}; an absence claim needs a computed artifact comparison`,
      );
    }
    if (change.moduleSystem && change.moduleSystem.incompatibleUsage?.includes('require')) {
      if (change.moduleSystem.to && change.moduleSystem.to !== 'esm') {
        at(
          candidate,
          `"${change.summary}" claims require() incompatibility while its own metadata records the target as ${change.moduleSystem.to}`,
        );
      }
    }
  }
}

/**
 * Invariants 5 and 6 — a gap says what actually happened.
 *
 * A transport or tool failure may not be worded as a fact about what the
 * package publishes, and a package whose role Drift recognises may not be
 * described as though its library artifact went missing.
 */
function checkEvidenceGaps(candidate, at) {
  const codes = new Set((candidate.evidenceGaps ?? []).map((gap) => gap.code));
  const inspected = codes.size === 0 || [...codes].some((code) => !UNINSPECTED_CODES.has(code));

  for (const prose of candidate.gaps ?? []) {
    if (ABSENCE_CLAIM.test(prose) && !inspected) {
      at(candidate, `an absence is claimed ("${prose}") while every gap code says the artifact was never inspected: ${[...codes].join(', ')}`);
    }
    if (MISSING_ARTIFACT_CLAIM.test(prose) && [...codes].some((code) => ROLE_CODES.has(code))) {
      at(candidate, `a known package role is reported as a missing artifact: "${prose}"`);
    }
    // Invariant 8 — Cargo's progress narration is not a cause.
    const cargoFailure = /`?cargo public-api`? failed on .*?:\s*(.+)$/i.exec(prose);
    if (cargoFailure) {
      const cause = cargoFailure[1].trim();
      if (cause && CARGO_PROGRESS.test(cause)) {
        at(candidate, `a Cargo failure is reported as progress output: "${cause}"`);
      }
    }
  }
}

/**
 * Invariant 9 — truncated source coverage cannot support an exhaustive
 * absence, but must not erase the sites that were found.
 */
function checkLocalizationClaims(candidate, at) {
  const coverage = candidate.sourceCoverage;
  if (!coverage || coverage.localizationComplete !== false) return;

  // Incomplete coverage only undermines a verdict that *depends* on absence.
  // A package with nothing breaking upstream has nothing to look for, and its
  // clean verdict was earned by the upstream comparison, not by a search.
  if (candidate.severity === 'clean' && candidate.breakingCount > 0 && candidate.impactCount === 0) {
    at(
      candidate,
      'a clean verdict rests on finding no local use of an upstream break, while source localization was explicitly incomplete',
    );
  }
  // A positive site survives truncation: finding fewer files does not unfind
  // the ones already found.
  const sites = (candidate.breaking ?? []).reduce((total, change) => total + (change.sites?.length ?? 0), 0);
  if (sites > 0 && candidate.severity === 'localization-incomplete') {
    at(candidate, 'positive impact sites were found, but the verdict reports only incomplete localization');
  }
}

/**
 * Invariant 11 — a clean verdict answers "what was inspected that earned this".
 */
function checkCleanVerdict(candidate, at) {
  if (candidate.severity !== 'clean') return;
  if (candidate.hasCompatibilityEvidence === false) {
    at(candidate, 'clean with no compatibility evidence');
  }
  const uninspected = (candidate.evidenceGaps ?? []).filter((gap) => UNINSPECTED_CODES.has(gap.code));
  if (uninspected.length > 0 && candidate.breakingCount === 0) {
    at(
      candidate,
      `clean while ${uninspected.map((gap) => gap.code).join(', ')} says a required inspection never happened`,
    );
  }
}

/**
 * Invariant 7 — the same unresolved runtime site repeated across many
 * unrelated packages.
 *
 * A diagnostic, not a violation, and deliberately so. Kubernetes pins a
 * digest-addressed `FROM golang@sha256:...` that genuinely cannot be read
 * statically, and it genuinely does affect every Go package that raised its
 * floor — thirty-four real facts about one line. The same shape is also how an
 * analyzer-wide bug looks (one malformed CI matrix copied into dozens of
 * unrelated results), which is why it is surfaced for a human to judge rather
 * than either banned or ignored.
 */
function runtimeRepetitionDiagnostics(recording, name) {
  const diagnostics = [];
  const byFingerprint = new Map();
  for (const candidate of recording.candidates ?? []) {
    const seen = new Set();
    for (const change of candidate.breaking ?? []) {
      if (change.kind !== 'runtime-requirement') continue;
      for (const site of change.sites ?? []) {
        if (site.runtimeVerdict !== 'unknown') continue;
        const fingerprint = `${site.file}:${site.line}:${site.excerpt ?? ''}`;
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        byFingerprint.set(fingerprint, (byFingerprint.get(fingerprint) ?? 0) + 1);
      }
    }
  }

  for (const [fingerprint, count] of byFingerprint) {
    if (count >= RUNTIME_REPETITION_THRESHOLD) {
      diagnostics.push(
        `${name}: the same unresolved runtime site appears in ${count} unrelated packages (${fingerprint.split(':').slice(0, 2).join(':')}) — confirm it is one repeated fact and not one analyzer bug`,
      );
    }
  }
  return diagnostics;
}
