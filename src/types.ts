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
 *   DispatchResult      -- dispatch  (branch + agent task + PR)
 *
 * Every stage is independently testable and every downstream artefact carries
 * citations back to the Evidence that justified it. Nothing reaches a pull
 * request without a traceable reason.
 */

import type { UpgradeRationale } from './rationale/types.js';
import type { ChangeTaxonomy } from './confidence/taxonomy.js';
import type { AnalysisGap, CheckedSurface, ConfidenceAssessment } from './confidence/types.js';
import type { CommunityRecipeCandidate } from './remediation/types.js';
import type { AttachedFixPlan } from './fixplan/schema.js';
import type { SpecEvidenceSource } from './evidence/spec/sources.js';
import type { UpgradeVerification } from './verification/upgrade-probe.js';

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
  | 'opam'
  /**
   * C and C++ have no single package manager, so they have three entries here
   * rather than one. Collapsing them into a `c` ecosystem would have been
   * tidier and wrong: they have different manifests, different registries,
   * different version grammars, and a project using one has never heard of the
   * others. What they share — the language, the `#include` graph, the header
   * surface diff — is shared at the layers where that is actually true.
   */
  | 'conan'
  | 'vcpkg'
  | 'arduino';

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
   * Whether this change was observed in a manifest or a lockfile.
   *
   * Independent of `kind`: a lockfile entry can be reclassified to `dev` or
   * `transitive`, but it never becomes a human's decision. Detection uses this
   * — not `kind` — to decide whether a manifest-derived change should win over
   * a lockfile-derived one for the same package.
   */
  source?: 'manifest' | 'lockfile';
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

/**
 * Where a piece of evidence came from. Drives how much we trust it.
 *
 * The contract-document diffs (OpenAPI and friends) are not listed by hand:
 * each is declared by the provider that produces it, and `SpecEvidenceSource`
 * is the union of those declarations. See `evidence/spec/sources.ts`.
 */
export type EvidenceSource =
  | 'registry-metadata'
  | 'github-release'
  | 'changelog'
  | 'migration-guide'
  | 'type-surface-diff'
  | 'behavioural-diff'
  | 'semver-heuristic'
  | SpecEvidenceSource;

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
  /**
   * Which part of a `signature-changed` finding actually moved, when the
   * provider could tell.
   *
   * The distinction changes what a reader needs to do about it: a parameter
   * change means every call site's arguments need attention, a return-type
   * change means every call site that keeps the result does — and whether
   * that second kind is even visible depends on whether the calling language
   * checks types at all. Absent when the provider only has two raw signature
   * strings and no parser to tell them apart.
   */
  changed?: 'parameters' | 'return-type' | 'both';
  /**
   * The declaration's own shape on each side of a `kind-changed` finding —
   * `function`, `class`, `interface`, and so on. What a caller needs to edit
   * for "class became a function" (drop every `new`) and "function became a
   * class" (add `new` everywhere) are opposite fixes for the same finding
   * code, and neither is discoverable from `before`/`after` alone without
   * re-parsing them.
  */
  fromKind?: string;
  toKind?: string;
  moduleSystem?: {
    from?: ModuleSystem;
    to?: ModuleSystem;
    incompatibleUsage: ModuleIncompatibleUsage[];
    /**
     * Exact consumer module specifiers affected by this finding. Absent means
     * the package-wide loading mode is incompatible.
     */
    affectedSpecifiers?: string[];
    /**
     * Consumer module specifier patterns affected by this finding, using npm's
     * `*` subpath export wildcard shape, e.g. `pkg/features/*`.
     */
    affectedSpecifierPatterns?: string[];
  };
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
  readonly content: string;
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
  | 'module-system-change'
  | 'runtime-requirement'
  | 'unknown';

/** Runtime names understood by the structured prose and declaration paths. */
export type RuntimeName = 'node' | 'python' | 'go' | 'ruby' | 'java' | 'rust';

/** A parseable runtime floor announced by an upstream release. */
export interface MinimumRuntimeRequirement {
  kind: 'minimum-runtime';
  runtime: RuntimeName;
  requirement: string;
  /** The exact prose fragment from which the requirement was parsed. */
  sourceText: string;
}

/** A runtime line upstream dropped without stating its replacement floor. */
export interface UnsupportedRuntimeRange {
  kind: 'unsupported-runtime-range';
  runtime: RuntimeName;
  /** The unsupported range exactly as upstream stated it, e.g. "16.x", "^16", "<18". */
  requirement: string;
  /** The exact prose fragment from which the requirement was parsed. */
  sourceText: string;
  /**
   * A replacement floor, but only when the unsupported range's complement is
   * mathematically unambiguous (`<18` implies `>=18`; `^16` does not imply
   * anything Drift is willing to state as a floor). Never invented — see
   * `parseRuntimeRequirement` in `analyze/rules.ts`.
   */
  derivedMinimum?: string;
}

/** Structured runtime evidence. Only `minimum-runtime` implies a local floor. */
export type RuntimeRequirement = MinimumRuntimeRequirement | UnsupportedRuntimeRange;

export type ModuleSystem = 'commonjs' | 'esm' | 'dual';
export type ModuleIncompatibleUsage = 'require' | 'static-import' | 'dynamic-import' | 're-export';

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
  /** Present for structured `runtime-requirement` changes. */
  runtime?: RuntimeRequirement;
  /** One-line statement of what broke. */
  summary: string;
  /**
   * The actual before/after declaration text, when this came from a computed
   * diff (see `StructuredFinding`). This is the evidence itself — a reader
   * comparing two signatures — as opposed to `citations`, which point at
   * where to go verify it independently.
   */
  before?: string;
  after?: string;
  /** Observed declaration shape before removal/change, when the surface provider knows it. */
  fromKind?: string;
  /** Observed declaration shape after a kind change. */
  toKind?: string;
  /**
   * The real upstream source declaring the changed symbol, as a GitHub blob
   * URL with a line number — set after localization, only for a breaking
   * change that reaches code in this repository (see
   * `attachGitHubSources`), since evidence gathering happens before impact
   * sites are known and would otherwise spend a rate-limited lookup on
   * symbols the report may never show. Preferred over a citation's own URL
   * when present, since it points at the actual declaration rather than a
   * compiled artifact.
   */
  sourceUrl?: string;
  /** What a fix must accomplish. Fed verbatim into the Copilot task. */
  remediation: string;
  /** Identifiers to search for: export names, endpoint paths, option keys. */
  symbols: string[];
  /** Replacement identifiers when the change is a rename/move. */
  replacementSymbols?: string[];
  /**
   * Structured package loading compatibility semantics.
   *
   * Package-wide module changes are not symbol changes. A package becoming
   * ESM-only affects CommonJS loading sites, not every import/reference to the
   * package name. This metadata lets localization match the consumer syntax
   * that is actually incompatible instead of smuggling the package name through
   * `symbols`.
   */
  moduleSystem?: {
    from?: ModuleSystem;
    to?: ModuleSystem;
    incompatibleUsage: ModuleIncompatibleUsage[];
    /**
     * Exact consumer module specifiers affected by this finding. Absent means
     * every specifier under the package identity is affected.
     */
    affectedSpecifiers?: string[];
    /**
     * Consumer module specifier patterns affected by this finding, using npm's
     * `*` subpath export wildcard shape, e.g. `pkg/features/*`.
     */
    affectedSpecifierPatterns?: string[];
  };
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
  /**
   * 0-based offset within the line where the match actually started.
   *
   * Localization matches once per line, so this identifies *the* occurrence
   * Drift established — not "somewhere on this line". It matters because a
   * line can legitimately contain the same name twice for different reasons:
   *
   *   primary.oldMethod(); backup.oldMethod();
   *
   * where only one receiver was bound from the dependency that moved. A fix
   * anchored to the line would rewrite both; a fix anchored here rewrites the
   * one that was localized. See `FixPlanAnchor`.
   *
   * Absent for the two sites that genuinely have no column: a manifest/runtime
   * finding, and the `callOpensOnNextLine` fallback, where the match is the
   * *absence* of a call on this line. A consumer needing an exact position
   * must treat an absent column as "not established" rather than guessing 0.
   */
  column?: number;
  /**
   * The exact text the matcher consumed at `column` — `connect(`, `new Foo(`,
   * `<Slot`, or a bare name, depending on the symbol's shape.
   *
   * Carried alongside `column` so a later consumer can confirm it is looking
   * at the same occurrence rather than trusting an offset into a file that
   * may have changed since.
   */
  matchedText?: string;
  confidence: Confidence;
  /**
   * Set only for a `runtime-requirement` site: what compatibility state this
   * particular declaration was found in. Distinct from `confidence`, which
   * answers a different question (how sure Drift is about the site itself,
   * not what it means) — an `unknown` site is one Drift is quite sure it
   * found, and quite unsure how to interpret, hence `low` confidence paired
   * with `runtimeVerdict: 'unknown'` rather than one field trying to carry
   * both. Used to keep runtime rationale text (§ `assess.ts`) and the
   * recording validator honest without re-deriving the verdict from prose.
   */
  runtimeVerdict?: 'incompatible' | 'partial' | 'unknown';
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
    /**
     * Line-level, and safe to remain so. This tier only ever performs
     * `rename-identifier`, whose matcher refuses anything preceded by a dot,
     * so every occurrence it can reach on one line is the same imported
     * binding. The fix plan tier added `rename-member`, where that stops
     * being true — two receivers on one line can be different objects — which
     * is why `FixPlanAnchor` is per-occurrence instead.
     */
    anchors: { file: string; line: string; lineNumber: number }[];
  }[];
  /**
   * A validated deterministic fix plan covering some or all of this unit's
   * call sites (see `src/fixplan/`).
   *
   * The tier between `codemod` and an agent. Where `codemod` carries a rule
   * Drift derived unaided, this carries a rule Drift *validated* — proposed
   * by a cache hit, a community recipe's observed edits, or one model call
   * for the whole finding, then put through `validateFixPlan` before it was
   * allowed anywhere near a file.
   *
   * Unlike `codemod`, this is not all-or-nothing. `covered` sites are
   * resolved by Drift's own executor and `residualSites` are handed to an
   * agent individually, so a rule explaining nine of ten call sites resolves
   * nine rather than none. A consumer re-applies it against whatever each
   * file actually holds when it runs (`applyFixPlanToContent`) and puts the
   * result through the same scope validation and verification an agent's
   * output would.
   *
   * `codemod`, when present, still wins: it needed no model and no
   * validation because it could not have been wrong by construction.
   */
  fixPlan?: AttachedFixPlan;
  /**
   * Community recipe candidates matching this unit's breaking changes, when
   * a live registry lookup (`src/remediation/live-search.ts`, only run when
   * `remediation.communityRecipes` is enabled) found a version-pinned recipe
   * for each one.
   *
   * Metadata for the report, and a record of what was consulted. This is no
   * longer an execution path: a recipe's own edits are never committed. What
   * a recipe can do is *propose* — it runs in a throwaway worktree, Drift
   * infers which of its own operations explain the edits it made, and the
   * result arrives on `fixPlan` above having passed the same gate a
   * model-authored plan passes. A recipe whose edits Drift cannot re-derive
   * leaves no `fixPlan` behind and the finding goes to an agent.
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
   * rather than misreading a newer one.
   */
  schemaVersion: number;
  id: string;
  /** Branch Drift will create and the selected agent will work on. */
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
  /**
   * How many breaking changes upstream published, fixed at plan creation and
   * never revised afterward.
   *
   * `breakingChanges` is a working list: verification prunes it as compiler-
   * provable predictions get disproved, so its length is "what's still
   * unresolved", not "what upstream shipped". Reading that shrinking length as
   * the headline count is how the same commit reported "209 upstream changes"
   * in one verification run and "2" in another — the only thing that changed
   * was whether the probe happened to test this package alone or batched with
   * others, not what the dependency actually published. Absent only for plans
   * built before this field existed; callers should fall back to
   * `breakingChanges.length` in that case.
   */
  upstreamBreakingCount?: number;
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
  /**
   * What the project's own toolchain said when this upgrade was actually
   * installed and checked, in a throwaway worktree, before any of this was
   * reported.
   *
   * The only measured claim in a plan otherwise made of predictions, which is
   * why consumers should prefer it wherever the two disagree. Absent when
   * verification was switched off or the repository offered no check to run —
   * never a silent "it passed".
   */
  verification?: UpgradeVerification;
  /**
   * Dependency changes verification proved actually broke the project —
   * baseline passed, this change installed, the same check failed — keyed by
   * {@link dependencyEcosystemKey}.
   *
   * Deliberately narrower than "verification failed": that can mean an
   * install timed out, a tool was missing, or the repository was already red,
   * none of which says anything about this dependency. An entry only lands
   * here when the failure was isolated to one dependency change and measured
   * against a passing baseline for that exact check — the one shape of
   * verification result strong enough to say a repository is affected even
   * when static localization found nothing to point at. See `verifyPlan` in
   * `analysis.ts` and `resolvePlanVerdict` in `report/confidence.ts`, the one
   * place this is read.
   */
  confirmedRegressions: string[];
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
  /** Cloud provider task/session id, when asynchronous dispatch succeeded. */
  taskId?: string;
  /** Provider that owns `taskId`, when an async cloud task was dispatched. */
  taskProvider?: string;
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
