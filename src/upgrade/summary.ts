/**
 * The one-line verdict on an upgrade.
 *
 * Its own module because it has to be computed twice. The first time is when
 * the analysis finishes, from what Drift predicted. The second is after the
 * probe has installed the upgrade for real and disproved some of those
 * predictions, at which point the counts on the row are re-derived — and a
 * summary left over from the first pass says "66 upstream breaking changes"
 * beside a row that now reads "1 upstream change, none used here". Two numbers
 * for the same fact, one of them stale, is worse than either alone.
 */
import { RECOMMENDATION_LABEL } from '../rationale/assess.js';
import type { UpgradeRationale } from '../rationale/types.js';

/**
 * The one-line verdict.
 *
 * Written from the developer's point of view, not the registry's: what this
 * upgrade means for *this* repository comes first, and the upstream count is
 * context rather than a headline.
 *
 * It leads with the recommendation, because "Upgrade recommended — fixes a
 * high-severity advisory" and "Safe to upgrade" are different answers to the
 * question actually being asked, and a line that could only ever say what
 * might break was the old, weaker version of this.
 *
 * The failure case is the reason this function is careful. It used to
 * concatenate every gap onto a fixed preamble, which printed the same missing
 * toolchain twice — once as "Drift could not verify this upgrade" and once as
 * the gap that explained it. Gaps arrive deduplicated from the rationale, and
 * the preamble no longer restates them.
 */
export function summarize(
  breakingCount: number,
  impactCount: number,
  name: string,
  rationale: UpgradeRationale | undefined,
): string {
  if (!rationale) {
    return breakingCount > 0
      ? `${breakingCount} breaking change${breakingCount === 1 ? '' : 's'} found in ${name}.`
      : `No breaking changes found for this version of ${name}.`;
  }

  const { assessment, security } = rationale;
  const headline = RECOMMENDATION_LABEL[assessment.recommendation];

  const detail: string[] = [];

  if (impactCount > 0) {
    detail.push(
      `${impactCount} place${impactCount === 1 ? '' : 's'} in this repository use${impactCount === 1 ? 's' : ''} an API that ${name} changed`,
    );
  } else if (breakingCount > 0) {
    detail.push(
      `${breakingCount} upstream breaking change${breakingCount === 1 ? '' : 's'}, none of which this repository uses`,
    );
  }

  if (security.checked && security.resolved.length > 0) {
    detail.push(
      `fixes ${security.resolved.length} known ${security.resolved.length === 1 ? 'vulnerability' : 'vulnerabilities'}`,
    );
  }
  if (security.checked && security.introduced.length > 0) {
    detail.push(
      `introduces ${security.introduced.length} known ${security.introduced.length === 1 ? 'vulnerability' : 'vulnerabilities'}`,
    );
  }

  // Said once, at the end, and only when nothing above already carried the
  // news. Repeating a stated gap is the bug this shape exists to prevent.
  if (detail.length === 0 && rationale.gaps.length > 0) {
    return `${headline}. ${rationale.gaps.join(' ')}`;
  }

  if (detail.length === 0) {
    return `${headline}. No breaking changes found for this version of ${name}.`;
  }

  return `${headline}. ${capitalizeFirst(detail.join('; '))}.`;
}

function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
