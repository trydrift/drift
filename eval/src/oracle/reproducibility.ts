import type { PublicCase, CaseStatus, FailureCategory, HiddenCheck } from '../case/schema.ts';
import type { MaterializedCase } from '../case/materialize.ts';
import type { OracleStageArtifact } from '../artifacts/prediction.ts';
import { runCaseStage } from './stage.ts';

/**
 * The reproducibility gate: what a case must survive before any Drift result
 * measured on it means anything.
 *
 * BUMP established the discipline this follows. It reproduced every candidate
 * breaking update locally, ran each three times, on two platforms, with the
 * network disconnected, and discarded 57 of 628 candidates for flaky tests or
 * system-configuration dependence — keeping 571. That discard rate is the
 * point: roughly one candidate in eleven looked like a real breaking update
 * and was not, and a benchmark that skips this step reports that noise as
 * product accuracy.
 *
 * Three repetitions is the minimum here for the same reason it was there.
 * Repetition catches the flakiness that a single run cannot see, and the
 * threshold is stated in the case rather than assumed, so a case that needs a
 * stricter rule can say so.
 *
 * What this gate cannot do is claim cross-platform reproducibility from one
 * platform. It records the platform it verified and nothing more; a case
 * verified only on darwin says `darwin`, not "reproducible".
 */

export const REPRODUCIBILITY_VERSION = 'repro-gate-v1';

export interface ReproducibilityOptions {
  /** Independent repetitions of each stage. Never fewer than 3 without a documented reason on the case. */
  repetitions?: number;
  /** Runs the gold/developer patch as a third stage, proving the recorded repair actually repairs. */
  goldRepair?: (consumerDir: string) => Promise<void>;
  /**
   * Benchmark-added behavioural assertions, run in every stage.
   *
   * Running them here is what makes them trustworthy rather than merely
   * strict. A hidden check that already fails on the baseline is asserting
   * something that was never true, and the gate reports that as
   * `invalid-baseline` — so a check cannot quietly disqualify every repair of
   * a case because it was written wrong.
   */
  hiddenChecks?: readonly HiddenCheck[];
}

export interface StageRepetitions {
  stage: 'baseline' | 'broken' | 'gold-repaired';
  runs: OracleStageArtifact[];
  /** Every repetition observed the same outcome AND the same failure signature. */
  stable: boolean;
  /** The signature every repetition agreed on, or `null` when they disagreed. */
  agreedSignature: string[] | null;
}

export interface ReproducibilityReport {
  caseId: string;
  gateVersion: string;
  platform: string;
  arch: string;
  repetitions: number;
  stages: StageRepetitions[];
  /** `broken \ baseline`, agreed across every repetition. Empty means the bump broke nothing reproducibly. */
  triggerSignature: string[];
  baselineSignature: string[];
  /** What the observed failures actually are, derived from the agreed signature rather than declared by the case. */
  observedFailureCategory: FailureCategory;
  /** The status this evidence supports. Never upgrades a case on its own — `eval:cases:reproduce` writes it. */
  verdict: Extract<
    CaseStatus,
    'benchmark-ready' | 'flaky' | 'invalid-baseline' | 'non-causal' | 'oracle-insufficient' | 'environment-unavailable'
  >;
  reason: string;
}

export async function checkReproducibility(
  publicCase: PublicCase,
  materialized: MaterializedCase,
  options: ReproducibilityOptions = {},
): Promise<ReproducibilityReport> {
  const repetitions = Math.max(3, options.repetitions ?? 3);

  const baseline = await repeatStage(repetitions, () =>
    runCaseStage(publicCase, materialized, {
      stage: 'baseline',
      command: publicCase.oracles.baseline.command,
      expected: publicCase.oracles.baseline.expect,
      dependencyVersion: 'old',
      hiddenChecks: options.hiddenChecks ?? [],
    }),
  );

  const broken = await repeatStage(repetitions, () =>
    runCaseStage(publicCase, materialized, {
      stage: 'broken',
      command: publicCase.oracles.broken.command,
      expected: publicCase.oracles.broken.expect,
      dependencyVersion: 'new',
      hiddenChecks: options.hiddenChecks ?? [],
    }),
  );

  const stages: StageRepetitions[] = [
    { stage: 'baseline', ...baseline },
    { stage: 'broken', ...broken },
  ];

  if (options.goldRepair) {
    const gold = await repeatStage(repetitions, () =>
      runCaseStage(publicCase, materialized, {
        stage: 'repaired',
        command: publicCase.oracles.repaired.command,
        expected: publicCase.oracles.repaired.expect,
        dependencyVersion: 'new',
        hiddenChecks: options.hiddenChecks ?? [],
        prepareConsumer: options.goldRepair!,
      }),
    );
    stages.push({ stage: 'gold-repaired', ...gold });
  }

  const baselineSignature = baseline.agreedSignature ?? [];
  const brokenSignature = broken.agreedSignature ?? [];
  const triggerSignature = brokenSignature.filter((id) => !baselineSignature.includes(id)).sort();

  const report: Omit<ReproducibilityReport, 'verdict' | 'reason'> = {
    caseId: publicCase.id,
    gateVersion: REPRODUCIBILITY_VERSION,
    platform: process.platform,
    arch: process.arch,
    repetitions,
    stages,
    triggerSignature,
    baselineSignature,
    observedFailureCategory: categorize(triggerSignature),
  };

  return { ...report, ...verdictFor(publicCase, stages, triggerSignature) };
}

/**
 * The gate's decision, stated in the order the failures actually matter.
 *
 * Order is load-bearing. Infrastructure unavailability is checked before
 * anything else, because a machine that could not install cannot say anything
 * about a case. Baseline validity comes next: a consumer already failing its
 * own check before the upgrade makes every later observation uninterpretable,
 * and swe-bump-bench's collector warns about exactly this state and then keeps
 * the task anyway. Flakiness precedes causality, because an unstable signature
 * cannot support a causal claim.
 */
function verdictFor(
  publicCase: PublicCase,
  stages: readonly StageRepetitions[],
  triggerSignature: readonly string[],
): Pick<ReproducibilityReport, 'verdict' | 'reason'> {
  const byStage = new Map(stages.map((entry) => [entry.stage, entry]));
  const baseline = byStage.get('baseline')!;
  const broken = byStage.get('broken')!;
  const gold = byStage.get('gold-repaired');

  if (stages.some((stage) => stage.runs.some((run) => run.observed === 'unable-to-run'))) {
    return {
      verdict: 'environment-unavailable',
      reason: 'At least one repetition could not run its install or command on this machine.',
    };
  }

  if (!baseline.runs.every((run) => run.matchesExpectation)) {
    return {
      verdict: 'invalid-baseline',
      reason: `The pre-update state did not satisfy its own baseline oracle (expected ${publicCase.oracles.baseline.expect}).`,
    };
  }

  for (const stage of stages) {
    if (!stage.stable) {
      return {
        verdict: 'flaky',
        reason: `Stage ${stage.stage} did not produce the same outcome and failure signature across all ${stage.runs.length} repetitions.`,
      };
    }
  }

  if (!broken.runs.every((run) => run.matchesExpectation)) {
    return {
      verdict: 'non-causal',
      reason: `The bump-only state did not behave as the case declares (expected ${publicCase.oracles.broken.expect}).`,
    };
  }

  // A positive case whose bump-only state fails must fail with *new* failures.
  // Without this, a consumer that was already failing in some other way, or
  // one whose command fails for an environmental reason present on both sides,
  // would be recorded as a breaking update it is not.
  if (publicCase.failureCategory !== 'none' && triggerSignature.length === 0) {
    return {
      verdict: 'oracle-insufficient',
      reason: 'The bump-only state failed, but produced no failure the baseline did not already produce, so the update cannot be shown to be the cause.',
    };
  }

  if (gold && !gold.runs.every((run) => run.matchesExpectation)) {
    return {
      verdict: 'oracle-insufficient',
      reason: 'The recorded developer/gold repair does not make the bump-only state pass, so it cannot serve as evidence of a valid repair.',
    };
  }

  return {
    verdict: 'benchmark-ready',
    reason: `Baseline, bump-only${gold ? ' and gold-repaired' : ''} states reproduced identically across ${baseline.runs.length} repetitions on ${process.platform}/${process.arch}.`,
  };
}

async function repeatStage(
  repetitions: number,
  run: () => Promise<OracleStageArtifact>,
): Promise<{ runs: OracleStageArtifact[]; stable: boolean; agreedSignature: string[] | null }> {
  const runs: OracleStageArtifact[] = [];
  for (let index = 0; index < repetitions; index += 1) runs.push(await run());

  const first = runs[0]!;
  const stable = runs.every(
    (entry) => entry.observed === first.observed && sameSignature(entry.signature, first.signature),
  );
  return { runs, stable, agreedSignature: stable ? first.signature : null };
}

function sameSignature(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * What kind of failure the trigger set actually is, derived from the observed
 * diagnostics rather than from what the case claims. A case whose declared
 * category disagrees with this is reported, not silently corrected — the
 * disagreement is usually a real authoring error worth a human or reviewer
 * looking at.
 */
function categorize(triggerSignature: readonly string[]): FailureCategory {
  if (triggerSignature.length === 0) return 'none';
  const kinds = triggerSignature.map(diagnosticKindOf);
  if (kinds.includes('tsc')) return 'type-check-failure';
  if (kinds.includes('test')) return 'test-failure';
  if (kinds.includes('runtime')) return 'runtime-failure';
  // Everything left is `process:exit:<code>` — a command that failed and said
  // nothing the signature parser could read. Calling that a compile failure,
  // which this used to do, is a guess dressed as an observation.
  return 'unreadable-failure';
}

/**
 * The diagnostic kind an identity actually describes.
 *
 * A hidden behavioural check's diagnostics are namespaced `hidden:<id>:` and
 * keep their own inner kind after it, so `hidden:preserves-shout:runtime:...`
 * is a runtime failure. Matching on the raw prefix — which this used to do —
 * matched none of the kinds and fell through to `compile-failure`, so every
 * case whose trigger set was purely behavioural was categorised as a compile
 * error it never produced.
 */
export function diagnosticKindOf(identity: string): string {
  const inner = identity.startsWith('hidden:') ? identity.split(':').slice(2).join(':') : identity;
  return inner.split(':')[0] ?? '';
}
