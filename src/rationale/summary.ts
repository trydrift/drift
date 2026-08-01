import type { BreakingChange, Evidence, ImpactSite } from '../types.js';
import type { SurfaceAddition } from '../evidence/surface/types.js';
import type { ChangeCategory, Improvement, ReleaseSummary, SummarizedChange } from './types.js';

/**
 * What changed upstream, in the maintainer's own words.
 *
 * The rule this module exists to enforce: **nothing here is written by Drift.**
 * Every line is a sentence a maintainer published, trimmed and classified. The
 * work is choosing which lines to show and what to call them — not producing
 * prose, which is where a summariser starts inventing migrations that were
 * never announced.
 *
 * Classification is keyword-based and deterministic, and it is allowed to be
 * imperfect in one direction only: a line it cannot classify becomes an
 * "improvement", the weakest claim available. It never promotes a line to
 * breaking or security without the maintainer having used those words.
 */

/** Lines kept per category, so a hundred-entry changelog stays readable. */
const PER_CATEGORY = 6;

/** Ordered: the first pattern that matches names the category. */
const PATTERNS: { category: ChangeCategory; pattern: RegExp }[] = [
  {
    category: 'security',
    pattern:
      /\b(CVE-\d{4}-\d+|GHSA-[\w-]+|GO-\d{4}-\d+|security fix|vulnerabilit|XSS|CSRF|SSRF|remote code execution|prototype pollution|path traversal|SQL injection|denial of service|ReDoS)\b/i,
  },
  {
    category: 'breaking',
    pattern:
      /\b(BREAKING|breaking change|no longer|has been removed|was removed|is removed|removed support|dropped support|drop support|renamed to|has been renamed|is now required|must now|migrate to|migration guide|incompatible)\b/i,
  },
  {
    category: 'performance',
    pattern:
      /\b(performance|faster|speed ?up|sped up|reduces? (?:the )?(?:allocation|memory|latency)|allocation|throughput|optimi[sz])\b/i,
  },
  { category: 'fix', pattern: /^\s*(?:fix(?:e[sd])?|bugfix|resolve[sd]?|correct(?:s|ed)?)\b/i },
];

export interface SummaryInput {
  dependency: string;
  evidence: readonly Evidence[];
  breakingChanges: readonly BreakingChange[];
  impactSites: readonly ImpactSite[];
  /** Additive API from the computed surface diff, when the ecosystem reports it. */
  additions?: readonly SurfaceAddition[];
}

export function summarizeRelease(input: SummaryInput): ReleaseSummary {
  const { dependency, evidence, breakingChanges, impactSites } = input;

  const sitesByChange = new Map<string, number>();
  for (const site of impactSites) {
    sitesByChange.set(site.breakingChangeId, (sitesByChange.get(site.breakingChangeId) ?? 0) + 1);
  }

  const changes: SummarizedChange[] = [];
  const seen = new Set<string>();

  // Computed findings first, and with their impact attached. "`Client.Do` now
  // requires a context argument. Drift found four affected calls." is a
  // sentence only Drift can write, and it is the most useful one in the report.
  for (const change of breakingChanges) {
    if (change.dependency !== dependency) continue;
    const affected = sitesByChange.get(change.id) ?? 0;
    const key = normalise(change.summary);
    if (seen.has(key)) continue;
    seen.add(key);

    changes.push({
      category: 'breaking',
      text: change.summary,
      ...(affected > 0 ? { affectedSites: affected } : {}),
      ...(citationUrl(change, evidence) ? { url: citationUrl(change, evidence)! } : {}),
      ...(change.citations[0] ? { citation: change.citations[0] } : {}),
    });
  }

  // Then the prose, which is where security fixes and improvements live: a
  // maintainer writes "fixes CVE-2026-1234" in a release body far more often
  // than anywhere a computed diff can see.
  let unrelated = 0;
  const counts = new Map<ChangeCategory, number>();

  for (const record of evidence) {
    if (record.dependency !== dependency) continue;
    if (record.source === 'semver-heuristic' || record.source === 'type-surface-diff') continue;

    for (const line of bulletLines(record.content)) {
      const key = normalise(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const category = classify(line);

      // A breaking change the analyser already extracted is in the list above,
      // with its impact count; the prose restatement of it is a duplicate.
      if (category === 'breaking' && changes.some((c) => overlaps(c.text, line))) continue;

      const taken = counts.get(category) ?? 0;
      if (taken >= PER_CATEGORY) {
        unrelated++;
        continue;
      }
      counts.set(category, taken + 1);

      changes.push({
        category,
        text: line,
        ...(record.url ? { url: record.url } : {}),
        citation: record.id,
      });
    }
  }

  return { changes: order(changes), unrelated };
}

/**
 * Performance and reliability claims, and only ones somebody published.
 *
 * Drawn from the same classified lines rather than generated, and deliberately
 * never inferred from a version number: "this release is newer, so it is
 * probably faster" is a guess, and a guess printed beside a computed API diff
 * borrows credibility it has not earned.
 */
export function improvementsFrom(summary: ReleaseSummary): Improvement[] {
  return summary.changes
    .filter((change) => change.category === 'performance')
    .map((change) => ({
      statement: change.text,
      ...(change.url ? { url: change.url } : {}),
      ...(change.citation ? { citation: change.citation } : {}),
    }));
}

/**
 * Additive API, as an improvement with a computed source.
 *
 * Counted rather than listed. "1,502 new exported symbols" is a fact about
 * `golang.org/x/sys` that a developer can use; 1,502 lines of symbol names is
 * not something anyone reads.
 */
export function describeAdditions(
  additions: readonly SurfaceAddition[],
  locator: string,
): Improvement | null {
  if (additions.length === 0) return null;

  const packages = additions.filter((a) => a.kind === 'package-added').length;
  const exports = additions.length - packages;

  const parts: string[] = [];
  if (packages > 0) parts.push(`${packages} new package${packages === 1 ? '' : 's'}`);
  if (exports > 0) parts.push(`${exports} new exported symbol${exports === 1 ? '' : 's'}`);
  if (parts.length === 0) return null;

  return {
    statement: `The target version adds ${parts.join(' and ')}, none of which can break existing code. Computed from ${locator}.`,
  };
}

export function classify(line: string): ChangeCategory {
  for (const { category, pattern } of PATTERNS) {
    if (pattern.test(line)) return category;
  }
  return 'improvement';
}

const CATEGORY_ORDER: Record<ChangeCategory, number> = {
  breaking: 0,
  security: 1,
  fix: 2,
  performance: 3,
  improvement: 4,
};

function order(changes: readonly SummarizedChange[]): SummarizedChange[] {
  return [...changes].sort((a, b) => {
    const byCategory = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
    if (byCategory !== 0) return byCategory;
    // Within a category, what touches this repository comes first.
    return (b.affectedSites ?? 0) - (a.affectedSites ?? 0);
  });
}

/**
 * One line per change, from a changelog or release body.
 *
 * Bullets are taken as written; a paragraph is taken whole. Headings are
 * dropped — "## Breaking changes" is a label, not a change, and letting it
 * through produces a summary whose most prominent entry says nothing.
 */
export function bulletLines(content: string): string[] {
  const out: string[] = [];

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^[-=]{3,}$/.test(line)) continue;

    const text = line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim();
    if (text.length < 12) continue;
    // A bare commit trailer or a contributor credit is not a change.
    if (/^(?:by\s+@|thanks|co-authored-by|https?:\/\/\S+$)/i.test(text)) continue;

    out.push(truncate(text, 240));
  }

  return out;
}

function citationUrl(change: BreakingChange, evidence: readonly Evidence[]): string | undefined {
  for (const id of change.citations) {
    const url = evidence.find((record) => record.id === id)?.url;
    if (url) return url;
  }
  return undefined;
}

/** Do two lines describe the same change? Judged on shared quoted identifiers. */
function overlaps(a: string, b: string): boolean {
  const symbols = (text: string) => new Set(text.match(/`([^`]+)`/g) ?? []);
  const left = symbols(a);
  if (left.size === 0) return false;
  return [...symbols(b)].some((symbol) => left.has(symbol));
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
