import type { DependencyChange, Evidence, EvidenceSource } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import { mapWithConcurrency } from '../util/http.js';
import { matchGlob } from '../util/glob.js';
import { stableId } from '../util/id.js';
import { isDowngrade, isZeroVerBreaking } from '../detect/version.js';
import {
  extractBreakingPassages,
  fetchChangelogDocuments,
  fetchMigrationGuides,
  parseChangelogSections,
  sectionsBetween,
} from './changelog.js';
import { fetchRegistryInfo, fetchVersionInfo } from './registry.js';
import { fetchReleaseNotes } from './releases.js';
import {
  computeSpecDiff,
  specEnabled,
  specPaths,
  SPEC_PROVIDERS,
  SPEC_WEIGHTS,
  type SpecChange,
  type SpecDocument,
  type SpecProvider,
  type SpecUnavailable,
} from './spec/index.js';
import {
  diffSurfaces,
  diffPackageModuleMetadata,
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
const WEIGHTS: Record<Exclude<EvidenceSource, 'behavioural-diff'>, number> = {
  'type-surface-diff': 1.0,
  // Contract-document diffs carry the weight their own provider declares, so
  // a format's weight lives with the differ that earns it rather than here.
  ...SPEC_WEIGHTS,
  'migration-guide': 0.8,
  'github-release': 0.7,
  changelog: 0.65,
  'registry-metadata': 0.4,
  'semver-heuristic': 0.25,
  // `behavioural-diff` is deliberately absent: a probe's weight depends on what
  // the probe observed (a difference, no difference, or an unavailable run),
  // so `verification/behavioural.ts` sets it per record rather than reading a
  // constant that could only ever be wrong for two of the three outcomes.
};

export interface EvidenceContext {
  config: DriftConfig;
  logger: Logger;
  /** Token used only to raise the GitHub API rate limit for public reads. */
  githubToken?: string;
  /** Reads a file from the *user's* repo at a given ref. */
  readRepoFile?: (path: string, ref: string) => Promise<string | null>;
  /**
   * Lists every file in the *user's* repo at a ref, or `null` if it cannot.
   *
   * Only needed to expand configured path patterns. `null` and `[]` are kept
   * apart deliberately: expanding a pattern against a failed listing would
   * match nothing, and report every contract it covers as clean.
   */
  listRepoFiles?: (ref: string) => Promise<string[] | null>;
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
  /**
   * Called when a configured contract document *was* compared, even if the
   * comparison found nothing. The counterpart of `onSurfaceComputed`: "the
   * schema was diffed and is clean" and "the schema was never diffed" are
   * different claims, and only this can tell them apart.
   */
  onSpecComputed?: (path: string, provider: SpecProvider) => void;
  /**
   * Called when a configured contract document could not be compared —
   * `buf` missing, a document that does not parse. A fact about the run, not
   * about the contract, and the report says which.
   */
  onUnavailableSpec?: (path: string, reason: SpecUnavailable) => void;
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

  const currentVersionPending = fetchVersionInfo(change.name, change.ecosystem, change.from).catch(() => null);
  const registry = await fetchRegistryInfo(change.name, change.ecosystem, change.to);
  const [currentVersion, targetVersion] = await Promise.all([
    currentVersionPending,
    fetchVersionInfo(change.name, change.ecosystem, change.to).catch(() => null),
  ]);

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

  // A raised or newly-introduced runtime floor declared in the target's own
  // registry metadata (npm `engines`, PyPI `requires-python`, the `go`
  // directive, Cargo `rust-version`) is a canonical runtime requirement — the
  // same kind of fact a changelog sentence produces. Emitted here as evidence
  // so `analyze` turns it into a `runtime-requirement` breaking change that
  // flows through the one `RuntimeRequirementAnalysis` pipeline. Maintenance
  // must not run a second compatibility check of its own against it.
  const runtimeFloor = raisedRuntimeFloor(currentVersion?.runtime ?? null, targetVersion?.runtime ?? null);
  if (runtimeFloor) {
    out.push({
      id: stableId('ev', change.name, 'runtime-metadata', change.to, runtimeFloor.runtime, runtimeFloor.requirement),
      source: 'registry-metadata',
      dependency: change.name,
      url: registry?.homepage ?? undefined,
      title: `${change.name}@${change.to} requires ${runtimeFloor.runtime} ${runtimeFloor.requirement}`,
      content: `${change.name}@${change.to} requires ${runtimeFloor.runtime} ${runtimeFloor.requirement}.`,
      weight: WEIGHTS['registry-metadata'],
    });
  }

  const githubRepo = registry?.githubRepo;

  // Everything below this line is started here and awaited where its results
  // are needed, rather than each being waited out before the next begins.
  //
  // The API surface diff, the release notes, the changelog and the migration
  // guides ask four different servers four unrelated questions; none of them
  // depends on any other's answer, and the registry lookup above has already
  // supplied the only thing they share. Running them in series made one
  // dependency's evidence cost the *sum* of four round trips — the largest
  // single component of per-package latency, paid once per dependency in the
  // repository. The evidence list is still assembled in the same order, so
  // nothing downstream can tell the difference except by how long it waited.
  //
  // The machine-verified API surface diff: every ecosystem answers the same
  // question there, with the weight its evidence honestly earns, and when it
  // applies it is decisive.
  const surfacePending = config.evidence.typeSurface ? surfaceEvidence(change, ctx) : null;
  const releasesPending =
    githubRepo && config.evidence.githubReleases
      ? fetchReleaseNotes(githubRepo, change.from, change.to, {
          token: ctx.githubToken,
          maxReleases: config.evidence.maxReleases,
        })
      : null;
  // Plural: a project large enough to split its changelog by version has one
  // document per release, and the index that lists them is not itself prose.
  const changelogsPending =
    githubRepo && config.evidence.changelog
      ? fetchChangelogDocuments(githubRepo, change.from, change.to)
      : null;
  // Migration guides are the artefact LADU relies on exclusively. Drift
  // treats one as strong corroboration rather than the sole input, so a
  // package without a guide is still analysable.
  const guidesPending = githubRepo && config.evidence.changelog ? fetchMigrationGuides(githubRepo) : null;
  // A rejection is still raised at the `await` below; this only stops one that
  // is awaited later than another's failure from being seen as unhandled.
  for (const pending of [surfacePending, releasesPending, changelogsPending, guidesPending]) {
    pending?.catch(() => undefined);
  }

  const surface = surfacePending ? await surfacePending : null;
  if (surface) out.push(surface);

  if (!githubRepo) {
    logger.debug(`No source repository resolved for ${change.name}; prose evidence unavailable`);
    return tag(out);
  }

  if (releasesPending) {
    const releases = await releasesPending;

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
        // Joined with a blank line, not a bare newline: `extractBreakingPassages`
        // hands back individual lines with the blank lines between them already
        // stripped out, so a bare join glued separate headings, bullets and
        // paragraphs into one run-on line once rendered as markdown.
        content: passages.join('\n\n'),
        weight: WEIGHTS['github-release'],
      });
    }
  }

  if (changelogsPending) {
    const documents = await changelogsPending;

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
          // Joined with a blank line, not a bare newline: `extractBreakingPassages`
        // hands back individual lines with the blank lines between them already
        // stripped out, so a bare join glued separate headings, bullets and
        // paragraphs into one run-on line once rendered as markdown.
        content: passages.join('\n\n'),
          weight: WEIGHTS.changelog,
        });
      }
    }
  }

  if (guidesPending) {
    for (const guide of await guidesPending) {
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
        content: passages.slice(0, 200).join('\n\n'),
        weight: WEIGHTS['migration-guide'],
      });
    }
  }

  return tag(out);
}

/** Gather evidence tied only to the published dependency upgrade. */
export async function gatherDependencyEvidence(change: DependencyChange, ctx: EvidenceContext): Promise<Evidence[]> {
  return gatherForChange(change, ctx);
}

/**
 * `VersionInfo.runtime.name` as each registry reports it, mapped to the display
 * form the runtime prose grammar (`analyze/rules.ts`) accepts, so a synthesized
 * sentence is parsed by exactly the same rule a changelog line is.
 */
const RUNTIME_METADATA_NAMES: Readonly<Record<string, string>> = {
  node: 'Node.js',
  'node.js': 'Node.js',
  nodejs: 'Node.js',
  python: 'Python',
  go: 'Go',
  ruby: 'Ruby',
  java: 'Java',
  rust: 'Rust',
};

/**
 * The runtime floor a target version *introduces* or *raises* over the
 * installed one, as a `{ runtime, requirement }` pair, or `null` when there is
 * no such change to state.
 *
 * Whether *this repository* actually satisfies the floor is deliberately not
 * decided here: that verdict has one owner, `RuntimeRequirementAnalysis`, and
 * this function only surfaces the upstream fact for it to answer.
 */
export function raisedRuntimeFloor(
  current: { name: string; requirement: string } | null,
  target: { name: string; requirement: string } | null,
): { runtime: string; requirement: string } | null {
  if (!target?.requirement) return null;
  const runtime = RUNTIME_METADATA_NAMES[target.name.toLowerCase()];
  if (!runtime) return null;
  const requirement = target.requirement.trim();
  if (!requirement) return null;

  const sameRuntime = current && RUNTIME_METADATA_NAMES[current.name.toLowerCase()] === runtime;
  if (!sameRuntime) return { runtime, requirement };

  // Same runtime on both sides: only a genuinely raised floor is news. An
  // unchanged or lowered minimum is not a breaking condition.
  const floor = (spec: string) => {
    const digits = /(\d+(?:\.\d+)*)/.exec(spec)?.[1];
    return digits ? digits.split('.').map((n) => Number(n)) : null;
  };
  const [before, after] = [floor(current!.requirement), floor(requirement)];
  if (!before || !after) return null;
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    const a = after[i] ?? 0;
    const b = before[i] ?? 0;
    if (a > b) return { runtime, requirement };
    if (a < b) return null;
  }
  return null;
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
    const [moduleMetadataChanges, surface] = await Promise.all([
      diffPackageModuleMetadata(change.name, from, to).catch((err) => {
        logger.debug(`Package module metadata diff failed for ${change.name}: ${(err as Error).message}`);
        return [] as SurfaceChange[];
      }),
      diffTypeSurfaces(change.name, from, to, logger),
    ]);
    if (!surface) {
      if (moduleMetadataChanges.length > 0) {
        // A real but partial result: package.json-level changes were found and
        // are counted below, but the TypeScript declarations themselves could
        // not be fetched, so this is not the clean API comparison it would
        // look like if nothing were recorded here. Recording the gap keeps
        // `collectGaps` from treating this the same as "nothing was checked at
        // all" — the failure mode that made a changelog-only prose note read
        // as though it were the *only* evidence, when a structural finding
        // already existed.
        ctx.onUnavailableSurface?.(
          change,
          unavailable(
            'TypeScript declarations',
            'no-public-surface',
            `${change.name} publishes no TypeScript declarations Drift could compare, though its package.json changed between versions — that metadata-level change is counted below, but nothing about its public API could be verified.`,
          ),
        );
        return surfaceRecord(change, {
          changes: moduleMetadataChanges,
          weight: WEIGHTS['type-surface-diff'],
          locator: `${change.name}@${from}:package.json → ${change.name}@${to}:package.json`,
          url: jsdelivrDeclarationUrl(change.name, to, 'package.json'),
          beforeUrl: jsdelivrDeclarationUrl(change.name, from, 'package.json'),
          afterUrl: jsdelivrDeclarationUrl(change.name, to, 'package.json'),
        });
      }
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
    if (surface.comparisonFailed) {
      // Distinct from the `!surface` branch above on purpose: this is Drift's
      // own comparison breaking (a parser bug, a malformed CDN response, an
      // unexpected error), not a fact about what the package publishes. Saying
      // "publishes no declarations" here would misreport the reason for every
      // future reader of this evidence, exactly backwards from what this PR
      // otherwise exists to fix — evidence gaps must state what is actually
      // known, not paper over an internal failure as an external fact.
      const detail = `Comparing ${change.name}'s TypeScript declarations failed unexpectedly (${surface.comparisonFailed}). This does not mean ${change.name} publishes no declarations.`;
      if (moduleMetadataChanges.length > 0) {
        ctx.onUnavailableSurface?.(change, unavailable('TypeScript declarations', 'toolchain-failed', detail));
        return surfaceRecord(change, {
          changes: moduleMetadataChanges,
          weight: WEIGHTS['type-surface-diff'],
          locator: `${change.name}@${from}:package.json → ${change.name}@${to}:package.json`,
          url: jsdelivrDeclarationUrl(change.name, to, 'package.json'),
          beforeUrl: jsdelivrDeclarationUrl(change.name, from, 'package.json'),
          afterUrl: jsdelivrDeclarationUrl(change.name, to, 'package.json'),
        });
      }
      ctx.onUnavailableSurface?.(change, unavailable('TypeScript declarations', 'toolchain-failed', detail));
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
    const computedChanges = [...moduleMetadataChanges, ...surface.changes];
    if (computedChanges.length === 0) {
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
      changes: computedChanges,
      weight: WEIGHTS['type-surface-diff'],
      locator: `${change.name}@${from}:${surface.beforeEntryPath} + package.json → ${change.name}@${to}:${surface.afterEntryPath} + package.json`,
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
      ...(c.changed ? { changed: c.changed } : {}),
      ...(c.fromKind ? { fromKind: c.fromKind } : {}),
      ...(c.toKind ? { toKind: c.toKind } : {}),
      ...(c.moduleSystem
        ? {
            moduleSystem: {
              ...c.moduleSystem,
              incompatibleUsage: [...c.moduleSystem.incompatibleUsage],
              ...(c.moduleSystem.affectedSpecifiers
                ? { affectedSpecifiers: [...c.moduleSystem.affectedSpecifiers] }
                : {}),
              ...(c.moduleSystem.affectedSpecifierPatterns
                ? { affectedSpecifierPatterns: [...c.moduleSystem.affectedSpecifierPatterns] }
                : {}),
            },
          }
        : {}),
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
  /**
   * An unexpected failure while comparing, not a fact about the package.
   *
   * `fetchTypeSurface` returning `null` (no `types`/`typings` field, no
   * resolvable `.d.ts`) is a genuine "this version publishes no
   * declarations" — that stays a bare `null` return below. This field is for
   * everything else that can throw inside this comparison — a parser bug, a
   * malformed CDN response, an unexpected error in `entryPointMoved` or
   * `diffSurfaces` — which used to be caught and turned into the exact same
   * bare `null`, so the caller could not tell "this package has no
   * declarations" from "Drift's own comparison broke" and reported the
   * former as fact either way.
   */
  comparisonFailed?: string;
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
    const changes = diffSurfaces(before.api, after.api, {
      beforeComplete: !before.incomplete,
      afterComplete: !after.incomplete,
    });

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
    return {
      changes: [],
      comparable: false,
      beforeEntryPath: '',
      afterEntryPath: '',
      comparisonFailed: (err as Error).message,
    };
  }
}

function jsdelivrDeclarationUrl(packageName: string, version: string, entryPath: string): string | undefined {
  if (!entryPath || entryPath.startsWith('@types:')) return undefined;
  return `https://cdn.jsdelivr.net/npm/${packageName}@${version}/${entryPath}`;
}

/**
 * A declaration, on one line.
 *
 * The only shaping these get: the `before:`/`after:` prefixes make each a line
 * of a list, so an embedded newline would break the pairing the panel parses
 * back out. A ceiling is kept for the pathological case — a machine-generated
 * type thousands of characters wide is not evidence anyone reads — but it sits
 * far above any real signature rather than in the middle of them.
 */
function collapseSignature(declaration: string): string {
  return truncate(declaration.replace(/\s+/g, ' ').trim(), 4000);
}

function formatSurfaceChanges(changes: readonly SurfaceChange[]): string {
  const MAX = 60;
  const lines = changes.slice(0, MAX).map((c) => {
    // The kind is already carried structurally on the finding, and the detail
    // sentence ("The signature of Drop changed.") says the same thing in words
    // a reader does not have to decode. A raw `[signature-changed]` in front of
    // it is machine vocabulary leaking into prose.
    const parts = [`- ${c.detail}`];
    if (c.before && c.after) {
      // Whole, not clipped. These two lines are the evidence — the declaration
      // as it was and as it now is — and the panel renders them as the
      // before/after pair a developer reads to decide what the change means. A
      // signature cut at 200 characters loses the end of the parameter list,
      // which is exactly where a parameter tends to have been added, so the
      // pair showed a "before" and an "after" that were identical up to the
      // ellipsis and said nothing. They are already whitespace-collapsed to a
      // single line each, and the number of changes is capped above, so what
      // bounds this is the count rather than the truth of any one entry.
      parts.push(`    before: ${collapseSignature(c.before)}`);
      parts.push(`    after:  ${collapseSignature(c.after)}`);
    }
    return parts.join('\n');
  });
  if (changes.length > MAX) lines.push(`- …and ${changes.length - MAX} more`);
  return lines.join('\n');
}

/**
 * Diff the contract documents committed in the user's own repo.
 *
 * This covers the case the dependency-manifest path cannot see at all: a repo
 * that vendors the contract of an upstream service — an OpenAPI document, a
 * `.proto`, a GraphQL schema. When that document changes, the consumer's client
 * code breaks even though no package version moved.
 *
 * Format-agnostic by construction. Every provider in `SPEC_PROVIDERS` declares
 * which config keys switch it on, which documents it recognises, and what its
 * evidence is called and weighs, so this loop never learns that OpenAPI exists.
 */
async function gatherSpecEvidence(ctx: EvidenceContext): Promise<Evidence[]> {
  const { config, logger, readRepoFile, beforeSha, afterSha } = ctx;
  if (!readRepoFile || !beforeSha || !afterSha) return [];

  const out: Evidence[] = [];

  for (const provider of SPEC_PROVIDERS) {
    if (!specEnabled(provider, config)) continue;

    const resolved = await resolveSpecPaths(specPaths(provider, config), ctx);
    for (const unresolvable of resolved.unresolvable) {
      // A pattern that could not be expanded is a gap, not a skip. This used to
      // `continue` silently: every contract the pattern covered went uncompared
      // and unmentioned, which is precisely the "reported clean without being
      // read" failure the rest of this file exists to prevent.
      ctx.onUnavailableSpec?.(unresolvable, {
        available: false,
        reason: 'toolchain-failed',
        detail: `Drift could not list the files in this repository, so the pattern \`${unresolvable}\` could not be expanded and the contracts it covers were not compared.`,
        remedy: 'List the contract documents by literal path instead of by pattern.',
        tool: provider.tool,
      });
    }

    // Read every configured document once, before diffing any of them. Formats
    // whose documents import each other need the whole set to compile even one,
    // and a document that did not change is exactly as necessary to that as one
    // that did — so the read cannot be folded into the "did this change?" loop
    // below.
    const documents: SpecDocument[] = [];
    for (const specPath of resolved.paths) {
      const [before, after] = await Promise.all([
        readRepoFile(specPath, beforeSha),
        readRepoFile(specPath, afterSha),
      ]);
      if (!before || !after) continue;
      if (!provider.handles(specPath, after)) continue;
      documents.push({ path: specPath, before, after });
    }

    for (const document of documents) {
      const specPath = document.path;
      if (document.before === document.after) continue;

      const outcome = await computeSpecDiff(provider, document, {
        logger,
        exec: ctx.exec,
        env: ctx.env,
        siblings: documents.filter((other) => other.path !== specPath),
      });

      if (!outcome.available) {
        // Stated, never silent. "buf is not installed" and "that document does
        // not parse" lead a developer to different actions, and a spec that was
        // configured and then not compared must not look like one that was
        // compared and found clean.
        logger.debug(`No ${provider.id} diff for ${specPath}: ${outcome.detail}`);
        ctx.onUnavailableSpec?.(specPath, outcome);
        continue;
      }

      ctx.onSpecComputed?.(specPath, provider);
      if (outcome.changes.length === 0) continue;

      out.push({
        id: stableId('ev', specPath, provider.id, afterSha),
        source: provider.source,
        dependency: specPath,
        locator: specPath,
        title: `${outcome.changes.length} breaking change(s) in ${specPath}`,
        content: formatSpecChanges(outcome.changes),
        findings: outcome.changes.map((change) => ({
          code: change.code,
          symbol: change.location,
          detail: change.detail,
          ...(change.before !== undefined ? { before: change.before } : {}),
          ...(change.after !== undefined ? { after: change.after } : {}),
        })),
        weight: outcome.weight,
      });
    }
  }

  return out;
}

/**
 * Turn configured contract paths into concrete ones.
 *
 * A literal path is passed straight through — including one that does not
 * exist, so the existing "configured but never compared" reporting still fires
 * on a typo rather than being swallowed here as "matched nothing".
 *
 * A pattern is expanded against the files present *after* the change, since
 * that is the revision whose contracts the repository is now written against.
 * A document deleted between the two revisions is therefore not matched, which
 * is correct: there is no "after" side to diff, and its disappearance is a
 * change to the repository rather than to the contract.
 */
async function resolveSpecPaths(
  configured: readonly string[],
  ctx: EvidenceContext,
): Promise<{ paths: string[]; unresolvable: string[] }> {
  const patterns = configured.filter(isPathPattern);
  const literals = configured.filter((path) => !isPathPattern(path));
  if (patterns.length === 0) return { paths: literals, unresolvable: [] };

  const listed = ctx.listRepoFiles && ctx.afterSha ? await ctx.listRepoFiles(ctx.afterSha) : null;
  if (!listed) return { paths: literals, unresolvable: patterns };

  const matched = new Set(literals);
  for (const pattern of patterns) {
    for (const file of listed) {
      if (matchGlob(pattern, file)) matched.add(file);
    }
  }

  // Sorted so a run is reproducible: the listing's order is git's, and a report
  // whose findings reorder between two identical runs is hard to trust.
  return { paths: [...matched].sort(), unresolvable: [] };
}

function isPathPattern(path: string): boolean {
  return path.includes('*') || path.includes('?');
}

function formatSpecChanges(changes: readonly SpecChange[]): string {
  return changes.map((change) => `- \`${change.location}\` — ${change.detail}`).join('\n');
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
export * from './spec/index.js';
export * from './type-surface.js';
export * from './surface/index.js';
export * from './changelog.js';
export * from './registry.js';
export * from './releases.js';
