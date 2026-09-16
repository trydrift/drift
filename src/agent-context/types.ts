import type {
  BreakingChangeDispositionState,
  BreakingChangeKind,
  Confidence,
  DependencyKind,
  Ecosystem,
} from '../types.js';
import type { GapSeverity, GapStage } from '../confidence/types.js';
import type { FindingVerdict } from '../report/confidence.js';

/**
 * What a coding agent is handed about a dependency upgrade.
 *
 * Drift has two audiences for one {@link RemediationPlan}, and they need
 * opposite things. A reviewer approving a pull request needs everything: every
 * upstream change, its evidence, its uncertainty, the checklist. A coding agent
 * about to edit the repository needs the few facts that change what it types,
 * and it re-reads whatever it was given on every turn of its loop — so every
 * irrelevant line is paid for dozens of times.
 *
 * The first paired agent benchmark measured exactly that failure: Drift found
 * the right change and the right file in every trial, and the agent still used
 * more tokens, because it was handed the reviewer's document (499k characters,
 * 293 upstream changes, 288 of them with no located usage).
 *
 * So the rule is structural: the brief carries only locally actionable facts
 * (a located site, a measured failure, a planned commit, a runtime requirement
 * this repository violates), states everything else as counts, and names a
 * stable handle for each thing it left out. Nothing is deleted from the plan;
 * it is simply not placed in the agent's hot context.
 */
export const AGENT_BRIEF_SCHEMA_VERSION = 'agent-brief/1';

/** Where a finding came from. */
export type AgentFindingSource =
  /** Computed from upstream evidence and localized to this repository. */
  | 'analysis'
  /** Measured: this project's own checks failed after the upgrade, at these lines. */
  | 'verification';

/**
 * Why a finding is in the brief.
 *
 * `measured` outranks the rest because it is not a prediction. `actionable`
 * and `review-only` are the plan's own dispositions, unchanged — the brief
 * never re-decides confidence. `planned` covers a finding a commit unit
 * references whose disposition is weaker, so a unit never names a finding the
 * agent cannot see.
 */
export type AgentFindingState =
  | 'measured'
  | 'actionable'
  | 'review-only'
  | 'planned'
  /** Not in the brief (no located usage, not searched, or unaffected); only ever returned on request. */
  | 'omitted';

export interface AgentSite {
  file: string;
  line: number;
  /** The symbol or diagnostic code matched here. */
  symbol?: string;
  /**
   * Only for measured sites: the compiler's message, which is the most useful
   * sentence Drift has about that line. Analysis sites omit their excerpt —
   * the agent opens the file anyway, and the excerpt is the line it will read.
   */
  message?: string;
}

export interface AgentFinding {
  /** The plan's own id (`BreakingChange.id`, or the `measured:*` site key). Resolvable with `get_finding`. */
  id: string;
  source: AgentFindingSource;
  state: AgentFindingState;
  /** The disposition reason from the plan, verbatim, when there is one. */
  reason?: string;
  dependency: string;
  kind: BreakingChangeKind | 'verification-regression';
  confidence: Confidence;
  summary: string;
  /** The change the code needs, from the plan. */
  change: string;
  /** Every located site. Renderers cap what they print; the brief keeps them all. */
  sites: AgentSite[];
  /** Distinct files among `sites`, sorted. */
  files: string[];
  /** Files among `files` that the repository's guardrails forbid an agent to edit. */
  protectedFiles: string[];
  /** Execution units that address this finding. */
  unitIds: string[];
  /** Evidence ids the plan cites for this finding. Resolvable with `get_evidence`. */
  evidenceIds: string[];
}

/**
 * Work Drift already knows how to do without a model.
 *
 * `covered` sites are handled by a validated deterministic transform (a
 * built-in codemod or an accepted fix plan) and are not agent work. What is
 * left in `residualSites` is.
 */
export interface AgentDeterministicWork {
  mechanism: 'codemod' | 'fix-plan';
  /** Rule ids (codemod) or the fix plan id. */
  ids: string[];
  covered: number;
  residualSites: { file: string; line: number; reason: string }[];
}

/**
 * One bounded piece of work, from the plan's commit units.
 *
 * Carries only what dispatching the unit on its own would need, so units with
 * no `dependsOn` between them can later be handed to separate agents. The
 * brief does not dispatch anything; it keeps the shape that makes that possible.
 */
export interface AgentExecutionUnit {
  id: string;
  order: number;
  /** Units in the same layer have no ordering constraint between them. */
  layer: number;
  goal: string;
  findingIds: string[];
  files: string[];
  symbols: string[];
  dependsOn: string[];
  checks: string[];
  deterministic: AgentDeterministicWork | null;
  /** `none` when a deterministic transform covers every site. */
  agentWork: 'all' | 'residual' | 'none';
  protectedFiles: string[];
}

export interface AgentCheck {
  /** Command or label as the project runs it (`npm test`), or the kind when no command is known. */
  label: string;
  kind: string;
  /**
   * `passed`/`failed` — measured by Drift against the upgraded tree, before any fix.
   * `expected` — a check the plan says a fix must pass, not yet run.
   * `available` — a check this repository offers, detected, not run.
   */
  status: 'passed' | 'failed' | 'not-run' | 'expected' | 'available';
  /** For a failed check with no parsed diagnostics: the last lines it printed. */
  excerpt?: string;
}

/** Gaps with the same stage, severity, consequence and remedy, collapsed into one entry. */
export interface AgentGap {
  stage: GapStage;
  severity: GapSeverity;
  automaticExecution: 'blocks' | 'degrades' | 'none';
  /** The distinct surfaces this entry covers, sorted. */
  surfaces: string[];
  dependencies: string[];
  /** The reason of the first gap in the group; the rest share its remedy. */
  reason: string;
  remediation: string;
}

export interface AgentOmitted {
  /** Localization ran to completion and found no usage. Not proven unaffected. */
  noLocatedUsage: number;
  /** Localization did not run, or did not finish, for these. Uncertain. */
  notSearched: number;
  /** Established not to affect this repository (e.g. a runtime requirement it already meets). */
  unaffected: number;
  /** Omitted upstream findings by kind, for a reader wondering what kind of thing was left out. */
  byKind: Record<string, number>;
  /** Evidence records the plan holds; none are inlined in the brief. */
  evidenceRecords: number;
  /** Plan warnings not restated (skipped transitive/added/removed packages, and similar). */
  warnings: number;
}

export interface AgentDependency {
  name: string;
  ecosystem: Ecosystem;
  from: string | null;
  to: string | null;
  kind: DependencyKind;
  manifestPath: string;
}

export interface AgentBrief {
  schemaVersion: typeof AGENT_BRIEF_SCHEMA_VERSION;
  planId: string;
  dependencies: AgentDependency[];
  verdict: FindingVerdict;
  verification: {
    status: 'passed' | 'failed' | 'skipped' | 'not-run';
    reason?: string;
  };
  counts: {
    /** Every breaking change the plan holds. */
    upstreamBreakingChanges: number;
    /** Findings placed in this brief, measured ones included. */
    locallyRelevant: number;
  };
  /** In priority order: measured, then actionable by unit order, then review-only. */
  findings: AgentFinding[];
  units: AgentExecutionUnit[];
  checks: AgentCheck[];
  /**
   * Hard constraints. `protectedPaths` are the guardrail globs whose matches an
   * agent must not edit; `blockers` are the plan's own blockers, verbatim,
   * minus any that only restate a gap listed in `gaps`.
   */
  constraints: {
    protectedPaths: string[];
    protectedFiles: string[];
    blockers: string[];
  };
  gaps: AgentGap[];
  omitted: AgentOmitted;
  /**
   * Upstream prose — migration guides, changelogs, release notes — by id and
   * title only. A finding may not cite the section that matters (a config
   * format change the analyzer did not turn into a finding); naming the
   * records lets an agent read Drift's copy on request instead of searching
   * the web for it.
   */
  notes: { id: string; dependency: string; source: string; title: string }[];
}

/** The dispositions, re-exported so a consumer does not import from two places. */
export type { BreakingChangeDispositionState };
