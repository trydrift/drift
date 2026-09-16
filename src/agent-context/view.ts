import { AGENT_BRIEF_BUDGET, byteLength, estimateTokens, maxBytes, type ContextBudget } from './budget.js';
import type { AgentBrief, AgentFinding } from './types.js';

/**
 * The brief as a flat, bounded JSON object, for a client that wants fields.
 *
 * Same selection rules and ceiling as the text renderer, but JSON is less
 * dense than prose, so under the same ceiling it can hold fewer findings; any
 * it leaves out are named in `omittedForBudget`, never dropped silently.
 * Protected files are stated once, in `constraints`. The shape is
 * deliberately shallow — site references are `file:line` strings, not objects —
 * because a nested object per site costs several times the bytes and a model
 * reads the string form just as well.
 *
 * One client behaviour shapes how this is served: Claude Code (2.1.x) passes a
 * tool's `structuredContent` to the model *instead of* its text content when
 * both are present. So a tool must not attach this alongside the text brief
 * expecting it to be supplementary — the model would get only the JSON. The
 * MCP server returns one or the other, by request.
 */

export interface AgentBriefView {
  schemaVersion: string;
  planId: string;
  dependencies: string[];
  verdict: string;
  verification: string;
  findings: {
    id: string;
    state: string;
    dependency: string;
    kind: string;
    confidence: string;
    summary: string;
    change: string;
    sites?: string[];
    /** Same site list as this earlier finding; sent once. */
    sitesAs?: string;
    siteCount: number;
    units?: string[];
    evidence?: string[];
  }[];
  omittedForBudget: string[];
  units: { id: string; layer: number; goal: string; findings: string[]; files: string[]; after?: string[]; agentWork: string }[];
  checks: { label: string; status: string }[];
  constraints: { protectedFiles: string[]; blockers: string[] };
  gaps: { severity: string; stage: string; surfaces: string[]; dependencies?: string[]; remediation: string }[];
  omitted: { noLocatedUsage: number; notSearched: number; unaffected: number; byKind: Record<string, number>; evidenceRecords: number };
  notes: string[];
}

const SITES_PER_FINDING = 24;

export function agentBriefView(
  brief: AgentBrief,
  options: { budget?: ContextBudget } = {},
): { view: AgentBriefView; bytes: number; estimatedTokens: number } {
  const ceiling = maxBytes(options.budget ?? AGENT_BRIEF_BUDGET);
  // Findings sharing an exact site list (three packages raising the same Node
  // floor on the same workflow lines) carry it once.
  const firstWithSites = new Map<string, string>();
  const findings = brief.findings.map((finding) => {
    const view = findingView(finding);
    const key = finding.sites.map((site) => `${site.file}:${site.line}`).join(',');
    const earlier = key ? firstWithSites.get(key) : undefined;
    if (earlier) {
      delete view.sites;
      view.sitesAs = earlier;
    } else if (key) {
      firstWithSites.set(key, finding.id);
    }
    return view;
  });

  const build = (count: number, withUnits: boolean): AgentBriefView => ({
    schemaVersion: brief.schemaVersion,
    planId: brief.planId,
    dependencies: brief.dependencies.map((d) => `${d.name} ${d.from ?? '—'} → ${d.to ?? '—'}`),
    verdict: brief.verdict,
    verification: brief.verification.status,
    findings: findings.slice(0, count),
    omittedForBudget: brief.findings.slice(count).map((f) => f.id),
    units: withUnits
      ? brief.units.map((u) => ({
          id: u.id,
          layer: u.layer,
          goal: u.goal,
          findings: u.findingIds,
          files: u.files,
          ...(u.dependsOn.length ? { after: u.dependsOn } : {}),
          agentWork: u.agentWork,
        }))
      : [],
    checks: brief.checks.map((c) => ({ label: c.label, status: c.status })),
    constraints: { protectedFiles: brief.constraints.protectedFiles, blockers: brief.constraints.blockers },
    gaps: brief.gaps.map((g) => ({
      severity: g.severity,
      stage: g.stage,
      surfaces: g.surfaces,
      ...(g.dependencies.length ? { dependencies: g.dependencies } : {}),
      remediation: g.remediation,
    })),
    omitted: {
      noLocatedUsage: brief.omitted.noLocatedUsage,
      notSearched: brief.omitted.notSearched,
      unaffected: brief.omitted.unaffected,
      byKind: brief.omitted.byKind,
      evidenceRecords: brief.omitted.evidenceRecords,
    },
    notes: brief.notes.map((n) => `${n.id} ${n.title}`),
  });

  // Units go first when space is short; findings go whole, from the end.
  let withUnits = true;
  let count = findings.length;
  let view = build(count, withUnits);
  while (byteLength(JSON.stringify(view)) > ceiling && (withUnits || count > 0)) {
    if (withUnits && brief.units.length > 0) withUnits = false;
    else count -= 1;
    view = build(Math.max(0, count), withUnits);
  }
  const json = JSON.stringify(view);
  return { view, bytes: byteLength(json), estimatedTokens: estimateTokens(json) };
}

function findingView(finding: AgentFinding): AgentBriefView['findings'][number] {
  const refs = finding.sites.map((site) => (site.message ? `${site.file}:${site.line} ${site.message}` : `${site.file}:${site.line}`));
  return {
    id: finding.id,
    state: finding.state,
    dependency: finding.dependency,
    kind: finding.kind,
    confidence: finding.confidence,
    summary: finding.summary,
    change: finding.change,
    sites: refs.slice(0, SITES_PER_FINDING),
    siteCount: finding.sites.length,
    ...(finding.unitIds.length ? { units: finding.unitIds } : {}),
    ...(finding.evidenceIds.length ? { evidence: finding.evidenceIds } : {}),
  };
}
