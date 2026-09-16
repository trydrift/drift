import type {
  BreakingChange,
  BreakingChangeDisposition,
  CommitUnit,
  ImpactSite,
  RemediationPlan,
} from '../types.js';
import type { AnalysisGap } from '../confidence/types.js';
import { DEFAULT_CONFIG, type DriftConfig } from '../config/schema.js';
import { resolvePlanVerdict } from '../report/confidence.js';
import { matchesAny } from '../util/glob.js';
import {
  AGENT_BRIEF_SCHEMA_VERSION,
  type AgentBrief,
  type AgentCheck,
  type AgentExecutionUnit,
  type AgentFinding,
  type AgentFindingState,
  type AgentGap,
  type AgentOmitted,
  type AgentSite,
} from './types.js';

/**
 * Build the agent brief from a production {@link RemediationPlan}.
 *
 * Pure and deterministic: the same plan and options always produce the same
 * brief, field for field, in the same order. It reads the plan's decisions and
 * never makes new ones — dispositions, confidence, blockers and gaps all come
 * from the stages that own them.
 *
 * Inclusion, per upstream breaking change:
 *
 *   actionable     included  (a high-confidence located site, or a runtime
 *                              requirement this repository was shown to violate)
 *   review-only    included  (located, but not confidently enough to act on)
 *   in a commit    included  (whatever its disposition — a unit never names a
 *                              finding the agent cannot see)
 *   unknown        counted   (no located usage, or not searched)
 *   unaffected     counted
 *
 * Measured regressions — sites the project's own checks reported after the
 * upgrade — are always included, first: they are observations, not predictions.
 */

export interface AgentBriefOptions {
  /** Supplies the guardrails (protected paths). Defaults to Drift's defaults. */
  config?: Pick<DriftConfig, 'guardrails'>;
  /**
   * Checks this repository offers, detected by the caller (for instance with
   * `availableChecks`). Listed as `available` when the plan measured nothing.
   * The builder never touches the filesystem itself.
   */
  availableChecks?: readonly { label: string; kind: string }[];
}

const MEASURED_PREFIX = 'measured:';

export function buildAgentBrief(plan: RemediationPlan, options: AgentBriefOptions = {}): AgentBrief {
  const protectedPaths = [...(options.config?.guardrails.protectedPaths ?? DEFAULT_CONFIG.guardrails.protectedPaths)];
  const isProtected = (file: string) => matchesAny(protectedPaths, file);

  const dispositions = new Map((plan.dispositions ?? []).map((d) => [d.changeId, d]));
  const sitesByChange = groupSites(plan.impactSites);
  const unitsByChange = new Map<string, string[]>();
  for (const commit of [...plan.commits].sort(byOrder)) {
    for (const id of commit.breakingChangeIds) {
      const list = unitsByChange.get(id) ?? [];
      if (!list.includes(commit.id)) list.push(commit.id);
      unitsByChange.set(id, list);
    }
  }

  const omitted: AgentOmitted = {
    noLocatedUsage: 0,
    notSearched: 0,
    unaffected: 0,
    byKind: {},
    evidenceRecords: plan.evidence.length,
    warnings: plan.warnings.length,
  };

  const analysisFindings: { finding: AgentFinding; rank: number }[] = [];
  for (const change of plan.breakingChanges) {
    const disposition = dispositions.get(change.id);
    const unitIds = unitsByChange.get(change.id) ?? [];
    const sites = disposition?.sites ?? sitesByChange.get(change.id) ?? [];
    const state = inclusionState(disposition, sites, unitIds);

    if (!state) {
      countOmission(omitted, change, disposition);
      continue;
    }

    const finding = analysisFinding(change, disposition, state, sites, unitIds, isProtected);
    const firstUnit = plan.commits.find((c) => c.id === unitIds[0]);
    analysisFindings.push({ finding, rank: tierOf(finding) * 1_000_000 + (firstUnit?.order ?? 999_999) });
  }

  analysisFindings.sort((a, b) => a.rank - b.rank || compare(a.finding.id, b.finding.id));

  const measured = measuredFindings(plan, sitesByChange, isProtected);
  const findings = [...measured, ...analysisFindings.map((entry) => entry.finding)];

  const units = [...plan.commits].sort(byOrder).map((commit) => executionUnit(commit, isProtected));
  const gaps = groupGaps(plan.gaps);

  const protectedFiles = unique(findings.flatMap((f) => f.protectedFiles).concat(units.flatMap((u) => u.protectedFiles)));

  return {
    schemaVersion: AGENT_BRIEF_SCHEMA_VERSION,
    planId: plan.id,
    dependencies: plan.changes.map((change) => ({
      name: change.name,
      ecosystem: change.ecosystem,
      from: change.from,
      to: change.to,
      kind: change.kind,
      manifestPath: change.manifestPath,
    })),
    verdict: resolvePlanVerdict(plan),
    verification: plan.verification
      ? {
          status: plan.verification.status,
          ...(plan.verification.reason ? { reason: plan.verification.reason } : {}),
        }
      : { status: 'not-run' },
    counts: {
      upstreamBreakingChanges: plan.upstreamBreakingCount ?? plan.breakingChanges.length,
      locallyRelevant: findings.length,
    },
    findings,
    units,
    checks: collectChecks(plan, options.availableChecks ?? []),
    constraints: {
      protectedPaths,
      protectedFiles,
      blockers: plan.blockers.filter((blocker) => !plan.gaps.some((gap) => blocker.startsWith(gap.reason))),
    },
    gaps,
    omitted,
    notes: proseNotes(plan),
  };
}

const NOTE_SOURCES: Record<string, number> = { 'migration-guide': 0, changelog: 1, 'github-release': 2 };
const MAX_NOTES = 6;
/** Below this, a "release note" is a heading and a link, not something worth fetching. */
const MIN_NOTE_BYTES = 200;

function proseNotes(plan: RemediationPlan): AgentBrief['notes'] {
  return plan.evidence
    .filter((record) => record.source in NOTE_SOURCES && record.content.length >= MIN_NOTE_BYTES)
    .sort(
      (a, b) =>
        NOTE_SOURCES[a.source]! - NOTE_SOURCES[b.source]! ||
        b.content.length - a.content.length ||
        compare(a.id, b.id),
    )
    .slice(0, MAX_NOTES)
    .map((record) => ({ id: record.id, dependency: record.dependency, source: record.source, title: record.title }));
}

function inclusionState(
  disposition: BreakingChangeDisposition | undefined,
  sites: readonly ImpactSite[],
  unitIds: readonly string[],
): AgentFindingState | null {
  if (disposition?.state === 'actionable') return 'actionable';
  if (disposition?.state === 'review-only') return 'review-only';
  if (unitIds.length > 0) return 'planned';
  // A plan written before dispositions existed: a located site is still a
  // place in this repository, and it is not the brief's job to rule it out.
  if (!disposition && sites.length > 0) return 'review-only';
  return null;
}

/**
 * Priority tiers for analysis findings, lowest first.
 *
 * Work an agent can actually do comes first. A finding whose every site is a
 * protected path is still stated — the agent must not break the constraint
 * silently — but it is not what the agent's edits are for, and a budget should
 * never drop a finding in editable code to make room for one. Within a tier,
 * the plan's own unit order decides, then the id, so the order never depends
 * on how the plan happened to list its changes.
 */
function tierOf(finding: AgentFinding): number {
  const editable = finding.files.length === 0 || finding.files.length > finding.protectedFiles.length;
  if (finding.state === 'review-only') return editable ? 3 : 4;
  return editable ? 1 : 2;
}

function countOmission(
  omitted: AgentOmitted,
  change: BreakingChange,
  disposition: BreakingChangeDisposition | undefined,
): void {
  if (disposition?.state === 'unaffected') omitted.unaffected += 1;
  else if (disposition?.reason === 'impact-unresolved') omitted.noLocatedUsage += 1;
  else omitted.notSearched += 1;
  omitted.byKind[change.kind] = (omitted.byKind[change.kind] ?? 0) + 1;
}

function analysisFinding(
  change: BreakingChange,
  disposition: BreakingChangeDisposition | undefined,
  state: AgentFindingState,
  sites: readonly ImpactSite[],
  unitIds: string[],
  isProtected: (file: string) => boolean,
): AgentFinding {
  const agentSites = sortSites(
    dedupeSites(sites).map((site): AgentSite => ({
      file: site.file,
      line: site.line,
      ...(site.matchedSymbol ? { symbol: site.matchedSymbol } : {}),
    })),
  );
  const files = unique(agentSites.map((site) => site.file));
  return {
    id: change.id,
    source: 'analysis',
    state,
    ...(disposition ? { reason: disposition.reason } : {}),
    dependency: change.dependency,
    kind: change.kind,
    confidence: change.confidence,
    summary: change.summary,
    change: change.remediation,
    sites: agentSites,
    files,
    protectedFiles: files.filter(isProtected),
    unitIds,
    evidenceIds: [...change.citations],
  };
}

/**
 * One finding per measured regression key (`measured:npm winston`).
 *
 * The plan records these as impact sites with a synthetic change id and no
 * {@link BreakingChange}; `confirmedRegressions` names the dependency. The
 * compiler message is kept on each site — for these lines it is the best
 * description Drift has.
 */
function measuredFindings(
  plan: RemediationPlan,
  sitesByChange: ReadonlyMap<string, ImpactSite[]>,
  isProtected: (file: string) => boolean,
): AgentFinding[] {
  const ids = [...sitesByChange.keys()].filter((id) => id.startsWith(MEASURED_PREFIX)).sort(compare);
  const failing = (plan.verification?.checks ?? []).filter((check) => check.status === 'failed').map((check) => check.label);

  return ids.map((id) => {
    const key = id.slice(MEASURED_PREFIX.length);
    const change = plan.changes.find((c) => `${c.ecosystem} ${c.name}` === key);
    const dependency = change?.name ?? key.replace(/^\S+\s+/, '');
    const sites = sortSites(
      dedupeSites(sitesByChange.get(id) ?? []).map((site): AgentSite => ({
        file: site.file,
        line: site.line,
        ...(site.matchedSymbol && site.matchedSymbol !== dependency ? { symbol: site.matchedSymbol } : {}),
        ...(site.excerpt ? { message: site.excerpt } : {}),
      })),
    );
    const files = unique(sites.map((site) => site.file));
    const versions = change ? ` ${change.from ?? '—'} → ${change.to ?? '—'}` : '';
    return {
      id,
      source: 'verification',
      state: 'measured',
      dependency,
      kind: 'verification-regression',
      confidence: 'high',
      summary: `${failing.length > 0 ? failing.join(', ') : "The project's checks"} passed before ${dependency}${versions} and fail after it, at these locations.`,
      change: 'Fix these errors against the new version. They were measured by running the checks, not predicted.',
      sites,
      files,
      protectedFiles: files.filter(isProtected),
      unitIds: [],
      evidenceIds: [],
    };
  });
}

function executionUnit(commit: CommitUnit, isProtected: (file: string) => boolean): AgentExecutionUnit {
  const deterministic = deterministicWork(commit);
  const files = unique(commit.allowedFiles.length > 0 ? commit.allowedFiles : commit.files);
  return {
    id: commit.id,
    order: commit.order,
    layer: commit.executionLayer,
    goal: commit.message,
    findingIds: [...commit.breakingChangeIds],
    files,
    symbols: unique(commit.allowedSymbols ?? []),
    dependsOn: unique(commit.dependsOn),
    checks: unique(commit.expectedChecks.map((check) => check.command ?? check.kind)),
    deterministic,
    agentWork: !deterministic ? 'all' : deterministic.residualSites.length === 0 ? 'none' : 'residual',
    protectedFiles: files.filter(isProtected),
  };
}

/**
 * The deterministic share of a unit, from what the plan already validated.
 *
 * A codemod is all-or-nothing per commit (`resolveCodemod`), so its presence
 * means every anchored site is covered. A fix plan records its own split.
 */
function deterministicWork(commit: CommitUnit): AgentExecutionUnit['deterministic'] {
  if (commit.fixPlan) {
    return {
      mechanism: 'fix-plan',
      ids: [commit.fixPlan.plan.id],
      covered: commit.fixPlan.covered,
      residualSites: [...commit.fixPlan.residualSites].sort((a, b) => compare(a.file, b.file) || a.line - b.line),
    };
  }
  if (commit.codemod && commit.codemod.length > 0) {
    return {
      mechanism: 'codemod',
      ids: unique(commit.codemod.map((rule) => rule.ruleId)),
      covered: commit.codemod.reduce((sum, rule) => sum + rule.anchors.length, 0),
      residualSites: [],
    };
  }
  return null;
}

function collectChecks(plan: RemediationPlan, available: readonly { label: string; kind: string }[]): AgentCheck[] {
  const checks: AgentCheck[] = [];
  const seen = new Set<string>();
  const add = (check: AgentCheck) => {
    if (seen.has(check.label)) return;
    seen.add(check.label);
    checks.push(check);
  };

  const measuredSites = plan.impactSites.some((site) => site.breakingChangeId.startsWith(MEASURED_PREFIX));
  for (const outcome of plan.verification?.checks ?? []) {
    const status = outcome.status === 'cancelled' ? 'not-run' : outcome.status;
    const excerpt =
      status === 'failed' && !measuredSites && outcome.output.trim()
        ? outcome.output.trim().split('\n').slice(-6).join('\n')
        : undefined;
    add({ label: outcome.label, kind: outcome.kind, status, ...(excerpt ? { excerpt } : {}) });
  }

  for (const commit of [...plan.commits].sort(byOrder)) {
    for (const requirement of commit.expectedChecks) {
      if (!requirement.command) continue;
      add({ label: requirement.command, kind: requirement.kind, status: 'expected' });
    }
  }

  for (const check of available) add({ label: check.label, kind: check.kind, status: 'available' });
  return checks;
}

/**
 * Collapse gaps that differ only in which surface they name.
 *
 * Seven "reachability of `winston.Logger`… only observable at runtime" gaps are
 * one fact about seven symbols. Grouping keeps every surface name and loses
 * nothing but the repetition.
 */
function groupGaps(gaps: readonly AnalysisGap[]): AgentGap[] {
  const groups = new Map<string, AgentGap>();
  for (const gap of gaps) {
    const key = [gap.stage, gap.severity, gap.automaticExecution, gap.remediation, gap.surface.replace(/ of .*$/, '')].join(' ');
    const existing = groups.get(key);
    if (existing) {
      existing.surfaces = unique([...existing.surfaces, gap.surface]);
      if (gap.dependency) existing.dependencies = unique([...existing.dependencies, gap.dependency]);
      continue;
    }
    groups.set(key, {
      stage: gap.stage,
      severity: gap.severity,
      automaticExecution: gap.automaticExecution,
      surfaces: [gap.surface],
      dependencies: gap.dependency ? [gap.dependency] : [],
      reason: gap.reason,
      remediation: gap.remediation,
    });
  }
  const severityRank = { blocking: 0, significant: 1, minor: 2 } as const;
  return [...groups.values()].sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      compare(a.stage, b.stage) ||
      compare(a.surfaces[0] ?? '', b.surfaces[0] ?? ''),
  );
}

function groupSites(sites: readonly ImpactSite[]): Map<string, ImpactSite[]> {
  const byChange = new Map<string, ImpactSite[]>();
  for (const site of sites) {
    const list = byChange.get(site.breakingChangeId) ?? [];
    list.push(site);
    byChange.set(site.breakingChangeId, list);
  }
  return byChange;
}

function dedupeSites(sites: readonly ImpactSite[]): ImpactSite[] {
  const seen = new Set<string>();
  return sites.filter((site) => {
    const key = `${site.file}:${site.line}:${site.matchedSymbol ?? ''}:${site.excerpt ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortSites(sites: AgentSite[]): AgentSite[] {
  return sites.sort((a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.symbol ?? '', b.symbol ?? ''));
}

function byOrder(a: CommitUnit, b: CommitUnit): number {
  return a.order - b.order || compare(a.id, b.id);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare);
}

/** Locale-independent, so the brief is byte-identical on every machine. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
