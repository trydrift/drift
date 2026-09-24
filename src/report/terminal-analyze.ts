/**
 * What `drift analyze` looks like in a terminal.
 *
 * The command printed the pull request body — several hundred lines of raw
 * markdown, every advisory, every confidence table, every evidence excerpt —
 * straight to stdout whether or not anything was there to render it. In a real
 * terminal that is not a report, it is a transcript of one, and the two findings
 * that actually reached the developer's code were somewhere in the middle of it.
 *
 * The markdown is still exactly right for where it was designed to go: an
 * approval issue, a pull request body, a paste into a review. So it is still
 * available, under `--markdown`, unchanged. What changed is the default, which
 * now answers the question someone at a prompt is actually asking — *does this
 * upgrade break my code, and where* — in a screen or two.
 *
 * The grouping is not invented here. `BreakingChangeDisposition` is the single
 * authority the rest of Drift already routes on, and its four states are exactly
 * the distinction a reader needs:
 *
 *   actionable    reaches this repository, and Drift can say where
 *   review-only   reaches it, but not with enough confidence to act
 *   unaffected    published upstream, provably not reached here
 *   unknown       Drift could not establish either way — never "fine"
 *
 * That last one is the reason this file does not simply print the findings that
 * matter and drop the rest. An absence of evidence is not a clean bill of
 * health, and a terminal summary that quietly omitted the unknowns would be the
 * one place in Drift where a gap reads as a pass.
 */

import type { BreakingChangeDisposition, RemediationPlan } from '../types.js';
import { terminalWidth, type Palette } from '../util/terminal.js';
import { wrap } from './terminal-outdated.js';

/** One rendered section: a disposition state, its heading, and how to colour it. */
const SECTIONS = [
  {
    state: 'actionable' as const,
    heading: 'Affects this repository',
    tone: 'red' as const,
    glyph: '!',
  },
  {
    state: 'review-only' as const,
    heading: 'Reaches this repository — review before upgrading',
    tone: 'yellow' as const,
    glyph: '?',
  },
  {
    state: 'unknown' as const,
    // Named for what the reader should do about it. The old heading — "Drift
    // could not establish whether this repository is affected" — was true and
    // useless: it turned the most common outcome on a real upgrade into a wall
    // of things that are apparently wrong and apparently nobody's job.
    heading: 'Check before upgrading — Drift could not settle these either way',
    tone: 'yellow' as const,
    glyph: '·',
  },
  {
    state: 'unaffected' as const,
    heading: 'Published upstream, not reached here',
    tone: 'gray' as const,
    glyph: '·',
  },
];

/**
 * The terminal report.
 *
 * Returns the whole thing as a string rather than writing it, so the caller owns
 * the stream and a test can read it without capturing stdout.
 */
export function renderAnalyzeReport(
  plan: RemediationPlan,
  palette: Palette,
  width: number = terminalWidth(),
): string {
  const out: string[] = [];
  const body = Math.max(40, Math.min(width, 100));

  for (const change of plan.changes) {
    const from = change.from ?? '—';
    const to = change.to ?? '—';
    out.push('', palette('bold', `${change.name}  ${from} → ${to}`));
  }

  const dispositions = plan.dispositions ?? [];
  const byId = new Map(dispositions.map((d) => [d.changeId, d]));

  // Sites are keyed by change so "where" sits under the finding it belongs to,
  // rather than in a separate list the reader has to join by hand.
  const sitesByChange = new Map<string, { file: string; line: number }[]>();
  for (const site of plan.impactSites) {
    const list = sitesByChange.get(site.breakingChangeId) ?? [];
    list.push({ file: site.file, line: site.line });
    sitesByChange.set(site.breakingChangeId, list);
  }

  for (const section of SECTIONS) {
    const changes = plan.breakingChanges.filter(
      (c) => stateOf(byId.get(c.id)) === section.state,
    );
    if (changes.length === 0) continue;

    out.push('', palette(section.tone, `${section.heading} (${changes.length})`));

    // Grouped by package, and capped per package. One major can remove three
    // dozen type exports, and printing each one gives a reader thirty-six
    // lines that differ by an identifier and say the same thing: this package
    // changed a lot, and none of it was traced to your code. The count keeps
    // that honest without spending a screen on it.
    for (const [dependency, group] of groupByDependency(changes)) {
      if (changes.length !== group.length) {
        out.push(palette('gray', `  ${dependency} (${group.length})`));
      }
      const shown = section.state === 'actionable' ? group : group.slice(0, PER_DEPENDENCY_CAP);
      for (const change of shown) {
        out.push(`  ${palette(section.tone, section.glyph)} ${wrap(change.summary, body - 4, '    ').trimStart()}`);

        const sites = sitesByChange.get(change.id) ?? [];
        // A cap, because "affects this repository" is the finding and forty line
        // numbers is an appendix. The count still tells the truth about the rest.
        for (const site of sites.slice(0, 3)) {
          out.push(palette('gray', `      ${site.file}:${site.line}`));
        }
        if (sites.length > 3) {
          out.push(palette('gray', `      …and ${sites.length - 3} more`));
        }
      }
      if (group.length > shown.length) {
        out.push(
          palette('gray', `      …and ${group.length - shown.length} more from ${dependency} — \`--markdown\` lists them`),
        );
      }
    }
  }

  // Gaps last and never omitted: this is the difference between "nothing else
  // is wrong" and "nothing else was checked".
  if (plan.gaps.length > 0) {
    out.push('', palette('gray', 'Not checked'));
    for (const gap of plan.gaps) {
      // With the package named. Four bare lines reading "upstream release
      // evidence" say something was not checked without saying about what,
      // which is the one thing a gap has to say.
      const surface = gap.dependency ? `${gap.surface} — ${gap.dependency}` : gap.surface;
      out.push(palette('gray', `  · ${wrap(surface, body - 4, '    ').trimStart()}`));
    }
  }

  return out.join('\n');
}

/** How many findings one package contributes before the rest become a count. */
const PER_DEPENDENCY_CAP = 4;

/**
 * How many findings nothing has ruled on either way.
 *
 * The number a reader is really asking about when a quick scan comes back
 * mostly uncertain — and the number deep verification is for, since installing
 * the upgrade and running the project's own checks settles all of them at once
 * without anyone reading a single line.
 */
export function unsettledCount(plan: RemediationPlan): number {
  const byId = new Map((plan.dispositions ?? []).map((d) => [d.changeId, d]));
  return plan.breakingChanges.filter((c) => stateOf(byId.get(c.id)) === 'unknown').length;
}

/**
 * Findings by package, in the order the packages first appear, so a reader
 * follows the same sequence as the version list at the top of the report.
 */
function groupByDependency(changes: readonly { dependency: string }[]): Map<string, { dependency: string; id: string; summary: string }[]> {
  const groups = new Map<string, { dependency: string; id: string; summary: string }[]>();
  for (const change of changes as { dependency: string; id: string; summary: string }[]) {
    const group = groups.get(change.dependency) ?? [];
    group.push(change);
    groups.set(change.dependency, group);
  }
  return groups;
}

function stateOf(disposition: BreakingChangeDisposition | undefined): string {
  // A change with no disposition is not a change that is fine — it is one
  // nothing ruled on, which is what `unknown` means.
  return disposition?.state ?? 'unknown';
}
