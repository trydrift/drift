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

import type { UpgradeRationale } from './rationale/types.js';
import type { ChangeTaxonomy } from './confidence/taxonomy.js';
import type { AnalysisGap, CheckedSurface, ConfidenceAssessment } from './confidence/types.js';
import type { CommunityRecipeCandidate } from './remediation/types.js';

export type { UpgradeRationale };

/**
 * Package ecosystems Drift can parse manifests for.
 *
 * An entry here is a claim about *detection* only. What Drift can actually do
 * with each one — retrieve evidence, compute an API surface, run the native
 * checks, produce a fix — differs per ecosystem and is stated, per stage, in
 * `detect/capabilities.ts`. Adding a name here without adding a row there is a
 * compile error, which is deliberate: an ecosystem that appears in a dropdown
 * but silently does half as much is exactly the kind of quiet over-claim this
 * tool exists not to make.
 *
 * Scala is absent on purpose, and is not an omission: sbt coordinates resolve
 * to Maven Central artifacts, so `build.sbt` is parsed into `maven` and gets
 * that ecosystem's registry, japicmp surface diff, and OSV coverage for free.
 * React Native is likewise absent — its JavaScript half is `npm` and its iOS
 * half is `cocoapods`.
 */
export type Ecosystem =
  | 'npm'
  | 'pypi'
  | 'go'
  | 'cargo'
  | 'maven'
  | 'rubygems'
  | 'nuget'
  | 'packagist'
  | 'hex'
  | 'pub'
  | 'swift'
  | 'cocoapods'
  | 'opam';

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
  | 'behavioural-diff'
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
  /**
   * The workspace member this evidence was gathered for, mirroring
   * `DependencyChange.workspace`. Absent in a single-package repository.
   * Two members can depend on the same package at different versions, so
   * `dependency` alone is not a safe key for matching evidence back to a
   * specific change in a monorepo — see `dependencyKey` in `util/id.ts`.
   */
  workspace?: string;
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
  /** The API still exists, but not where it used to be imported from. */
  | 'moved-export'
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

/**
 * How sure Drift is that this is real and actionable.
 *
 * Retained as a compatibility view. It is now derived from
 * `ConfidenceAssessment` rather than computed independently — see
 * `confidence/calibrate.ts`, which holds the one calculation.
 *
 * On a `BreakingChange` this specifically means **upstream** confidence: how
 * sure Drift is that the change happened at all. It says nothing about whether
 * this repository is affected, which is a separate question with separate
 * evidence and is carried on `assessment.localImpact`. Conflating the two is
 * what let a machine-verified upstream diff present as a high-confidence reason
 * to edit local code nothing had shown to be affected.
 */
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
  /**
   * The workspace member this finding belongs to, mirroring
   * `DependencyChange.workspace`. Absent in a single-package repository.
   * Two members can depend on the same package at different versions, so this
   * — not `dependency` alone — is what keeps their findings from merging.
   */
  workspace?: string;
  kind: BreakingChangeKind;
  /** One-line statement of what broke. */
  summary: string;
  /** What a fix must accomplish. Fed verbatim into the Copilot task. */
  remediation: string;
  /** Identifiers to search for: export names, endpoint paths, option keys. */
  symbols: string[];
  /** Replacement identifiers when the change is a rename/move. */
  replacementSymbols?: string[];
  /**
   * Upstream confidence — did this change really happen?
   *
   * Derived from `assessment.upstream`. See the type's own documentation for
   * why this is not "how safe is it to fix this".
   */
  confidence: Confidence;
  /**
   * What kind of break this is, along four axes.
   *
   * Separate from `kind`, which stays the remediation-strategy field. The axis
   * that earns its keep is `detectability`: a removed export and a changed
   * default are both breaking, but one stops the build and the other ships
   * quietly, and no single field could say so.
   *
   * Optional on the interface so that findings constructed by hand — by a test,
   * or by an external consumer of the library — stay valid. `analyze` always
   * populates it, and `buildPlan` fills any that are missing from `kind`, so
   * every finding on a plan has one. Read it through `taxonomyOf`.
   */
  taxonomy?: ChangeTaxonomy;
  /**
   * The full three-dimensional assessment.
   *
   * Attached by `buildPlan`, because local impact cannot be assessed until
   * localization has run. Absent on the output of `analyze()` alone, where only
   * the upstream dimension is knowable.
   */
  assessment?: ConfidenceAssessment;
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

export type PlanEdgeReason =
  | 'same-file-conflict'
  | 'runtime-prerequisite'
  | 'configuration-prerequisite'
  | 'import-prerequisite'
  | 'generated-output'
  | 'symbol-dependency'
  | 'package-cohort'
  | 'verification-discovered'
  | 'repository-policy';

export interface PlanEdge {
  /** Prerequisite commit unit id. */
  from: string;
  /** Dependent commit unit id. */
  to: string;
  reason: PlanEdgeReason;
  evidence: string[];
}

export interface VerificationRequirement {
  id: string;
  kind: 'build' | 'typecheck' | 'test' | 'lint' | 'integration' | 'custom';
  command?: string;
  reason: string;
}

export interface VersionConstraint {
  dependency: string;
  ecosystem: Ecosystem;
  range: string;
  source: 'peer-dependency' | 'solver' | 'workspace-family' | 'bom' | 'framework' | 'lockstep-metadata' | 'user-config';
}

export interface UpgradeCohort {
  id: string;
  ecosystem: Ecosystem;
  dependencies: string[];
  constraints: VersionConstraint[];
  candidatePaths: string[];
  reason: string;
}

/**
 * One commit's worth of work.
 *
 * Drift deliberately never produces a single "upgrade everything" commit.
 * Each unit is one coherent concern so that a reviewer can read, approve, or
 * revert it in isolation — and so that `git bisect` stays meaningful.
 */
export interface CommitUnit {
  /** Stable content-derived id. */
  id: string;
  /** Display order, starting at 1. Derived from deterministic graph order. */
  order: number;
  /** Conventional-commit subject line. */
  message: string;
  /** Longer body explaining the why, with evidence citations. */
  body: string;
  /** BreakingChange IDs addressed by this commit. */
  breakingChangeIds: string[];
  /** Compatibility view of `allowedFiles`. */
  files: string[];
  /** Files this commit is allowed to touch. */
  allowedFiles: string[];
  /** Symbols this unit is expected to update, when localization can name them. */
  allowedSymbols?: string[];
  /** Imperative instructions handed to the coding agent. */
  instructions: string;
  /** Commit unit ids that must land before this one. */
  dependsOn: string[];
  /** Incoming edge reasons, repeated here for consumers that only read units. */
  dependencyReasons: PlanEdge[];
  /** Topological layer. Units in the same layer may run concurrently. */
  executionLayer: number;
  /** Checks expected after this unit or layer. */
  expectedChecks: VerificationRequirement[];
  /** Changes that invalidate this unit and require replanning. */
  invalidationTriggers: string[];
  /**
   * A deterministic fix for every breaking change in this unit, when Drift's
   * own codemod engine (see `codemod/index.ts`) could resolve all of them
   * without a model. Present only when coverage is complete for this unit.
   *
   * Carries the rule and its parameters, not precomputed file contents — a
   * consumer re-applies the transform (`applyCodemodTransform`) against
   * whatever each file actually contains when it runs, then puts the result
   * through the same scope validation and verification an agent's output
   * would go through, and skips dispatching an agent entirely. Absent, as
   * before, means "ask an agent."
   */
  codemod?: {
    ruleId: string;
    from: string;
    to: string;
    files: string[];
    anchors: { file: string; line: string }[];
  }[];
  /**
   * Community recipe candidates that claim to resolve every breaking change
   * in this unit, when no built-in codemod could and the curated registry
   * (`src/remediation/registry.ts`) has a matching, version-pinned recipe for
   * each one. Metadata only, exactly like `codemod` is a rule plus
   * parameters rather than precomputed content — a consumer decides whether
   * to run it (never automatically; see `src/remediation/partition.ts`),
   * executes it in an isolated worktree, and puts the result through the
   * same scope validation and verification an agent's output would.
   *
   * `codemod`, when present, always takes priority over this field.
   */
  recipe?: CommunityRecipeCandidate[];
}

/** Aggregate risk, used to gate automatic execution. */
export type RiskLevel = 'none' | 'low' | 'medium' | 'high';

/** The full remediation proposal for one dependency-change batch. */
export interface RemediationPlan {
  /**
   * Version of the serialized plan shape.
   *
   * Present so a consumer reading a stored plan — an approval issue, a cached
   * report, a benchmark fixture — can tell whether it understands the format
   * rather than misreading a newer one. See `docs/schema-migration.md`.
   */
  schemaVersion: number;
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
  /** Real dependency graph over commit units. */
  planEdges: PlanEdge[];
  /** Dependency upgrades that should be reasoned about together. */
  upgradeCohorts: UpgradeCohort[];
  /**
   * Why each upgrade might be worth taking, alongside what it might cost.
   *
   * One entry per dependency that moved. Empty when the rationale stage was
   * switched off or had nothing to run against — never partially populated in a
   * way that would let a reader mistake an absent entry for a clean one.
   */
  rationale?: UpgradeRationale[];
  risk: RiskLevel;
  /**
   * Everything Drift could not establish.
   *
   * First-class records rather than prose buried in `warnings`, because these
   * decide whether the rest of the plan can be trusted. An empty list means
   * every surface Drift knows how to check was checked — never that the ones it
   * skipped were clean.
   */
  gaps: AnalysisGap[];
  /**
   * What was looked at, and whether looking succeeded.
   *
   * The record that lets a report distinguish "searched and found nothing" from
   * "could not search" — the two produce identical output otherwise and mean
   * opposite things.
   */
  checkedSurfaces: CheckedSurface[];
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
