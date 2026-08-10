import type { BreakingChange, Ecosystem, RepoContext } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import type { AnalysisGap, CheckedSurface } from '../confidence/types.js';
import { detectWorkspaces, memberDirectories, nodeWorkspaceFs, withinMember, type WorkspaceFs } from '../detect/workspace.js';
import { discoverNestedProjects } from '../detect/nested.js';
import { walkSourceFiles, type SourceFile } from '../index/walk.js';
import { buildIndex, packageNameFromSpecifier, type RepoIndex } from '../index/metarag.js';
import { localize } from '../localize/index.js';
import { resolveModuleMaps } from '../localize/modules.js';
import { stableId } from '../util/id.js';
import { discoverTargets, directDependencies, type EcosystemTarget } from '../upgrade/scan.js';
import { satisfiesRange } from './range.js';
import { readInstalledSurface } from './installed-surface.js';
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
 * was last touched.
 *
 * Earlier versions of this check answered that with a version diff: compute
 * the oldest release the manifest's range admits, fetch its published
 * declarations, and diff them against the installed version the same way
 * `analyze` diffs an upgrade. That worked, but it asked the wrong question — a
 * repository pinned to an exact version, or one whose lockfile happened to sit
 * right at the floor, has no window to diff and got no answer, even though
 * "does my code match what's on disk" is just as true of a pin as of a range.
 *
 * So the check now skips the manifest, and the diff, entirely. It reads the
 * declarations of the package that is *actually installed* — straight out of
 * `node_modules`, never a registry — and asks whether every symbol this
 * repository imports from it is still there. No range, no floor, no second
 * version: one real file on disk, compared against one real import statement.
 * A symbol that is not in that file is not usable, no matter what the
 * manifest says was intended.
 *
 * Localization is still the same machinery the rest of Drift uses — a finding
 * still needs a real import site, found by `localize`, not a synthetic one.
 * Only where the "expected API" comes from is different: not evidence about a
 * change, but the file the runtime will actually resolve.
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

  // Every package's module names, resolved once for the whole audit rather
  // than once per dependency inside the parallel loop below. Six hundred
  // concurrent resolutions of six hundred different gems is the shape of
  // request burst that gets a run rate-limited.
  const moduleMaps = await resolveModuleMaps(
    deps.map(({ dep, target }) => ({
      name: dep.name,
      ecosystem: target.manager.ecosystem,
      from: dep.current,
      to: dep.current,
      kind: dep.kind,
      bump: 'patch' as const,
      manifestPath: target.manifestPath,
    })),
    { logger },
  );

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

    // The static check reads real `.d.ts` text off disk, which only npm
    // packages publish in a form Drift can parse today. Every other ecosystem
    // is stated as a gap rather than silently skipped — the difference between
    // "checked, nothing wrong" and "never looked" matters here as much as it
    // does everywhere else in this file.
    if (ecosystem !== 'npm') {
      checkedSurfaces.push({
        surface: 'api-surface',
        dependency: dep.name,
        ecosystem,
        status: 'unavailable',
        detail: 'A static check against the installed package is only available for npm/TypeScript today.',
      });
      done += 1;
      return;
    }

    report('Checking installed versions', `${dep.name} ${installed} (installed)`, done, deps.length);

    try {
      const usedSymbols = namedSymbolsImported(files, index, dep.name, member);
      if (usedSymbols.size === 0) return;

      const surface = await readInstalledSurface(root, member, dep.name, fs);
      if (surface.status !== 'found') {
        gaps.push({
          stage: 'evidence',
          surface: 'api-surface',
          reason:
            surface.status === 'not-installed'
              ? `${dep.name}: not found in node_modules — run an install before auditing.`
              : `${dep.name}@${installed}: no readable TypeScript declarations on disk; static check skipped.`,
          severity: 'minor',
          automaticExecution: 'none',
          remediation:
            'Install dependencies so node_modules is present, or accept this package cannot be statically checked.',
        });
        return;
      }

      analysed += 1;

      const missing = [...usedSymbols].filter((name) => !surface.api.has(name));
      if (missing.length === 0) {
        checkedSurfaces.push({
          surface: 'api-surface',
          dependency: dep.name,
          ecosystem,
          status: 'checked',
          detail: `Checked ${usedSymbols.size} symbol(s) this repository imports from ${dep.name} against the installed ${installed}; all present.`,
        });
        return;
      }

      const breakingChanges: BreakingChange[] = missing.map((symbol) => ({
        id: stableId('latent', target.manifestPath, dep.name, installed, symbol),
        dependency: dep.name,
        ...(member === undefined ? {} : { workspace: member }),
        kind: 'removed-export',
        summary: `\`${symbol}\` is imported from \`${dep.name}\`, but the installed ${dep.name}@${installed} does not export it.`,
        remediation: `Check what ${dep.name}@${installed} actually exports in place of \`${symbol}\` and update the import.`,
        symbols: [symbol],
        confidence: 'high',
        citations: [`node_modules/${dep.name}/${surface.entryPath}`],
      }));

      const dependencyChange = {
        name: dep.name,
        ecosystem,
        from: installed,
        to: installed,
        kind: dep.kind,
        bump: 'patch' as const,
        manifestPath: target.manifestPath,
        ...(member === undefined ? {} : { workspace: member }),
        ...(memberName ? { workspaceName: memberName } : {}),
      };

      const sites = localize(breakingChanges, [dependencyChange], index, files, {
        logger,
        maxSitesPerChange: maxSites,
        member,
        moduleMaps,
      });

      const sitesByChange = new Map<string, typeof sites>();
      for (const site of sites) {
        const list = sitesByChange.get(site.breakingChangeId);
        if (list) list.push(site);
        else sitesByChange.set(site.breakingChangeId, [site]);
      }

      // Same rule as before: a missing export with no site Drift can point at
      // is trivia, not a finding worth a developer's attention.
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
        detail: `Checked ${usedSymbols.size} symbol(s) this repository imports from ${dep.name} against the installed ${installed}; ${missing.length} missing.`,
      });
    } catch (err) {
      gaps.push({
        stage: 'evidence',
        surface: 'api-surface',
        reason: `${dep.name}: the installed version could not be audited — ${(err as Error).message}`,
        severity: 'minor',
        automaticExecution: 'none',
        remediation: 'Re-run once the failure above is resolved, or pin the dependency to skip it.',
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
      ? `No dependency had anything to statically check (${result.checked} checked; unused, unreadable, or not npm).`
      : `Nothing in this repository is out of step with its installed dependencies (${result.analysed} of ${result.checked} had something worth checking).`;
  }

  const files = new Set(result.findings.flatMap((f) => f.sites.map((s) => s.file))).size;
  const packages = new Set(result.findings.map((f) => f.dependency)).size;
  return (
    `${result.findings.length} finding(s) across ${packages} package(s)` +
    (files > 0 ? ` affecting ${files} file(s)` : '') +
    ' — already true of the versions installed today.'
  );
}

/**
 * The real, exported names this repository's own source binds from a named
 * import of `packageName` — the "expected API" the installed surface is
 * checked against.
 *
 * Deliberately narrow: only `import { a, b as c } from 'pkg'` and
 * `export { a } from 'pkg'` are read, and only the name declared by the
 * package (`a`), never the local alias (`c`). A default or namespace import
 * binds an arbitrary local name that carries no relationship to what the
 * package actually calls its export, so there is nothing safe to check it
 * against — counting it would mean guessing, which is the one failure mode
 * this feature must not have.
 */
function namedSymbolsImported(
  files: readonly SourceFile[],
  index: RepoIndex,
  packageName: string,
  member: string | undefined,
): Set<string> {
  const relevant = new Set(index.importers.get(packageName) ?? []);
  const names = new Set<string>();
  const pattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;

  for (const file of files) {
    if (!relevant.has(file.path)) continue;
    if (member !== undefined && !withinMember(file.path, member)) continue;

    for (const match of file.content.matchAll(pattern)) {
      const [, group, specifier] = match;
      if (!specifier || packageNameFromSpecifier(specifier) !== packageName) continue;

      for (const part of (group ?? '').split(',')) {
        const cleaned = part.replace(/\btype\s+/g, '').trim();
        if (!cleaned) continue;
        const imported = cleaned.split(/\s+as\s+/)[0]!.trim();
        if (imported && imported !== 'default') names.add(imported);
      }
    }
  }

  return names;
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
