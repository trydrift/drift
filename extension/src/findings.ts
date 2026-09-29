import type { RemediationPlan } from '../../src/types.js';
import type { FindingGroup } from './session.js';

/**
 * Split a `/recent` plan into one group per dependency that has something to
 * say, each carrying only its own breaks, evidence and sites.
 *
 * A plan covers every dependency a commit moved; the panel shows the same
 * per-package detail the scan does, so it needs the plan cut the same way a
 * scan candidate's is. Dependencies with no breaking changes are left out —
 * there is nothing under them to show.
 */
export function findingGroupsOf(plan: RemediationPlan, idPrefix: string): FindingGroup[] {
  const groups: FindingGroup[] = [];
  const belongs = (entry: { dependency: string; workspace?: string }, name: string, workspace?: string) =>
    entry.dependency === name && (entry.workspace ?? '') === (workspace ?? '');

  for (const change of plan.changes) {
    const breakingChanges = plan.breakingChanges.filter((b) => belongs(b, change.name, change.workspace));
    if (breakingChanges.length === 0) continue;
    const ids = new Set(breakingChanges.map((b) => b.id));
    const cited = new Set(breakingChanges.flatMap((b) => b.citations));

    groups.push({
      id: `${idPrefix}:${change.workspace ?? ''}:${change.name}`,
      name: change.name,
      ecosystem: change.ecosystem,
      from: change.from ?? '',
      to: change.to ?? '',
      ...(change.workspace ? { workspace: change.workspace } : {}),
      plan: {
        ...plan,
        changes: [change],
        breakingChanges,
        impactSites: plan.impactSites.filter((site) => ids.has(site.breakingChangeId)),
        evidence: plan.evidence.filter(
          (entry) => cited.has(entry.id) || belongs(entry, change.name, change.workspace),
        ),
        ...(plan.dispositions
          ? { dispositions: plan.dispositions.filter((d) => ids.has(d.changeId)) }
          : {}),
      },
    });
  }

  // Affected dependencies first — they are what the developer came to find.
  return groups.sort((a, b) => b.plan.impactSites.length - a.plan.impactSites.length);
}
