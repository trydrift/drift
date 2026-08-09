import semver from 'semver';
import type { DependencyChange, Ecosystem, RepoContext } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import type { AnalysisGap, CheckedSurface } from '../confidence/types.js';
import type { SurfaceUnavailable } from '../evidence/surface/types.js';
import { classifyBump } from '../detect/version.js';
import { detectWorkspaces, memberDirectories, nodeWorkspaceFs, type WorkspaceFs } from '../detect/workspace.js';
import { discoverNestedProjects } from '../detect/nested.js';
import { gatherEvidence } from '../evidence/index.js';
import { analyze } from '../analyze/index.js';
import { walkSourceFiles, type SourceFile } from '../index/walk.js';
import { buildIndex, type RepoIndex } from '../index/metarag.js';
import { localize } from '../localize/index.js';
import { stableId } from '../util/id.js';
import { discoverTargets, directDependencies, type EcosystemTarget } from '../upgrade/scan.js';
import { rangeFloor, satisfiesRange } from './range.js';
import { emptyAudit, type AuditResult, type LatentFinding } from './types.js';

export { rangeFloor, satisfiesRange } from './range.js';
export * from './types.js';

/**
 * The audit: what is already broken, as opposed to what would break.
 *
 * Drift's other two questions both point at a version that is not installed.
 * `analyze` asks what a bump that just landed did to this code; `outdated` asks
 * what the newest release would do to it. Both are about a move. Neither ever
 * asks the question a developer actually opens the editor with — *is the code I
 * have correct against the dependency I have?*
 *
 * It usually is not, and the reason is structural. A manifest range is a
 * standing instruction to a resolver: `^4.0.0` says "take anything on 4.x". So
 * the resolver does, on a schedule nobody set, in a lockfile refresh nobody
 * read. The code was written against whatever 4.x looked like the day it was
 * written; the dependency on disk is whatever 4.x looked like the day the lock
 * was last touched. Everything upstream deprecated, removed, or quietly
 * re-specified between those two points is live in this repository right now.
 *
 * So the audit runs the ordinary pipeline over an unordinary window: from the
 * oldest version the range admits, to the version actually installed. Findings
 * are present tense. They are not a reason to upgrade — they are a reason to
 * read the code, and they will not go away by waiting.
 *
 * Nothing here is new machinery. Evidence gathering, breaking-change analysis
 * and localization are the same functions the rest of Drift uses, held to the
 * same standard: a finding still needs a citation, and a site still needs the
 * file to import the dependency. Only the two versions handed in are different.
 */

export interface AuditOptions {
  /** Absolute path to the checkout to audit. */
  root: string;
  repo: RepoContext;
  config: DriftConfig;
  logger: Logger;
  /** Raises public GitHub rate limits. Never required. */
  githubToken?: string;
  env?: NodeJS.ProcessEnv;
  fs?: WorkspaceFs;
  /** Include dev, peer and optional dependencies. Runtime-only by default. */
  includeDev?: boolean;
  /** Cap on impact sites recorded per finding. */
  maxSites?: number;
  /** Cap on dependencies examined. `0` means no cap. */
  maxPackages?: number;
  /** Dependencies checked at once. Defaults to 8, clamped to [1, 16]. */
  concurrency?: number;
  /**
   * Reuse an index the caller already built.
   *
   * The upgrade scan and the audit both need every source file in the
   * repository; walking it twice in one command is pure duplicated I/O on the
   * largest input either of them touches.
   */
  files?: readonly SourceFile[];
  index?: RepoIndex;
  onProgress?: (phase: string, detail: string, done: number, total: number) => void;
  token?: { isCancellationRequested: boolean };
}

export async function auditCurrentUsage(options: AuditOptions): Promise<AuditResult> {
  const { root, repo, config, logger, githubToken } = options;
  const fs = options.fs ?? nodeWorkspaceFs();
  const env = options.env ?? process.env;
  const maxSites = options.maxSites ?? 40;
  const concurrency = Math.max(1, Math.min(16, Math.floor(options.concurrency ?? 8) || 8));
  const report = options.onProgress ?? (() => undefined);

  const declared = await detectWorkspaces(root, fs);
  const declaredMembers = memberDirectories(declared);
  const nested = await discoverNestedProjects(root, fs, declaredMembers).catch(() => []);
  const dirs = [...declaredMembers, ...nested.filter((p) => !p.hasOwnGit).map((p) => p.dir)];

  const { targets } = await discoverTargets(root, dirs, new Map(), fs);
  if (targets.length === 0) return emptyAudit();

  const memberNames = new Map<string, string>();
  for (const layout of declared) {
    for (const member of layout.members) if (member.name) memberNames.set(member.dir, member.name);
  }

  const enabled = new Set(config.ecosystems);
  const multiPackage = new Set(targets.map((t) => t.dir)).size > 1;

  const all: { dep: Awaited<ReturnType<typeof directDependencies>>[number]; target: EcosystemTarget }[] = [];
  for (const target of targets) {
    if (!enabled.has(target.manager.ecosystem)) continue;
    for (const dep of await directDependencies(root, target, options.includeDev ?? false, fs)) {
      all.push({ dep, target });
    }
  }

  const deps = options.maxPackages && options.maxPackages > 0 ? all.slice(0, options.maxPackages) : all;
  if (deps.length === 0) return emptyAudit();

  // Reused when the caller already has one — see `AuditOptions.files`.
  const files = options.files ?? (await walkSourceFiles(root, { members: dirs }));
  const index = options.index ?? buildIndex(files);

  const findings: LatentFinding[] = [];
  const gaps: AnalysisGap[] = [];
  const checkedSurfaces: CheckedSurface[] = [];
  let analysed = 0;
  let done = 0;

  await inParallel(deps, concurrency, async ({ dep, target }) => {
    if (options.token?.isCancellationRequested) return;

    const ecosystem = target.manager.ecosystem;
    const member = multiPackage ? target.dir : undefined;
    const memberName = memberNames.get(target.dir);
    const installed = dep.current;

    // Cheap and unconditional: a lockfile that disagrees with its own manifest
    // is a finding on its own terms, and needs no upstream evidence to state.
    const satisfies = satisfiesRange(installed, dep.range, ecosystem);
    if (satisfies === false) {
      findings.push({
        id: stableId('latent', target.manifestPath, dep.name, dep.range, installed),
        kind: 'range-violation',
        dependency: dep.name,
        ecosystem,
        ...(member === undefined ? {} : { workspace: member }),
        manifestPath: target.manifestPath,
        declaredRange: dep.range,
        rangeFloor: installed,
        installedVersion: installed,
        sites: [],
        summary:
          `${dep.name} resolves to ${installed}, which does not satisfy the declared range ${dep.range}. ` +
          `A clean install elsewhere would not reproduce this tree.`,
      });
    }

    const floor = rangeFloor(dep.range, ecosystem);
    if (!floor) {
      done += 1;
      return;
    }

    // An exact pin, or a lockfile older than its own floor. Either way there is
    // no unreviewed window, which is the answer — not a shortfall.
    if (!semver.valid(floor) || !semver.valid(installed) || !semver.gt(installed, floor)) {
      done += 1;
      return;
    }

    analysed += 1;
    report('Auditing installed versions', `${dep.name} ${floor} → ${installed} (installed)`, done, deps.length);

    const change: DependencyChange = {
      name: dep.name,
      ecosystem,
      from: floor,
      to: installed,
      kind: dep.kind,
      bump: classifyBump(floor, installed),
      manifestPath: target.manifestPath,
      rawFrom: dep.range,
      rawTo: installed,
      ...(member === undefined ? {} : { workspace: member }),
      ...(memberName ? { workspaceName: memberName } : {}),
    };

    try {
      const surfaceGaps = new Map<string, SurfaceUnavailable>();
      const evidence = await gatherEvidence([change], {
        config,
        logger,
        githubToken,
        env,
        workspaceRoot: root,
        onUnavailableSurface: (_change, reason) => surfaceGaps.set(dep.name, reason),
      });

      const breakingChanges = await analyze([change], evidence, { config, logger });
      if (breakingChanges.length === 0) {
        checkedSurfaces.push({
          surface: 'api-surface',
          dependency: dep.name,
          ecosystem,
          status: surfaceGaps.size > 0 ? 'unavailable' : 'checked',
          detail:
            surfaceGaps.size > 0
              ? [...surfaceGaps.values()][0]!.reason
              : `Nothing breaking was found between ${floor} and the installed ${installed}.`,
        });
        done += 1;
        return;
      }

      const sites = localize(breakingChanges, [change], index, files, {
        logger,
        maxSitesPerChange: maxSites,
        member,
      });

      // The whole point of the audit is present-tense breakage, and a finding
      // with no site is not present tense — it is trivia about a version window
      // this repository never touched. `analyze` and `outdated` both have
      // reasons to report an unlocalized breaking change (they are proposing a
      // move, and "we could not find where this bites" is a real caveat about a
      // decision the developer is about to make). Here there is no decision
      // pending, so an unsited finding is pure noise and is dropped.
      const sitesByChange = new Map<string, typeof sites>();
      for (const site of sites) {
        const list = sitesByChange.get(site.breakingChangeId);
        if (list) list.push(site);
        else sitesByChange.set(site.breakingChangeId, [site]);
      }

      for (const breaking of breakingChanges) {
        const hits = sitesByChange.get(breaking.id);
        if (!hits || hits.length === 0) continue;

        findings.push({
          id: stableId('latent', target.manifestPath, dep.name, breaking.id),
          kind: 'unreviewed-drift',
          dependency: dep.name,
          ecosystem,
          ...(member === undefined ? {} : { workspace: member }),
          manifestPath: target.manifestPath,
          declaredRange: dep.range,
          rangeFloor: floor,
          installedVersion: installed,
          breakingChange: breaking,
          sites: hits,
          summary: `${dep.name} ${installed} is installed: ${breaking.summary}`,
        });
      }

      checkedSurfaces.push({
        surface: 'api-surface',
        dependency: dep.name,
        ecosystem,
        status: 'checked',
        detail: `Checked the installed ${installed} against ${floor}, the oldest version ${dep.range} admits.`,
      });
    } catch (err) {
      gaps.push({
        stage: 'evidence',
        surface: 'api-surface',
        reason: `${dep.name}: the installed version could not be audited — ${(err as Error).message}`,
        severity: 'minor',
        automaticExecution: 'none',
        remediation: 'Re-run with network access, or pin the dependency to remove the unreviewed window.',
      });
    } finally {
      done += 1;
    }
  });

  return {
    findings: findings.sort(compareFindings),
    checked: deps.length,
    analysed,
    gaps,
    checkedSurfaces,
  };
}

/**
 * Range violations first — they invalidate the premise of everything else in
 * the run — then by how much code each finding actually touches, then by name
 * so the order is stable across runs on an unchanged repository.
 */
function compareFindings(a: LatentFinding, b: LatentFinding): number {
  if (a.kind !== b.kind) return a.kind === 'range-violation' ? -1 : 1;
  return b.sites.length - a.sites.length || a.dependency.localeCompare(b.dependency) || a.id.localeCompare(b.id);
}

/** One line summarising an audit, for a CLI footer or a status bar. */
export function summarizeAudit(result: AuditResult): string {
  if (result.findings.length === 0) {
    return result.analysed === 0
      ? `No dependency had an unreviewed version window (${result.checked} checked, all pinned or unreadable).`
      : `Nothing in this repository is out of step with its installed dependencies (${result.analysed} of ${result.checked} had a window worth checking).`;
  }

  const files = new Set(result.findings.flatMap((f) => f.sites.map((s) => s.file))).size;
  const packages = new Set(result.findings.map((f) => f.dependency)).size;
  return (
    `${result.findings.length} finding(s) across ${packages} package(s)` +
    (files > 0 ? ` affecting ${files} file(s)` : '') +
    ' — already true of the versions installed today.'
  );
}

/** Run `worker` over `items`, at most `limit` in flight. */
async function inParallel<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export type { Ecosystem };
