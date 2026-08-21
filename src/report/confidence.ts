import type { BreakingChange, RemediationPlan } from '../types.js';
import type { AnalysisGap, CheckedSurface, ConfidenceAssessment, ConfidenceScore } from '../confidence/types.js';
import { taxonomyOf } from '../confidence/taxonomy.js';
import { deriveOverallConfidence } from '../confidence/calibrate.js';

/**
 * Rendering for the confidence model.
 *
 * Shared by the Markdown report, the Action summary, and the extension panel so
 * a finding reads the same wherever it is shown. Two rules run through all of
 * it:
 *
 * **Never say "safe".** Drift can say what it checked and what it found. It
 * cannot say an upgrade is safe, and a tool that says so once has taught its
 * users that the word means "probably".
 *
 * **Never let an unchecked surface read as a clean one.** "No usages found" and
 * "could not search" produce the same empty list and mean opposite things, so
 * they get different sentences.
 */

/** The five things a finding can honestly be said to be. */
export type FindingVerdict =
  | 'no-incompatible-change-in-checked-surfaces'
  | 'detected-not-locally-reachable'
  | 'locally-affected'
  | 'insufficient-evidence'
  | 'verification-incomplete';

export const VERDICT_TEXT: Record<FindingVerdict, string> = {
  'no-incompatible-change-in-checked-surfaces':
    'No incompatible change detected in the surfaces that were checked',
  'detected-not-locally-reachable':
    'Incompatible change detected upstream, but not reachable from this repository',
  'locally-affected': 'This repository is affected',
  'insufficient-evidence': 'Insufficient evidence to say',
  'verification-incomplete': 'Verification incomplete',
};

/**
 * The verdict sentence, hedged when it's earned.
 *
 * `VERDICT_TEXT['locally-affected']` states impact flatly, but a `low` or
 * `medium` localImpact band means the match itself is uncertain — a textual
 * hit with no import edge, or a wrapper-mediated call. Declaring "this
 * repository is affected" with the same confidence as a direct, imported
 * usage overstates what was actually found. Only a `high` local-impact band —
 * a symbol bound from an established import — earns the unhedged sentence.
 */
export function verdictText(verdict: FindingVerdict, assessment?: ConfidenceAssessment): string {
  if (verdict === 'locally-affected' && assessment && assessment.localImpact.band !== 'high') {
    return 'This repository may be affected';
  }
  return VERDICT_TEXT[verdict];
}

/**
 * Which of the five a finding warrants.
 *
 * Order matters: weak upstream evidence is reported as insufficient regardless
 * of what a search turned up, because a textual match against a finding nothing
 * substantiates is not a reason to claim the repository is affected.
 */
export function verdictFor(change: BreakingChange): FindingVerdict {
  const assessment = change.assessment;
  if (!assessment) return 'insufficient-evidence';

  if (assessment.upstream.band === 'none' || assessment.upstream.band === 'low') {
    return 'insufficient-evidence';
  }

  if (assessment.localImpact.band === 'none') {
    // Distinguishing these two is the entire point of `localizationRan`.
    const notSearched = assessment.localImpact.penalties.some(
      (p) => p.code === 'localization-unavailable' || p.code === 'not-locally-checkable',
    );
    return notSearched ? 'verification-incomplete' : 'detected-not-locally-reachable';
  }

  return 'locally-affected';
}

/** The two verdicts that tell a developer this upgrade does not affect them. */
const SAFE_EQUIVALENT_VERDICTS = new Set<FindingVerdict>([
  'no-incompatible-change-in-checked-surfaces',
  'detected-not-locally-reachable',
]);

/**
 * One verdict for a whole plan, not just one finding.
 *
 * `verdictFor` answers per finding, and production otherwise leaves the
 * questions "were any findings safe-equivalent" and "was the surface actually
 * checked" for a caller to combine by hand. This is that combination, done
 * once, so the CLI, the Action, the extension panel and the benchmark harness
 * cannot quietly disagree about what Drift told a developer.
 *
 * A repository-wide absence of findings is only a safe claim when the API
 * surface was genuinely computed *and* the repository was genuinely searched
 * — `checkedSurfaces` is what lets that be distinguished from a surface that
 * could not be computed at all, where the honest verdict stays
 * `insufficient-evidence`.
 */
export function reduceVerdict(
  verdicts: readonly FindingVerdict[],
  noBreakingChanges: boolean,
  checkedSurfaces: readonly Pick<CheckedSurface, 'surface' | 'status'>[],
): FindingVerdict {
  if (noBreakingChanges) {
    if (verdicts.length > 0) return verdicts[0]!;
    const surfaceChecked = checkedSurfaces.some(
      (surface) => surface.surface === 'api-surface' && surface.status === 'checked',
    );
    const searched = checkedSurfaces.some(
      (surface) => surface.surface === 'localization' && surface.status === 'checked',
    );
    return surfaceChecked && searched ? 'no-incompatible-change-in-checked-surfaces' : 'insufficient-evidence';
  }

  const precedence: FindingVerdict[] = [
    'locally-affected',
    'insufficient-evidence',
    'verification-incomplete',
    'detected-not-locally-reachable',
    'no-incompatible-change-in-checked-surfaces',
  ];
  return precedence.find((verdict) => verdicts.includes(verdict)) ?? verdicts[0] ?? 'insufficient-evidence';
}

/**
 * `reduceVerdict`, folding in what the project's own toolchain measured.
 *
 * Static analysis and measurement can disagree, and when they do the
 * measurement wins — but only the specific shape of measurement that earns
 * it. `plan.confirmedRegressions` is deliberately narrow: an entry only lands
 * there when a check passed against this exact dependency's *absence* and
 * then failed against its presence, isolated from every other change in the
 * same manifest (see `verifyPlan` in `analysis.ts`). That rules out the two
 * ways a naive "verification failed → affected" rule would manufacture false
 * positives: an environment that could not install or run at all, and a
 * repository whose build was already red before Drift touched anything.
 * Neither produces a `confirmedRegressions` entry, so neither can move this
 * verdict — an inconclusive or pre-existing failure leaves the static
 * conclusion exactly where it was.
 *
 * The override only ever *replaces a safe-equivalent claim*. A plan already
 * reporting `locally-affected` on static grounds is left alone, and a plan
 * genuinely `insufficient-evidence` — upstream itself unproven — stays that
 * way: a confirmed regression says this repository broke, not that Drift
 * understands why.
 */
export function resolvePlanVerdict(plan: RemediationPlan): FindingVerdict {
  const verdicts = plan.breakingChanges.map((change) => verdictFor(change));
  const reduced = reduceVerdict(verdicts, plan.breakingChanges.length === 0, plan.checkedSurfaces);

  if (plan.confirmedRegressions.length > 0 && SAFE_EQUIVALENT_VERDICTS.has(reduced)) {
    return 'locally-affected';
  }

  return reduced;
}

/**
 * The one sentence a reader needs when a plan has nothing else to show them —
 * no breaking changes, no impact sites, nothing for `renderBreakingChanges` or
 * a commit plan to list. Every production surface that used to reconstruct
 * this from `plan.commits.length === 0` alone collapsed three different facts
 * into one "no code affected" sentence; this is the one place that tells them
 * apart, so the Markdown report, the check-run summary, the CLI's printed
 * summary and every other repository-wide claim agree with
 * {@link resolvePlanVerdict} instead of contradicting it.
 *
 * A confirmed regression is measured, not predicted, and is reported as
 * exactly that — the repository is affected, but static analysis found
 * nothing to localize it to — reusing `plan.blockers[0]`, the one sentence
 * `verifyPlan` already wrote describing what broke and where, rather than
 * inventing a second description of the same fact.
 *
 * A blocker that is *not* a confirmed regression (an ambiguous
 * multi-dependency verification failure, a guardrail unrelated to
 * verification) still earns its own detail rather than collapsing to the
 * generic `insufficient-evidence` label — a standalone caller (the CLI's
 * printed summary, a log line) may never show `plan.blockers` anywhere else,
 * unlike the Markdown report's dedicated blockers section.
 *
 * Every other case defers to {@link VERDICT_TEXT}, the same wording already
 * used per finding, so the repository-level and per-finding conclusions are
 * never phrased as if they came from two different tools.
 */
export function repositoryConclusion(plan: RemediationPlan): string {
  const verdict = resolvePlanVerdict(plan);

  if (plan.confirmedRegressions.length > 0 && plan.blockers.length > 0) {
    return `Drift confirmed this repository is affected, even though static analysis found nothing to point at: ${plan.blockers[0]}`;
  }

  if (verdict !== 'locally-affected' && plan.blockers.length > 0) {
    return `Could not establish whether this repository is affected: ${plan.blockers[0]}`;
  }

  return VERDICT_TEXT[verdict];
}

const BAND_BADGE: Record<string, string> = {
  high: '🟢',
  medium: '🟡',
  low: '🟠',
  none: '⚪',
};

export function bandBadge(band: string): string {
  return BAND_BADGE[band] ?? '⚪';
}

/** `🟢 high (0.90)` */
export function scoreLabel(score: ConfidenceScore): string {
  return `${bandBadge(score.band)} ${score.band} (${score.score.toFixed(2)})`;
}

/**
 * A word for what `weight` means, next to the number rather than instead of
 * it — the raw figure stays for anyone auditing the calibration, but "strong
 * source" is what most readers actually need from it.
 */
export function evidenceStrengthLabel(weight: number): string {
  if (weight >= 0.9) return 'very strong source';
  if (weight >= 0.7) return 'strong source';
  if (weight >= 0.5) return 'moderate source';
  if (weight >= 0.3) return 'weak source';
  return 'very weak source';
}

/**
 * The one line a non-expert reads: `Confidence: 82/100 — Fairly confident`.
 *
 * Placed above the three-dimension table, never instead of it — the breakdown
 * stays available for anyone who wants to see why the number is what it is.
 */
export function overallConfidenceLine(assessment: ConfidenceAssessment): string {
  const overall = deriveOverallConfidence(assessment);
  return `${bandBadge(overall.band)} **Confidence: ${overall.score}/100 — ${overall.label}**`;
}

/**
 * The three dimensions as a compact table.
 *
 * Shown per finding rather than once per plan because they genuinely differ per
 * finding — that variation is the information.
 */
export function renderConfidenceTable(assessment: ConfidenceAssessment): string {
  return [
    '| Dimension | Confidence | Why |',
    '|---|---|---|',
    `| Upstream — did this change happen? | ${scoreLabel(assessment.upstream)} | ${topReason(assessment.upstream)} |`,
    `| Local impact — does it reach this repo? | ${scoreLabel(assessment.localImpact)} | ${topReason(assessment.localImpact)} |`,
    `| Verification — did anything run? | ${scoreLabel(assessment.verification)} | ${topReason(assessment.verification)} |`,
  ].join('\n');
}

/**
 * The single most useful sentence about a score.
 *
 * A penalty beats a contribution: the reason a reader needs is why they should
 * hesitate, not why they should not.
 */
function topReason(score: ConfidenceScore): string {
  const penalty = score.penalties[0];
  if (penalty) return escapeCell(penalty.detail);

  const strongest = [...score.evidence].sort((a, b) => b.delta - a.delta)[0];
  return strongest ? escapeCell(strongest.detail) : '—';
}

/** Pipes and newlines would break the row. */
function escapeCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

export function renderTaxonomy(change: BreakingChange): string {
  const taxonomy = taxonomyOf(change);
  const parts = [
    `**Nature:** ${taxonomy.nature}`,
    `**Scope:** ${taxonomy.scope}`,
    `**Detectable at:** ${taxonomy.detectability.join(', ')}`,
    `**Reached via:** ${taxonomy.visibility.join(', ')}`,
  ];

  // Worth saying out loud rather than leaving to be inferred from the list.
  const onlyAtRuntime = !taxonomy.detectability.some((d) =>
    ['manifest', 'link-or-import', 'compile-time', 'static-semantic'].includes(d),
  );

  const note = onlyAtRuntime
    ? '\n\n> This change is only observable when the code runs. Neither a compiler nor a source search can confirm whether this repository is affected.'
    : '';

  return `${parts.join(' · ')}${note}`;
}

/**
 * Gaps, as their own section.
 *
 * Deliberately not folded into `warnings`: the things Drift could not check
 * decide how much the rest of the report is worth, and burying them among
 * ordinary caveats is how they get skimmed past.
 */
export function renderGaps(gaps: readonly AnalysisGap[]): string {
  // Silent when there is nothing to report. A section that says "nothing to
  // report" on every clean upgrade is a section people stop reading, which
  // costs it its power on the one run where it matters.
  if (gaps.length === 0) return '';

  const lines = [
    '## What Drift could not check',
    '',
    'These are surfaces Drift did not establish. A limit of the tool is not a finding',
    'about the upgrade — an absence here is not evidence that nothing is wrong.',
    '',
    '| Stage | Surface | Why it matters | What to do |',
    '|---|---|---|---|',
  ];

  for (const gap of gaps) {
    const consequence =
      gap.automaticExecution === 'blocks'
        ? '**blocks automatic execution**'
        : gap.automaticExecution === 'degrades'
          ? 'lowers confidence'
          : 'noted';

    const where = gap.dependency ? `${gap.surface} (\`${gap.dependency}\`)` : gap.surface;

    lines.push(
      `| ${gap.stage} | ${escapeCell(where)} | ${escapeCell(gap.reason)} — ${consequence} | ${escapeCell(gap.remediation)} |`,
    );
  }

  return lines.join('\n');
}

/**
 * What was looked at.
 *
 * The counterpart to gaps, and the reason a reader can tell "checked and clean"
 * from "not checked" at a glance.
 */
export function renderCheckedSurfaces(plan: RemediationPlan): string {
  if (plan.checkedSurfaces.length === 0) return '';

  const lines = ['## What Drift checked', '', '| Surface | Dependency | Result |', '|---|---|---|'];

  for (const surface of plan.checkedSurfaces) {
    const status =
      surface.status === 'checked' ? '✅ checked' : surface.status === 'skipped' ? '⏭️ skipped' : '⚠️ unavailable';
    lines.push(
      `| ${surface.surface} | ${surface.dependency ? `\`${surface.dependency}\`` : '—'} | ${status} — ${escapeCell(surface.detail)} |`,
    );
  }

  return lines.join('\n');
}

/**
 * One line stating whether a finding may be acted on unattended, and why not.
 *
 * Absence of evidence never reads as eligibility here — `automaticExecutionEligible`
 * is false whenever a dimension is unestablished.
 */
export function renderEligibility(assessment: ConfidenceAssessment): string {
  if (assessment.automaticExecutionEligible) {
    return '**Automatic execution:** eligible — upstream evidence and local impact are both established.';
  }

  const reasons: string[] = [];
  if (assessment.upstream.band !== 'high') reasons.push('upstream evidence is not conclusive');
  if (assessment.localImpact.band === 'none') reasons.push('no local impact was established');
  else if (assessment.localImpact.band === 'low') reasons.push('local impact is weakly established');
  for (const gap of assessment.gaps) {
    if (gap.automaticExecution === 'blocks') reasons.push(gap.surface);
  }

  return `**Automatic execution:** not eligible — ${reasons.join('; ') || 'insufficient evidence'}.`;
}
