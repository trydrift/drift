import type { DependencyChange, Evidence } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import { mapWithConcurrency } from '../util/http.js';
import { stableId } from '../util/id.js';
import { isDowngrade, isZeroVerBreaking } from '../detect/version.js';
import {
  extractBreakingPassages,
  fetchChangelogDocuments,
  fetchMigrationGuides,
  parseChangelogSections,
  sectionsBetween,
} from './changelog.js';
import { fetchRegistryInfo } from './registry.js';
import { fetchReleaseNotes } from './releases.js';
import { diffSpecs, parseSpec, type OpenApiFinding } from './openapi.js';
import {
  diffSurfaces,
  entryPointMoved,
  fetchTypeSurface,
  VersionUnavailableError,
  type SurfaceChange,
} from './type-surface.js';
import {
  computeSurfaceDiff,
  unavailable,
  type SurfaceDiff,
  type SurfaceUnavailable,
} from './surface/index.js';
import type { Exec } from '../util/exec.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  /** Command runner for the ecosystem diffing tools. Injected by tests. */
  exec?: Exec;
  /** Environment to use for local ecosystem diffing tools. */
  env?: NodeJS.ProcessEnv;
  /**
   * Absolute path of a local checkout.
   *
   * Lets a surface provider read the repository's own build files directly —
   * the Go provider names the version in `go.mod` in its remedy, which needs
   * no ref and no network. Preferred over `readRepoFile` when both exist.
   */
  workspaceRoot?: string;
  /**
   * Called when a computed surface diff *was* produced.
   *
   * The upgrade rationale needs what the new version added, and only the
   * computed diff knows. Passing it back rather than folding it into Evidence
   * keeps Evidence what it claims to be: things that justify a breaking change.
   */
  onSurfaceComputed?: (change: DependencyChange, diff: SurfaceDiff) => void;
  /**
   * Called when a computed surface diff could not be produced.
   *
   * An absent diff is a fact about the run, not about the dependency, and the
   * report says which — "japicmp is not installed" and "that version was
   * yanked" lead a developer to different actions.
   */
  onUnavailableSurface?: (change: DependencyChange, reason: SurfaceUnavailable) => void;
  /**
   * Called with every prose document Drift actually read, whether or not it
   * said anything about breakage.
   *
   * Evidence records only exist for passages that mention breaking changes, so
   * a changelog that was read and was simply calm produced no record — and the
   * report then told the developer no changelog was reachable. That is a
   * different and much more alarming claim than the truth, which is that the
   * changelog was read and nothing in it looked breaking.
   */
  onProseConsulted?: (change: DependencyChange, source: ProseSource) => void;
}

/** One prose document Drift reached, for reporting what was actually read. */
export interface ProseSource {
  kind: 'github-release' | 'changelog' | 'migration-guide';
  /** Human label, e.g. `CHANGELOG-v3.90.md` or `v4.2.0 release notes`. */
  label: string;
  url: string;
  /** Whether anything in it matched a breakage marker. */
  breaking: boolean;
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
  // Every push below sets `dependency: change.name` but not `workspace` — set
  // once here instead of at each of the ~6 call sites below and in
  // `surfaceEvidence`, so a monorepo member never has to be threaded through
  // by hand at every evidence source.
  const tag = (evidence: Evidence[]): Evidence[] =>
    change.workspace === undefined ? evidence : evidence.map((e) => ({ ...e, workspace: change.workspace }));

  // The semver signal always exists and costs nothing, so it is recorded first
  // and acts as the floor: no dependency is ever analysed with zero evidence.
  const semverNote = describeSemver(change);
  if (semverNote) {
    out.push({
      id: stableId('ev', change.name, 'semver', change.from, change.to),
      source: 'semver-heuristic',
      dependency: change.name,
      // Drift cites a clause of the specification by number, so the clause has
      // to be openable. A reader told that "semver §4 permits this" and given
      // no way to check it is being asked to take Drift's word for the rule it
      // is reasoning from.
      url: semverClauseUrl(change),
      title: `${change.name} ${change.from} → ${change.to} (${change.bump})`,
      content: semverNote,
      weight: WEIGHTS['semver-heuristic'],
    });
  }

  if (!change.from || !change.to) return tag(out);

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

  // The machine-verified API surface diff. Every ecosystem answers the same
  // question here, with the weight its evidence honestly earns; when it
  // applies it is decisive.
  if (config.evidence.typeSurface) {
    const surface = await surfaceEvidence(change, ctx);
    if (surface) out.push(surface);
  }

  const githubRepo = registry?.githubRepo;
  if (!githubRepo) {
    logger.debug(`No source repository resolved for ${change.name}; prose evidence unavailable`);
    return tag(out);
  }

  if (config.evidence.githubReleases) {
    const releases = await fetchReleaseNotes(githubRepo, change.from, change.to, {
      token: ctx.githubToken,
      maxReleases: config.evidence.maxReleases,
    });

    for (const release of releases) {
      const passages = extractBreakingPassages(release.body);
      ctx.onProseConsulted?.(change, {
        kind: 'github-release',
        label: `${release.name ?? release.tag} release notes`,
        url: release.url,
        breaking: passages.length > 0,
      });
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
    // Plural: a project large enough to split its changelog by version has one
    // document per release, and the index that lists them is not itself prose.
    const documents = await fetchChangelogDocuments(githubRepo, change.from, change.to);

    for (const changelog of documents) {
      const sections = sectionsBetween(parseChangelogSections(changelog.content), change.from, change.to);
      const breaking = sections.some((section) => extractBreakingPassages(section.body).length > 0);
      ctx.onProseConsulted?.(change, {
        kind: 'changelog',
        label: changelog.path,
        url: changelog.url,
        breaking,
      });

      for (const section of sections) {
        const passages = extractBreakingPassages(section.body);
        if (passages.length === 0) continue;
        out.push({
          id: stableId('ev', change.name, 'changelog', changelog.path, section.version),
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
    for (const guide of await fetchMigrationGuides(githubRepo)) {
      const passages = extractBreakingPassages(guide.content);
      ctx.onProseConsulted?.(change, {
        kind: 'migration-guide',
        label: guide.path,
        url: guide.url,
        breaking: passages.length > 0,
      });
      if (passages.length === 0) continue;
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

  return tag(out);
}

/**
 * The computed API-surface diff for one dependency move.
 *
 * npm is served from jsDelivr with no local toolchain; everything else goes
 * through `surface/`, which shells out to the ecosystem's own diffing tool.
 * Both produce the same `SurfaceChange[]`, so nothing downstream — analyze,
 * plan, or any guardrail — learns which ecosystem it came from.
 *
 * A surface that could not be computed is recorded on the change so the report
 * and the panel can say *why* rather than showing an absence.
 */
async function surfaceEvidence(change: DependencyChange, ctx: EvidenceContext): Promise<Evidence | null> {
  const { logger } = ctx;
  const from = change.from!;
  const to = change.to!;

  if (change.ecosystem === 'npm') {
    const surface = await diffTypeSurfaces(change.name, from, to, logger);
    if (!surface) {
      ctx.onUnavailableSurface?.(
        change,
        unavailable(
          'TypeScript declarations',
          'no-public-surface',
          `${change.name} publishes no TypeScript declarations Drift could compare, so this upgrade rests on prose evidence.`,
        ),
      );
      return null;
    }
    if (surface.unreachable) {
      ctx.onUnavailableSurface?.(
        change,
        unavailable(
          'TypeScript declarations',
          'version-unavailable',
          `${surface.unreachable} could not be fetched, so nothing was compared. That version may have been unpublished, or the CDN may not carry it.`,
        ),
      );
      return null;
    }
    if (surface.definitelyTyped) {
      ctx.onUnavailableSurface?.(
        change,
        unavailable(
          'TypeScript declarations',
          'no-public-surface',
          `${change.name} ships no declarations of its own; its types live in @types/${change.name.replace(/^@/, '').replace('/', '__')}, which versions separately and does not move with this upgrade. Nothing was compared.`,
        ),
      );
      return null;
    }
    if (surface.changes.length === 0) {
      if (!surface.comparable) {
        ctx.onUnavailableSurface?.(
          change,
          unavailable(
            'TypeScript declarations',
            'no-public-surface',
            `${change.name}'s public API is neither in its own declarations nor in any dependency Drift could follow, so comparing its declarations proves nothing about this upgrade.`,
          ),
        );
      } else {
        // A real, successful comparison that happened to find nothing — reported
        // the same way the non-npm surface path already reports a clean diff
        // (below), so this is recorded as *checked*, not folded into the same
        // "unavailable" bucket as a comparison that could not run at all.
        ctx.onSurfaceComputed?.(change, {
          available: true,
          changes: [],
          tool: 'jsdelivr-dts-diff',
          weight: WEIGHTS['type-surface-diff'],
          locator: `${change.name}@${from}:${surface.beforeEntryPath} → ${change.name}@${to}:${surface.afterEntryPath}`,
        });
      }
      return null;
    }

    return surfaceRecord(change, {
      changes: surface.changes,
      weight: WEIGHTS['type-surface-diff'],
      locator: `${change.name}@${from}:${surface.beforeEntryPath} → ${change.name}@${to}:${surface.afterEntryPath}`,
      url: jsdelivrDeclarationUrl(change.name, to, surface.afterEntryPath),
      beforeUrl: jsdelivrDeclarationUrl(change.name, from, surface.beforeEntryPath),
      afterUrl: jsdelivrDeclarationUrl(change.name, to, surface.afterEntryPath),
    });
  }

  const outcome = await computeSurfaceDiff(change, {
    logger,
    exec: ctx.exec,
    env: ctx.env,
    readRepoFile: repoFileReader(ctx),
    autoInstall: ctx.config.tools.autoInstall,
  });
  if (!outcome.available) {
    logger.debug(`No computed surface for ${change.name}: ${outcome.detail}`);
    ctx.onUnavailableSurface?.(change, outcome);
    return null;
  }

  // Reported even when nothing broke. "Drift compared 412 packages and found
  // no removals" is a result; returning early would make it indistinguishable
  // from never having looked.
  ctx.onSurfaceComputed?.(change, outcome);
  if (outcome.changes.length === 0) return null;

  return surfaceRecord(change, {
    changes: outcome.changes,
    weight: outcome.weight,
    locator: `${outcome.locator} · computed by ${outcome.tool}`,
  });
}

/**
 * How a surface provider reads the repository under analysis.
 *
 * A local checkout answers without a network round trip and without a ref,
 * which is what the editor has; the provider's `readFile` at the analysed
 * commit is what CI has. Absent when neither exists, which providers treat as
 * an ordinary case rather than an error.
 */
function repoFileReader(ctx: EvidenceContext): ((path: string) => Promise<string | null>) | undefined {
  const { workspaceRoot, readRepoFile, afterSha } = ctx;

  if (workspaceRoot) {
    return async (path) => readFile(join(workspaceRoot, path), 'utf8').catch(() => null);
  }
  if (readRepoFile && afterSha) {
    return (path) => readRepoFile(path, afterSha).catch(() => null);
  }
  return undefined;
}

function surfaceRecord(
  change: DependencyChange,
  args: {
    changes: SurfaceChange[];
    weight: number;
    locator: string;
    url?: string;
    beforeUrl?: string;
    afterUrl?: string;
  },
): Evidence {
  const sources =
    args.beforeUrl || args.afterUrl
      ? [
          'Declaration sources:',
          args.beforeUrl ? `- before: ${args.beforeUrl}` : '',
          args.afterUrl ? `- after: ${args.afterUrl}` : '',
          '',
        ]
          .filter(Boolean)
          .join('\n')
      : '';

  return {
    id: stableId('ev', change.name, 'surface', change.from ?? '', change.to ?? ''),
    source: 'type-surface-diff',
    dependency: change.name,
    url: args.url,
    locator: args.locator,
    title: `${args.changes.length} API surface change(s) in ${change.name}`,
    content: `${sources}${formatSurfaceChanges(args.changes)}`,
    findings: args.changes.map((c) => ({
      code: c.kind,
      symbol: c.symbol,
      detail: c.detail,
      before: c.before,
      after: c.after,
    })),
    weight: args.weight,
  };
}

/**
 * The smallest surface worth calling a comparison.
 *
 * A package whose entry declaration is one re-export of another package
 * resolves to a single symbol on both sides and diffs to nothing. Reporting
 * that as "no API changes" claims a comparison that never happened.
 *
 * Reaching this at all now takes a package whose API is neither in its own
 * declarations nor in any dependency Drift could follow — `fetchTypeSurface`
 * resolves the dependencies a wrapper re-exports through, which is what made
 * `@octokit/rest`, the case this constant was written for, comparable.
 */
const MIN_COMPARABLE_SYMBOLS = 3;

async function diffTypeSurfaces(
  packageName: string,
  from: string,
  to: string,
  logger: Logger,
): Promise<{
  changes: SurfaceChange[];
  comparable: boolean;
  beforeEntryPath: string;
  afterEntryPath: string;
  unreachable?: string;
  /**
   * Both sides resolved to DefinitelyTyped.
   *
   * `@types/x` is fetched at `latest` because it carries no version of its own
   * that corresponds to `x@1.2.3`. That makes the two sides of the diff the
   * same file, which is empty by construction — and an empty diff was being
   * reported as a clean comparison. Nothing was compared at all.
   */
  definitelyTyped?: boolean;
} | null> {
  try {
    const [before, after] = await Promise.all([
      fetchTypeSurface(packageName, from),
      fetchTypeSurface(packageName, to),
    ]);
    if (!before || !after) return null;

    if (before.viaDependencies.length > 0 || after.viaDependencies.length > 0) {
      logger.debug(
        `${packageName} surface includes ${[...new Set([...before.viaDependencies, ...after.viaDependencies])].join(', ')}`,
      );
    }

    // Named first, because it explains every removal underneath it. A reader
    // who sees three hundred "removed" lines with no cause reaches for the
    // wrong fix; a reader who is told the entry point moved reaches for the
    // right one.
    const moved = entryPointMoved(packageName, before, after);
    const changes = diffSurfaces(before.api, after.api);

    const definitelyTyped =
      before.entryPath.startsWith('@types:') && after.entryPath.startsWith('@types:');

    return {
      changes: moved ? [moved, ...changes] : changes,
      comparable:
        before.api.size >= MIN_COMPARABLE_SYMBOLS && after.api.size >= MIN_COMPARABLE_SYMBOLS,
      beforeEntryPath: before.entryPath,
      afterEntryPath: after.entryPath,
      ...(definitelyTyped ? { definitelyTyped } : {}),
    };
  } catch (err) {
    // Never let an untyped or oddly-packaged dependency fail the run.
    logger.debug(`Type surface diff failed for ${packageName}: ${(err as Error).message}`);
    if (err instanceof VersionUnavailableError) {
      return {
        changes: [],
        comparable: false,
        beforeEntryPath: '',
        afterEntryPath: '',
        unreachable: `${err.packageName}@${err.version}`,
      };
    }
    return null;
  }
}

function jsdelivrDeclarationUrl(packageName: string, version: string, entryPath: string): string | undefined {
  if (!entryPath || entryPath.startsWith('@types:')) return undefined;
  return `https://cdn.jsdelivr.net/npm/${packageName}@${version}/${entryPath}`;
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
      findings: findings.map((f) => ({
        code: f.kind,
        symbol: f.location,
        detail: f.detail,
      })),
      weight: WEIGHTS['openapi-diff'],
    });
  }

  return out;
}

function formatOpenApiFindings(findings: readonly OpenApiFinding[]): string {
  return findings.map((f) => `- [${f.kind}] ${f.location} — ${f.detail}`).join('\n');
}

/**
 * The clause of the semver specification this reasoning rests on.
 *
 * The numbering is the specification's own: §4 is the "major version zero"
 * clause, §8 is the one that permits arbitrary breakage across a major bump.
 */
function semverClauseUrl(change: DependencyChange): string {
  if (change.from && change.to && isZeroVerBreaking(change.from, change.to)) {
    return 'https://semver.org/#spec-item-4';
  }
  if (change.bump === 'major') return 'https://semver.org/#spec-item-8';
  return 'https://semver.org/';
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
      // No figure. This string is *evidence* a developer reads next to a
      // finding, and an unsourced statistic presented as evidence is the one
      // thing this pipeline is built not to produce.
      `Minor bump ${change.from} → ${change.to}. Semver says this should be additive, which is a convention rather than a guarantee — minor releases do break consumers, so the version number alone is not evidence either way.`,
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
export * from './surface/index.js';
export * from './changelog.js';
export * from './registry.js';
export * from './releases.js';
