import type { BreakingChange, BreakingChangeKind, CommitUnit, ImpactSite } from '../types.js';
import type { DriftConfig } from '../config/schema.js';

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
}

export function planCommits({
  breakingChanges,
  impactSites,
  config,
}: PlanCommitsInput): CommitUnit[] {
  const sitesByChange = groupSites(impactSites);

  // A breaking change with no impact site needs no commit. Reporting it is
  // still valuable — it tells the reviewer Drift looked and found nothing —
  // but asking an agent to "fix" untouched code invites gratuitous edits.
  const actionable = breakingChanges.filter((c) => (sitesByChange.get(c.id)?.length ?? 0) > 0);
  if (actionable.length === 0) return [];

  const groups =
    config.remediation.commitGranularity === 'single'
      ? [actionable]
      : config.remediation.commitGranularity === 'per-dependency'
        ? groupByDependency(actionable)
        : actionable.map((change) => [change]);

  const sorted = [...groups].sort(compareGroups);

  return sorted.map((group, index) => toCommitUnit(group, index + 1, sitesByChange, sorted.length));
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
): CommitUnit {
  const sites = group.flatMap((c) => sitesByChange.get(c.id) ?? []);
  const files = [...new Set(sites.map((s) => s.file))].sort();
  const primary = group[0]!;

  return {
    order,
    message: subjectLine(group, files.length),
    body: commitBody(group, sites),
    breakingChangeIds: group.map((c) => c.id),
    files,
    instructions: instructionsFor(group, sites, order, totalCommits),
    // Every commit depends on the one before it: they land sequentially on a
    // single branch, and a later fix is frequently only verifiable once the
    // earlier one compiles.
    dependsOn: order > 1 ? [order - 1] : [],
  };
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

function commitBody(group: readonly BreakingChange[], sites: readonly ImpactSite[]): string {
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
  lines.push('Identified by Drift from upstream evidence; see the pull request');
  lines.push('description for the citations behind this change.');

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
