/**
 * Drift's domain model.
 *
 * The pipeline is a series of pure-ish transforms over these types:
 *
 *   DependencyChange[]  -- detect    (what versions moved)
 *        v
 *   Evidence[]          -- evidence  (ground truth about what changed upstream)
 *        v
 *   BreakingChange[]    -- analyze   (which upstream changes are breaking, and why)
 *        v
 *   ImpactSite[]        -- localize  (where in *this* repo they bite)
 *        v
 *   RemediationPlan     -- plan      (ordered, separated commit units)
 *        v
 *   DispatchResult      -- dispatch  (branch + Copilot task + PR)
 *
 * Every stage is independently testable and every downstream artefact carries
 * citations back to the Evidence that justified it. Nothing reaches a pull
 * request without a traceable reason.
 */

/** Package ecosystems Drift can parse manifests for. */
export type Ecosystem =
  | 'npm'
  | 'pypi'
  | 'go'
  | 'cargo'
  | 'maven'
  | 'rubygems';

/** Semantic classification of a version move. */
export type BumpKind =
  | 'major'
  | 'minor'
  | 'patch'
  | 'prerelease'
  | 'added'
  | 'removed'
  | 'unknown';

/** How the dependency is reached from this repo. */
export type DependencyKind = 'runtime' | 'dev' | 'peer' | 'optional' | 'transitive';

/** A single dependency whose version moved between two git refs. */
export interface DependencyChange {
  /** Canonical package name as the registry knows it. */
  name: string;
  ecosystem: Ecosystem;
  /** Previous version. `null` when the dependency was newly added. */
  from: string | null;
  /** New version. `null` when the dependency was removed. */
  to: string | null;
  kind: DependencyKind;
  bump: BumpKind;
  /** Manifest or lockfile the change was observed in, repo-relative. */
  manifestPath: string;
  /** Raw version ranges as written, useful for reproducing the edit. */
  rawFrom?: string | null;
  rawTo?: string | null;
  /**
   * The workspace member directory whose manifest declared this.
   *
   * Absent in a single-package repository, where the question does not arise.
   * `''` is the workspace root. This is the boundary localization respects: a
   * bump in `packages/api` is a fact about `packages/api`.
   */
  workspace?: string;
  /** That member's own package name, when its manifest declares one. */
  workspaceName?: string;
}

/** Where a piece of evidence came from. Drives how much we trust it. */
export type EvidenceSource =
  | 'registry-metadata'
  | 'github-release'
  | 'changelog'
  | 'migration-guide'
  | 'openapi-diff'
  | 'type-surface-diff'
  | 'semver-heuristic';

/**
 * A machine-extracted finding attached to an Evidence record.
 *
 * Computed evidence sources (the type-surface and OpenAPI diffs) already know
 * exactly which symbol changed and how. Carrying that structure alongside the
 * human-readable text means the analyser reads facts instead of re-parsing its
 * own prose — which would be both fragile and circular.
 */
export interface StructuredFinding {
  /** Rule identifier, e.g. `export-removed`, `path-removed`. */
  code: string;
  /** The identifier, endpoint, or option key this concerns. */
  symbol: string;
  detail: string;
  before?: string;
  after?: string;
}

/**
 * A retrieved, citable fact about what changed upstream.
 *
 * Evidence is the difference between Drift and "ask an LLM to guess". Every
 * BreakingChange must point at Evidence, and every Evidence has a `url` or
 * `locator` a human can open to check our work.
 */
export interface Evidence {
  id: string;
  source: EvidenceSource;
  dependency: string;
  /** Human-openable citation. Absent only for locally-computed diffs. */
  url?: string;
  /** Local citation when there is no URL, e.g. "node_modules/foo/index.d.ts". */
  locator?: string;
  title: string;
  /** Verbatim excerpt. Never paraphrased — this is what a reviewer audits. */
  content: string;
  /** Present on computed sources; absent on prose sources. */
  findings?: StructuredFinding[];
  /**
   * How directly this evidence speaks to breakage.
   * 1.0 = a machine-computed diff of the actual API surface.
   * 0.3 = a semver major bump with no other information.
   */
  weight: number;
}

/** The shape of an upstream change, which determines the fix strategy. */
export type BreakingChangeKind =
  | 'removed-export'
  | 'renamed-export'
  | 'signature-change'
  | 'type-change'
  | 'behaviour-change'
  | 'removed-endpoint'
  | 'changed-endpoint'
  | 'required-field-added'
  | 'default-change'
  | 'config-change'
  | 'runtime-requirement'
  | 'unknown';

/** How sure Drift is that this is real and actionable. */
export type Confidence = 'high' | 'medium' | 'low';

/**
 * A specific upstream API change that can break consumers.
 *
 * `symbols` is what makes localization possible: these are the identifiers
 * we grep/parse for in the consumer repo.
 */
export interface BreakingChange {
  id: string;
  dependency: string;
  kind: BreakingChangeKind;
  /** One-line statement of what broke. */
  summary: string;
  /** What a fix must accomplish. Fed verbatim into the Copilot task. */
  remediation: string;
  /** Identifiers to search for: export names, endpoint paths, option keys. */
  symbols: string[];
  /** Replacement identifiers when the change is a rename/move. */
  replacementSymbols?: string[];
  confidence: Confidence;
  /** IDs of the Evidence records that justify this. Never empty. */
  citations: string[];
}

/** A concrete location in the consumer repo affected by a BreakingChange. */
export interface ImpactSite {
  breakingChangeId: string;
  /** Repo-relative path. */
  file: string;
  /** 1-indexed. */
  line: number;
  /** The matched source line, trimmed. Shown in the report. */
  excerpt: string;
  /** Enclosing function/class/method, from the Meta-RAG index when known. */
  enclosingSymbol?: string;
  /** Which symbol from the BreakingChange matched here. */
  matchedSymbol: string;
  confidence: Confidence;
}

/**
 * One commit's worth of work.
 *
 * Drift deliberately never produces a single "upgrade everything" commit.
 * Each unit is one coherent concern so that a reviewer can read, approve, or
 * revert it in isolation — and so that `git bisect` stays meaningful.
 */
export interface CommitUnit {
  /** Execution order, starting at 1. */
  order: number;
  /** Conventional-commit subject line. */
  message: string;
  /** Longer body explaining the why, with evidence citations. */
  body: string;
  /** BreakingChange IDs addressed by this commit. */
  breakingChangeIds: string[];
  /** Files this commit is allowed to touch. */
  files: string[];
  /** Imperative instructions handed to the coding agent. */
  instructions: string;
  /** Commits that must land before this one. */
  dependsOn: number[];
}

/** Aggregate risk, used to gate automatic execution. */
export type RiskLevel = 'none' | 'low' | 'medium' | 'high';

/** The full remediation proposal for one dependency-change batch. */
export interface RemediationPlan {
  id: string;
  /** Branch Drift will create and Copilot will work on. */
  branchName: string;
  /** Branch the eventual PR merges back into. */
  baseBranch: string;
  /**
   * Commit this plan was derived from.
   *
   * Recorded in the report footer so the approval flow can reproduce the plan
   * from a filed issue without storing it anywhere — the analysis is
   * deterministic, so the same commit yields the same plan.
   */
  headSha: string;
  changes: DependencyChange[];
  evidence: Evidence[];
  breakingChanges: BreakingChange[];
  impactSites: ImpactSite[];
  commits: CommitUnit[];
  risk: RiskLevel;
  /** Reasons Drift refused to proceed automatically, if any. */
  blockers: string[];
  /** Non-fatal caveats surfaced to the reviewer. */
  warnings: string[];
  createdAt: string;
}

/** Terminal outcome of handing a plan to the coding agent. */
export interface DispatchResult {
  status: 'dispatched' | 'skipped' | 'blocked' | 'failed';
  planId: string;
  branchName?: string;
  /** Copilot Agent Tasks API session id, when dispatch succeeded. */
  taskId?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  /** Issue opened for human approval in `approve` mode. */
  approvalIssueNumber?: number;
  message: string;
}

/** Identifies the repository and refs a run operates on. */
export interface RepoContext {
  owner: string;
  repo: string;
  /** Branch the dependency change landed on; also the PR base. */
  baseBranch: string;
  /** Commit before the change. */
  beforeSha: string;
  /** Commit after the change. */
  afterSha: string;
  /** Absolute path to a local checkout, when one is available. */
  workspace?: string;
}
