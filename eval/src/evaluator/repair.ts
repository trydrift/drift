import type { OracleStageArtifact, RepairArtifact, Track } from '../artifacts/prediction.ts';
import type { Conclusion } from '../review.ts';
import { analyzeFailToPass, type FailToPassAnalysis } from '../oracle/signature.ts';
import { normalizePatch } from '../adapters/repair-capture.ts';

/**
 * Repair scoring.
 *
 * The single rule that matters: a repair is credited only when an *executable*
 * oracle says the specific failures the upgrade introduced are gone and
 * nothing that used to pass now fails. Textual similarity to the developer's
 * own patch is never a gate — it is reported, because a diff that matches is
 * mildly reassuring, and ignored in the verdict, because a semantically
 * correct migration that reads differently is still correct and a benchmark
 * that punishes it is measuring conformity rather than repair.
 *
 * Three kinds of non-success are kept apart, because pooling them is how a
 * repair rate stops describing the product.
 *
 *   `case-invalid`            the benchmark could not set the case up, so no
 *                             observation after that point means anything.
 *   `environment-unavailable` a tier was never asked, because the input or
 *                             provider it needs does not exist here.
 *   `delivery-failure`        Drift started on a valid case and could not
 *                             finish: the agent errored, the patch would not
 *                             apply, the install fell over.
 *
 * The first two leave the denominator with a reason attached. The third stays
 * in it. That split is the correction: all three used to be one
 * `operational-failure` that left every rate, so an end-to-end repair number
 * could be improved by failing in a different way — every case Drift began and
 * could not finish quietly stopped counting, and the headline described only
 * the attempts that survived long enough to be judged.
 */

export type RepairOutcome =
  /** Trigger failures resolved, nothing regressed, no scope escape. */
  | 'repaired'
  /** Some trigger failures resolved, others remain. Not a success. */
  | 'partially-repaired'
  /** A repair was applied and the trigger failures survived it. */
  | 'failed-to-fix'
  /** A repair was applied and something that previously passed now fails. */
  | 'introduced-regression'
  /** Drift declined, and adjudicated truth says declining was right. */
  | 'correct-abstention'
  /** Drift declined where truth says a safe mechanical repair existed. */
  | 'missed-opportunity'
  /** Drift attempted where truth says it should have declined. */
  | 'unsafe-attempt'
  /** No repair was needed and none was attempted. */
  | 'no-repair-needed'
  /**
   * Drift began its product path on a valid case and failed to produce or
   * validate a repair: the agent errored, timed out or was unavailable when
   * the hierarchy actually reached it, a patch would not apply, a
   * remediation-time install failed, a tier claimed a commit and emitted no
   * diff, or Drift's own scope gate rejected what came back.
   *
   * This is a product outcome, not an infrastructure one, and it stays in the
   * denominator. It used to be pooled into `operational-failure` and dropped
   * from every rate, which meant an end-to-end repair rate could be improved
   * by failing differently: every case Drift started and could not finish left
   * the denominator, so the headline described only the attempts that survived
   * long enough to be judged.
   */
  | 'delivery-failure'
  /**
   * A tier that was never asked, because the input or provider it needs does
   * not exist on this machine: no plan cache, no recipe candidate, no
   * configured model, no agent CLI for a track whose whole subject is the
   * agent. Excluded from every rate with its reason preserved — a mechanism
   * nobody invoked has not declined and has not failed.
   */
  | 'environment-unavailable'
  /**
   * The case itself did not behave as declared before Drift was judged on it:
   * the baseline did not pass, the bump-only state did not fail, or the
   * repaired stage could not be run at all. No observation after that point is
   * interpretable, so nothing is scored — and this is deliberately kept apart
   * from `delivery-failure`, because one is the benchmark failing and the
   * other is the product failing.
   */
  | 'case-invalid'
  /** The case's own bump-only state produced no new failure, so nothing was repairable. */
  | 'no-trigger';

export interface RepairScore {
  caseId: string;
  track: Track;
  outcome: RepairOutcome;
  /**
   * Whether this outcome may enter a success rate at all.
   *
   * True for every product outcome, `delivery-failure` included. False only
   * where the benchmark or the machine — not Drift — is why there is nothing
   * to judge.
   */
  scorable: boolean;
  /** Why this outcome left the denominator, or `null` when it did not. Every exclusion has one. */
  exclusionReason: string | null;
  failToPass: FailToPassAnalysis;
  attempted: boolean;
  notAttemptedReason: RepairArtifact['notAttemptedReason'];
  /** Drift's plan disobeying its own declared scope. A production-safety failure and CI-blocking. */
  productionScopeEscapes: string[];
  /** In-scope files the adjudicated truth did not expect. A benchmark-quality signal, never CI-blocking. */
  unexpectedChangedFiles: string[];
  changedFiles: { tp: number; fp: number; fn: number };
  /** Diagnostic only. `not-applicable` when nothing was compared — never `false` for "we did not look". */
  goldPatchExact: boolean | 'not-applicable';
  patchStats: RepairArtifact['patchStats'];
  residualImpactSites: number;
  resolvedByTier: RepairArtifact['resolvedByTier'];
}

/**
 * Tracks where Drift itself decides whether to act, and is therefore
 * answerable for that decision.
 *
 * `repair-agent` is deliberately absent. Run standalone, the harness points
 * the agent at exactly the commits Drift's planner already routed to the agent
 * tier — so "should Drift have acted here?" was decided upstream, by the
 * planner, and scoring the agent against an abstention expectation would blame
 * it for a decision it never made. That policy question is answered by
 * `repair-full-remediation`, where Drift chooses its own tier; the agent track
 * answers the capability question, "given Drift handed this to an agent, did
 * the agent repair it correctly?".
 *
 * This distinction is not cosmetic: the first run of the agent track scored
 * six of twelve trials as `unsafe-attempt` — including three that produced a
 * repair the oracle confirmed correct — purely because adjudicated truth said
 * `abstain`, and that adjudication was reasoned about what a *deterministic*
 * tier could safely guess.
 */
const POLICY_SCOPED_TRACKS = new Set<Track>([
  'repair-codemod',
  'repair-fixplan-cache',
  'repair-fixplan-recipe',
  'repair-fixplan-model',
  'repair-full-remediation',
]);

export function isPolicyScoped(track: Track): boolean {
  return POLICY_SCOPED_TRACKS.has(track);
}

/**
 * Tracks that may reach the coding-agent tier.
 *
 * `agent-delegation` truth says an agent under approval is the right answer
 * and a deterministic rule is not derivable. Only a track that can actually
 * delegate is entitled to act on that; a deterministic mechanism that acts
 * anyway is guessing, which is the behaviour the value exists to forbid.
 */
const AGENT_CAPABLE_TRACKS = new Set<Track>(['repair-agent', 'repair-full-remediation']);

export function canDelegateToAgent(track: Track): boolean {
  return AGENT_CAPABLE_TRACKS.has(track);
}

export interface ScoreRepairInput {
  caseId: string;
  track: Track;
  repair: RepairArtifact;
  oracleStages: readonly OracleStageArtifact[];
  truth: Conclusion;
  /** The developer/gold patch from private truth, when the case has one. */
  developerPatch: string | null;
}

export function scoreRepair(input: ScoreRepairInput): RepairScore {
  const { caseId, track, repair, truth } = input;
  const stage = (name: OracleStageArtifact['stage']): OracleStageArtifact | undefined =>
    input.oracleStages.find((entry) => entry.stage === name);

  const baseline = stage('baseline');
  const broken = stage('broken');
  const repaired = stage('repaired');

  const failToPass = analyzeFailToPass({
    baseline: baseline?.signature ?? [],
    broken: broken?.signature ?? [],
    ...(repaired ? { repaired: repaired.signature } : {}),
  });

  const expectedAction = truth.repair.expectedAction;
  const expectedChangedFiles = new Set(truth.repair.expectedChangedFiles);
  const actualChangedFiles = new Set(repair.changedFiles);

  const changedFiles = {
    tp: [...expectedChangedFiles].filter((file) => actualChangedFiles.has(file)).length,
    fp: [...actualChangedFiles].filter((file) => !expectedChangedFiles.has(file)).length,
    fn: [...expectedChangedFiles].filter((file) => !actualChangedFiles.has(file)).length,
  };

  const goldPatchExact: boolean | 'not-applicable' =
    !repair.attempted || !input.developerPatch
      ? 'not-applicable'
      : normalizePatch(repair.patch) === normalizePatch(input.developerPatch);

  const { outcome, scorable, exclusionReason } = classify({
    repair,
    failToPass,
    policyScoped: isPolicyScoped(track),
    agentCapable: canDelegateToAgent(track),
    expectedAction,
    baselineValid: baseline === undefined || baseline.matchesExpectation,
    brokenValid: broken === undefined || broken.matchesExpectation,
    repairedRan: repaired !== undefined && repaired.observed !== 'unable-to-run',
  });

  return {
    caseId,
    track,
    outcome,
    scorable,
    exclusionReason,
    failToPass,
    attempted: repair.attempted,
    notAttemptedReason: repair.notAttemptedReason,
    productionScopeEscapes: repair.scopeEscapeFiles,
    unexpectedChangedFiles: [...actualChangedFiles].filter((file) => !expectedChangedFiles.has(file)).sort(),
    changedFiles,
    goldPatchExact,
    patchStats: repair.patchStats,
    residualImpactSites: repair.residualImpactSites,
    resolvedByTier: repair.resolvedByTier,
  };
}

/**
 * Outcome classification, in the order the checks actually gate each other.
 *
 * Operational failures come first, because a trial that could not run says
 * nothing about the product. Case validity comes next: if the baseline did not
 * pass or the bump-only state did not fail as declared, no observation after
 * that point is interpretable, and crediting a repair there would credit a
 * repair of a case the harness has just shown it does not understand.
 * Abstention policy is judged before execution, because "should Drift have
 * acted?" and "did what it did work?" are separate questions and only the
 * first applies when nothing was attempted.
 */
function classify(input: {
  repair: RepairArtifact;
  failToPass: FailToPassAnalysis;
  policyScoped: boolean;
  agentCapable: boolean;
  expectedAction: Conclusion['repair']['expectedAction'];
  baselineValid: boolean;
  brokenValid: boolean;
  repairedRan: boolean;
}): { outcome: RepairOutcome; scorable: boolean; exclusionReason: string | null } {
  const { repair, failToPass, expectedAction } = input;

  const excluded = (outcome: RepairOutcome, exclusionReason: string) => ({ outcome, scorable: false, exclusionReason });
  const scored = (outcome: RepairOutcome) => ({ outcome, scorable: true, exclusionReason: null });

  /**
   * Tiers that were never invoked, because what they run on does not exist on
   * this machine. A cache entry is a plan an earlier run authored, a recipe is
   * a third-party package, a model needs a configured provider, and the
   * standalone agent track needs the agent CLI it exists to measure. None of
   * them declined and none of them failed; asking them was impossible.
   */
  const NEVER_ASKED = new Set<RepairArtifact['notAttemptedReason']>([
    'model-unavailable',
    'cache-unavailable',
    'recipe-unavailable',
    'agent-unavailable',
  ]);

  /**
   * Drift's own path, begun and not finished.
   *
   * `agent-required-unavailable` is the one that matters most and is
   * deliberately distinct from `agent-unavailable`: it means the hierarchy
   * actually routed work to the agent tier and found nothing there to route it
   * to. On the end-to-end track that is a case Drift did not deliver, and it
   * used to be recorded as `abstained-by-policy` — a missing agent CLI
   * presented as a considered product decision to decline.
   */
  const DELIVERY = new Set<RepairArtifact['notAttemptedReason']>([
    'agent-required-unavailable',
    'agent-error',
    'agent-timeout',
    'patch-application-failed',
    'install-failed',
    'scope-validation-rejected',
    'empty-patch',
  ]);

  if (!repair.attempted && NEVER_ASKED.has(repair.notAttemptedReason)) {
    return excluded('environment-unavailable', repair.notAttemptedReason!);
  }
  if (!repair.attempted && DELIVERY.has(repair.notAttemptedReason)) {
    return scored('delivery-failure');
  }

  // Case validity, before anything about Drift is read. A consumer that was
  // already failing its own check, or a bump that did not break it, makes
  // every later observation uninterpretable.
  if (!input.baselineValid) return excluded('case-invalid', 'baseline stage did not behave as the case declares');
  if (!input.brokenValid) return excluded('case-invalid', 'bump-only stage did not behave as the case declares');

  if (!repair.attempted) {
    if (expectedAction === 'no-repair-needed') return scored('no-repair-needed');
    if (input.policyScoped && expectedAction === 'abstain') return scored('correct-abstention');
    // Truth says an agent under approval is the right answer. A deterministic
    // tier declining is correct behaviour, not a miss — it is being asked
    // whether it could derive a rule, and the reviewed answer is that it
    // could not. A track that *can* delegate and still did nothing has missed
    // the opportunity the reviewer identified.
    if (input.policyScoped && expectedAction === 'agent-delegation' && !input.agentCapable) {
      return scored('correct-abstention');
    }
    return scored('missed-opportunity');
  }

  // An attempt where truth says abstain is a product error regardless of
  // whether the oracle happened to go green: acting on evidence that does not
  // support acting is wrong even when lucky. Scored only where Drift made the
  // decision — see `POLICY_SCOPED_TRACKS`.
  if (input.policyScoped && expectedAction === 'abstain') return scored('unsafe-attempt');

  // Same rule one step down: truth says no deterministic rule is derivable
  // here, so a deterministic mechanism that produced one produced a guess.
  // A green oracle does not rescue it — a rule that happens to work on the
  // call sites this repository has is still not attested by the evidence.
  if (input.policyScoped && expectedAction === 'agent-delegation' && !input.agentCapable) {
    return scored('unsafe-attempt');
  }

  // The repaired stage could not be run — an install that fell over inside the
  // oracle, a patch the oracle could not stage. That is the benchmark failing
  // to observe, not Drift failing to repair.
  if (!input.repairedRan) return excluded('case-invalid', 'repaired stage could not be run');

  // A bump that broke nothing reproducibly cannot have been repaired, however
  // green the repaired stage is.
  if (failToPass.verdict === 'no-trigger') return excluded('no-trigger', 'the bump-only state produced no new failure');

  // Editing outside the plan's own declared scope disqualifies a repair even
  // when every check passes. A green build produced by touching files Drift
  // promised not to touch is not a result a user can accept.
  if (repair.scopeEscapeFiles.length > 0) return scored('introduced-regression');

  switch (failToPass.verdict) {
    case 'resolved':
      return scored('repaired');
    case 'partially-resolved':
      return scored('partially-repaired');
    case 'regressed':
      return scored('introduced-regression');
    case 'unresolved':
      return scored('failed-to-fix');
    default:
      // `not-attempted` with `repair.attempted` true: the repaired stage never
      // produced a signature to compare. Nothing about Drift is observable.
      return excluded('case-invalid', 'no repaired-stage signature to compare against');
  }
}

/** The outcomes that count as a success in a repair rate. Exactly one of them. */
export function isRepairSuccess(outcome: RepairOutcome): boolean {
  return outcome === 'repaired';
}

/**
 * The outcomes that count as a *correct product decision*, which is a broader
 * and separately reported question: correctly declining to touch a migration
 * no tool should guess at is a good outcome, and a benchmark that only counted
 * repairs would push a tool toward guessing.
 */
export function isCorrectDecision(outcome: RepairOutcome): boolean {
  return outcome === 'repaired' || outcome === 'correct-abstention' || outcome === 'no-repair-needed';
}
