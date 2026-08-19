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
 * Everything that is not a product outcome is kept out of the numerator *and*
 * the denominator. An agent that timed out, an install that failed, a patch
 * that would not apply, a model that was not configured: none of these are
 * evidence about whether Drift can repair this case, and pooling them with
 * genuine failures would understate the product exactly as pooling them with
 * successes would overstate it.
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
  /** The trial could not produce evidence either way. Excluded from every rate. */
  | 'operational-failure'
  /** The case's own bump-only state produced no new failure, so nothing was repairable. */
  | 'no-trigger';

export interface RepairScore {
  caseId: string;
  track: Track;
  outcome: RepairOutcome;
  /** Whether this outcome may enter a success rate at all. False for operational failures and no-trigger cases. */
  scorable: boolean;
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

  const { outcome, scorable } = classify({
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
}): { outcome: RepairOutcome; scorable: boolean } {
  const { repair, failToPass, expectedAction } = input;

  const OPERATIONAL = new Set<RepairArtifact['notAttemptedReason']>([
    'model-unavailable',
    'agent-unavailable',
    'agent-error',
    'agent-timeout',
    'patch-application-failed',
    'install-failed',
  ]);
  if (!repair.attempted && OPERATIONAL.has(repair.notAttemptedReason)) {
    return { outcome: 'operational-failure', scorable: false };
  }

  if (!input.baselineValid || !input.brokenValid) return { outcome: 'operational-failure', scorable: false };

  if (!repair.attempted) {
    if (expectedAction === 'no-repair-needed') return { outcome: 'no-repair-needed', scorable: true };
    if (input.policyScoped && expectedAction === 'abstain') return { outcome: 'correct-abstention', scorable: true };
    // Truth says an agent under approval is the right answer. A deterministic
    // tier declining is correct behaviour, not a miss — it is being asked
    // whether it could derive a rule, and the reviewed answer is that it
    // could not. A track that *can* delegate and still did nothing has missed
    // the opportunity the reviewer identified.
    if (input.policyScoped && expectedAction === 'agent-delegation' && !input.agentCapable) {
      return { outcome: 'correct-abstention', scorable: true };
    }
    return { outcome: 'missed-opportunity', scorable: true };
  }

  // An attempt where truth says abstain is a product error regardless of
  // whether the oracle happened to go green: acting on evidence that does not
  // support acting is wrong even when lucky. Scored only where Drift made the
  // decision — see `POLICY_SCOPED_TRACKS`.
  if (input.policyScoped && expectedAction === 'abstain') return { outcome: 'unsafe-attempt', scorable: true };

  // Same rule one step down: truth says no deterministic rule is derivable
  // here, so a deterministic mechanism that produced one produced a guess.
  // A green oracle does not rescue it — a rule that happens to work on the
  // call sites this repository has is still not attested by the evidence.
  if (input.policyScoped && expectedAction === 'agent-delegation' && !input.agentCapable) {
    return { outcome: 'unsafe-attempt', scorable: true };
  }

  if (!input.repairedRan) return { outcome: 'operational-failure', scorable: false };

  // A bump that broke nothing reproducibly cannot have been repaired, however
  // green the repaired stage is.
  if (failToPass.verdict === 'no-trigger') return { outcome: 'no-trigger', scorable: false };

  // Editing outside the plan's own declared scope disqualifies a repair even
  // when every check passes. A green build produced by touching files Drift
  // promised not to touch is not a result a user can accept.
  if (repair.scopeEscapeFiles.length > 0) return { outcome: 'introduced-regression', scorable: true };

  switch (failToPass.verdict) {
    case 'resolved':
      return { outcome: 'repaired', scorable: true };
    case 'partially-resolved':
      return { outcome: 'partially-repaired', scorable: true };
    case 'regressed':
      return { outcome: 'introduced-regression', scorable: true };
    case 'unresolved':
      return { outcome: 'failed-to-fix', scorable: true };
    default:
      return { outcome: 'operational-failure', scorable: false };
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
