import type { DependencyChange, Evidence } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import { mapWithConcurrency } from '../util/http.js';
import { stableId } from '../util/id.js';
import { isDowngrade, isZeroVerBreaking } from '../detect/version.js';
import {
  extractBreakingPassages,
  fetchChangelog,
  fetchMigrationGuide,
  parseChangelogSections,
  sectionsBetween,
} from './changelog.js';
import { fetchRegistryInfo } from './registry.js';
import { fetchReleaseNotes } from './releases.js';
import { diffSpecs, parseSpec, type OpenApiFinding } from './openapi.js';
import { diffSurfaces, fetchTypeSurface, type SurfaceChange } from './type-surface.js';

/**
 * Evidence weights.
 *
 * These numbers drive confidence downstream, so they encode a judgement worth
 * stating plainly: *computed diffs beat prose, and prose beats guessing.*
 *
 * A semver heuristic alone scores 0.25 — deliberately below the threshold at
 * which Drift will dispatch an automatic fix. "The major number went up" is a
 * reason to look, not a reason to let an agent edit your code.
 */
const WEIGHTS = {
  'type-surface-diff': 1.0,
  'openapi-diff': 1.0,
  'migration-guide': 0.8,
  'github-release': 0.7,
  changelog: 0.65,
  'registry-metadata': 0.4,
  'semver-heuristic': 0.25,
} as const;

export interface EvidenceContext {
  config: DriftConfig;
  logger: Logger;
  /** Token used only to raise the GitHub API rate limit for public reads. */
  githubToken?: string;
  /** Reads a file from the *user's* repo at a given ref. */
  readRepoFile?: (path: string, ref: string) => Promise<string | null>;
  beforeSha?: string;
  afterSha?: string;
}

/** Gather all available evidence for a batch of dependency changes. */
export async function gatherEvidence(
  changes: readonly DependencyChange[],
  ctx: EvidenceContext,
): Promise<Evidence[]> {
  const perDependency = await mapWithConcurrency(changes, 4, (change) =>
    gatherForChange(change, ctx),
  );

  const specEvidence = await gatherSpecEvidence(ctx);

  return [...perDependency.flat(), ...specEvidence];
}

async function gatherForChange(change: DependencyChange, ctx: EvidenceContext): Promise<Evidence[]> {
  const { config, logger } = ctx;
  const out: Evidence[] = [];

  // The semver signal always exists and costs nothing, so it is recorded first
  // and acts as the floor: no dependency is ever analysed with zero evidence.
  const semverNote = describeSemver(change);
  if (semverNote) {
    out.push({
      id: stableId('ev', change.name, 'semver', change.from, change.to),
      source: 'semver-heuristic',
      dependency: change.name,
      title: `${change.name} ${change.from} → ${change.to} (${change.bump})`,
      content: semverNote,
      weight: WEIGHTS['semver-heuristic'],
    });
  }

  if (!change.from || !change.to) return out;

  const registry = await fetchRegistryInfo(change.name, change.ecosystem, change.to);

  if (registry?.deprecated) {
    out.push({
      id: stableId('ev', change.name, 'deprecated', change.to),
      source: 'registry-metadata',
      dependency: change.name,
      url: registry.homepage ?? undefined,
      title: `${change.name}@${change.to} is deprecated`,
      content: registry.deprecated,
      weight: WEIGHTS['registry-metadata'],
    });
  }

  // The machine-verified type surface diff. npm only, and only when the
  // package ships declarations — but when it applies it is decisive.
  if (config.evidence.typeSurface && change.ecosystem === 'npm') {
    const surfaceChanges = await diffTypeSurfaces(change.name, change.from, change.to, logger);
    if (surfaceChanges && surfaceChanges.length > 0) {
      out.push({
        id: stableId('ev', change.name, 'surface', change.from, change.to),
        source: 'type-surface-diff',
        dependency: change.name,
        url: `https://www.npmjs.com/package/${change.name}/v/${change.to}`,
        locator: `${change.name}@${change.from} → @${change.to} (.d.ts)`,
        title: `${surfaceChanges.length} API surface change(s) in ${change.name}`,
        content: formatSurfaceChanges(surfaceChanges),
        weight: WEIGHTS['type-surface-diff'],
      });
    }
  }

  const githubRepo = registry?.githubRepo;
  if (!githubRepo) {
    logger.debug(`No source repository resolved for ${change.name}; prose evidence unavailable`);
    return out;
  }

  if (config.evidence.githubReleases) {
    const releases = await fetchReleaseNotes(githubRepo, change.from, change.to, {
      token: ctx.githubToken,
      maxReleases: config.evidence.maxReleases,
    });

    for (const release of releases) {
      const passages = extractBreakingPassages(release.body);
      if (passages.length === 0) continue;
      out.push({
        id: stableId('ev', change.name, 'release', release.tag),
        source: 'github-release',
        dependency: change.name,
        url: release.url,
        title: `${change.name} ${release.name ?? release.tag} release notes`,
        content: passages.join('\n'),
        weight: WEIGHTS['github-release'],
      });
    }
  }

  if (config.evidence.changelog) {
    const changelog = await fetchChangelog(githubRepo);
    if (changelog) {
      const sections = sectionsBetween(parseChangelogSections(changelog.content), change.from, change.to);
      for (const section of sections) {
        const passages = extractBreakingPassages(section.body);
        if (passages.length === 0) continue;
        out.push({
          id: stableId('ev', change.name, 'changelog', section.version),
          source: 'changelog',
          dependency: change.name,
          url: `${changelog.url}#L${section.line}`,
          locator: `${changelog.path}:${section.line}`,
          title: `${change.name} CHANGELOG § ${section.version}`,
          content: passages.join('\n'),
          weight: WEIGHTS.changelog,
        });
      }
    }

    // Migration guides are the artefact LADU relies on exclusively. Drift
    // treats one as strong corroboration rather than the sole input, so a
    // package without a guide is still analysable.
    const guide = await fetchMigrationGuide(githubRepo);
    if (guide) {
      const passages = extractBreakingPassages(guide.content);
      if (passages.length > 0) {
        out.push({
          id: stableId('ev', change.name, 'migration', guide.path),
          source: 'migration-guide',
          dependency: change.name,
          url: guide.url,
          locator: guide.path,
          title: `${change.name} migration guide (${guide.path})`,
          content: passages.slice(0, 200).join('\n'),
          weight: WEIGHTS['migration-guide'],
        });
      }
    }
  }

  return out;
}

async function diffTypeSurfaces(
  packageName: string,
  from: string,
  to: string,
  logger: Logger,
): Promise<SurfaceChange[] | null> {
  try {
    const [before, after] = await Promise.all([
      fetchTypeSurface(packageName, from),
      fetchTypeSurface(packageName, to),
    ]);
    if (!before || !after) return null;
    return diffSurfaces(before.api, after.api);
  } catch (err) {
    // Never let an untyped or oddly-packaged dependency fail the run.
    logger.debug(`Type surface diff failed for ${packageName}: ${(err as Error).message}`);
    return null;
  }
}

function formatSurfaceChanges(changes: readonly SurfaceChange[]): string {
  const MAX = 60;
  const lines = changes.slice(0, MAX).map((c) => {
    const parts = [`- [${c.kind}] ${c.detail}`];
    if (c.before && c.after) {
      parts.push(`    before: ${truncate(c.before, 200)}`);
      parts.push(`    after:  ${truncate(c.after, 200)}`);
    }
    return parts.join('\n');
  });
  if (changes.length > MAX) lines.push(`- …and ${changes.length - MAX} more`);
  return lines.join('\n');
}

/**
 * Diff OpenAPI specs committed in the user's own repo.
 *
 * This covers the case the dependency-manifest path cannot see at all: a repo
 * that vendors the spec of an upstream HTTP service. When that spec changes,
 * the consumer's client code breaks even though no package version moved.
 */
async function gatherSpecEvidence(ctx: EvidenceContext): Promise<Evidence[]> {
  const { config, readRepoFile, beforeSha, afterSha } = ctx;
  if (!config.evidence.openapi) return [];
  if (!readRepoFile || !beforeSha || !afterSha) return [];
  if (config.evidence.openapiSpecs.length === 0) return [];

  const out: Evidence[] = [];

  for (const specPath of config.evidence.openapiSpecs) {
    // Globs are resolved by the caller's file listing where available; a
    // literal path is the common case and is handled directly.
    if (specPath.includes('*')) continue;

    const [before, after] = await Promise.all([
      readRepoFile(specPath, beforeSha),
      readRepoFile(specPath, afterSha),
    ]);
    if (!before || !after || before === after) continue;
    if (!parseSpec(after)) continue;

    const findings = diffSpecs(before, after);
    if (findings.length === 0) continue;

    out.push({
      id: stableId('ev', specPath, 'openapi', afterSha),
      source: 'openapi-diff',
      dependency: specPath,
      locator: specPath,
      title: `${findings.length} breaking change(s) in ${specPath}`,
      content: formatOpenApiFindings(findings),
      weight: WEIGHTS['openapi-diff'],
    });
  }

  return out;
}

function formatOpenApiFindings(findings: readonly OpenApiFinding[]): string {
  return findings.map((f) => `- [${f.kind}] ${f.location} — ${f.detail}`).join('\n');
}

function describeSemver(change: DependencyChange): string | null {
  if (!change.from || !change.to) return null;

  const notes: string[] = [];
  if (change.bump === 'major') {
    notes.push(
      `Major version bump ${change.from} → ${change.to}. Semver permits arbitrary breaking changes across a major boundary.`,
    );
  } else if (isZeroVerBreaking(change.from, change.to)) {
    notes.push(
      `0.x minor bump ${change.from} → ${change.to}. Under semver §4 the minor position carries breaking changes while the major version is 0.`,
    );
  } else if (change.bump === 'minor') {
    notes.push(
      `Minor bump ${change.from} → ${change.to}. Should be additive, but ~5% of npm minor/patch releases break consumers in practice.`,
    );
  } else if (change.bump === 'patch') {
    notes.push(`Patch bump ${change.from} → ${change.to}. Breakage here is usually accidental.`);
  }

  if (isDowngrade(change.from, change.to)) {
    notes.push(
      `This is a DOWNGRADE. Code written against ${change.from} may rely on APIs that do not exist in ${change.to}.`,
    );
  }

  return notes.length > 0 ? notes.join(' ') : null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export { WEIGHTS as EVIDENCE_WEIGHTS };
export * from './openapi.js';
export * from './type-surface.js';
export * from './changelog.js';
export * from './registry.js';
export * from './releases.js';
