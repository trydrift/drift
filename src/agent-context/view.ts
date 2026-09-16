import { AGENT_BRIEF_BUDGET, byteLength, capLine, estimateTokens, maxBytes, type ContextBudget } from './budget.js';
import { AgentBudgetExceededError, fillWhole, requireCoreFits } from './fit.js';
import type { AgentBrief, AgentFinding } from './types.js';
import { matchGlob } from '../util/glob.js';

/**
 * The brief as a flat, hard-bounded JSON object, for a client that wants fields.
 *
 * Built in a fixed priority order, each section a prefix of whole items with
 * an exact "not shown" count, and never serialized larger than the ceiling:
 *
 *   1. core: schema, plan id, verdict, verification, counts, and the omission
 *      accounting — what the brief leaves out, by reason and kind. If the core
 *      does not fit, this throws (`AgentBudgetExceededError`); it never
 *      returns an oversized object.
 *   2. dependencies
 *   3. safety: the protected-path globs that match, protected files, blockers
 *   4. findings, in the brief's priority order (site lists capped per finding,
 *      with the exact total; a site list identical to an earlier finding's is
 *      sent once, as `sitesAs` — findings are placed as a prefix, so the
 *      earlier finding is always present)
 *   5. checks
 *   6. gaps (surfaces capped per group, with the exact total)
 *   7. execution units
 *   8. upstream notes
 *   9. the ids of findings that did not fit, as many as fit
 *
 * Safety comes before findings on purpose: an agent told where to edit but
 * not what it must not edit is the worse failure.
 *
 * One client behaviour shapes how this is served: Claude Code (2.1.x) passes a
 * tool's `structuredContent` to the model *instead of* its text content when
 * both are present. A tool serves this object or the prose brief, never both.
 */

export interface AgentBriefView {
  schemaVersion: string;
  planId: string;
  verdict: string;
  verification: string;
  counts: { upstreamBreakingChanges: number; locallyRelevant: number };
  omitted: { noLocatedUsage: number; notSearched: number; unaffected: number; byKind: Record<string, number>; evidenceRecords: number };
  dependencies: string[];
  dependenciesNotShown: number;
  constraints: {
    protectedPaths: string[];
    protectedFiles: string[];
    protectedFilesNotShown: number;
    blockers: string[];
    blockersNotShown: number;
  };
  findings: AgentBriefFindingView[];
  findingsNotShown: number;
  checks: { label: string; status: string }[];
  checksNotShown: number;
  gaps: { severity: string; stage: string; surfaces: string[]; surfaceCount: number; dependencies?: string[]; remediation: string }[];
  gapsNotShown: number;
  units: { id: string; layer: number; goal: string; findings: string[]; files: string[]; after?: string[]; agentWork: string }[];
  unitsNotShown: number;
  notes: string[];
  notesNotShown: number;
  /** Ids of findings not shown, in priority order, as many as fit. */
  findingIdsNotShown: string[];
}

export interface AgentBriefFindingView {
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
}

/** Sites listed per finding in the structured brief; `siteCount` is always the full total. */
const SITES_PER_FINDING = 24;
/** Surfaces listed per gap group; `surfaceCount` is always the full total. */
const SURFACES_PER_GAP = 10;

export function agentBriefView(
  brief: AgentBrief,
  options: { budget?: ContextBudget } = {},
): { view: AgentBriefView; bytes: number; estimatedTokens: number } {
  const limit = maxBytes(options.budget ?? AGENT_BRIEF_BUDGET);

  const view: AgentBriefView = {
    schemaVersion: brief.schemaVersion,
    planId: brief.planId,
    verdict: brief.verdict,
    verification: brief.verification.status,
    counts: { ...brief.counts },
    omitted: {
      noLocatedUsage: brief.omitted.noLocatedUsage,
      notSearched: brief.omitted.notSearched,
      unaffected: brief.omitted.unaffected,
      byKind: brief.omitted.byKind,
      evidenceRecords: brief.omitted.evidenceRecords,
    },
    dependencies: [],
    dependenciesNotShown: brief.dependencies.length,
    constraints: {
      protectedPaths: brief.constraints.protectedPaths.filter((glob) => brief.constraints.protectedFiles.some((file) => matchGlob(glob, file))),
      protectedFiles: [],
      protectedFilesNotShown: brief.constraints.protectedFiles.length,
      blockers: [],
      blockersNotShown: brief.constraints.blockers.length,
    },
    findings: [],
    findingsNotShown: brief.findings.length,
    checks: [],
    checksNotShown: brief.checks.length,
    gaps: [],
    gapsNotShown: brief.gaps.length,
    units: [],
    unitsNotShown: brief.units.length,
    notes: [],
    notesNotShown: brief.notes.length,
    findingIdsNotShown: [],
  };
  // 1. The irreducible core.
  requireCoreFits('agent brief', view, limit);

  // 2. Dependencies.
  const dependencies = brief.dependencies.map((d) => `${d.name} ${d.from ?? '—'} → ${d.to ?? '—'}`);
  fillWhole(view, view.dependencies, dependencies, limit, (n) => (view.dependenciesNotShown = dependencies.length - n));

  // 3. Safety.
  const c = brief.constraints;
  fillWhole(view, view.constraints.protectedFiles, c.protectedFiles, limit, (n) => (view.constraints.protectedFilesNotShown = c.protectedFiles.length - n));
  fillWhole(view, view.constraints.blockers, c.blockers, limit, (n) => (view.constraints.blockersNotShown = c.blockers.length - n));

  // 4. Findings.
  const findings = findingViews(brief.findings);
  const placed = fillWhole(view, view.findings, findings, limit, (n) => (view.findingsNotShown = findings.length - n));

  // 5–8. Checks, gaps, units, notes.
  const checks = brief.checks.map((check) => ({ label: check.label, status: check.status }));
  fillWhole(view, view.checks, checks, limit, (n) => (view.checksNotShown = checks.length - n));

  const gaps = brief.gaps.map((g) => ({
    severity: g.severity,
    stage: g.stage,
    surfaces: g.surfaces.slice(0, SURFACES_PER_GAP),
    surfaceCount: g.surfaces.length,
    ...(g.dependencies.length ? { dependencies: g.dependencies } : {}),
    remediation: g.remediation,
  }));
  fillWhole(view, view.gaps, gaps, limit, (n) => (view.gapsNotShown = gaps.length - n));

  const units = brief.units.map((u) => ({
    id: u.id,
    layer: u.layer,
    goal: u.goal,
    findings: u.findingIds,
    files: u.files,
    ...(u.dependsOn.length ? { after: u.dependsOn } : {}),
    agentWork: u.agentWork,
  }));
  fillWhole(view, view.units, units, limit, (n) => (view.unitsNotShown = units.length - n));

  const notes = brief.notes.map((n) => `${n.id} ${capLine(n.title, 100)}`);
  fillWhole(view, view.notes, notes, limit, (n) => (view.notesNotShown = notes.length - n));

  // 9. Which findings were left out.
  fillWhole(view, view.findingIdsNotShown, findings.slice(placed).map((f) => f.id), limit);

  const json = JSON.stringify(view);
  const bytes = byteLength(json);
  // Unreachable by construction; the contract is enforced, not assumed.
  if (bytes > limit) throw new AgentBudgetExceededError('agent brief', bytes, limit);
  return { view, bytes, estimatedTokens: estimateTokens(json) };
}

function findingViews(findings: readonly AgentFinding[]): AgentBriefFindingView[] {
  const firstWithSites = new Map<string, string>();
  return findings.map((finding) => {
    const key = finding.sites.map((site) => `${site.file}:${site.line}`).join(',');
    const earlier = key ? firstWithSites.get(key) : undefined;
    if (key && !earlier) firstWithSites.set(key, finding.id);
    return {
      id: finding.id,
      state: finding.state,
      dependency: finding.dependency,
      kind: finding.kind,
      confidence: finding.confidence,
      summary: finding.summary,
      change: finding.change,
      ...(earlier
        ? { sitesAs: earlier }
        : {
            sites: finding.sites
              .slice(0, SITES_PER_FINDING)
              .map((site) => (site.message ? `${site.file}:${site.line} ${capLine(site.message, 160)}` : `${site.file}:${site.line}`)),
          }),
      siteCount: finding.sites.length,
      ...(finding.unitIds.length ? { units: finding.unitIds } : {}),
      ...(finding.evidenceIds.length ? { evidence: finding.evidenceIds } : {}),
    };
  });
}
