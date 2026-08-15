import type { RemediationPlan } from '../types.js';
import { taxonomyOf } from '../confidence/taxonomy.js';
import type { CheckOutcome } from './checks.js';
import type { UpgradeVerification } from './upgrade-probe.js';

/**
 * Reconciling what Drift predicted with what the toolchain measured.
 *
 * These two disagree constantly, and the disagreement used to be resolved late
 * and badly: the prediction was reported, someone acted on it, and only then did
 * a check against the installed version reveal there had never been anything to
 * fix. The probe moves the measurement ahead of the report; this decides what it
 * means, in one place, so the scan, the CLI, and the Action cannot drift into
 * three different readings of the same green build.
 *
 * The rule is asymmetric, and the asymmetry is the point:
 *
 * - A **passing** check disproves only what a compiler can see. A signature that
 *   moved, an export that vanished, a type that narrowed — if the project builds
 *   against the real declarations, those predictions were wrong and are dropped.
 *   A behavioural change is invisible to a compiler, so a green build says
 *   nothing about it and it survives untouched. Skipping those on a green build
 *   is how a real break ships.
 * - A **failing** check proves breakage outright, whether or not Drift predicted
 *   it, and its output is attached so the fix stage and the filed issue both
 *   quote what actually broke instead of re-deriving it.
 */

/** The predicted change kinds a compiler is capable of contradicting. */
export function provableByCompiler(change: Parameters<typeof taxonomyOf>[0]): boolean {
  return taxonomyOf(change).detectability.some((how) => how === 'compile-time' || how === 'link-or-import');
}

/**
 * Fold a probe result into a plan.
 *
 * Returns a new plan; the input is not modified, so a caller holding the
 * unverified version for comparison still has it.
 *
 * `workspace` scopes a pass to one workspace member — pass it whenever the
 * probe only actually installed and checked that member, which is every
 * multi-package repository. Without it, a green result from `packages/web`
 * would be free to clear a compiler-provable finding that lives in
 * `packages/api`, a package the probe never touched. Omit it only for a
 * verification that genuinely covers the whole plan (a single-package repo,
 * or a result already combined across every member with `combineVerifications`).
 */
export function applyVerificationToPlan(
  plan: RemediationPlan,
  verification: UpgradeVerification,
  workspace?: string,
): RemediationPlan {
  if (verification.status !== 'passed') return { ...plan, verification };

  // A passing test suite proves nothing about a signature or an export: only a
  // check capable of seeing the declarations — a typecheck, or a build stage
  // that compiles them — can disprove a compiler-provable prediction. Without
  // this, a project whose only green check is `test` (or a `build` script that
  // just bundles, never type-checks) would have real compiler-provable
  // breakage erased by a check that never looked at types at all.
  if (!verification.checks.some((check) => check.status === 'passed' && isCompileCapable(check.kind))) {
    return { ...plan, verification };
  }

  // A green run over several upgrades installed together proves the batch is
  // safe together, not that any one of them is safe alone: dependencies can
  // compensate for each other (a framework and its adapter, a runtime and its
  // type definitions), so `A@2 + B@2` passing says nothing about `A@2` on its
  // own. `measuredWith > 1` marks exactly that case — the display keeps
  // saying "passed", which is a true statement about the batch, but nothing
  // gets pruned on the strength of it. Only a pass measured for this
  // candidate alone may clear its predictions.
  if (verification.measuredWith && verification.measuredWith > 1) {
    return { ...plan, verification };
  }

  const inScope = (change: RemediationPlan['breakingChanges'][number]) =>
    workspace === undefined || (change.workspace ?? '') === workspace;

  const cleared = new Set(
    plan.breakingChanges.filter((change) => inScope(change) && provableByCompiler(change)).map((change) => change.id),
  );
  if (cleared.size === 0) return { ...plan, verification };

  return prunePlan(plan, cleared, verification);
}

/** Check kinds able to observe a compiler's own view of the declarations. */
function isCompileCapable(kind: CheckOutcome['kind']): boolean {
  return kind === 'typecheck' || kind === 'build';
}

/**
 * Remove every trace of the disproved changes from a plan.
 *
 * Everything downstream of a breaking change goes with it — its impact sites,
 * the commit units built to fix them, and the edges those units carry. A plan
 * that kept an empty commit unit around would put a card in front of someone
 * with nothing to do in it, which is the "flagged and then walked back"
 * experience this whole design exists to remove.
 *
 * Evidence is deliberately kept. It records what the *upstream project*
 * published, which is still true — the compiler proved this repository is not
 * affected by it, not that it never happened.
 */
function prunePlan(
  plan: RemediationPlan,
  cleared: ReadonlySet<string>,
  verification: UpgradeVerification,
): RemediationPlan {
  const breakingChanges = plan.breakingChanges.filter((change) => !cleared.has(change.id));
  const impactSites = plan.impactSites.filter((site) => !cleared.has(site.breakingChangeId));

  const commits = plan.commits
    .map((commit) => ({
      ...commit,
      breakingChangeIds: commit.breakingChangeIds.filter((id) => !cleared.has(id)),
    }))
    .filter((commit) => commit.breakingChangeIds.length > 0);

  const kept = new Set(commits.map((commit) => commit.id));

  return {
    ...plan,
    breakingChanges,
    impactSites,
    verification,
    planEdges: plan.planEdges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)),
    commits: commits.map((commit) => ({
      ...commit,
      dependsOn: commit.dependsOn.filter((id) => kept.has(id)),
      dependencyReasons: commit.dependencyReasons.filter((edge) => kept.has(edge.from) && kept.has(edge.to)),
    })),
  };
}

/**
 * One verdict for a plan assembled from several candidates' plans.
 *
 * Combining plans used to drop verification on the floor, and the cost of that
 * was paid by the developer: every "fix" over a scanned candidate — even a
 * single one, because that path combines too — arrived at the fix stage with no
 * record of having been measured. The compiler then cleared the predictions the
 * probe had already cleared, and the only thing left to tell them why was a log.
 *
 * The merge is pessimistic on purpose. A pass is only a pass if every part
 * passed; anything unmeasured makes the whole thing unmeasured, because a plan
 * that is half-verified must not be described as verified.
 */
export function combineVerifications(
  parts: readonly (UpgradeVerification | undefined)[],
): UpgradeVerification | undefined {
  if (parts.length === 0 || parts.every((part) => !part)) return undefined;

  const present = parts.filter((part): part is UpgradeVerification => Boolean(part));
  const checks = present.flatMap((part) => part.checks);

  const failed = present.filter((part) => part.status === 'failed');
  if (failed.length > 0) {
    return {
      status: 'failed',
      checks,
      diagnostics: failed
        .map((part) => part.diagnostics)
        .filter((text): text is string => Boolean(text))
        .join('\n\n'),
      failedFiles: [...new Set(failed.flatMap((part) => part.failedFiles))],
    };
  }

  // Missing counts as unmeasured, not as passing: `parts` carries one entry per
  // plan, so an absent verification is a candidate nobody checked.
  const unmeasured = parts.filter((part) => !part || part.status === 'skipped');
  if (unmeasured.length > 0) {
    const reasons = [
      ...new Set(
        unmeasured.map((part) => part?.reason ?? 'One of these upgrades was not tested, and no reason was recorded.'),
      ),
    ];
    return { status: 'skipped', reason: reasons.join(' '), checks, failedFiles: [] };
  }

  return { status: 'passed', checks, failedFiles: [] };
}

/**
 * One line stating what was measured, for a panel row, a log, or an issue body.
 *
 * Written to be readable on its own: whoever sees this may never see the checks
 * list it summarizes.
 */
export function describeVerification(verification: UpgradeVerification): string {
  const ran = verification.checks
    .filter((check) => check.status === 'passed' || check.status === 'failed')
    .map((check) => `\`${check.label}\``);

  if (verification.status === 'passed') {
    // Stated whenever it applies, because it is the difference between "this
    // upgrade is fine" and "this set of upgrades is fine", and only the reader
    // knows whether they are about to take one or all of them.
    const alongside =
      verification.measuredWith && verification.measuredWith > 1
        ? ` (measured with ${verification.measuredWith - 1} other upgrade${verification.measuredWith === 2 ? '' : 's'} from the same manifest installed alongside it)`
        : '';
    return ran.length > 0
      ? `${ran.join(', ')} ${ran.length === 1 ? 'passes' : 'pass'} with this upgrade installed${alongside}.`
      : `This upgrade was installed and the project still checks out clean${alongside}.`;
  }

  if (verification.status === 'failed') {
    const failingChecks = verification.checks.filter((check) => check.status === 'failed');
    const failing = failingChecks.map((check) => `\`${check.label}\``);
    const where =
      verification.failedFiles.length > 0
        ? ` in ${verification.failedFiles.length} file${verification.failedFiles.length === 1 ? '' : 's'}`
        : '';
    const summary = `${failing.join(', ')} fails with this upgrade installed${where} — measured, not predicted.`;

    // The command and its output, not just its label: a reader deciding
    // whether to trust this verdict needs to see what actually ran and what
    // it said, the same way they would if they had run it themselves.
    const detail = failingChecks
      .map((check) => `$ ${check.label}\n${check.output.trim() || '(no output captured)'}`)
      .join('\n\n');
    return detail ? `${summary}\n\n${detail}` : summary;
  }

  return verification.reason ?? 'This upgrade was not tested.';
}
