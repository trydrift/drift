import type {
  BreakingChange,
  BreakingChangeKind,
  CommitUnit,
  DependencyChange,
  ImpactSite,
  PlanEdge,
  PlanEdgeReason,
  UpgradeCohort,
  VerificationRequirement,
} from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { CodemodResult } from '../codemod/index.js';
import type { CommunityRecipeCandidate } from '../remediation/types.js';
import { stableId, slugify } from '../util/id.js';

/**
 * Commit planning.
 *
 * Drift never produces a single "fix the upgrade" commit. Each unit is one
 * coherent concern, which buys three things that matter more than convenience:
 *
 *   - A reviewer can approve or reject one change without judging the rest.
 *   - `git revert` has a meaningful target when one fix turns out wrong.
 *   - `git bisect` stays useful, instead of landing on a 40-file blob.
 *
 * The ordering below is not cosmetic. Runtime and config changes land first
 * because a later commit's tests cannot pass until the toolchain matches;
 * mechanical renames land before semantic rewrites so the reviewer reads the
 * boring diffs first and spends their attention on the ones that need it.
 */

/**
 * Execution order by change kind. Lower runs first.
 *
 * The three tiers are: make the build possible (0–1), mechanical edits the
 * reviewer can skim (2–3), then judgement calls that deserve real attention
 * (4–6).
 */
const KIND_ORDER: Record<BreakingChangeKind, number> = {
  'runtime-requirement': 0,
  'config-change': 1,
  // Ahead of the individual removals it explains: rewriting the import path is
  // what makes the symbols reachable again, so doing it first can leave the
  // per-symbol commits with nothing to do.
  'moved-export': 1,
  'removed-export': 2,
  'renamed-export': 2,
  'removed-endpoint': 3,
  'changed-endpoint': 3,
  'signature-change': 4,
  'type-change': 4,
  'required-field-added': 5,
  'default-change': 5,
  'behaviour-change': 6,
  unknown: 7,
};

/** Conventional-commit type for each kind of change. */
function commitType(kind: BreakingChangeKind): string {
  switch (kind) {
    case 'runtime-requirement':
    case 'config-change':
      return 'build';
    case 'behaviour-change':
    case 'default-change':
      return 'fix';
    default:
      return 'refactor';
  }
}

export interface PlanCommitsInput {
  breakingChanges: readonly BreakingChange[];
  impactSites: readonly ImpactSite[];
  config: DriftConfig;
  changes?: readonly DependencyChange[];
  /** Deterministic fixes already computed for individual findings, by `BreakingChange.id`. */
  codemods?: ReadonlyMap<string, CodemodResult>;
  /** Community recipe candidates matched for individual findings, by `BreakingChange.id`. */
  recipes?: ReadonlyMap<string, CommunityRecipeCandidate>;
}

export interface PlanCommitGraph {
  commits: CommitUnit[];
  edges: PlanEdge[];
  cohorts: UpgradeCohort[];
  blockers: string[];
}

export function planCommitGraph({
  breakingChanges,
  impactSites,
  config,
  changes = [],
  codemods,
  recipes,
}: PlanCommitsInput): PlanCommitGraph {
  const sitesByChange = groupSites(impactSites);

  // A breaking change with no impact site needs no commit. Reporting it is
  // still valuable — it tells the reviewer Drift looked and found nothing —
  // but asking an agent to "fix" untouched code invites gratuitous edits.
  const actionable = breakingChanges.filter((c) => (sitesByChange.get(c.id)?.length ?? 0) > 0);
  if (actionable.length === 0) return { commits: [], edges: [], cohorts: detectUpgradeCohorts(changes), blockers: [] };

  const groups =
    config.remediation.commitGranularity === 'single'
      ? [actionable]
      : config.remediation.commitGranularity === 'per-dependency'
        ? groupByDependency(actionable)
      : actionable.map((change) => [change]);

  const sorted = [...groups].sort(compareGroups);
  const cohorts = detectUpgradeCohorts(changes);
  const cohortByDependency = new Map<string, UpgradeCohort>();
  for (const cohort of cohorts) {
    for (const dependency of cohort.dependencies) cohortByDependency.set(dependency, cohort);
  }

  const commits = sorted.map((group, index) =>
    toCommitUnit(group, index + 1, sitesByChange, sorted.length, codemods, recipes),
  );
  const edges = deriveEdges(commits, breakingChanges, impactSites, cohortByDependency);
  const layered = assignExecutionLayers(commits, edges);
  const cycle = layered.cycle.length > 0 ? explainCycle(layered.cycle, edges) : undefined;

  return {
    commits: layered.commits,
    edges,
    cohorts,
    blockers: cycle ? [cycle] : [],
  };
}

export function planCommits(input: PlanCommitsInput): CommitUnit[] {
  return planCommitGraph(input).commits;
}

function groupSites(sites: readonly ImpactSite[]): Map<string, ImpactSite[]> {
  const map = new Map<string, ImpactSite[]>();
  for (const site of sites) {
    const bucket = map.get(site.breakingChangeId);
    if (bucket) bucket.push(site);
    else map.set(site.breakingChangeId, [site]);
  }
  return map;
}

function groupByDependency(changes: readonly BreakingChange[]): BreakingChange[][] {
  const map = new Map<string, BreakingChange[]>();
  for (const change of changes) {
    const bucket = map.get(change.dependency);
    if (bucket) bucket.push(change);
    else map.set(change.dependency, [change]);
  }
  return [...map.values()];
}

function compareGroups(a: readonly BreakingChange[], b: readonly BreakingChange[]): number {
  const rankA = Math.min(...a.map((c) => KIND_ORDER[c.kind]));
  const rankB = Math.min(...b.map((c) => KIND_ORDER[c.kind]));
  if (rankA !== rankB) return rankA - rankB;

  const depA = a[0]?.dependency ?? '';
  const depB = b[0]?.dependency ?? '';
  return depA.localeCompare(depB);
}

function toCommitUnit(
  group: readonly BreakingChange[],
  order: number,
  sitesByChange: Map<string, ImpactSite[]>,
  totalCommits: number,
  codemods?: ReadonlyMap<string, CodemodResult>,
  recipes?: ReadonlyMap<string, CommunityRecipeCandidate>,
): CommitUnit {
  const sites = group.flatMap((c) => sitesByChange.get(c.id) ?? []);
  const files = [...new Set(sites.map((s) => s.file))].sort();
  const primary = group[0]!;
  const codemod = codemods ? resolveCodemod(group, sitesByChange, codemods) : undefined;
  // Only worth offering a recipe for a commit the built-in engine could not
  // resolve — `codemod` always wins, mirroring `remediationKindFor`.
  const recipe = !codemod && recipes ? resolveRecipe(group, recipes) : undefined;

  return {
    id: stableId(
      'unit',
      group.map((c) => c.id).sort().join(','),
      files.join(','),
      primary.dependency,
      primary.kind,
    ),
    order,
    message: subjectLine(group, files.length),
    body: commitBody(group, sites, codemod),
    breakingChangeIds: group.map((c) => c.id),
    files,
    allowedFiles: files,
    allowedSymbols: [...new Set(group.flatMap((c) => c.symbols))].sort(),
    instructions: instructionsFor(group, sites, order, totalCommits),
    dependsOn: [],
    dependencyReasons: [],
    executionLayer: 0,
    expectedChecks: expectedChecksFor(group, files),
    invalidationTriggers: invalidationTriggersFor(group, files),
    ...(codemod ? { codemod } : {}),
    ...(recipe ? { recipe } : {}),
  };
}

/**
 * Decide whether every breaking change in a commit group has a matching
 * community recipe, and if so, collect them.
 *
 * Mirrors `resolveCodemod`'s "full coverage or nothing" rule: offering a
 * recipe for only some of a commit's findings would leave a reviewer unsure
 * whether accepting it resolves the whole commit or leaves part of it
 * needing an agent regardless.
 */
function resolveRecipe(
  group: readonly BreakingChange[],
  recipes: ReadonlyMap<string, CommunityRecipeCandidate>,
): CommunityRecipeCandidate[] | undefined {
  const candidates: CommunityRecipeCandidate[] = [];
  for (const change of group) {
    const candidate = recipes.get(change.id);
    if (!candidate) return undefined;
    candidates.push(candidate);
  }
  return candidates.length > 0 ? candidates : undefined;
}

/**
 * Decide whether every breaking change in a commit group was fully resolved
 * by a deterministic codemod, and if so, merge their edits into one list.
 *
 * "Fully resolved" means the codemod touched every impact site the change
 * has, not merely some of them — a partial deterministic fix left mixed with
 * agent-driven edits inside the same commit would blur exactly the boundary
 * commit-scoping exists to keep sharp. Anything short of full coverage falls
 * back to the agent for the whole unit, unchanged from today's behaviour.
 *
 * Two changes in the same group editing the same file also fall back: each
 * codemod ran independently against the original file content, so their
 * `after` versions cannot both be applied without one silently discarding
 * the other's edit.
 */
function resolveCodemod(
  group: readonly BreakingChange[],
  sitesByChange: ReadonlyMap<string, ImpactSite[]>,
  codemods: ReadonlyMap<string, CodemodResult>,
): CommitUnit['codemod'] {
  const claimedFiles = new Set<string>();
  const transforms: NonNullable<CommitUnit['codemod']> = [];

  for (const change of group) {
    const sites = sitesByChange.get(change.id) ?? [];
    const result = codemods.get(change.id);
    if (!result || result.sitesResolved < sites.length) return undefined;

    const files = [...new Set(result.edits.map((edit) => edit.file))];
    if (files.some((file) => claimedFiles.has(file))) return undefined;
    for (const file of files) claimedFiles.add(file);

    transforms.push({ ...result.transform, files });
  }

  return transforms.length > 0 ? transforms : undefined;
}

function deriveEdges(
  commits: readonly CommitUnit[],
  changes: readonly BreakingChange[],
  impactSites: readonly ImpactSite[],
  cohortByDependency: ReadonlyMap<string, UpgradeCohort>,
): PlanEdge[] {
  const edges = new Map<string, PlanEdge>();
  const changeById = new Map(changes.map((change) => [change.id, change]));
  const sitesByFile = new Map<string, ImpactSite[]>();
  for (const site of impactSites) {
    const bucket = sitesByFile.get(site.file);
    if (bucket) bucket.push(site);
    else sitesByFile.set(site.file, [site]);
  }

  const add = (from: CommitUnit, to: CommitUnit, reason: PlanEdgeReason, evidence: string[]) => {
    if (from.id === to.id) return;
    const key = `${from.id}\0${to.id}\0${reason}`;
    if (!edges.has(key)) edges.set(key, { from: from.id, to: to.id, reason, evidence: [...new Set(evidence)].sort() });
  };

  for (let i = 0; i < commits.length; i += 1) {
    const a = commits[i]!;
    const aChanges = changesFor(a, changeById);
    const aDeps = new Set(aChanges.map((change) => change.dependency));
    const aFiles = new Set(a.allowedFiles);

    for (let j = i + 1; j < commits.length; j += 1) {
      const b = commits[j]!;
      const bChanges = changesFor(b, changeById);
      const bDeps = new Set(bChanges.map((change) => change.dependency));
      const overlap = b.allowedFiles.filter((file) => aFiles.has(file));

      if (overlap.length > 0) {
        add(a, b, 'same-file-conflict', overlap);
      }

      if (aChanges.some((change) => change.kind === 'runtime-requirement')) {
        add(a, b, 'runtime-prerequisite', aChanges.map((change) => change.summary));
      }

      if (
        aChanges.some((change) => change.kind === 'config-change') &&
        bChanges.some((change) => aDeps.has(change.dependency))
      ) {
        add(a, b, 'configuration-prerequisite', aChanges.map((change) => change.summary));
      }

      if (aChanges.some((change) => change.kind === 'moved-export') && relatedByImportMigration(aChanges, bChanges)) {
        add(a, b, 'import-prerequisite', aChanges.flatMap((change) => change.symbols));
      }

      if (a.allowedFiles.some(isGeneratedPath) && !b.allowedFiles.every(isGeneratedPath) && shareDependency(aDeps, bDeps)) {
        add(a, b, 'generated-output', a.allowedFiles.filter(isGeneratedPath));
      }

      const sharedCohorts = [...aDeps]
        .map((dependency) => cohortByDependency.get(dependency))
        .filter((cohort): cohort is UpgradeCohort => Boolean(cohort))
        .filter((cohort) => bChanges.some((change) => cohort.dependencies.includes(change.dependency)));
      for (const cohort of sharedCohorts) {
        add(a, b, 'package-cohort', [`${cohort.id}: ${cohort.reason}`]);
      }

      const symbolEvidence = symbolDependencyEvidence(a, b, sitesByFile);
      if (symbolEvidence.length > 0) add(a, b, 'symbol-dependency', symbolEvidence);
    }
  }

  return [...edges.values()].sort(compareEdges);
}

function changesFor(unit: CommitUnit, byId: ReadonlyMap<string, BreakingChange>): BreakingChange[] {
  return unit.breakingChangeIds.map((id) => byId.get(id)).filter((change): change is BreakingChange => Boolean(change));
}

function shareDependency(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const dependency of a) {
    if (b.has(dependency)) return true;
  }
  return false;
}

function relatedByImportMigration(a: readonly BreakingChange[], b: readonly BreakingChange[]): boolean {
  const moved = a.filter((change) => change.kind === 'moved-export');
  if (moved.length === 0) return false;

  for (const change of moved) {
    const symbols = new Set([...change.symbols, ...(change.replacementSymbols ?? [])]);
    if (b.some((other) => other.dependency === change.dependency && other.symbols.some((symbol) => symbols.has(symbol)))) {
      return true;
    }
  }

  return false;
}

function isGeneratedPath(path: string): boolean {
  return /(^|\/)(__generated__|generated|gen)\//i.test(path) || /\.(generated|gen)\./i.test(path);
}

function symbolDependencyEvidence(
  from: CommitUnit,
  to: CommitUnit,
  sitesByFile: ReadonlyMap<string, readonly ImpactSite[]>,
): string[] {
  const fromSymbols = new Set(from.allowedSymbols ?? []);
  if (fromSymbols.size === 0) return [];

  const evidence: string[] = [];
  for (const file of to.allowedFiles) {
    for (const site of sitesByFile.get(file) ?? []) {
      if (site.enclosingSymbol && fromSymbols.has(site.enclosingSymbol)) {
        evidence.push(`${file}:${site.line} is inside ${site.enclosingSymbol}`);
      }
    }
  }
  return evidence;
}

function compareEdges(a: PlanEdge, b: PlanEdge): number {
  return (
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    a.reason.localeCompare(b.reason) ||
    a.evidence.join('\0').localeCompare(b.evidence.join('\0'))
  );
}

function assignExecutionLayers(
  commits: readonly CommitUnit[],
  edges: readonly PlanEdge[],
): { commits: CommitUnit[]; cycle: string[] } {
  const byId = new Map(commits.map((commit) => [commit.id, commit]));
  const incoming = new Map<string, Set<string>>();

  for (const commit of commits) {
    incoming.set(commit.id, new Set());
  }

  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    incoming.get(edge.to)!.add(edge.from);
  }

  const remaining = new Set(commits.map((commit) => commit.id));
  const layers = new Map<string, number>();
  let layer = 0;

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) => [...(incoming.get(id) ?? [])].every((dependency) => !remaining.has(dependency)))
      .map((id) => byId.get(id)!)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

    if (ready.length === 0) return { commits: attachGraph(commits, edges, layers), cycle: [...remaining].sort() };

    for (const commit of ready) {
      layers.set(commit.id, layer);
      remaining.delete(commit.id);
    }
    layer += 1;
  }

  return { commits: attachGraph(commits, edges, layers), cycle: [] };
}

function attachGraph(
  commits: readonly CommitUnit[],
  edges: readonly PlanEdge[],
  layers: ReadonlyMap<string, number>,
): CommitUnit[] {
  const incoming = new Map<string, PlanEdge[]>();
  for (const edge of edges) {
    const bucket = incoming.get(edge.to);
    if (bucket) bucket.push(edge);
    else incoming.set(edge.to, [edge]);
  }

  return commits
    .map((commit) => {
      const dependencyReasons = [...(incoming.get(commit.id) ?? [])].sort(compareEdges);
      return {
        ...commit,
        dependsOn: dependencyReasons.map((edge) => edge.from).sort(),
        dependencyReasons,
        executionLayer: layers.get(commit.id) ?? 0,
      };
    })
    .sort((a, b) => a.executionLayer - b.executionLayer || a.order - b.order || a.id.localeCompare(b.id))
    .map((commit, index) => ({
      ...commit,
      order: index + 1,
    }));
}

function explainCycle(ids: readonly string[], edges: readonly PlanEdge[]): string {
  const details = edges
    .filter((edge) => ids.includes(edge.from) && ids.includes(edge.to))
    .slice(0, 5)
    .map((edge) => `${edge.from} -> ${edge.to} (${edge.reason})`)
    .join('; ');
  return `The remediation graph contains a dependency cycle across ${ids.length} commit unit(s): ${details}. Drift cannot automatically execute this plan until the inseparable work is combined or reviewed manually.`;
}

function expectedChecksFor(
  group: readonly BreakingChange[],
  files: readonly string[],
): VerificationRequirement[] {
  const requirements: VerificationRequirement[] = [];
  if (group.some((change) => change.kind === 'signature-change' || change.kind === 'type-change' || change.kind === 'removed-export' || change.kind === 'renamed-export' || change.kind === 'moved-export')) {
    requirements.push({
      id: stableId('check', 'typecheck', group.map((change) => change.id).sort().join(',')),
      kind: 'typecheck',
      reason: 'API-shape and type-contract migrations should be checked by the repository type checker when available.',
    });
  }
  if (group.some((change) => change.kind === 'behaviour-change' || change.kind === 'default-change')) {
    requirements.push({
      id: stableId('check', 'test', group.map((change) => change.id).sort().join(',')),
      kind: 'test',
      reason: 'Behavioural and default changes need tests because compilation can still succeed with wrong behaviour.',
    });
  }
  if (files.some((file) => /(^|\/)(package\.json|tsconfig\.json|vite\.config|webpack\.config|rollup\.config)/.test(file))) {
    requirements.push({
      id: stableId('check', 'build', files.join(',')),
      kind: 'build',
      reason: 'Configuration and package-entry changes can alter the build graph.',
    });
  }
  return requirements;
}

function invalidationTriggersFor(group: readonly BreakingChange[], files: readonly string[]): string[] {
  const triggers = [
    ...files.map((file) => `file:${file}`),
    ...group.flatMap((change) => change.symbols.map((symbol) => `symbol:${symbol}`)),
    ...group.map((change) => `dependency:${change.dependency}`),
  ];
  return [...new Set(triggers)].sort();
}

function detectUpgradeCohorts(changes: readonly DependencyChange[]): UpgradeCohort[] {
  const cohorts: UpgradeCohort[] = [];
  const byEcosystem = new Map<string, DependencyChange[]>();

  for (const change of changes) {
    const bucket = byEcosystem.get(change.ecosystem);
    if (bucket) bucket.push(change);
    else byEcosystem.set(change.ecosystem, [change]);
  }

  for (const [ecosystem, entries] of byEcosystem) {
    for (const group of groupFrameworkFamilies(entries)) {
      if (group.length < 2) continue;
      const names = group.map((change) => change.name).sort();
      cohorts.push({
        id: stableId('cohort', ecosystem, names.join(',')),
        ecosystem: group[0]!.ecosystem,
        dependencies: names,
        constraints: group.map((change) => ({
          dependency: change.name,
          ecosystem: change.ecosystem,
          range: change.rawTo ?? change.to ?? '*',
          source: 'workspace-family',
        })),
        candidatePaths: [...new Set(group.map((change) => change.manifestPath))].sort(),
        reason: `These ${ecosystem} packages appear to be part of the same ${familyName(group[0]!.name)} upgrade family and should be reviewed together.`,
      });
    }
  }

  return cohorts.sort((a, b) => a.id.localeCompare(b.id));
}

function groupFrameworkFamilies(entries: readonly DependencyChange[]): DependencyChange[][] {
  const groups = new Map<string, DependencyChange[]>();
  for (const change of entries) {
    const key = familyKey(change.name);
    if (!key) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(change);
    else groups.set(key, [change]);
  }
  return [...groups.values()];
}

function familyKey(name: string): string | null {
  const known = [
    /^(@angular)\//,
    /^(@babel)\//,
    /^(@nestjs)\//,
    /^(@types)\//,
    /^(@vue)\//,
    /^(react)(?:$|-)/,
    /^(next)(?:$|-)/,
    /^(eslint)(?:$|-)/,
    /^(jest)(?:$|-)/,
    /^(webpack)(?:$|-)/,
    /^(vite)(?:$|-)/,
  ];

  for (const pattern of known) {
    const match = pattern.exec(name);
    if (match?.[1]) return match[1];
  }

  if (name.startsWith('@')) {
    const scope = name.split('/')[0];
    return scope && scope !== name ? scope : null;
  }

  return null;
}

function familyName(name: string): string {
  return slugify(familyKey(name) ?? name, 32);
}

function subjectLine(group: readonly BreakingChange[], fileCount: number): string {
  const primary = group[0]!;
  const type = commitType(primary.kind);
  const scope = scopeFor(group);

  if (group.length === 1) {
    return truncateSubject(`${type}(${scope}): ${describeChange(primary)}`);
  }

  return truncateSubject(
    `${type}(${scope}): update ${group.length} usages for the new ${primary.dependency} API`,
  );
}

/** Short, imperative description of a single change, for the subject line. */
function describeChange(change: BreakingChange): string {
  const symbol = change.symbols[0];
  const replacement = change.replacementSymbols?.[0];

  switch (change.kind) {
    case 'removed-export':
      return symbol ? `replace removed \`${symbol}\`` : 'replace removed API';
    case 'renamed-export':
      return symbol && replacement
        ? `migrate \`${symbol}\` to \`${replacement}\``
        : `migrate renamed \`${symbol ?? 'API'}\``;
    case 'moved-export':
      return `import ${symbol ? `\`${symbol}\`` : 'the API'} from its new entry point`;
    case 'signature-change':
      return symbol ? `update \`${symbol}\` call sites for the new signature` : 'update call sites for new signatures';
    case 'type-change':
      return symbol ? `adapt to the new \`${symbol}\` type` : 'adapt to changed types';
    case 'removed-endpoint':
      return symbol ? `migrate calls to removed endpoint \`${symbol}\`` : 'migrate removed endpoint calls';
    case 'changed-endpoint':
      return symbol ? `update requests to \`${symbol}\`` : 'update API requests';
    case 'required-field-added':
      return symbol ? `supply now-required \`${symbol}\`` : 'supply newly-required fields';
    case 'default-change':
      return symbol ? `pin previous default for \`${symbol}\`` : 'account for changed defaults';
    case 'runtime-requirement':
      return change.summary.toLowerCase().startsWith('minimum')
        ? change.summary.charAt(0).toLowerCase() + change.summary.slice(1)
        : 'raise the minimum runtime version';
    case 'config-change':
      // An ESM migration is by far the most common change of this kind, and
      // "update configuration" tells a reviewer nothing about what to expect
      // in the diff. Name it.
      if (/\bESM\b/i.test(change.summary)) return 'migrate to ESM imports';
      if (/commonjs/i.test(change.summary)) return 'replace dropped CommonJS usage';
      return 'update configuration for the new version';
    case 'behaviour-change':
      return symbol ? `handle changed \`${symbol}\` behaviour` : 'handle changed behaviour';
    default:
      return `update usage of \`${change.dependency}\``;
  }
}

function scopeFor(group: readonly BreakingChange[]): string {
  const dependencies = [...new Set(group.map((c) => c.dependency))];
  if (dependencies.length === 1) {
    // Strip the npm scope so `@scope/pkg` reads as `pkg` in the subject line.
    const name = dependencies[0]!;
    return name.startsWith('@') ? name.split('/')[1] ?? name : name.split(':').pop() ?? name;
  }
  return 'deps';
}

function truncateSubject(subject: string): string {
  // 72 characters is the conventional soft limit for a git subject line.
  return subject.length <= 72 ? subject : `${subject.slice(0, 69)}...`;
}

function commitBody(
  group: readonly BreakingChange[],
  sites: readonly ImpactSite[],
  codemod?: CommitUnit['codemod'],
): string {
  const lines: string[] = [];

  for (const change of group) {
    lines.push(change.summary);
    lines.push('');
    lines.push(change.remediation);
    lines.push('');
  }

  const files = [...new Set(sites.map((s) => s.file))];
  lines.push(`Affects ${sites.length} location(s) across ${files.length} file(s).`);
  lines.push('');

  if (codemod) {
    const fileCount = new Set(codemod.flatMap((t) => t.files)).size;
    lines.push(
      `Resolved deterministically by Drift's codemod engine across ${fileCount} file(s) — no model call was made for this commit.`,
    );
  } else {
    lines.push(
      'Identified by Drift from upstream evidence; see the pull request',
    );
    lines.push('description for the citations behind this change.');
  }

  return lines.join('\n').trim();
}

/**
 * The instructions handed to the coding agent for one commit.
 *
 * Written imperatively and scoped tightly to this commit's files. The scoping
 * is what makes separation of concerns real rather than aspirational: without
 * it the agent tends to fix everything it notices in one pass, and the commit
 * boundaries collapse.
 */
function instructionsFor(
  group: readonly BreakingChange[],
  sites: readonly ImpactSite[],
  order: number,
  totalCommits: number,
): string {
  const lines: string[] = [];

  lines.push(`## Commit ${order} of ${totalCommits}`);
  lines.push('');

  for (const change of group) {
    lines.push(`### ${change.summary}`);
    lines.push('');
    lines.push(`- Dependency: \`${change.dependency}\``);
    lines.push(`- Change type: ${change.kind}`);
    lines.push(`- Confidence: ${change.confidence}`);
    lines.push('');
    lines.push(change.remediation);
    lines.push('');

    const changeSites = sites.filter((s) => s.breakingChangeId === change.id);
    if (changeSites.length > 0) {
      lines.push('Known locations (verify each; there may be others):');
      lines.push('');
      for (const site of changeSites.slice(0, 40)) {
        const where = site.enclosingSymbol ? ` in \`${site.enclosingSymbol}\`` : '';
        lines.push(`- \`${site.file}:${site.line}\`${where} — \`${site.excerpt}\``);
      }
      if (changeSites.length > 40) {
        lines.push(`- …and ${changeSites.length - 40} more matches of the same symbols`);
      }
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

export { KIND_ORDER };
