import type {
  BreakingChange,
  BreakingChangeDisposition,
  Confidence,
  DependencyChange,
  Evidence,
  ImpactSite,
  RemediationPlan,
  RepoContext,
  RiskLevel,
  UpgradeRationale,
} from '../types.js';
import { compareRisk, riskWithinLimit, type DriftConfig } from '../config/schema.js';
import type { CodemodResult } from '../codemod/index.js';
import type { FixPlanAssessment } from '../fixplan/schema.js';
import type { CommunityRecipeCandidate } from '../remediation/types.js';
import { branchNameFor as branchName } from './pull-request.js';
import { meetsConfidence } from '../analyze/index.js';
import { isDowngrade } from '../detect/version.js';
import { matchesAny } from '../util/glob.js';
import { stableId } from '../util/id.js';
import { planCommitGraph } from './commits.js';
import {
  CAPABILITY_STAGES,
  STAGE_LABEL,
  capabilitiesFor,
  type CapabilityStage,
} from '../detect/capabilities.js';
import { assess, deriveLegacyConfidence } from '../confidence/calibrate.js';
import { isLocallyUnprovable, taxonomyOf } from '../confidence/taxonomy.js';
import type { AnalysisGap, CheckedSurface, VerificationOutcome } from '../confidence/types.js';
import { PLAN_SCHEMA_VERSION } from '../approval/digest.js';
import { deriveBreakingChangeDispositions } from '../disposition.js';
import type { RuntimeRequirementAnalysis } from '../rationale/compatibility.js';

/**
 * Plan assembly: turn findings into a proposal, and decide whether Drift is
 * allowed to execute it without a human.
 *
 * `blockers` and `warnings` are the heart of this module and the reason a team
 * can leave `auto` mode on. A blocker does not discard the plan — it downgrades
 * the run to approval-required, so the work is still visible and one click from
 * proceeding. Drift's failure mode is "asks a human too often", never "edits
 * code it shouldn't have".
 */

export interface BuildPlanInput {
  repo: RepoContext;
  config: DriftConfig;
  changes: readonly DependencyChange[];
  evidence: readonly Evidence[];
  breakingChanges: readonly BreakingChange[];
  impactSites: readonly ImpactSite[];
  /** Exactly one analysis per runtime breaking change. */
  runtimeAnalyses?: readonly RuntimeRequirementAnalysis[];
  /** Reasons from triage, surfaced so nothing looks silently dropped. */
  skipped?: readonly { change: DependencyChange; reason: string }[];
  /** Why each upgrade might be worth taking. Absent when the stage was skipped. */
  rationale?: readonly UpgradeRationale[];
  /**
   * Whether localization actually ran.
   *
   * Defaults to true, because every caller with a workspace runs it. Passing
   * `false` is what turns "no impact sites" from a finding into a stated gap —
   * the distinction between searched-and-clean and never-searched.
   */
  localizationRan?: boolean;
  /** Checks that ran against this plan. Empty means nothing was verified. */
  verification?: readonly VerificationOutcome[];
  /** Surfaces the earlier stages looked at, and how that went. */
  checkedSurfaces?: readonly CheckedSurface[];
  /**
   * Dependency changes verification has already proven broke the project.
   *
   * Always empty at plan-build time in production — `verifyPlan` in
   * `analysis.ts` is what populates this, and it runs after `buildPlan`. The
   * field exists on the input here only so a test can construct the plan
   * `resolvePlanVerdict` would see after verification, without standing up
   * verification itself.
   */
  confirmedRegressions?: readonly string[];
  /** Deterministic fixes already computed for individual findings, by `BreakingChange.id`. */
  codemods?: ReadonlyMap<string, CodemodResult>;
  /** Community recipe candidates matched for individual findings, by `BreakingChange.id`. */
  recipes?: ReadonlyMap<string, CommunityRecipeCandidate>;
  /** Validated deterministic fix plans, by `BreakingChange.id`. See `src/fixplan/`. */
  fixPlans?: ReadonlyMap<string, FixPlanAssessment>;
}

/**
 * The confidence a guardrail should judge a finding by.
 *
 * Prefers the calibrated assessment, which accounts for local impact, and falls
 * back to the legacy upstream-only field for callers that build a plan from
 * hand-made findings. Without the fallback, a finding assembled in a test or by
 * an external consumer would read as `low` purely for lacking an assessment.
 */
function effectiveConfidence(change: BreakingChange): Confidence {
  return change.assessment ? deriveLegacyConfidence(change.assessment) : change.confidence;
}

export function buildPlan(input: BuildPlanInput): RemediationPlan {
  const { repo, config, changes, evidence, impactSites } = input;

  // Assessments first: the guardrails below decide on local impact, which does
  // not exist until localization has run and cannot be known inside `analyze`.
  const breakingChanges = assessAll(input);
  const dispositions = deriveBreakingChangeDispositions(
    breakingChanges,
    impactSites,
    input.runtimeAnalyses ?? input.rationale?.flatMap((entry) => entry.runtimeAnalyses ?? []) ?? [],
    input.localizationRan ?? true,
  );

  const graph = planCommitGraph({
    breakingChanges,
    impactSites,
    dispositions,
    config,
    changes,
    codemods: input.codemods,
    recipes: input.recipes,
    fixPlans: input.fixPlans,
  });
  const commits = graph.commits;
  const risk = assessRisk(
    changes,
    breakingChanges,
    impactSites,
    (input.rationale ?? []).map((entry) => entry.assessment.runtimeCompatibility),
    dispositions,
  );
  const gaps = collectGaps(input, breakingChanges, commits);
  const { blockers, warnings } = evaluateGuardrails(input, breakingChanges, commits, risk, gaps);

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    id: stableId('plan', repo.owner, repo.repo, repo.afterSha),
    branchName: branchNameFor(config, changes, repo.afterSha),
    baseBranch: repo.baseBranch,
    headSha: repo.afterSha,
    changes: [...changes],
    evidence: [...evidence],
    breakingChanges,
    upstreamBreakingCount: breakingChanges.length,
    impactSites: [...impactSites],
    dispositions,
    commits,
    planEdges: graph.edges,
    upgradeCohorts: graph.cohorts,
    ...(input.rationale ? { rationale: [...input.rationale] } : {}),
    risk,
    gaps,
    checkedSurfaces: [...(input.checkedSurfaces ?? [])],
    confirmedRegressions: [...(input.confirmedRegressions ?? [])],
    blockers: [...graph.blockers, ...blockers],
    warnings,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Attach the full three-dimensional assessment to every finding.
 *
 * `analyze` could only score the upstream dimension — it has no repository to
 * look at. This is where local impact and verification join it, and where the
 * legacy `confidence` field stops being the only thing a caller can consult.
 */
function assessAll(input: BuildPlanInput): BreakingChange[] {
  const { evidence, breakingChanges, impactSites } = input;
  const localizationRan = input.localizationRan ?? true;

  return breakingChanges.map((change) => {
    const sites = impactSites.filter((site) => site.breakingChangeId === change.id);
    // Normalised here so every finding on a plan carries one, whatever the
    // caller supplied.
    const taxonomy = taxonomyOf(change);
    const runtimeState = (input.runtimeAnalyses ?? []).find((analysis) => analysis.changeId === change.id)?.state;
    // An outcome with no `dependency` is a repo-wide check (typecheck, build)
    // and applies to every finding. One that names `breakingChangeIds` is
    // scoped to those exact findings — the precise case, since a dependency
    // can have several distinct breaking changes and a probe of one symbol
    // says nothing about another. Falling back to dependency/workspace
    // matching only covers the coarser case (e.g. an outcome that never
    // learned which change it cited); either way, a behavioural probe of
    // dependency A must never raise verification confidence for dependency
    // B's unrelated finding, and a probe of one finding must never raise it
    // for a sibling finding on the same dependency.
    const outcomes = (input.verification ?? []).filter((outcome) => {
      if (outcome.breakingChangeIds !== undefined) return outcome.breakingChangeIds.includes(change.id);
      if (outcome.dependency === undefined) return true;
      return outcome.dependency === change.dependency && outcome.workspace === change.workspace;
    });
    const assessment = assess({
      change,
      taxonomy,
      evidence,
      sites,
      localizationRan,
      runtimeState,
      outcomes,
      checkedSurfaces: input.checkedSurfaces ?? [],
      gaps: [],
    });

    return { ...change, taxonomy, assessment };
  });
}

/**
 * Everything Drift could not establish, as records rather than prose.
 *
 * The rule this encodes: an unchecked surface is never reported as a clean one.
 * Each entry says what was not established, how much it matters, and what it
 * means for acting automatically — so nobody has to infer severity from tone.
 */
function collectGaps(
  input: BuildPlanInput,
  breakingChanges: readonly BreakingChange[],
  commits: readonly { breakingChangeIds: string[] }[],
): AnalysisGap[] {
  const { changes, evidence, impactSites, config } = input;
  const gaps: AnalysisGap[] = [];
  const localizationRan = input.localizationRan ?? true;

  if (!localizationRan && breakingChanges.length > 0) {
    gaps.push({
      stage: 'localize',
      surface: 'repository source',
      reason:
        'No checkout was available, so Drift could not search this repository for affected code. Zero impact sites here means "not searched", not "not affected".',
      severity: 'blocking',
      automaticExecution: 'blocks',
      remediation:
        'Run Drift as a GitHub Action or from the CLI in a checkout. The webhook runner cannot localize — see docs/deployment.md.',
    });
  }

  // Dependencies for which nothing but a version number could be retrieved.
  for (const change of changes) {
    const records = evidence.filter((e) => e.dependency === change.name && e.workspace === change.workspace);
    const substantive = records.filter(
      (e) => e.source !== 'semver-heuristic' && e.source !== 'registry-metadata',
    );
    if (substantive.length === 0) {
      gaps.push({
        stage: 'evidence',
        ecosystem: change.ecosystem,
        dependency: change.name,
        surface: 'upstream release evidence',
        reason:
          `No changelog, release notes, migration guide, or API diff could be retrieved for ${change.name}. ` +
          'Drift will not dispatch a fix based on a version number alone.',
        severity: 'significant',
        // `requireEvidence` is what decides whether this stops a run. The gap is
        // recorded either way, because the surface was unchecked either way.
        automaticExecution:
          config.guardrails.requireEvidence && breakingChanges.length > 0 ? 'blocks' : 'degrades',
        remediation:
          'Check the package publishes release notes Drift can reach, or review this upgrade by hand.',
      });
    }
  }

  // Findings that are real upstream but that nothing local could confirm.
  for (const change of breakingChanges) {
    const sites = impactSites.filter((s) => s.breakingChangeId === change.id);
    if (sites.length > 0) continue;
    if (!isLocallyUnprovable(taxonomyOf(change))) continue;

    gaps.push({
      stage: 'localize',
      dependency: change.dependency,
      surface: `reachability of ${change.symbols.slice(0, 3).join(', ') || change.dependency}`,
      reason: `${change.summary} is only observable at runtime, so searching the source cannot establish whether this repository is affected.`,
      severity: 'significant',
      automaticExecution: 'degrades',
      remediation: 'Confirm by exercising the affected paths, or review the upstream notes directly.',
    });
  }

  // Nothing ran that could confirm the fix compiles or behaves.
  //
  // Behavioural probes are excluded from this check even though they populate
  // `input.verification` too: they confirm something about the *dependency*,
  // not about a fix Drift would write, so their presence must not silence the
  // one gap that specifically warns "nothing confirms a fix would compile".
  const structuralOutcomes = (input.verification ?? []).filter((o) => !o.name.startsWith('behavioural:'));
  if (structuralOutcomes.length === 0 && commits.length > 0) {
    gaps.push({
      stage: 'verify',
      surface: 'build, typecheck, and test',
      reason:
        'No checks were run against this plan, so nothing confirms the findings were understood correctly or that a fix would compile.',
      severity: 'significant',
      automaticExecution: 'degrades',
      remediation:
        'Configure the repository checks Drift should run, or review the resulting pull request against CI before merging.',
    });
  }

  // Ecosystem capability gaps. A stage that cannot run at all for an ecosystem
  // is the same kind of fact as a changelog that could not be fetched — it is a
  // surface that went unchecked — so it lives in the same model rather than in
  // a separate section a reader has to correlate by hand.
  for (const ecosystem of [...new Set(changes.map((c) => c.ecosystem))].sort()) {
    const capability = capabilitiesFor(ecosystem);

    for (const stage of CAPABILITY_STAGES) {
      // `partial` is the norm; saying so every time would bury the real gaps.
      if (capability.support[stage].level !== 'none') continue;

      gaps.push({
        stage: mapCapabilityStage(stage),
        ecosystem,
        surface: STAGE_LABEL[stage],
        reason: capability.support[stage].note ?? `${STAGE_LABEL[stage]} does not run for ${ecosystem}.`,
        severity: 'significant',
        // A limit of the tool, not a finding about the upgrade. It lowers what
        // the report can claim without stopping a run that is otherwise sound.
        automaticExecution: 'degrades',
        remediation: `Drift cannot run this stage for ${ecosystem}; review this surface by hand.`,
      });
    }
  }

  return gaps;
}

/** Capability stages and gap stages name the same pipeline at different grain. */
function mapCapabilityStage(stage: CapabilityStage): AnalysisGap['stage'] {
  switch (stage) {
    case 'detect':
      return 'detect';
    case 'evidence':
    case 'surface':
      return 'evidence';
    case 'static-analysis':
      return 'localize';
    case 'verify':
      return 'verify';
    // `fix` and `pull-request` are downstream of analysis; a gap there is a
    // limit on acting, which the plan expresses through blockers instead.
    default:
      return 'plan';
  }
}

/**
 * Branch naming.
 *
 * Encodes the dependency and version move so the branch is self-describing in
 * a branch list, and uses the run date rather than a commit hash so repeat
 * upgrades are readable before a human opens the PR.
 *
 * Delegates to `plan/pull-request.ts`, which the extension and the CLI use
 * too — so the same upgrade produces the same branch name wherever it was
 * started from. A team that has learned to recognise `drift/upgrade-…` should
 * not have to learn a second shape because someone clicked instead of pushing.
 */
export function branchNameFor(
  config: DriftConfig,
  changes: readonly DependencyChange[],
  afterSha: string,
): string {
  // `afterSha` deliberately does not appear in the name: the branch name is
  // stable across retries of the same analysed commit (see `createBranch`'s
  // idempotency contract in `github/client.ts`), which keeps branch names
  // readable instead of a hash. Staleness across a moved base branch is
  // guarded in `createBranch`, which verifies the existing branch is still
  // built on `afterSha` before treating "ref already exists" as success.
  void afterSha;
  return branchName(
    { changes },
    {
      branch: config.pullRequest.branchTemplate,
      prefix: config.remediation.branchPrefix,
    },
  );
}

/**
 * Aggregate risk.
 *
 * Risk is driven by what Drift is being asked to *change*, not by how alarming
 * the upstream release sounds. A major bump with two well-understood renames
 * is lower risk than a minor bump that silently altered behaviour in code
 * Drift can only partly see.
 */
export function assessRisk(
  changes: readonly DependencyChange[],
  breakingChanges: readonly BreakingChange[],
  impactSites: readonly ImpactSite[],
  /**
   * Runtime compatibility states from the rationale, when one was computed.
   *
   * Passed in because `'none'` — the strongest thing this function says — is
   * otherwise reached purely by `impactSites` being empty, which a runtime
   * requirement Drift could not resolve produces just as readily as an
   * upgrade that provably touches nothing.
   */
  runtimeStates: readonly (string | undefined)[] = [],
  dispositions?: readonly BreakingChangeDisposition[],
): RiskLevel {
  const runtimeUnresolved = runtimeStates.some((state) => state === 'unknown' || state === 'partial');
  const localReview = dispositions?.some((d) => d.state === 'review-only' || d.state === 'unknown') ?? false;
  const actionableSites = dispositions
    ? dispositions.flatMap((disposition) => disposition.actionableSites)
    : impactSites;
  if (breakingChanges.length === 0 || actionableSites.length === 0) return runtimeUnresolved || localReview ? 'low' : 'none';

  let risk: RiskLevel = 'low';
  const raise = (level: RiskLevel) => {
    if (compareRisk(level, risk) > 0) risk = level;
  };

  const fileCount = new Set(actionableSites.map((s) => s.file)).size;
  if (fileCount > 5 || actionableSites.length > 20) raise('medium');
  if (fileCount > 20 || actionableSites.length > 75) raise('high');

  const relevantChangeIds = new Set(
    (dispositions ?? []).filter((d) => d.state !== 'unaffected').map((d) => d.changeId),
  );
  for (const change of breakingChanges.filter((change) => relevantChangeIds.size === 0 || relevantChangeIds.has(change.id))) {
    // Behaviour changes are the dangerous class: the code still compiles, so
    // neither the type checker nor an agent's smoke test will catch a wrong fix.
    if (change.kind === 'behaviour-change' || change.kind === 'default-change') raise('high');
    if (change.kind === 'unknown') raise('medium');
    if (change.confidence === 'low') raise('medium');
  }

  for (const change of changes) {
    if (change.bump === 'major') raise('medium');
    if (isDowngrade(change.from, change.to)) raise('high');
  }

  // Test files being touched is a warning sign worth escalating: the fix may
  // be adjusting the test rather than the code the test protects.
  if (actionableSites.some((s) => isTestPath(s.file))) raise('medium');

  return risk;
}

interface GuardrailResult {
  blockers: string[];
  warnings: string[];
}

function evaluateGuardrails(
  input: BuildPlanInput,
  breakingChanges: readonly BreakingChange[],
  commits: readonly { files: string[]; breakingChangeIds: string[] }[],
  risk: RiskLevel,
  gaps: readonly AnalysisGap[],
): GuardrailResult {
  const { config, changes, impactSites, skipped = [] } = input;
  const guardrails = config.guardrails;

  const blockers: string[] = [];
  const warnings: string[] = [];

  const touchedFiles = [...new Set(commits.flatMap((c) => c.files))];

  if (touchedFiles.length > guardrails.maxFilesChanged) {
    blockers.push(
      `This plan would touch ${touchedFiles.length} files, above the \`maxFilesChanged\` limit of ${guardrails.maxFilesChanged}. A change this wide should be read by a person before an agent starts editing.`,
    );
  }

  if (changes.length > guardrails.maxDependenciesPerRun) {
    blockers.push(
      `${changes.length} dependencies moved in one commit, above the \`maxDependenciesPerRun\` limit of ${guardrails.maxDependenciesPerRun}. Batched upgrades make it hard to attribute a regression to the dependency that caused it.`,
    );
  }

  const protectedHits = touchedFiles.filter((f) => matchesAny(guardrails.protectedPaths, f));
  if (protectedHits.length > 0) {
    blockers.push(
      `Impact sites fall inside protected paths: ${protectedHits.slice(0, 5).join(', ')}${protectedHits.length > 5 ? `, +${protectedHits.length - 5} more` : ''}. Drift will not direct an agent to edit these.`,
    );
  }

  const alwaysApprove = changes.filter((c) => matchesAny(config.alwaysApprove, c.name));
  if (alwaysApprove.length > 0) {
    blockers.push(
      `${alwaysApprove.map((c) => c.name).join(', ')} matched \`alwaysApprove\` in drift.yml.`,
    );
  }

  // `requireEvidence` is enforced through the gap records — see `collectGaps`,
  // which is the single place that decides what counts as an unchecked surface.

  /*
   * `minConfidence`, as a blocker.
   *
   * This was a warning, which made the setting a lie: a repository configured
   * for `high` would still dispatch an agent against a low-confidence guess,
   * having recorded its own doubt in a paragraph nobody had to read.
   *
   * Only *actionable* findings count — ones Drift planned a commit for. A
   * low-confidence finding with no planned edit is information, and blocking on
   * it would train people to raise the threshold until it stopped mattering.
   *
   * Blocking does not discard the plan. It falls back to approval: the full
   * plan is filed, and one comment from someone with write access proceeds.
   */
  const plannedChangeIds = new Set(commits.flatMap((c) => c.breakingChangeIds));
  const actionableBelowConfidence = breakingChanges.filter(
    (c) => plannedChangeIds.has(c.id) && !meetsConfidence(effectiveConfidence(c), guardrails.minConfidence),
  );

  if (actionableBelowConfidence.length > 0) {
    const detail = actionableBelowConfidence
      .slice(0, 3)
      .map((c) => `\`${c.dependency}\`: ${c.summary}`)
      .join('; ');

    if (guardrails.experimentalDispatchBelowMinConfidence) {
      warnings.push(
        `${actionableBelowConfidence.length} finding(s) are below the \`minConfidence\` threshold of ` +
          `\`${guardrails.minConfidence}\` but \`experimentalDispatchBelowMinConfidence\` is on, so Drift will ` +
          `dispatch anyway. ${detail}.`,
      );
    } else {
      blockers.push(
        `${actionableBelowConfidence.length} finding(s) Drift planned commits for are below the ` +
          `\`minConfidence\` threshold of \`${guardrails.minConfidence}\`: ${detail}. ` +
          'The plan is filed for review rather than dispatched.',
      );
    }
  }

  // Below the threshold but nothing planned — worth stating, not worth blocking.
  const belowConfidenceUnplanned = breakingChanges.filter(
    (c) => !plannedChangeIds.has(c.id) && !meetsConfidence(effectiveConfidence(c), guardrails.minConfidence),
  );
  if (belowConfidenceUnplanned.length > 0) {
    warnings.push(
      `${belowConfidenceUnplanned.length} finding(s) are below the \`minConfidence\` threshold and no commit was planned for them. They are listed for awareness.`,
    );
  }

  const blockingGaps = gaps.filter((gap) => gap.automaticExecution === 'blocks');
  for (const gap of blockingGaps) {
    blockers.push(`${gap.reason} ${gap.remediation}`);
  }

  if (!riskWithinLimit(risk, config.maxAutoRisk)) {
    blockers.push(
      `Assessed risk is \`${risk}\`, above the \`maxAutoRisk\` ceiling of \`${config.maxAutoRisk}\`.`,
    );
  }

  const testSites = impactSites.filter((s) => isTestPath(s.file));
  if (testSites.length > 0) {
    warnings.push(
      `${testSites.length} impact site(s) are in test files. Confirm the fix updates tests to match the new API rather than weakening what they assert.`,
    );
  }

  const changesWithoutSites = breakingChanges.filter(
    (c) => !impactSites.some((s) => s.breakingChangeId === c.id),
  );
  if (changesWithoutSites.length > 0) {
    warnings.push(
      `${changesWithoutSites.length} breaking change(s) were identified upstream but no usage was found in this repository. They are listed for awareness and no commit was planned for them.`,
    );
  }

  for (const entry of skipped) {
    warnings.push(`Skipped \`${entry.change.name}\`: ${entry.reason}.`);
  }

  return { blockers, warnings };
}

/** Heuristic test-path detection across the ecosystems Drift supports. */
export function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    /(^|\/)(tests?|__tests__|spec|specs|e2e|integration_tests)\//.test(lower) ||
    /\.(test|spec)\.[jt]sx?$/.test(lower) ||
    /(^|\/)test_[^/]+\.py$/.test(lower) ||
    /_test\.(py|go|rb)$/.test(lower) ||
    /_spec\.rb$/.test(lower) ||
    /Test\.java$/.test(path) ||
    /Tests?\.kt$/.test(path)
  );
}

/** True when the plan is safe to dispatch without asking a human. */
export function isAutoDispatchable(plan: RemediationPlan, config: DriftConfig): boolean {
  if (config.mode !== 'auto') return false;
  if (plan.blockers.length > 0) return false;
  if (plan.commits.length === 0) return false;
  return riskWithinLimit(plan.risk, config.maxAutoRisk);
}

export function highestConfidence(changes: readonly BreakingChange[]): Confidence {
  if (changes.some((c) => c.confidence === 'high')) return 'high';
  if (changes.some((c) => c.confidence === 'medium')) return 'medium';
  return 'low';
}

export * from './commits.js';
