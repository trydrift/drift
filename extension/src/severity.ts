/**
 * How much a developer should care.
 *
 * This distinction is the whole point of Drift, and it must survive into the UI
 * intact. "Seven breaking changes" is a fact about the package. "None of them
 * touch your code" is the fact about *you*, and it is the one that decides
 * whether this upgrade is a five-second job or an afternoon.
 *
 * Deliberately dependency-free — no `vscode`, no imports at all — so the render
 * layer can use it and so the whole panel stays testable in plain Node.
 */

export type UpgradeSeverity = 'affected' | 'upstream-only' | 'unchecked' | 'clean' | 'error';

/** The parts of an upgrade candidate that decide its severity. */
export interface SeverityInput {
  status: string;
  breakingCount: number;
  impactCount: number;
  impactFiles: number;
  /**
   * Reasons this upgrade could not actually be checked — no declarations to
   * diff, no changelog, no release in the range.
   */
  gaps?: readonly string[];
}

/**
 * The verdict.
 *
 * `unchecked` exists because the alternative is a lie Drift told once and must
 * never tell again: zod 3 → 4 and typescript 5 → 7 were both reported as *no
 * breaking changes found* when the truth was that nothing had been found at
 * all — the `.d.ts` surface would not resolve, no changelog was reachable, and
 * the only evidence was "the major number went up". Zero findings from a
 * complete check and zero findings from a check that never happened are
 * different facts, and a developer needs to be told which one they have.
 */
export function severityOf(candidate: SeverityInput): UpgradeSeverity {
  if (candidate.status === 'error') return 'error';
  if (candidate.impactCount > 0) return 'affected';
  if (candidate.breakingCount > 0) return 'upstream-only';
  if (candidate.gaps && candidate.gaps.length > 0) return 'unchecked';
  return 'clean';
}

/**
 * The line shown on a package row.
 *
 * Never leads with a raw breaking-change count when nothing here is affected —
 * that reads as an alarm, and an alarm that turns out to be nothing is how a
 * tool teaches people to ignore it.
 */
export function describeSeverity(candidate: SeverityInput): string {
  switch (severityOf(candidate)) {
    case 'error':
      return 'Could not check';
    case 'affected': {
      const files = candidate.impactFiles;
      return `Affects your code · ${candidate.impactCount} site${candidate.impactCount === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}`;
    }
    case 'upstream-only':
      return `Safe for your code · ${candidate.breakingCount} upstream change${candidate.breakingCount === 1 ? '' : 's'}, none used here`;
    case 'unchecked':
      return 'Not verified · Drift found nothing it could check this version against';
    case 'clean':
      return 'Safe for your code · no breaking changes found';
  }
}

/**
 * Order by what the developer has to act on, not by upstream noise.
 *
 * Unverified upgrades sort above clean ones and below anything with a real
 * finding: they are not an emergency, but leaving them at the bottom of the
 * list next to the genuinely safe ones is how one gets installed by accident.
 */
export function compareSeverity(a: SeverityInput, b: SeverityInput): number {
  const rank = { affected: 0, error: 1, 'upstream-only': 2, unchecked: 3, clean: 4 } as const;
  return rank[severityOf(a)] - rank[severityOf(b)];
}
