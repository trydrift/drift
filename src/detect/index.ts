import type { DependencyChange, Ecosystem } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import { matchesAny } from '../util/glob.js';
import { classifyBump, isDowngrade, isZeroVerBreaking, normalizeVersion } from './version.js';
import { cargoParser } from './ecosystems/cargo.js';
import { cocoapodsParser } from './ecosystems/cocoapods.js';
import { composerParser } from './ecosystems/composer.js';
import { goParser } from './ecosystems/go.js';
import { hexParser } from './ecosystems/hex.js';
import { mavenParser } from './ecosystems/maven.js';
import { npmParser } from './ecosystems/npm.js';
import { nugetParser } from './ecosystems/nuget.js';
import { opamParser } from './ecosystems/opam.js';
import { pubParser } from './ecosystems/pub.js';
import { pythonParser } from './ecosystems/python.js';
import { rubygemsParser } from './ecosystems/rubygems.js';
import { sbtParser } from './ecosystems/sbt.js';
import { swiftParser } from './ecosystems/swift.js';
import type { ManifestParser } from './ecosystems/types.js';

/**
 * Order matters: `parserFor` takes the first parser that claims a path, so any
 * two parsers whose `handles` could both match must be ordered deliberately.
 * The live case is Maven and sbt — `sbtParser` claims `*.sbt` and
 * `project/*.scala`, which `mavenParser` never looks at, but keeping sbt ahead
 * of Maven makes that independence explicit rather than incidental.
 */
export const PARSERS: readonly ManifestParser[] = [
  npmParser,
  pythonParser,
  goParser,
  cargoParser,
  sbtParser,
  mavenParser,
  rubygemsParser,
  nugetParser,
  composerParser,
  hexParser,
  pubParser,
  swiftParser,
  cocoapodsParser,
  opamParser,
];

/** A manifest file as it looked on each side of the diff. */
export interface ManifestSnapshot {
  path: string;
  /** Content at `beforeSha`. `null` when the file was added. */
  before: string | null;
  /** Content at `afterSha`. `null` when the file was deleted. */
  after: string | null;
}

/** True when any registered parser recognises this path. */
export function isManifestPath(path: string): boolean {
  return PARSERS.some((p) => p.handles(path));
}

export function parserFor(path: string): ManifestParser | undefined {
  return PARSERS.find((p) => p.handles(path));
}

/**
 * Diff a set of manifest snapshots into concrete dependency moves.
 *
 * Results are deduplicated across files: a bump that shows up in both
 * `package.json` and `package-lock.json` is one change, reported against the
 * manifest (which carries the author's intent) rather than the lockfile.
 */
export function detectChanges(snapshots: readonly ManifestSnapshot[]): DependencyChange[] {
  const byKey = new Map<string, DependencyChange>();

  for (const snapshot of snapshots) {
    const parser = parserFor(snapshot.path);
    if (!parser) continue;

    const before = snapshot.before ? parser.parse(snapshot.before, snapshot.path) : new Map();
    const after = snapshot.after ? parser.parse(snapshot.after, snapshot.path) : new Map();
    const fromLockfile = parser.isLockfile(snapshot.path);

    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const prev = before.get(name);
      const next = after.get(name);

      const rawFrom = prev?.version ?? null;
      const rawTo = next?.version ?? null;

      // Unchanged, including "both unparseable in the same way".
      if (rawFrom === rawTo) continue;

      const fromVersion = normalizeVersion(rawFrom);
      const toVersion = normalizeVersion(rawTo);

      // A range widening that resolves to the same version (`^1.2.0` -> `>=1.2.0`)
      // is churn, not a dependency change.
      if (fromVersion && toVersion && fromVersion === toVersion) continue;

      const declaredKind = next?.kind ?? prev?.kind ?? 'runtime';
      const kind = fromLockfile && declaredKind === 'runtime' ? 'transitive' : declaredKind;

      const change: DependencyChange = {
        name,
        ecosystem: parser.ecosystem,
        from: fromVersion,
        to: toVersion,
        kind,
        bump: classifyBump(rawFrom, rawTo),
        manifestPath: snapshot.path,
        rawFrom,
        rawTo,
      };

      const key = `${parser.ecosystem}:${name}`;
      const existing = byKey.get(key);
      if (!existing || shouldPreferNew(existing, change, fromLockfile)) {
        byKey.set(key, change);
      }
    }
  }

  return [...byKey.values()].sort(
    (a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name),
  );
}

/**
 * When the same package moves in two files, prefer the manifest over the
 * lockfile — the manifest records what a human decided, and its `kind` is
 * accurate (`runtime` vs `dev`) where a lockfile only guesses.
 */
function shouldPreferNew(
  existing: DependencyChange,
  candidate: DependencyChange,
  candidateIsLock: boolean,
): boolean {
  const existingIsLock = existing.kind === 'transitive';
  if (existingIsLock && !candidateIsLock) return true;
  if (!existingIsLock && candidateIsLock) return false;
  // Otherwise keep the one with the more complete version information.
  return candidate.from !== null && candidate.to !== null && (existing.from === null || existing.to === null);
}

export interface TriageResult {
  /** Changes worth analysing. */
  actionable: DependencyChange[];
  /** Changes filtered out, with the reason, for transparency in the report. */
  skipped: { change: DependencyChange; reason: string }[];
}

/**
 * Decide which detected changes are worth spending analysis on.
 *
 * Every rejection carries a reason and is surfaced in the run output. Drift
 * never silently drops a dependency change — an unexplained silence is
 * indistinguishable from a bug, and trust is the product.
 */
export function triage(changes: readonly DependencyChange[], config: DriftConfig): TriageResult {
  const actionable: DependencyChange[] = [];
  const skipped: { change: DependencyChange; reason: string }[] = [];
  const enabledEcosystems = new Set<Ecosystem>(config.ecosystems);

  for (const change of changes) {
    const reason = rejectionReason(change, config, enabledEcosystems);
    if (reason) skipped.push({ change, reason });
    else actionable.push(change);
  }

  return { actionable, skipped };
}

function rejectionReason(
  change: DependencyChange,
  config: DriftConfig,
  enabled: Set<Ecosystem>,
): string | null {
  if (!enabled.has(change.ecosystem)) {
    return `ecosystem "${change.ecosystem}" is not enabled in drift.yml`;
  }
  if (matchesAny(config.ignore, change.name)) {
    return 'matched an `ignore` pattern in drift.yml';
  }
  if (change.to === null) {
    return 'dependency was removed; removals need no compatibility fix';
  }
  if (change.kind === 'dev' && !config.triggerOn.dev) {
    return 'dev dependency (enable `triggerOn.dev` to analyse these)';
  }
  if (change.kind === 'transitive' && !config.triggerOn.transitive) {
    return 'transitive dependency (enable `triggerOn.transitive` to analyse these)';
  }
  if (change.from === null) {
    return 'newly added dependency; there is no prior version to break against';
  }

  // 0.x minors are breaking per semver, so they bypass the `minor` toggle.
  const zeroVerBreaking = isZeroVerBreaking(change.from, change.to);

  if (change.bump === 'major' && !config.triggerOn.major) {
    return 'major bumps are disabled in drift.yml';
  }
  if (change.bump === 'minor' && !config.triggerOn.minor && !zeroVerBreaking) {
    return 'minor bumps are disabled in drift.yml';
  }
  if (change.bump === 'patch' && !config.triggerOn.patch) {
    return 'patch bumps are disabled in drift.yml';
  }
  if (change.bump === 'prerelease' && !config.triggerOn.patch) {
    return 'prerelease moves are disabled in drift.yml (enable `triggerOn.patch`)';
  }

  return null;
}

/** Downgrades and 0.x minors are re-exported so the analyser can weight them. */
export { classifyBump, isDowngrade, isZeroVerBreaking, normalizeVersion };
export type { ManifestParser };
