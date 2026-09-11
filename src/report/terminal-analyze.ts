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
    heading: 'Drift could not establish whether this repository is affected',
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

    for (const change of changes) {
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
  }

  // Gaps last and never omitted: this is the difference between "nothing else
  // is wrong" and "nothing else was checked".
  if (plan.gaps.length > 0) {
    out.push('', palette('gray', 'Not checked'));
    for (const gap of plan.gaps) {
      out.push(palette('gray', `  · ${wrap(gap.surface, body - 4, '    ').trimStart()}`));
    }
  }

  return out.join('\n');
}

function stateOf(disposition: BreakingChangeDisposition | undefined): string {
  // A change with no disposition is not a change that is fine — it is one
  // nothing ruled on, which is what `unknown` means.
  return disposition?.state ?? 'unknown';
}
