import type { BreakingChange, RemediationPlan } from '../types.js';
import type { AnalysisGap, ConfidenceAssessment, ConfidenceScore } from '../confidence/types.js';
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
