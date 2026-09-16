import { VERDICT_TEXT } from '../report/confidence.js';
import { matchGlob } from '../util/glob.js';
import {
  AGENT_BRIEF_BUDGET,
  byteLength,
  capLine,
  clipLines,
  estimateTokens,
  maxBytes,
  targetBytes,
  type ContextBudget,
} from './budget.js';
import type { AgentBrief, AgentExecutionUnit, AgentFinding, AgentGap, AgentSite } from './types.js';

/**
 * The brief as text, inside a hard size budget.
 *
 * Budget rules, in the order they bite:
 *
 *  1. The header, constraints, checks, a summary of every gap, and the
 *     omission footer are always present. They are small, and they are the part that stops an agent
 *     from editing a protected file or reading silence as safety.
 *  2. Findings go in whole, in priority order. A finding that does not fit
 *     at full detail is tried with its site list compacted to a few files and
 *     an exact count; one that does not fit even then is left out entirely
 *     and its id is listed as omitted for size. A finding is never cut
 *     part-way through.
 *  3. Execution units and grouped gaps fill what remains, full or as a
 *     one-line summary; titles of upstream notes come last. These may use
 *     the headroom between the target and the ceiling, findings may not.
 *
 * The text states what it left out and how to get it, so a smaller budget
 * costs a tool call rather than a wrong answer.
 */

/** How the agent can fetch what the brief leaves out. */
export type DetailRetrieval =
  /** The Drift MCP server is connected: name its tools. */
  | 'mcp'
  /** Only the CLI is available: name the command. */
  | 'cli'
  /** Nothing is available: say plainly that the detail exists but is not reachable here. */
  | 'none';

export interface RenderAgentBriefOptions {
  budget?: ContextBudget;
  retrieval?: DetailRetrieval;
  /** One line a surface needs to add (e.g. that the plan was computed earlier). Counted inside the budget. */
  note?: string;
}

export interface RenderedAgentBrief {
  text: string;
  bytes: number;
  estimatedTokens: number;
  findings: {
    full: string[];
    compacted: string[];
    omittedForBudget: string[];
  };
  sections: { units: SectionLevel; gaps: SectionLevel; notes: SectionLevel };
}

type SectionLevel = 'full' | 'summary' | 'omitted' | 'empty';

/**
 * What the agent is told Drift has done, and what not to redo.
 *
 * Operational, and deliberately not "trust Drift": the agent still reads the
 * code. What it is told not to do is the broad re-research — enumerating the
 * package's API or changelog — that the first benchmark showed agents doing
 * even with Drift's findings in hand.
 */
export const AGENT_BRIEF_INSTRUCTIONS = [
  'Drift has already compared the published versions of these packages and searched this repository for code that uses what changed.',
  'Use the findings and locations below as your starting scope. Do not independently enumerate the package API or changelog unless this brief is insufficient or the code contradicts it.',
  'Inspect the affected code, make the required changes, and run the checks listed.',
].join(' ');

const RETRIEVAL_HINT: Record<DetailRetrieval, string> = {
  mcp: 'Any id below resolves with the Drift MCP tools: get_finding <id> for every site and the fix, get_evidence <id> for the upstream evidence.',
  cli: 'Any id below resolves with `drift analyze --agent --finding <id>` or `--evidence <id>`.',
  none: "Omitted detail exists in Drift's full plan but is not available in this session.",
};

const FULL_SITE_REFS = 24;
/** Omitted ids named in the footer. Beyond this the footer states a count, so its size is bounded too. */
const MAX_OMITTED_IDS = 20;
const FULL_MEASURED_SITES = 12;
const COMPACT_FILES = 3;
const COMPACT_LINES_PER_FILE = 3;

export function renderAgentBrief(brief: AgentBrief, options: RenderAgentBriefOptions = {}): RenderedAgentBrief {
  const budget = options.budget ?? AGENT_BRIEF_BUDGET;
  const retrieval = options.retrieval ?? 'mcp';
  const target = targetBytes(budget);
  const ceiling = maxBytes(budget);

  const header = options.note ? `${renderHeader(brief, retrieval)}\n${options.note}` : renderHeader(brief, retrieval);
  const constraints = renderConstraints(brief);
  const checks = renderChecks(brief);

  const groups = groupFindings(brief.findings);
  const full: string[] = [];
  const compacted: string[] = [];
  const omittedForBudget: string[] = [];

  let notesText = '';
  const assemble = (findingBlocks: string[], units: string, gaps: string, footer: string) =>
    [header, constraints, findingBlocks.length > 0 ? `## Findings\n\n${findingBlocks.join('\n\n')}` : '', units, checks, gaps, notesText, footer]
      .filter(Boolean)
      .join('\n\n');

  // Reserve the footer at its largest plausible size — every finding id
  // omitted — so admitting findings can never push it over the ceiling.
  const worstFooter = renderFooter(brief, retrieval, brief.findings.map((f) => f.id));
  // Uncertainty is reserved like the header: at worst it is summarised, it is
  // never dropped to make room for anything.
  const summaryGaps = brief.gaps.length > 0 ? renderGaps(brief.gaps, 'summary') : '';
  const fixedBytes = byteLength(assemble([], '', summaryGaps, worstFooter));

  const blocks: string[] = [];
  const blockGroups: AgentFinding[][] = [];
  let used = fixedBytes;
  let index = 0;
  for (const group of groups) {
    index += 1;
    const ids = group.map((f) => f.id);
    const fullBlock = renderFindingGroup(group, index, 'full');
    const compactBlock = renderFindingGroup(group, index, 'compact');
    const cost = (block: string) => byteLength(block) + 2 + (blocks.length === 0 ? byteLength('## Findings\n\n') : 0);
    if (used + cost(fullBlock) <= target) {
      blocks.push(fullBlock);
      blockGroups.push(group);
      used += cost(fullBlock);
      full.push(...ids);
    } else if (used + cost(compactBlock) <= target) {
      blocks.push(compactBlock);
      blockGroups.push(group);
      used += cost(compactBlock);
      if (compactBlock === fullBlock) full.push(...ids);
      else compacted.push(...ids);
    } else {
      omittedForBudget.push(...ids);
      index -= 1;
    }
  }

  let unitsLevel: SectionLevel = brief.units.length === 0 ? 'empty' : 'omitted';
  let unitsText = '';
  if (brief.units.length > 0) {
    const fullUnits = renderUnits(brief.units, 'full');
    const summaryUnits = renderUnits(brief.units, 'summary');
    if (used + byteLength(fullUnits) + 2 <= target) {
      unitsText = fullUnits;
      unitsLevel = 'full';
    } else if (used + byteLength(summaryUnits) + 2 <= ceiling) {
      unitsText = summaryUnits;
      unitsLevel = 'summary';
    }
    used += unitsText ? byteLength(unitsText) + 2 : 0;
  }

  let gapsLevel: SectionLevel = brief.gaps.length === 0 ? 'empty' : 'summary';
  let gapsText = summaryGaps;
  if (brief.gaps.length > 0) {
    const fullGaps = renderGaps(brief.gaps, 'full');
    // The summary is already inside `used`; only the difference is new.
    if (used + byteLength(fullGaps) - byteLength(summaryGaps) <= target) {
      gapsText = fullGaps;
      gapsLevel = 'full';
      used += byteLength(fullGaps) - byteLength(summaryGaps);
    }
  }



  // Last and optional: titles of upstream prose an agent can ask for instead
  // of searching the web. Worth a line, never worth a finding — so it is
  // admitted only after every finding has been placed, and like the section
  // summaries it may use the headroom between the target and the ceiling.
  let notesLevel: SectionLevel = brief.notes.length === 0 || retrieval === 'none' ? 'empty' : 'omitted';
  if (notesLevel === 'omitted') {
    const candidate = `## Upstream notes on request\n\n${brief.notes.map((note) => `- ${note.id} ${capLine(note.title, 70)}`).join('\n')}`;
    if (used + byteLength(candidate) + 2 <= ceiling - byteLength(worstFooter)) {
      notesText = candidate;
      notesLevel = 'full';
    }
  }

  const footer = renderFooter(brief, retrieval, omittedForBudget);
  let text = assemble(blocks, unitsText, gapsText, footer);
  if (byteLength(text) > ceiling && notesText) {
    notesText = '';
    notesLevel = 'omitted';
    text = assemble(blocks, unitsText, gapsText, footer);
  }

  // The reservation above makes this unreachable for any brief whose fixed
  // part fits; it stays as the hard stop for one whose fixed part does not.
  if (byteLength(text) > ceiling && gapsLevel === 'full') {
    gapsText = summaryGaps;
    gapsLevel = 'summary';
    text = assemble(blocks, unitsText, gapsText, footer);
  }
  if (byteLength(text) > ceiling && unitsText) {
    unitsText = '';
    unitsLevel = 'omitted';
    text = assemble(blocks, unitsText, gapsText, footer);
  }
  while (byteLength(text) > ceiling && blocks.length > 0) {
    blocks.pop();
    const dropped = new Set((blockGroups.pop() ?? []).map((finding) => finding.id));
    for (const list of [full, compacted]) {
      const kept = list.filter((id) => !dropped.has(id));
      list.splice(0, list.length, ...kept);
    }
    omittedForBudget.push(...[...dropped].filter((id) => !omittedForBudget.includes(id)));
    text = assemble(blocks, unitsText, gapsText, renderFooter(brief, retrieval, omittedForBudget));
  }

  // Unconditional: a pathological plan (hundreds of blockers) can make even
  // the reserved part too large. Cut at a line and say so, rather than
  // exceed the ceiling a caller was promised.
  if (byteLength(text) > ceiling) {
    const note = '\n\n(Brief cut at its size limit. Drift blockers and constraints above are incomplete; ask for the full plan.)';
    text = clipLines(text, ceiling - byteLength(note)).text + note;
  }

  return {
    text,
    bytes: byteLength(text),
    estimatedTokens: estimateTokens(text),
    findings: { full, compacted, omittedForBudget },
    sections: { units: unitsLevel, gaps: gapsLevel, notes: notesLevel },
  };
}

function renderHeader(brief: AgentBrief, retrieval: DetailRetrieval): string {
  const moved = brief.dependencies.map((d) => `${d.name} ${d.from ?? '—'} → ${d.to ?? '—'}`);
  const shown = moved.slice(0, 4).join(', ') + (moved.length > 4 ? ` (+${moved.length - 4} more)` : '');
  const verification =
    brief.verification.status === 'not-run'
      ? 'not run'
      : brief.verification.status === 'skipped'
        ? `skipped${brief.verification.reason ? ` (${capLine(brief.verification.reason, 120)})` : ''}`
        : `${brief.verification.status} — the upgraded tree was installed and this project's checks were run before any fix`;

  const omittedUpstream = brief.omitted.noLocatedUsage + brief.omitted.notSearched + brief.omitted.unaffected;
  const scope =
    `${brief.counts.locallyRelevant} finding${brief.counts.locallyRelevant === 1 ? '' : 's'} reach this repository` +
    (omittedUpstream > 0 ? `; ${omittedUpstream} other upstream breaking change${omittedUpstream === 1 ? ' is' : 's are'} omitted (see the end)` : '') +
    '.';

  return [
    `# Drift agent brief: ${shown}`,
    '',
    AGENT_BRIEF_INSTRUCTIONS,
    RETRIEVAL_HINT[retrieval],
    '',
    `Verdict: ${VERDICT_TEXT[brief.verdict]}.`,
    `Verification: ${verification}.`,
    `Scope: ${scope}`,
  ].join('\n');
}

function renderConstraints(brief: AgentBrief): string {
  const lines: string[] = [];
  const { protectedFiles, protectedPaths } = brief.constraints;
  if (protectedFiles.length > 0) {
    // The globs, not every file: the rule is the glob, and the files are
    // already named at their sites below.
    const globs = protectedPaths.filter((glob) => protectedFiles.some((file) => matchGlob(glob, file)));
    lines.push(
      `- Protected by drift.yml guardrails, do not edit: ${globs.join(', ')} (${protectedFiles.length} file${protectedFiles.length === 1 ? '' : 's'} with sites below). If a fix needs one, say so instead.`,
    );
  }
  for (const blocker of brief.constraints.blockers) lines.push(`- Drift blocker: ${blocker}`);
  return lines.length > 0 ? `## Constraints\n\n${lines.join('\n')}` : '';
}

/**
 * Findings with the same kind, state and exact site set render as one block.
 *
 * Three packages in one upgrade family raising the same Node floor land on the
 * same fifteen workflow lines; listing those lines three times is the kind of
 * repetition this renderer exists to remove. Each id and summary is kept.
 */
function groupFindings(findings: readonly AgentFinding[]): AgentFinding[][] {
  const groups: AgentFinding[][] = [];
  const byKey = new Map<string, AgentFinding[]>();
  for (const finding of findings) {
    const key =
      finding.source === 'verification' || finding.sites.length === 0
        ? `solo:${finding.id}`
        : `${finding.kind}|${finding.state}|${finding.sites.map((s) => `${s.file}:${s.line}`).join(',')}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.push(finding);
      continue;
    }
    const group = [finding];
    byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}

function renderFindingGroup(group: readonly AgentFinding[], index: number, level: 'full' | 'compact'): string {
  const first = group[0]!;
  const lines: string[] = [];
  const confidence = unique(group.map((f) => f.confidence)).join('/');
  const dependencies = unique(group.map((f) => f.dependency)).join(', ');
  lines.push(`### [${index}] ${group.map((f) => f.id).join(', ')}`);
  lines.push(`${dependencies} · ${first.kind} · ${first.state} · confidence ${confidence}`);

  const changes = unique(group.map((f) => f.change));
  if (group.length === 1) {
    lines.push(first.summary);
  } else {
    for (const finding of group) lines.push(`- ${finding.id} (${finding.dependency}): ${finding.summary}`);
  }
  if (changes.length === 1) {
    lines.push(`Change: ${changes[0]}`);
  } else if (level === 'compact') {
    // Grouped findings' remedies are usually one template with a different
    // symbol. Compact keeps the first verbatim and names where the rest are,
    // rather than cutting any of them part-way.
    lines.push(`Change (${first.id}): ${first.change}`);
    lines.push(`Change for ${group.slice(1).map((f) => f.id).join(', ')}: see each id.`);
  } else {
    for (const finding of group) lines.push(`Change (${finding.id}): ${finding.change}`);
  }

  if (first.source === 'verification') {
    lines.push(...renderMeasuredSites(first.sites, level === 'full' ? FULL_MEASURED_SITES : COMPACT_FILES, first.id));
  } else if (first.sites.length > 0) {
    lines.push(`At: ${renderSiteRefs(first.sites, level, first.id)}`);
  }

  const protectedCount = unique(group.flatMap((f) => f.protectedFiles)).length;
  const fileCount = unique(group.flatMap((f) => f.files)).length;
  if (protectedCount > 0) {
    lines.push(protectedCount === fileCount ? 'Every site is in a protected path.' : `${protectedCount} of ${fileCount} files are protected.`);
  }

  const units = unique(group.flatMap((f) => f.unitIds));
  const evidence = unique(group.flatMap((f) => f.evidenceIds));
  const refs = [units.length > 0 ? `units ${units.join(', ')}` : '', evidence.length > 0 ? `evidence ${evidence.join(', ')}` : '']
    .filter(Boolean)
    .join(' · ');
  if (refs) lines.push(refs);

  return lines.join('\n');
}

function renderMeasuredSites(sites: readonly AgentSite[], limit: number, id: string): string[] {
  const shown = sites.slice(0, limit).map((site) => `- ${site.file}:${site.line} ${capLine(site.message ?? site.symbol ?? '', 140)}`.trimEnd());
  if (sites.length > limit) shown.push(`- …${sites.length - limit} more; get the rest with ${id}`);
  return shown;
}

/** `src/a.ts:3,15,28; package.json:71`, capped by site count, with an exact remainder. */
function renderSiteRefs(sites: readonly AgentSite[], level: 'full' | 'compact', id: string): string {
  const byFile = new Map<string, number[]>();
  for (const site of sites) {
    const lines = byFile.get(site.file) ?? [];
    if (!lines.includes(site.line)) lines.push(site.line);
    byFile.set(site.file, lines);
  }

  const parts: string[] = [];
  let shownSites = 0;
  let fileCount = 0;
  for (const [file, lines] of byFile) {
    if (level === 'compact' && fileCount >= COMPACT_FILES) break;
    const room = level === 'full' ? FULL_SITE_REFS - shownSites : COMPACT_LINES_PER_FILE;
    if (room <= 0) break;
    const taken = lines.slice(0, room);
    parts.push(`${file}:${taken.join(',')}${lines.length > taken.length ? `,+${lines.length - taken.length}` : ''}`);
    shownSites += taken.length;
    fileCount += 1;
  }

  const total = [...byFile.values()].reduce((sum, lines) => sum + lines.length, 0);
  const remainingFiles = byFile.size - fileCount;
  const remainder =
    remainingFiles > 0
      ? `; +${remainingFiles} more file${remainingFiles === 1 ? '' : 's'} (${total} sites in ${byFile.size} files; get the rest with ${id})`
      : '';
  return `${parts.join('; ')}${remainder}`;
}

function renderUnits(units: readonly AgentExecutionUnit[], level: 'full' | 'summary'): string {
  if (level === 'summary') {
    const layers = unique(units.map((u) => String(u.layer))).length;
    const deterministic = units.filter((u) => u.agentWork === 'none').length;
    const named = units.slice(0, 10).map((u) => u.id).join(' → ');
    return `## Execution units\n\n${units.length} unit${units.length === 1 ? '' : 's'} in ${layers} layer${layers === 1 ? '' : 's'}${deterministic > 0 ? `, ${deterministic} fully deterministic` : ''}: ${named}${units.length > 10 ? ` → … (${units.length - 10} more)` : ''}.`;
  }
  const lines = units.map((unit) => {
    const parts = [`- ${unit.id} (layer ${unit.layer}) ${unit.goal}`];
    parts.push(`  findings ${unit.findingIds.join(', ')} · files ${unit.files.join(', ') || '—'}`);
    if (unit.dependsOn.length > 0) parts.push(`  after ${unit.dependsOn.join(', ')}`);
    if (unit.deterministic) {
      const d = unit.deterministic;
      parts.push(
        unit.agentWork === 'none'
          ? `  deterministic: ${d.mechanism} ${d.ids.join(', ')} covers all ${d.covered} site${d.covered === 1 ? '' : 's'}; not agent work`
          : `  deterministic: ${d.mechanism} ${d.ids.join(', ')} covers ${d.covered}; agent handles ${d.residualSites.map((s) => `${s.file}:${s.line}`).join(', ')}`,
      );
    }
    if (unit.checks.length > 0) parts.push(`  checks ${unit.checks.join(', ')}`);
    return parts.join('\n');
  });
  return `## Execution units (in order; the same layer means independent)\n\n${lines.join('\n')}`;
}

function renderChecks(brief: AgentBrief): string {
  if (brief.checks.length === 0) return '## Checks\n\nDrift knows no check commands for this repository; use the project\'s own.';
  const status: Record<string, string> = {
    passed: 'passed after the upgrade, before any fix',
    failed: 'failed after the upgrade, before any fix',
    'not-run': 'did not run',
    expected: 'must pass after the fix',
    available: 'available',
  };
  const lines = brief.checks.map((check) => {
    const line = `- ${check.label}: ${status[check.status]}`;
    return check.excerpt ? `${line}\n  ${check.excerpt.split('\n').map((l) => capLine(l, 160)).join('\n  ')}` : line;
  });
  return `## Checks\n\n${lines.join('\n')}`;
}

function renderGaps(gaps: readonly AgentGap[], level: 'full' | 'summary'): string {
  if (level === 'summary') {
    const names = gaps.map((gap) => {
      const who = gap.dependencies.length > 0 ? ` [${gap.dependencies.join(', ')}]` : '';
      const what = gap.surfaces.length === 1 ? gap.surfaces[0] : `${gap.surfaces.length} × ${surfaceKind(gap.surfaces[0]!)}`;
      return `- ${what}${who}: ${gap.remediation}`;
    });
    return `## What Drift could not establish (none of it is evidence of safety)\n\n${names.join('\n')}`;
  }
  const lines = gaps.map((gap) => {
    const names = gap.surfaces.length === 1 ? gap.surfaces[0] : `${gap.surfaces.length} surfaces: ${gap.surfaces.join('; ')}`;
    const who = gap.dependencies.length > 0 ? ` [${gap.dependencies.join(', ')}]` : '';
    const reason = gap.surfaces.length === 1 ? ` ${gap.reason}` : '';
    return `- ${gap.severity} (${gap.stage})${who} ${names}.${reason} ${gap.remediation}`;
  });
  return `## What Drift could not establish\n\n${lines.join('\n')}`;
}

function renderFooter(brief: AgentBrief, retrieval: DetailRetrieval, omittedForBudget: readonly string[]): string {
  const o = brief.omitted;
  const parts: string[] = [];
  if (o.noLocatedUsage > 0) {
    parts.push(
      `${o.noLocatedUsage} upstream breaking change${o.noLocatedUsage === 1 ? '' : 's'} with no located usage in this repository (a search, not proof of safety)`,
    );
  }
  if (o.notSearched > 0) parts.push(`${o.notSearched} not searched for in this repository (uncertain)`);
  if (o.unaffected > 0) parts.push(`${o.unaffected} established not to affect it`);
  const kinds = Object.entries(o.byKind)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([kind, count]) => `${kind} ${count}`)
    .join(', ');

  const lines = ['## Not in this brief', ''];
  if (parts.length > 0) lines.push(`- ${parts.join('; ')}${kinds ? ` — by kind: ${kinds}` : ''}.`);
  if (o.evidenceRecords > 0) lines.push(`- ${o.evidenceRecords} evidence record${o.evidenceRecords === 1 ? '' : 's'}, cited by id above.`);

  if (omittedForBudget.length > 0) {
    const shown = omittedForBudget.slice(0, MAX_OMITTED_IDS);
    const rest = omittedForBudget.length - shown.length;
    lines.push(
      `- Left out for size, still locally relevant: ${shown.join(', ')}${rest > 0 ? ` and ${rest} more (${omittedForBudget.length} in all; they follow the findings above in priority order)` : ''}.`,
    );
  }
  if (lines.length === 2) lines.push('- Nothing.');
  if (retrieval === 'none' && (omittedForBudget.length > 0 || o.evidenceRecords > 0)) lines.push(`- ${RETRIEVAL_HINT.none}`);
  return lines.join('\n');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `reachability of winston.Logger` → `reachability`. Linear, unlike a ` of .*$` pattern on untrusted text. */
function surfaceKind(surface: string): string {
  const index = surface.indexOf(' of ');
  return index === -1 ? surface : surface.slice(0, index);
}
