import type { BreakingChange, Evidence, RemediationPlan } from '../types.js';
import {
  EVIDENCE_PAGE_BUDGET,
  FINDING_DETAIL_BUDGET,
  byteLength,
  capLine,
  clipLines,
  estimateTokens,
  maxBytes,
  targetBytes,
  type ContextBudget,
} from './budget.js';
import { buildAgentBrief, type AgentBriefOptions } from './brief.js';
import type { AgentFinding } from './types.js';

/**
 * Pull-based detail behind an agent brief.
 *
 * The brief names ids; these functions resolve them against the same
 * production plan, one object at a time, inside their own budgets. An id the
 * brief omitted — one of the upstream changes with no located usage — resolves
 * just as well: omitted from the hot context is not the same as unavailable.
 */

export class UnknownAgentIdError extends Error {
  constructor(
    readonly kind: 'finding' | 'evidence',
    readonly id: string,
    hint: string,
  ) {
    super(`No ${kind} with id "${id}" in this plan. ${hint}`);
    this.name = 'UnknownAgentIdError';
  }
}

export interface DetailResult<T> {
  text: string;
  bytes: number;
  estimatedTokens: number;
  data: T;
}

/** A finding in detail: the brief's shape plus what was left out of the brief. */
export interface AgentFindingDetail extends AgentFinding {
  /** The disposition state, including for findings the brief omitted. */
  disposition: string;
  before?: string;
  after?: string;
  replacementSymbols?: string[];
  /** Site excerpts, keyed `file:line`, for as many sites as the budget allowed. */
  excerpts: Record<string, string>;
  /** Upstream changes a measured finding's diagnostics name, or measured failures that name this change's symbols. */
  related: { id: string; summary: string }[];
  /** Gaps about this finding's dependency and symbols. */
  gaps: string[];
  /** Sites not printed for size. Always exact. */
  sitesNotShown: number;
}

const MEASURED_PREFIX = 'measured:';

/** Resolve one finding id. Throws {@link UnknownAgentIdError} for an id the plan does not hold. */
export function findingDetail(
  plan: RemediationPlan,
  id: string,
  options: AgentBriefOptions & { budget?: ContextBudget } = {},
): DetailResult<AgentFindingDetail> {
  const budget = options.budget ?? FINDING_DETAIL_BUDGET;
  const brief = buildAgentBrief(plan, options);
  const inBrief = brief.findings.find((finding) => finding.id === id);
  const change = plan.breakingChanges.find((c) => c.id === id);

  let base: AgentFinding;
  if (inBrief) {
    base = inBrief;
  } else if (change) {
    base = omittedFinding(plan, change);
  } else {
    throw new UnknownAgentIdError(
      'finding',
      id,
      'Finding ids are the `bc_…` and `measured:…` ids a Drift brief lists; call plan_upgrade to get the current ones.',
    );
  }

  const disposition = plan.dispositions?.find((d) => d.changeId === id);
  const detail: AgentFindingDetail = {
    ...base,
    disposition: base.source === 'verification' ? 'measured' : (disposition?.state ?? 'unknown'),
    ...(change?.before ? { before: change.before } : {}),
    ...(change?.after ? { after: change.after } : {}),
    ...(change?.replacementSymbols?.length ? { replacementSymbols: change.replacementSymbols } : {}),
    excerpts: {},
    related: relatedFindings(plan, base, change),
    gaps: plan.gaps
      .filter((gap) => gap.dependency === base.dependency && (change?.symbols ?? []).some((s) => gap.surface.includes(s)))
      .map((gap) => `${gap.surface}: ${gap.reason}`),
    sitesNotShown: 0,
  };

  const units = plan.commits.filter((commit) => base.unitIds.includes(commit.id));

  const head: string[] = [
    `# ${base.id}`,
    `${base.dependency} · ${base.kind} · ${detail.disposition}${base.reason ? ` (${base.reason})` : ''} · confidence ${base.confidence}`,
    base.summary,
    '',
    `Change: ${base.change}`,
  ];
  if (detail.before) head.push('', 'Before:', clipLines(detail.before, 600).text);
  if (detail.after) head.push('', 'After:', clipLines(detail.after, 600).text);
  if (change && change.symbols.length > 0) {
    head.push('', `Symbols: ${change.symbols.slice(0, 20).join(', ')}${change.symbols.length > 20 ? ` (+${change.symbols.length - 20})` : ''}`);
  }
  if (detail.replacementSymbols) head.push(`Replacements: ${detail.replacementSymbols.join(', ')}`);

  const tail: string[] = [];
  for (const unit of units) {
    const deterministic = unit.fixPlan
      ? ` Deterministic fix plan ${unit.fixPlan.plan.id} covers ${unit.fixPlan.covered}, ${unit.fixPlan.residual} left for an agent.`
      : unit.codemod?.length
        ? ` Deterministic codemod covers every anchored site.`
        : '';
    tail.push(
      `Unit ${unit.id} (layer ${unit.executionLayer}): ${unit.message}. Files: ${unit.allowedFiles.join(', ') || unit.files.join(', ')}.${unit.dependsOn.length ? ` After ${[...new Set(unit.dependsOn)].join(', ')}.` : ''}${deterministic}`,
    );
  }
  if (base.protectedFiles.length > 0) tail.push(`Protected (do not edit): ${base.protectedFiles.join(', ')}`);
  if (detail.related.length > 0) {
    tail.push(`Related: ${detail.related.map((r) => `${r.id} ${capLine(r.summary, 80)}`).join('; ')}`);
  }
  for (const gap of detail.gaps.slice(0, 3)) tail.push(`Gap: ${gap}`);
  const evidence = plan.evidence.filter((record) => base.evidenceIds.includes(record.id));
  if (evidence.length > 0) {
    tail.push(`Evidence: ${evidence.map((record) => `${record.id} (${record.source}) ${capLine(record.title, 70)}`).join('; ')}`);
  }

  // Sites fill whatever the budget leaves once the fixed parts are placed.
  const fixed = byteLength([...head, '', 'Sites:', '', ...tail].join('\n')) + 80;
  const excerptsBySite = siteExcerpts(plan, base.id);
  const siteLines: string[] = [];
  let used = fixed;
  let shown = 0;
  for (const site of base.sites) {
    const key = `${site.file}:${site.line}`;
    const excerpt = site.message ?? excerptsBySite.get(key) ?? '';
    const line = `- ${key}${site.symbol && !site.message ? ` ${site.symbol}` : ''}${excerpt ? ` — ${capLine(excerpt, 120)}` : ''}`;
    if (used + byteLength(line) + 1 > targetBytes(budget)) break;
    siteLines.push(line);
    if (excerpt) detail.excerpts[key] = excerpt;
    used += byteLength(line) + 1;
    shown += 1;
  }
  detail.sitesNotShown = base.sites.length - shown;
  if (detail.sitesNotShown > 0) siteLines.push(`- …${detail.sitesNotShown} more site${detail.sitesNotShown === 1 ? '' : 's'} not shown for size.`);

  const sections = [head.join('\n')];
  if (siteLines.length > 0) sections.push(`Sites (${base.sites.length}):\n${siteLines.join('\n')}`);
  if (tail.length > 0) sections.push(tail.join('\n'));
  const text = hardStop(sections.join('\n\n'), maxBytes(budget));
  return { text, bytes: byteLength(text), estimatedTokens: estimateTokens(text), data: detail };
}

export interface EvidenceRequest {
  findingId?: string;
  evidenceId?: string;
  /** Byte offset into one record's content, for paging through a long one. */
  offset?: number;
}

export interface AgentEvidenceExcerpt {
  id: string;
  source: string;
  dependency: string;
  title: string;
  url?: string;
  /** Structured findings in the record that concern the requested finding (or all, when none was named). */
  findings: { symbol: string; detail: string; before?: string; after?: string }[];
  excerpt: string;
  /** Where the excerpt starts in the record's content. */
  offset: number;
  /** The next offset to request, when the record continues past this page. */
  nextOffset: number | null;
  contentBytes: number;
}

/**
 * The evidence behind one finding, or one evidence record, bounded.
 *
 * For a finding, each cited record is narrowed to the lines that name one of
 * its symbols — a type-surface diff covering 278 changes contributes the one
 * line about this change, not the other 277. A measured finding's evidence is
 * the failing checks' own output.
 */
export function evidenceDetail(
  plan: RemediationPlan,
  request: EvidenceRequest,
  options: { budget?: ContextBudget } = {},
): DetailResult<{ records: AgentEvidenceExcerpt[] }> {
  const budget = options.budget ?? EVIDENCE_PAGE_BUDGET;
  if (!request.findingId && !request.evidenceId) {
    throw new UnknownAgentIdError('evidence', '', 'Pass a finding id, an evidence id, or both.');
  }

  let change: BreakingChange | undefined;
  if (request.findingId) {
    change = plan.breakingChanges.find((c) => c.id === request.findingId);
    if (!change && request.findingId.startsWith(MEASURED_PREFIX) && !request.evidenceId) {
      return measuredEvidence(plan, request.findingId, budget);
    }
    if (!change && !request.findingId.startsWith(MEASURED_PREFIX)) {
      throw new UnknownAgentIdError('finding', request.findingId, 'Use an id from the Drift brief.');
    }
  }

  let records: Evidence[];
  if (request.evidenceId) {
    const record = plan.evidence.find((e) => e.id === request.evidenceId);
    if (!record) {
      throw new UnknownAgentIdError('evidence', request.evidenceId, 'Evidence ids are the `ev_…` ids a Drift brief or finding cites.');
    }
    records = [record];
  } else {
    records = plan.evidence.filter((record) => change!.citations.includes(record.id));
  }

  const symbols = change ? change.symbols.filter((s) => s.length > 1) : [];
  const perRecord = Math.max(600, Math.floor(targetBytes(budget) / Math.max(1, records.length)) - 200);
  const out: AgentEvidenceExcerpt[] = [];
  const blocks: string[] = [];

  for (const record of records) {
    const structured = (record.findings ?? [])
      .filter((finding) => symbols.length === 0 || symbols.includes(finding.symbol))
      .slice(0, 10)
      .map((finding) => ({
        symbol: finding.symbol,
        detail: finding.detail,
        ...(finding.before ? { before: finding.before } : {}),
        ...(finding.after ? { after: finding.after } : {}),
      }));

    const offset = Math.max(0, Math.min(request.offset ?? 0, record.content.length));
    // Narrow to the finding when one was named and no page was asked for. A
    // record that names none of the finding's symbols contributes its
    // structured findings (if any) and a pointer, never its whole content:
    // the type-surface diff for 278 changes is exactly the thing not to dump.
    const narrowing = symbols.length > 0 && request.offset === undefined && !request.evidenceId;
    const narrowed = narrowing ? (linesNaming(record.content, symbols) ?? '') : null;
    const source = narrowed ?? record.content.slice(offset);
    const clipped = clipLines(source, perRecord);
    const consumed = narrowed !== null ? record.content.length : offset + clipped.text.length;
    const excerpt: AgentEvidenceExcerpt = {
      id: record.id,
      source: record.source,
      dependency: record.dependency,
      title: record.title,
      ...(record.url ? { url: record.url } : {}),
      findings: structured,
      excerpt: clipped.text,
      offset: narrowed !== null ? 0 : offset,
      nextOffset: narrowed === null && consumed < record.content.length ? consumed : null,
      contentBytes: byteLength(record.content),
    };
    out.push(excerpt);

    const lines = [`## ${record.id} · ${record.source} · ${record.title}`];
    if (record.url) lines.push(record.url);
    for (const finding of structured) {
      lines.push(`- ${finding.detail}${finding.before ? `\n  before: ${capLine(finding.before, 200)}` : ''}${finding.after ? `\n  after:  ${capLine(finding.after, 200)}` : ''}`);
    }
    if (clipped.text.trim() && !(structured.length > 0 && narrowed !== null)) {
      lines.push(narrowed !== null ? 'Lines naming this finding:' : `Content from byte ${excerpt.offset}:`, clipped.text);
    }
    if (narrowed !== null && !clipped.text.trim() && structured.length === 0) {
      lines.push(`No line names this finding's symbols. Read the record itself with evidence id ${record.id} (${record.content.length} characters, paged).`);
    }
    if (excerpt.nextOffset !== null) lines.push(`(continues: request offset ${excerpt.nextOffset} of ${record.content.length})`);
    if (narrowed !== null && clipped.clipped) lines.push('(more matching lines not shown for size)');
    blocks.push(lines.join('\n'));
  }

  const text = hardStop(blocks.join('\n\n') || 'The finding cites no evidence records.', maxBytes(budget));
  return { text, bytes: byteLength(text), estimatedTokens: estimateTokens(text), data: { records: out } };
}

/** An omitted upstream change, shaped as a finding so it resolves the same way. */
function omittedFinding(plan: RemediationPlan, change: BreakingChange): AgentFinding {
  const disposition = plan.dispositions?.find((d) => d.changeId === change.id);
  const sites = (disposition?.sites ?? plan.impactSites.filter((s) => s.breakingChangeId === change.id)).map((site) => ({
    file: site.file,
    line: site.line,
    ...(site.matchedSymbol ? { symbol: site.matchedSymbol } : {}),
  }));
  const files = [...new Set(sites.map((s) => s.file))].sort();
  return {
    id: change.id,
    source: 'analysis',
    state: 'omitted',
    ...(disposition ? { reason: disposition.reason } : {}),
    dependency: change.dependency,
    kind: change.kind,
    confidence: change.confidence,
    summary: change.summary,
    change: change.remediation,
    sites,
    files,
    protectedFiles: [],
    unitIds: plan.commits.filter((c) => c.breakingChangeIds.includes(change.id)).map((c) => c.id),
    evidenceIds: [...change.citations],
  };
}

/**
 * Cross-links between measured diagnostics and upstream changes.
 *
 * A compiler saying `Property 'v' does not exist on type 'TxData'` and an
 * upstream change saying `TxData.v` was removed are the same fact seen from
 * both ends, and the brief deliberately omitted the second (no located usage).
 * Naming it here is what lets an agent go from the error to the evidence in
 * one call instead of reading the changelog.
 */
function relatedFindings(
  plan: RemediationPlan,
  finding: AgentFinding,
  change: BreakingChange | undefined,
): { id: string; summary: string }[] {
  if (finding.source === 'verification') {
    const text = finding.sites.map((site) => site.message ?? '').join('\n');
    return plan.breakingChanges
      .filter((c) => c.dependency === finding.dependency)
      .filter((c) => c.symbols.some((symbol) => mentions(text, symbol)))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, 12)
      .map((c) => ({ id: c.id, summary: c.summary }));
  }
  if (!change) return [];
  const measured = plan.impactSites.filter(
    (site) => site.breakingChangeId.startsWith(MEASURED_PREFIX) && change.symbols.some((symbol) => mentions(site.excerpt, symbol)),
  );
  return [...new Set(measured.map((site) => site.breakingChangeId))].map((id) => ({
    id,
    summary: `measured failure naming ${change.symbols[0]}`,
  }));
}

/**
 * Whether a diagnostic names a symbol.
 *
 * `TxData.v` is matched through its parts — compilers print the member and
 * the type separately (`Property 'v' does not exist on type 'TxData'`). A
 * single-letter part is only accepted alongside its owner, never alone.
 */
function mentions(text: string, symbol: string): boolean {
  const parts = symbol.split('.').filter(Boolean);
  const quoted = (name: string) => new RegExp(`['\`"]${escapeRegExp(name)}['\`"]`).test(text);
  if (parts.length >= 2) {
    const owner = parts[parts.length - 2]!;
    const member = parts[parts.length - 1]!;
    return quoted(member) && quoted(owner);
  }
  return parts[0]!.length > 2 && quoted(parts[0]!);
}

function measuredEvidence(plan: RemediationPlan, id: string, budget: ContextBudget): DetailResult<{ records: AgentEvidenceExcerpt[] }> {
  const sites = plan.impactSites.filter((site) => site.breakingChangeId === id);
  if (sites.length === 0) {
    throw new UnknownAgentIdError('finding', id, 'Measured finding ids come from a verified Drift brief.');
  }
  const failed = (plan.verification?.checks ?? []).filter((check) => check.status === 'failed');
  const per = Math.max(600, Math.floor(targetBytes(budget) / Math.max(1, failed.length)) - 120);
  const records: AgentEvidenceExcerpt[] = failed.map((check) => {
    const tail = check.output.split('\n').filter((line) => line.trim()).slice(-40).join('\n');
    const clipped = clipLinesFromEnd(tail, per);
    return {
      id: `check:${check.label}`,
      source: 'verification',
      dependency: id.slice(MEASURED_PREFIX.length),
      title: `${check.label} (${check.kind}) failed after the upgrade`,
      findings: [],
      excerpt: clipped,
      offset: 0,
      nextOffset: null,
      contentBytes: byteLength(check.output),
    };
  });
  const text = hardStop(
    records.map((r) => `## ${r.title}\n${r.excerpt}`).join('\n\n') || 'The failing checks recorded no output.',
    maxBytes(budget),
  );
  return { text, bytes: byteLength(text), estimatedTokens: estimateTokens(text), data: { records } };
}

function siteExcerpts(plan: RemediationPlan, id: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const site of plan.impactSites) {
    if (site.breakingChangeId !== id || !site.excerpt) continue;
    const key = `${site.file}:${site.line}`;
    if (!map.has(key)) map.set(key, site.excerpt.trim());
  }
  return map;
}

/** Lines naming any symbol, each with the line after it (where a diff prints `before:`/`after:`). */
function linesNaming(content: string, symbols: readonly string[]): string | null {
  const lines = content.split('\n');
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (symbols.some((symbol) => line.includes(symbol))) {
      keep.add(index);
      for (let next = index + 1; next < Math.min(lines.length, index + 3); next++) {
        if (/^\s+(before|after):/.test(lines[next]!)) keep.add(next);
      }
    }
  });
  if (keep.size === 0) return null;
  return [...keep].sort((a, b) => a - b).map((index) => lines[index]).join('\n');
}

function clipLinesFromEnd(text: string, limit: number): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = capLine(lines[i]!, 300);
    const size = byteLength(line) + 1;
    if (used + size > limit) break;
    out.unshift(line);
    used += size;
  }
  return out.join('\n');
}

/** Last-resort byte cap at a line boundary, with a statement that it happened. */
function hardStop(text: string, limit: number): string {
  if (byteLength(text) <= limit) return text;
  const note = '\n(cut at the size limit)';
  return clipLines(text, limit - byteLength(note)).text + note;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
