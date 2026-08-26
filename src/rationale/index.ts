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
  type RepositoryStatus,
  type VersionInfo,
} from '../evidence/registry.js';
import { mapWithConcurrency } from '../util/http.js';
import { dependencyEcosystemKey } from '../util/id.js';
import { assessSecurity, assessSecurityBatch, unchecked, type OsvOptions, type SecurityLookup } from './osv.js';
import { assessMaintenance } from './maintenance.js';
import { assessLicense } from './license.js';
import { describeAdditions, improvementsFrom, summarizeRelease } from './summary.js';
import { assessUpgrade, hasCompatibilityEvidence } from './assess.js';
import type { LicenseFinding, SecurityAssessment, UpgradeRationale } from './types.js';
import type { RuntimeDeclaration } from './runtime.js';
import { startSpan as diagSpan, withSpan as diagWithSpan } from '../util/diagnostics.js';

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
  /**
   * The OSV batch lookup for every change in this call, keyed by the exact
   * upgrade object.
   *
   * A promise rather than an already-resolved `Map`: `buildRationale` starts
   * this fetch and hands it straight through without awaiting it, so it runs
   * concurrently with each change's own independent registry/version
   * lookups instead of gating the start of all of them.
   */
  security?: Promise<Map<DependencyChange, SecurityAssessment>>;
  /**
   * Where this repository declares its own Node.js version.
   *
   * The fallback used when a change carries no workspace (`change.workspace`
   * is `undefined`) or `repoRuntimeByWorkspace` has no entry for it.
   */
  repoRuntime?: readonly RuntimeDeclaration[];
  /** Where this repository declares its own Python version. See {@link repoRuntime}. */
  pythonRuntime?: readonly RuntimeDeclaration[];
  /**
   * Node.js declarations already scoped per workspace member, keyed by
   * `change.workspace` (`''` for the root member of a monorepo). A single
   * `buildRationale` call can cover changes from several members at once —
   * `analyzeRepository`'s main path does exactly this — and a flat
   * `repoRuntime` applied to all of them would let one member's declared
   * runtime leak into another's compatibility check. Absent (or missing a
   * key) falls back to `repoRuntime`.
   */
  repoRuntimeByWorkspace?: ReadonlyMap<string, readonly RuntimeDeclaration[]>;
  /** See {@link repoRuntimeByWorkspace}; the Python equivalent. */
  pythonRuntimeByWorkspace?: ReadonlyMap<string, readonly RuntimeDeclaration[]>;
  /**
   * Called as `rationaleFor` moves through its stages, one dependency at a
   * time.
   *
   * `rationaleFor` used to be reported as one opaque phase — "weighing what
   * this upgrade is worth" — for its entire duration, whether it was
   * fetching the registry, waiting on GitHub, or querying OSV. That made a
   * slow stage indistinguishable from a hung one. This is the seam a caller
   * uses to show which stage is actually running.
   */
  onProgress?: (change: DependencyChange, phase: string) => void;
  /**
   * Already-prepared workspace-independent facts for a change, keyed by the
   * change object — the counterpart to {@link security} above but for the
   * whole `prepareRationaleFacts` stage, not only the OSV lookup.
   *
   * `scanUpgrades` (`src/upgrade/scan.ts`) computes these once per unique
   * ecosystem/package/from/to upgrade, alongside (not after) evidence
   * gathering, and hands the same promise to every workspace row sharing
   * that exact upgrade. When absent, `rationaleFor` falls back to calling
   * `prepareRationaleFacts` itself, so every caller outside the shared-scan
   * path keeps working unchanged.
   */
  preparedFacts?: Map<DependencyChange, Promise<PreparedRationaleFacts>>;
}

export interface RationaleInput {
  changes: readonly DependencyChange[];
  evidence: readonly Evidence[];
  breakingChanges: readonly BreakingChange[];
  impactSites: readonly ImpactSite[];
}

/**
 * Everything about an upgrade that depends only on the published package —
 * its registry entry, both versions' own metadata, the upstream repository's
 * own activity, the security advisories against this exact version range,
 * and the license verdict — and nothing about any particular workspace that
 * happens to want this same upgrade.
 *
 * This is the half of `rationaleFor`'s work that is genuinely safe to share
 * across every row asking for the same exact `ecosystem/name/from/to`,
 * however many workspaces in a monorepo (or however many repositories in one
 * scan) declare it. The other half — {@link finalizeRationale} — reads a
 * particular repository's runtime declarations, breaking-change impact
 * sites, and API surface diff, so it must run once per row even when these
 * facts are shared.
 */
export interface PreparedRationaleFacts {
  registry: RegistryInfo | null;
  repository: RepositoryStatus | null;
  currentVersion: VersionInfo | null;
  targetVersion: VersionInfo | null;
  security: SecurityAssessment;
  license: LicenseFinding;
}

export interface PrepareRationaleFactsContext {
  config: DriftConfig;
  githubToken?: string;
  osv?: OsvOptions;
  /** See {@link RationaleContext.security}. */
  security?: Promise<Map<DependencyChange, SecurityAssessment>>;
  /**
   * A single already-in-flight security lookup for this exact change,
   * preferred over both {@link security} and a fresh `assessSecurity` call
   * when present. This is the seam `scanUpgrades` uses for scan-wide OSV
   * batching: one `SecurityLookup` per unique exact upgrade, looked up once,
   * shared by every row (and every ecosystem/workspace) asking for that same
   * upgrade.
   */
  securityLookup?: Promise<SecurityAssessment>;
  onProgress?: (phase: string) => void;
}

const RETRY_LABEL = {
  'rate-limited': 'rate limited',
  'server-error': 'server error',
  'network-error': 'network error',
} as const;

/**
 * Stage 3b(i) — the workspace-independent half of a rationale.
 *
 * Registry resolution, both versions' own metadata, and the security lookup
 * are independent of one another and started together rather than one after
 * another — only the repository-status fetch actually depends on anything
 * here (the GitHub repo the registry resolves), so it is the one fetch that
 * has to wait. License depends only on these same package-level facts, so it
 * belongs here too, not in `finalizeRationale`.
 *
 * Safe to call once and share the resulting promise across every workspace
 * row that declares the exact same `ecosystem/name/from/to` upgrade — see
 * {@link PreparedRationaleFacts}.
 */
export async function prepareRationaleFacts(
  change: DependencyChange,
  ctx: PrepareRationaleFactsContext,
): Promise<PreparedRationaleFacts> {
  return diagWithSpan(
    'rationale.prepare',
    { package: change.name, ecosystem: change.ecosystem, from: change.from, to: change.to },
    async () => {
      const { config } = ctx;
      const from = change.from!;
      const to = change.to!;
      const report = (phase: string) => ctx.onProgress?.(phase);

      report('Checking package metadata');
      const registryPromise = fetchRegistryInfo(change.name, change.ecosystem, to);
      const currentVersionPromise = fetchVersionInfo(change.name, change.ecosystem, from).catch(() => null);
      const targetVersionPromise = fetchVersionInfo(change.name, change.ecosystem, to).catch(() => null);
      const securityPromise: Promise<SecurityAssessment> = config.rationale.security
        ? (
            ctx.securityLookup ??
            Promise.resolve(ctx.security)
              .then((batch) => batch?.get(change))
              .then((cached) => cached ?? assessSecurity(change.name, change.ecosystem, from, to, ctx.osv ?? {}))
          ).catch((err: unknown) =>
            // Security is best-effort, like every other fact gathered here —
            // an unexpected rejection from a caller-supplied `securityLookup`
            // (e.g. `scanUpgrades`' scan-wide OSV batch) must degrade to an
            // honest "unknown" verdict rather than sinking the whole
            // `prepareRationaleFacts` call and discarding the registry,
            // version, repository-status, and license facts alongside it.
            unchecked(
              `Advisory lookup failed unexpectedly (${err instanceof Error ? err.message : String(err)}), so this upgrade's effect on known vulnerabilities is unknown.`,
            ),
          )
        : // Switched off, not unreachable. Saying "could not be reached" here sent
          // developers looking for a network problem behind their own setting.
          Promise.resolve(
            unchecked(
              'Advisory lookup is switched off for this repository (`rationale.security`), so this upgrade’s effect on known vulnerabilities was not checked.',
            ),
          );

      const registry = await registryPromise;
      report('Checking repository status');
      const repository = registry?.githubRepo
        ? await fetchRepositoryStatus(registry.githubRepo, ctx.githubToken, (attempt, reason) =>
            report(`Checking repository status (${RETRY_LABEL[reason]}, retrying — attempt ${attempt})`),
          ).catch(() => null)
        : null;

      report('Checking security advisories');
      const [currentVersion, targetVersion, security] = await Promise.all([
        currentVersionPromise,
        targetVersionPromise,
        securityPromise,
      ]);

      report('Checking license');
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

      return { registry, repository, currentVersion, targetVersion, security, license };
    },
  );
}

export async function buildRationale(
  input: RationaleInput,
  ctx: RationaleContext,
): Promise<UpgradeRationale[]> {
  const upgrades = input.changes.filter((change) => change.from && change.to);
  const unprepared = upgrades.filter((change) => !ctx.preparedFacts?.has(change));
  const lookups: SecurityLookup[] = unprepared.map((change) => ({
    name: change.name,
    ecosystem: change.ecosystem,
    from: change.from!,
    to: change.to!,
  }));
  // Started here and handed through unresolved, so it runs alongside each
  // change's own independent registry/version lookups in `rationaleFor`
  // rather than in front of all of them. Awaiting the whole batch here first
  // meant not one dependency's metadata fetch could even start until OSV had
  // already answered for every dependency in this call.
  const securityBatchPromise = ctx.config.rationale.security
    ? assessSecurityBatch(lookups, ctx.osv ?? {}).then(
        (security) => new Map(unprepared.map((change, index) => [change, security.get(lookups[index]!)!])),
      )
    : undefined;

  return mapWithConcurrency(upgrades, 4, async (change) => {
    try {
      return await rationaleFor(change, input, { ...ctx, security: securityBatchPromise });
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
  const report = (phase: string) => ctx.onProgress?.(change, phase);

  const preparedPromise = ctx.preparedFacts?.get(change);
  const facts = await (preparedPromise ??
    prepareRationaleFacts(change, {
      config: ctx.config,
      ...(ctx.githubToken ? { githubToken: ctx.githubToken } : {}),
      ...(ctx.osv ? { osv: ctx.osv } : {}),
      ...(ctx.security ? { security: ctx.security } : {}),
      onProgress: report,
    }));

  return finalizeRationale(change, input, facts, ctx, { shared: preparedPromise !== undefined });
}

/**
 * Stage 3b(ii) — the workspace-sensitive half of a rationale.
 *
 * Everything here reads something that varies per row even when the upgrade
 * itself (`ecosystem/name/from/to`) is identical: which runtime this
 * particular workspace declares, which breaking changes and impact sites its
 * own source tree produced, which API additions its own surface diff found.
 * So unlike {@link prepareRationaleFacts}, this must run once per candidate
 * row — never shared across workspaces, even when they share the exact same
 * upgrade and the exact same {@link PreparedRationaleFacts}.
 */
export async function finalizeRationale(
  change: DependencyChange,
  input: RationaleInput,
  facts: PreparedRationaleFacts,
  ctx: RationaleContext,
  opts?: { shared?: boolean },
): Promise<UpgradeRationale> {
  return diagWithSpan(
    'rationale.finalize',
    {
      package: change.name,
      ecosystem: change.ecosystem,
      from: change.from,
      to: change.to,
      shared: opts?.shared ?? ctx.preparedFacts?.has(change) ?? false,
    },
    async () => {
      const { config, logger } = ctx;
      const from = change.from!;
      const to = change.to!;
      const report = (phase: string) => ctx.onProgress?.(change, phase);
      const { registry, repository, currentVersion, targetVersion, security, license } = facts;

      report('Checking maintenance signals');
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
            repoRuntime:
              (change.workspace !== undefined ? ctx.repoRuntimeByWorkspace?.get(change.workspace) : undefined) ??
              ctx.repoRuntime,
            pythonRuntime:
              (change.workspace !== undefined ? ctx.pythonRuntimeByWorkspace?.get(change.workspace) : undefined) ??
              ctx.pythonRuntime,
          })
        : { facts: [] };

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

      const assessmentInput = {
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
      };
      const assessment = assessUpgrade(assessmentInput);

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
        // Whether Drift actually obtained evidence bearing on *compatibility*
        // (a computed surface diff, or compatibility prose fetched and read) —
        // as opposed to evidence that answers some other question (a clean
        // security check, a fine license, a version that merely exists).
        // Exposed alongside `assessment` so downstream consumers (recording
        // capture, the corpus validator) can check the "safe to upgrade
        // implies real evidence" invariant structurally, without re-parsing
        // `gaps` prose.
        hasCompatibilityEvidence: hasCompatibilityEvidence(assessmentInput),
      };
    },
  );
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
    hasCompatibilityEvidence: false,
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
export {
  checkNodeCompatibility,
  checkPythonCompatibility,
  checkRuntimeCompatibility,
  findNodeDeclarations,
  findPythonDeclarations,
  findRuntimeDeclarations,
} from './runtime.js';
export { assessLicense, isAllowed } from './license.js';
export { summarizeRelease, classify, bulletLines, improvementsFrom, describeAdditions } from './summary.js';
export { assessUpgrade, RECOMMENDATION_LABEL } from './assess.js';
