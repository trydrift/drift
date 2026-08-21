import type { BreakingChange, DependencyChange, Evidence, ImpactSite } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import type { SurfaceAddition, SurfaceUnavailable } from '../evidence/surface/types.js';
import type { ProseSource } from '../evidence/index.js';
import {
  fetchRegistryInfo,
  fetchRepositoryStatus,
  fetchVersionInfo,
  type RegistryInfo,
} from '../evidence/registry.js';
import { mapWithConcurrency } from '../util/http.js';
import { dependencyEcosystemKey } from '../util/id.js';
import { assessSecurity, assessSecurityBatch, unchecked, type OsvOptions, type SecurityLookup } from './osv.js';
import { assessMaintenance } from './maintenance.js';
import { assessLicense } from './license.js';
import { describeAdditions, improvementsFrom, summarizeRelease } from './summary.js';
import { assessUpgrade } from './assess.js';
import type { SecurityAssessment, UpgradeRationale } from './types.js';
import type { RuntimeDeclaration } from './runtime.js';

/**
 * Stage 3b — why this upgrade might be worth taking.
 *
 * Runs after evidence and analysis, because it needs both: the breaking changes
 * to weigh against the benefits, and the impact sites to know whether those
 * breaking changes are this repository's problem at all.
 *
 * Everything is best-effort and nothing throws. A source that cannot be reached
 * becomes a stated gap, and a stated gap changes the recommendation — which is
 * the only correct behaviour, because "Drift found nothing wrong" and "Drift
 * could not look" are different sentences and only one of them is reassuring.
 */

export interface RationaleContext {
  config: DriftConfig;
  logger: Logger;
  githubToken?: string;
  /** Test seam for the OSV client. */
  osv?: OsvOptions;
  /** Computed API additions, keyed by `dependencyEcosystemKey` (ecosystem + workspace + name). */
  additions?: Map<string, { additions: SurfaceAddition[]; locator: string }>;
  /** Computed API diffs that ran, keyed by `dependencyEcosystemKey` (ecosystem + workspace + name). */
  surfaceCompared?: ReadonlySet<string>;
  /** Surface diffs that could not be produced, keyed by `dependencyEcosystemKey` (ecosystem + workspace + name). */
  surfaceGaps?: Map<string, SurfaceUnavailable>;
  /** Prose documents that were actually read, keyed by `dependencyEcosystemKey` when available. */
  prose?: Map<string, ProseSource[]>;
  /** Precomputed security assessments, keyed by the exact upgrade object. */
  security?: Map<DependencyChange, SecurityAssessment>;
  /** Where this repository declares its own Node.js version. See {@link RuntimeDeclaration}. */
  repoRuntime?: readonly RuntimeDeclaration[];
}

export interface RationaleInput {
  changes: readonly DependencyChange[];
  evidence: readonly Evidence[];
  breakingChanges: readonly BreakingChange[];
  impactSites: readonly ImpactSite[];
}

export async function buildRationale(
  input: RationaleInput,
  ctx: RationaleContext,
): Promise<UpgradeRationale[]> {
  const upgrades = input.changes.filter((change) => change.from && change.to);
  const lookups: SecurityLookup[] = upgrades.map((change) => ({
    name: change.name,
    ecosystem: change.ecosystem,
    from: change.from!,
    to: change.to!,
  }));
  const security = ctx.config.rationale.security
    ? await assessSecurityBatch(lookups, ctx.osv ?? {})
    : undefined;
  const securityByChange = security
    ? new Map(upgrades.map((change, index) => [change, security.get(lookups[index]!)!]))
    : undefined;

  return mapWithConcurrency(upgrades, 4, async (change) => {
    try {
      return await rationaleFor(change, input, { ...ctx, security: securityByChange });
    } catch (err) {
      // A crash here is a bug in Drift, not a fact about the dependency — and
      // it must not cost the developer the analysis of the other thirty.
      ctx.logger.debug(`Rationale failed for ${change.name}: ${(err as Error).message}`);
      return degraded(change, `Drift could not assemble an upgrade rationale for ${change.name}.`);
    }
  });
}

async function rationaleFor(
  change: DependencyChange,
  input: RationaleInput,
  ctx: RationaleContext,
): Promise<UpgradeRationale> {
  const { config, logger } = ctx;
  const from = change.from!;
  const to = change.to!;

  const registry = await fetchRegistryInfo(change.name, change.ecosystem, to);

  const [currentVersion, targetVersion, repository] = await Promise.all([
    fetchVersionInfo(change.name, change.ecosystem, from).catch(() => null),
    fetchVersionInfo(change.name, change.ecosystem, to).catch(() => null),
    registry?.githubRepo
      ? fetchRepositoryStatus(registry.githubRepo, ctx.githubToken).catch(() => null)
      : Promise.resolve(null),
  ]);

  const security = config.rationale.security
    ? (ctx.security?.get(change) ?? (await assessSecurity(change.name, change.ecosystem, from, to, ctx.osv ?? {})))
    : // Switched off, not unreachable. Saying "could not be reached" here sent
      // developers looking for a network problem behind their own setting.
      unchecked(
        'Advisory lookup is switched off for this repository (`rationale.security`), so this upgrade’s effect on known vulnerabilities was not checked.',
      );

  const maintenance = config.rationale.maintenance
    ? assessMaintenance({
        name: change.name,
        ecosystem: change.ecosystem,
        from,
        to,
        registry,
        repository,
        currentVersion,
        targetVersion,
        repoRuntime: ctx.repoRuntime,
      })
    : { facts: [] };

  const license = await assessLicense({
    name: change.name,
    ecosystem: change.ecosystem,
    from,
    to,
    currentVersion,
    targetVersion,
    repository,
    policy: config.licenses,
  });

  const breakingChanges = input.breakingChanges.filter(
    (b) => b.dependency === change.name && b.workspace === change.workspace,
  );
  const relevantIds = new Set(breakingChanges.map((b) => b.id));
  const impactSites = input.impactSites.filter((s) => relevantIds.has(s.breakingChangeId));

  const key = dependencyEcosystemKey(change);
  const computed = ctx.additions?.get(key);
  const surfaceCompared = ctx.surfaceCompared?.has(key) ?? computed !== undefined;
  const summary = config.rationale.summary
    ? summarizeRelease({
        dependency: change.name,
        evidence: input.evidence,
        breakingChanges,
        impactSites,
        additions: computed?.additions,
      })
    : { changes: [], unrelated: 0 };

  const improvements = [...improvementsFrom(summary)];
  const additive = computed ? describeAdditions(computed.additions, computed.locator) : null;
  if (additive) improvements.push(additive);

  const prose = ctx.prose?.get(key) ?? ctx.prose?.get(change.name) ?? [];
  const gaps = collectGaps(change, {
    surfaceCompared,
    surfaceGap: ctx.surfaceGaps?.get(key),
    security,
    registry,
    evidence: input.evidence,
    prose,
    licenseUnknown: license.verdict === 'unknown',
  });

  const assessment = assessUpgrade({
    dependency: change.name,
    workspace: change.workspace,
    breakingChanges,
    impactSites,
    evidence: input.evidence,
    security,
    maintenance,
    license,
    gaps,
    surfaceCompared,
    proseRead: prose.length,
  });

  logger.debug(`${change.name} ${from} → ${to}: ${assessment.recommendation}`);

  return {
    dependency: change.name,
    from,
    to,
    security,
    maintenance,
    improvements,
    license,
    summary,
    assessment,
    gaps,
  };
}

/**
 * Every reason this analysis came up short, said once.
 *
 * The bug this function exists to prevent: the report used to print "The Go
 * toolchain is not installed" twice, once from the surface provider and once
 * from the summary line that repeated it. Two sentences saying the same thing
 * reads as two problems, and it makes a reader stop trusting the count of
 * anything.
 *
 * So gaps are assembled in one place, in one order, and deduplicated on their
 * meaning rather than their exact text — a stated remedy is appended to its own
 * reason instead of standing as a second entry.
 */
function collectGaps(
  change: DependencyChange,
  sources: {
    surfaceCompared: boolean;
    surfaceGap?: SurfaceUnavailable;
    security: UpgradeRationale['security'];
    registry: RegistryInfo | null;
    evidence: readonly Evidence[];
    prose: readonly ProseSource[];
    licenseUnknown: boolean;
  },
): string[] {
  const gaps: string[] = [];

  const cited = sources.evidence.filter(
    (record) =>
      record.dependency === change.name &&
      record.workspace === change.workspace &&
      (record.source === 'github-release' ||
        record.source === 'changelog' ||
        record.source === 'migration-guide'),
  );

  const surfaceGap = sources.surfaceGap;

  /**
   * What the prose actually showed — which is three states, not two.
   *
   * Drift used to collapse "no changelog exists" into "no *breaking* passage
   * was found in the changelog", and report both as the former. For a project
   * like Phaser, which publishes a meticulous per-version changelog and a
   * migration guide, that told the developer their dependency documents
   * nothing — the opposite of the truth, and a claim they could disprove in
   * one click. A tool that is caught being wrong about what it read loses the
   * benefit of the doubt on everything else it says.
   */
  const proseNote =
    cited.length > 0
      ? null
      : sources.prose.length > 0
        ? sources.surfaceCompared
          ? null
          : `Drift read ${describeSources(sources.prose)} for ${change.name} ${change.to} and found nothing in ${sources.prose.length === 1 ? 'it' : 'them'} that announces a breaking change. That is weaker than a clean API comparison: it means nothing was flagged, not that nothing broke.`
        : `No release notes, changelog, or migration guide was reachable for ${change.name} ${change.to}${sources.registry?.githubRepo ? '' : ', and no source repository could be resolved for it'}.`;

  // The two most common absences are stated as one sentence rather than two,
  // because they are one situation: nothing could be compared and nothing was
  // written down.
  if (surfaceGap && proseNote) {
    gaps.push(
      `${trimPeriod(surfaceGap.detail)}. ${proseNote}${surfaceGap.remedy ? ` ${surfaceGap.remedy}` : ''}`,
    );
  } else if (surfaceGap) {
    gaps.push(`${trimPeriod(surfaceGap.detail)}.${surfaceGap.remedy ? ` ${surfaceGap.remedy}` : ''}`);
  } else if (proseNote) {
    gaps.push(proseNote);
  }

  if (!sources.security.checked) {
    gaps.push(
      sources.security.reason ??
        'The OSV advisory database could not be reached, so this upgrade\'s effect on known vulnerabilities is unknown.',
    );
  }

  return dedupe(gaps);
}

const KIND_NOUN: Record<ProseSource['kind'], { one: string; many: string }> = {
  'github-release': { one: 'the release notes', many: 'sets of release notes' },
  changelog: { one: 'the changelog', many: 'changelog files' },
  'migration-guide': { one: 'the migration guide', many: 'migration guides' },
};

/**
 * Name what was read, in the developer's terms — and link to it. "Drift read
 * a changelog" is a claim a reader has no way to check; every `ProseSource`
 * already carries the URL Drift actually fetched, so this puts it in the
 * sentence instead of leaving it to sit unused on the object.
 *
 * Every source gets its own link, however many there are. This used to
 * collapse anything past the third into an unlinked "and N more" — a
 * dead-end count with no way to see which sources those were, in the one
 * sentence whose entire job is proving what Drift actually read.
 */
function describeSources(prose: readonly ProseSource[]): string {
  const byKind = (kind: ProseSource['kind']): ProseSource[] => prose.filter((p) => p.kind === kind);

  const parts: string[] = [];
  for (const kind of ['github-release', 'changelog', 'migration-guide'] as const) {
    const items = byKind(kind);
    if (items.length === 0) continue;
    const noun = KIND_NOUN[kind];

    if (items.length === 1) {
      parts.push(`${noun.one} (${mdLink(items[0]!)})`);
      continue;
    }

    parts.push(`${items.length} ${noun.many} (${items.map(mdLink).join(', ')})`);
  }

  if (parts.length === 0) return 'the published release prose';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function mdLink(source: ProseSource): string {
  return `[${source.label}](${source.url})`;
}

function dedupe(gaps: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const gap of gaps) {
    const key = gap.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(gap);
  }
  return out;
}

function trimPeriod(text: string): string {
  return text.replace(/\.\s*$/, '');
}

function degraded(change: DependencyChange, reason: string): UpgradeRationale {
  return {
    dependency: change.name,
    from: change.from ?? '',
    to: change.to ?? '',
    security: {
      checked: false,
      current: [],
      target: [],
      resolved: [],
      introduced: [],
      carried: [],
      direction: 'unknown',
    },
    maintenance: { facts: [] },
    improvements: [],
    license: { verdict: 'unknown', statement: 'Not checked.', introduced: [] },
    summary: { changes: [], unrelated: 0 },
    assessment: {
      recommendation: 'insufficient-evidence',
      reasons: [reason],
      confidence: 'low',
      confidenceBasis: reason,
    },
    gaps: [reason],
  };
}

export * from './types.js';
export { assessSecurity, assessSecurityBatch, mergeAliases, cvssBaseScore } from './osv.js';
export { assessMaintenance, describeAge, raisesMinimum } from './maintenance.js';
export { checkNodeCompatibility, findNodeDeclarations } from './runtime.js';
export { assessLicense, isAllowed } from './license.js';
export { summarizeRelease, classify, bulletLines, improvementsFrom, describeAdditions } from './summary.js';
export { assessUpgrade, RECOMMENDATION_LABEL } from './assess.js';
