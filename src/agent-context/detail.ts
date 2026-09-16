import type { BreakingChange, Evidence, RemediationPlan } from '../types.js';
import {
  EVIDENCE_PAGE_BUDGET,
  FINDING_DETAIL_BUDGET,
  byteLength,
  capLine,
  clipLines,
  estimateTokens,
  maxBytes,
  type ContextBudget,
} from './budget.js';
import { AgentBudgetExceededError, fillWhole, fitPrefix, jsonBytes, requireCoreFits, setIfFits } from './fit.js';
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
  /** Rendered from `data`, so both carry the same selection. */
  text: string;
  bytes: number;
  estimatedTokens: number;
  /** The bounded structured view. Its serialization is within the same ceiling as `text`. */
  data: T;
  /** Bytes of `JSON.stringify(data)`. Never more than the surface's ceiling. */
  jsonBytes: number;
}

/**
 * One finding, as a bounded object.
 *
 * The core (identity, disposition, the summary and the required change) is
 * irreducible. After it, in this order and each as a prefix of whole items:
 * protected files, sites, execution units, evidence records, related
 * findings, gaps, symbols, replacement symbols, and before/after signatures.
 * Every list has an exact "not shown" count beside it.
 */
export interface AgentFindingView {
  id: string;
  source: string;
  state: string;
  disposition: string;
  reason?: string;
  dependency: string;
  kind: string;
  confidence: string;
  summary: string;
  change: string;
  protectedFiles: string[];
  protectedFilesNotShown: number;
  siteCount: number;
  sites: { file: string; line: number; symbol?: string; note?: string }[];
  sitesNotShown: number;
  units: { id: string; layer: number; goal: string; files: string[]; after: string[]; deterministic?: string }[];
  unitsNotShown: number;
  evidence: { id: string; source: string; title: string }[];
  evidenceNotShown: number;
  related: { id: string; summary: string }[];
  relatedNotShown: number;
  gaps: string[];
  gapsNotShown: number;
  symbols: string[];
  symbolsNotShown: number;
  replacementSymbols: string[];
  replacementSymbolsNotShown: number;
  before?: string;
  after?: string;
  /** True when the plan has before/after signatures that did not fit. */
  signaturesNotShown: boolean;
}

/** Characters of a site excerpt or compiler message kept per site. */
const SITE_NOTE_CHARS = 160;
/** Characters kept of each before/after signature. */
const SIGNATURE_CHARS = 600;

const MEASURED_PREFIX = 'measured:';

/** Resolve one finding id. Throws {@link UnknownAgentIdError} for an id the plan does not hold. */
export function findingDetail(
  plan: RemediationPlan,
  id: string,
  options: AgentBriefOptions & { budget?: ContextBudget } = {},
): DetailResult<AgentFindingView> {
  const limit = maxBytes(options.budget ?? FINDING_DETAIL_BUDGET);
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
  const excerpts = siteExcerpts(plan, base.id);

  // Every list is built first, so each "not shown" counter starts at its full
  // total and only shrinks as items are placed.
  const protectedFiles = base.protectedFiles;
  const sites = base.sites.map((site) => {
    const note = site.message ?? excerpts.get(`${site.file}:${site.line}`);
    return {
      file: site.file,
      line: site.line,
      ...(site.symbol && !site.message ? { symbol: site.symbol } : {}),
      ...(note ? { note: capLine(note, SITE_NOTE_CHARS) } : {}),
    };
  });
  const units = plan.commits
    .filter((commit) => base.unitIds.includes(commit.id))
    .map((unit) => ({
      id: unit.id,
      layer: unit.executionLayer,
      goal: unit.message,
      files: unit.allowedFiles.length > 0 ? unit.allowedFiles : unit.files,
      after: [...new Set(unit.dependsOn)].sort(),
      ...(unit.fixPlan
        ? { deterministic: `fix plan ${unit.fixPlan.plan.id} covers ${unit.fixPlan.covered}; ${unit.fixPlan.residual} left for an agent` }
        : unit.codemod?.length
          ? { deterministic: 'codemod covers every anchored site' }
          : {}),
    }));
  const evidence = plan.evidence
    .filter((record) => base.evidenceIds.includes(record.id))
    .map((record) => ({ id: record.id, source: record.source, title: capLine(record.title, 120) }));
  const related = relatedFindings(plan, base, change).map((r) => ({ id: r.id, summary: capLine(r.summary, 160) }));
  const gaps = plan.gaps
    .filter((gap) => gap.dependency === base.dependency && (change?.symbols ?? []).some((s) => gap.surface.includes(s)))
    .map((gap) => `${gap.surface}: ${gap.reason}`);
  const symbols = change?.symbols ?? [];
  const replacements = change?.replacementSymbols ?? [];
  const hasSignatures = Boolean(change?.before || change?.after);

  const view: AgentFindingView = {
    id: base.id,
    source: base.source,
    state: base.state,
    disposition: base.source === 'verification' ? 'measured' : (disposition?.state ?? 'unknown'),
    ...(base.reason ? { reason: base.reason } : {}),
    dependency: base.dependency,
    kind: base.kind,
    confidence: base.confidence,
    summary: base.summary,
    change: base.change,
    protectedFiles: [],
    protectedFilesNotShown: protectedFiles.length,
    siteCount: sites.length,
    sites: [],
    sitesNotShown: sites.length,
    units: [],
    unitsNotShown: units.length,
    evidence: [],
    evidenceNotShown: evidence.length,
    related: [],
    relatedNotShown: related.length,
    gaps: [],
    gapsNotShown: gaps.length,
    symbols: [],
    symbolsNotShown: symbols.length,
    replacementSymbols: [],
    replacementSymbolsNotShown: replacements.length,
    signaturesNotShown: hasSignatures,
  };
  requireCoreFits('finding detail', view, limit);

  fillWhole(view, view.protectedFiles, protectedFiles, limit, (n) => (view.protectedFilesNotShown = protectedFiles.length - n));
  fillWhole(view, view.sites, sites, limit, (n) => (view.sitesNotShown = sites.length - n));
  fillWhole(view, view.units, units, limit, (n) => (view.unitsNotShown = units.length - n));
  fillWhole(view, view.evidence, evidence, limit, (n) => (view.evidenceNotShown = evidence.length - n));
  fillWhole(view, view.related, related, limit, (n) => (view.relatedNotShown = related.length - n));
  fillWhole(view, view.gaps, gaps, limit, (n) => (view.gapsNotShown = gaps.length - n));
  fillWhole(view, view.symbols, symbols, limit, (n) => (view.symbolsNotShown = symbols.length - n));
  fillWhole(view, view.replacementSymbols, replacements, limit, (n) => (view.replacementSymbolsNotShown = replacements.length - n));

  if (hasSignatures) {
    // Both or neither: half a before/after pair misleads more than none.
    const before = change?.before ? capLine(change.before, SIGNATURE_CHARS) : undefined;
    const after = change?.after ? capLine(change.after, SIGNATURE_CHARS) : undefined;
    if (before !== undefined) view.before = before;
    if (after !== undefined) view.after = after;
    view.signaturesNotShown = false;
    if (jsonBytes(view) > limit) {
      delete view.before;
      delete view.after;
      view.signaturesNotShown = true;
    }
  }

  return finish(view, renderFindingView(view), limit);
}

function renderFindingView(view: AgentFindingView): string {
  const lines: string[] = [
    `# ${view.id}`,
    `${view.dependency} · ${view.kind} · ${view.disposition}${view.reason ? ` (${view.reason})` : ''} · confidence ${view.confidence}`,
    view.summary,
    '',
    `Change: ${view.change}`,
  ];
  if (view.before) lines.push('', `Before: ${view.before}`);
  if (view.after) lines.push(`After: ${view.after}`);
  if (view.signaturesNotShown) lines.push('(before/after signatures not shown for size)');
  if (view.symbols.length > 0 || view.symbolsNotShown > 0) {
    lines.push('', `Symbols: ${view.symbols.join(', ')}${view.symbolsNotShown ? ` (+${view.symbolsNotShown} not shown)` : ''}`);
  }
  if (view.replacementSymbols.length > 0) {
    lines.push(`Replacements: ${view.replacementSymbols.join(', ')}${view.replacementSymbolsNotShown ? ` (+${view.replacementSymbolsNotShown})` : ''}`);
  }
  if (view.protectedFiles.length > 0 || view.protectedFilesNotShown > 0) {
    lines.push('', `Protected (do not edit): ${view.protectedFiles.join(', ')}${view.protectedFilesNotShown ? ` (+${view.protectedFilesNotShown} not shown)` : ''}`);
  }
  lines.push('', `Sites (${view.siteCount}):`);
  for (const site of view.sites) {
    lines.push(`- ${site.file}:${site.line}${site.symbol ? ` ${site.symbol}` : ''}${site.note ? ` — ${site.note}` : ''}`);
  }
  if (view.sitesNotShown > 0) lines.push(`- …${view.sitesNotShown} more site${view.sitesNotShown === 1 ? '' : 's'} not shown for size.`);
  if (view.units.length > 0 || view.unitsNotShown > 0) lines.push('');
  for (const unit of view.units) {
    lines.push(`Unit ${unit.id} (layer ${unit.layer}): ${unit.goal}. Files: ${unit.files.join(', ') || '—'}.${unit.after.length ? ` After ${unit.after.join(', ')}.` : ''}${unit.deterministic ? ` Deterministic: ${unit.deterministic}.` : ''}`);
  }
  if (view.unitsNotShown > 0) lines.push(`(${view.unitsNotShown} more unit(s) not shown)`);
  if (view.related.length > 0 || view.relatedNotShown > 0) {
    lines.push(`Related: ${view.related.map((r) => `${r.id} ${r.summary}`).join('; ')}${view.relatedNotShown ? ` (+${view.relatedNotShown} not shown)` : ''}`);
  }
  for (const gap of view.gaps) lines.push(`Gap: ${gap}`);
  if (view.gapsNotShown > 0) lines.push(`(${view.gapsNotShown} more gap(s) not shown)`);
  if (view.evidence.length > 0 || view.evidenceNotShown > 0) {
    lines.push(`Evidence: ${view.evidence.map((e) => `${e.id} (${e.source}) ${e.title}`).join('; ')}${view.evidenceNotShown ? ` (+${view.evidenceNotShown} not shown)` : ''}`);
  }
  return lines.join('\n');
}

export interface EvidenceRequest {
  findingId?: string;
  evidenceId?: string;
  /** Character offset into one record's content, for paging through a long one. */
  offset?: number;
}

/**
 * One evidence record as a bounded object.
 *
 * `narrowed` — the lines of the record that name the requested finding's
 * symbols, whole lines, with an exact count of those not shown.
 * `page` — the record's content from `offset` (characters), ending at a line
 * break where possible, with `nextOffset` to continue.
 * `check-output` — a failing check's output, its last lines.
 */
export interface AgentEvidenceRecordView {
  id: string;
  source: string;
  dependency: string;
  title: string;
  url?: string;
  mode: 'narrowed' | 'page' | 'check-output';
  /** Characters in the record's full content. */
  contentChars: number;
  findings: { symbol: string; detail: string; before?: string; after?: string }[];
  findingsNotShown: number;
  excerpt: string;
  offset: number;
  nextOffset: number | null;
  /** Whole lines selected but not shown (narrowed and check-output modes). */
  linesNotShown: number;
}

export interface AgentEvidenceView {
  records: AgentEvidenceRecordView[];
  /** Cited records that did not fit at all; resolvable one at a time by id. */
  recordIdsNotShown: string[];
  recordsNotShown: number;
}

/**
 * The evidence behind one finding, or one evidence record, bounded.
 *
 * For a finding, each cited record is narrowed to the lines that name one of
 * its symbols — a type-surface diff covering 278 changes contributes the one
 * line about this change, not the other 277. A measured finding's evidence is
 * the failing checks' own output. Every record's identity goes in before any
 * record's content, and the remaining space is shared evenly between records.
 */
export function evidenceDetail(
  plan: RemediationPlan,
  request: EvidenceRequest,
  options: { budget?: ContextBudget } = {},
): DetailResult<AgentEvidenceView> {
  const limit = maxBytes(options.budget ?? EVIDENCE_PAGE_BUDGET);
  if (!request.findingId && !request.evidenceId) {
    throw new UnknownAgentIdError('evidence', '', 'Pass a finding id, an evidence id, or both.');
  }

  let change: BreakingChange | undefined;
  if (request.findingId) {
    change = plan.breakingChanges.find((c) => c.id === request.findingId);
    if (!change && request.findingId.startsWith(MEASURED_PREFIX) && !request.evidenceId) {
      return measuredEvidence(plan, request.findingId, limit);
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
  // Narrow to the finding when one was named and no page was asked for. A
  // record that names none of the finding's symbols contributes its
  // structured findings (if any) and a pointer, never its whole content.
  const narrowing = symbols.length > 0 && request.offset === undefined && !request.evidenceId;

  const view: AgentEvidenceView = { records: [], recordIdsNotShown: [], recordsNotShown: 0 };
  requireCoreFits('evidence detail', view, limit);

  // Each record's selectable material is computed up front, so every counter
  // starts at its full total and only shrinks as items are placed.
  const material = records.map((record) => ({
    structured: (record.findings ?? [])
      .filter((finding) => symbols.length === 0 || symbols.includes(finding.symbol))
      .map((finding) => ({
        symbol: finding.symbol,
        detail: capLine(finding.detail, 300),
        ...(finding.before ? { before: capLine(finding.before, 300) } : {}),
        ...(finding.after ? { after: capLine(finding.after, 300) } : {}),
      })),
    lines: narrowing ? (linesNaming(record.content, symbols) ?? []) : [],
  }));
  const cores: AgentEvidenceRecordView[] = records.map((record, index) => {
    const offset = narrowing ? 0 : Math.max(0, Math.min(request.offset ?? 0, record.content.length));
    return {
      id: record.id,
      source: record.source,
      dependency: record.dependency,
      title: capLine(record.title, 160),
      ...(record.url ? { url: record.url } : {}),
      mode: narrowing ? 'narrowed' : 'page',
      contentChars: record.content.length,
      findings: [],
      findingsNotShown: material[index]!.structured.length,
      excerpt: '',
      offset,
      // Until content is placed, the continuation is the page's own start.
      nextOffset: narrowing || offset >= record.content.length ? null : offset,
      linesNotShown: material[index]!.lines.length,
    };
  });
  view.recordsNotShown = cores.length;
  view.recordIdsNotShown = [];
  requireCoreFits('evidence detail', view, limit);
  fillWhole(view, view.records, cores, limit, (n) => (view.recordsNotShown = cores.length - n));
  fillWhole(view, view.recordIdsNotShown, cores.slice(view.records.length).map((c) => c.id), limit);

  view.records.forEach((entry, index) => {
    const record = records[index]!;
    const { structured, lines } = material[index]!;
    // An even share of what is left, so the first record cannot starve the rest.
    const share = jsonBytes(view) + Math.floor((limit - jsonBytes(view)) / (view.records.length - index));
    fillWhole(view, entry.findings, structured, share, (n) => (entry.findingsNotShown = structured.length - n));

    if (entry.mode === 'narrowed') {
      const shown: string[] = [];
      fillWhole(view, shown, lines, share, (n) => {
        entry.excerpt = shown.slice(0, n).join('\n');
        entry.linesNotShown = lines.length - n;
      });
    } else if (entry.nextOffset !== null) {
      // Measure the page with its continuation offset at its largest possible
      // value, so setting the real one can only make the object smaller.
      const rest = record.content.slice(entry.offset);
      // `null` is four characters; never measure with something shorter than what may replace it.
      entry.nextOffset = Math.max(record.content.length, 1000);
      const page = fitPrefix(view, rest, share, (text) => (entry.excerpt = text));
      entry.nextOffset = entry.offset + page.length < record.content.length ? entry.offset + page.length : null;
    }
  });

  return finish(view, renderEvidenceView(view), limit);
}

function renderEvidenceView(view: AgentEvidenceView): string {
  if (view.records.length === 0 && view.recordsNotShown === 0) return 'The finding cites no evidence records.';
  const blocks = view.records.map((record) => {
    const lines = [`## ${record.id} · ${record.source} · ${record.title}`];
    if (record.url) lines.push(record.url);
    for (const finding of record.findings) {
      lines.push(`- ${finding.detail}${finding.before ? `\n  before: ${finding.before}` : ''}${finding.after ? `\n  after:  ${finding.after}` : ''}`);
    }
    if (record.findingsNotShown > 0) lines.push(`(${record.findingsNotShown} more structured finding(s) not shown)`);
    if (record.mode === 'narrowed') {
      if (record.excerpt && record.findings.length === 0) lines.push('Lines naming this finding:', record.excerpt);
      if (!record.excerpt && record.findings.length === 0 && record.linesNotShown === 0) {
        lines.push(`No line names this finding's symbols. Read the record itself with evidence id ${record.id} (${record.contentChars} characters, paged).`);
      }
      if (record.linesNotShown > 0) lines.push(`(${record.linesNotShown} more matching line(s) not shown for size)`);
    } else if (record.mode === 'check-output') {
      lines.push(record.excerpt);
      if (record.linesNotShown > 0) lines.push(`(${record.linesNotShown} earlier line(s) not shown)`);
    } else {
      lines.push(`Content from character ${record.offset}:`, record.excerpt);
      if (record.nextOffset !== null) lines.push(`(continues: request offset ${record.nextOffset} of ${record.contentChars})`);
    }
    return lines.join('\n');
  });
  if (view.recordsNotShown > 0) {
    blocks.push(`(${view.recordsNotShown} more cited record(s) not shown: ${view.recordIdsNotShown.join(', ') || 'ids not shown for size'}; request each by evidence id)`);
  }
  return blocks.join('\n\n');
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

function measuredEvidence(plan: RemediationPlan, id: string, limit: number): DetailResult<AgentEvidenceView> {
  const sites = plan.impactSites.filter((site) => site.breakingChangeId === id);
  if (sites.length === 0) {
    throw new UnknownAgentIdError('finding', id, 'Measured finding ids come from a verified Drift brief.');
  }
  const failed = (plan.verification?.checks ?? []).filter((check) => check.status === 'failed');
  // The end of a failing check's output is where the failure is; lines are
  // placed from the last one backwards.
  const tails = failed.map((check) => check.output.split('\n').filter((line) => line.trim()).map((line) => capLine(line, 300)).reverse());
  const view: AgentEvidenceView = { records: [], recordIdsNotShown: [], recordsNotShown: failed.length };
  requireCoreFits('evidence detail', view, limit);
  const cores: AgentEvidenceRecordView[] = failed.map((check, index) => ({
    id: `check:${check.label}`,
    source: 'verification',
    dependency: id.slice(MEASURED_PREFIX.length),
    title: capLine(`${check.label} (${check.kind}) failed after the upgrade`, 160),
    mode: 'check-output',
    contentChars: check.output.length,
    findings: [],
    findingsNotShown: 0,
    excerpt: '',
    offset: 0,
    nextOffset: null,
    linesNotShown: tails[index]!.length,
  }));
  fillWhole(view, view.records, cores, limit, (n) => (view.recordsNotShown = cores.length - n));
  fillWhole(view, view.recordIdsNotShown, cores.slice(view.records.length).map((c) => c.id), limit);
  view.records.forEach((entry, index) => {
    const share = jsonBytes(view) + Math.floor((limit - jsonBytes(view)) / (view.records.length - index));
    const lines = tails[index]!;
    const shown: string[] = [];
    fillWhole(view, shown, lines, share, (n) => {
      entry.excerpt = shown.slice(0, n).reverse().join('\n');
      entry.linesNotShown = lines.length - n;
    });
  });
  return finish(view, renderEvidenceView(view), limit);
}

/**
 * Serialize and render one bounded view. The JSON is within `limit` by
 * construction; the text, rendered from the same view, is checked against the
 * same limit and cut at a line only as a last resort.
 */
function finish<T>(view: T, rendered: string, limit: number): DetailResult<T> {
  const bytes = jsonBytes(view);
  if (bytes > limit) throw new AgentBudgetExceededError('structured detail', bytes, limit);
  const text = hardStop(rendered, limit);
  return { text, bytes: byteLength(text), estimatedTokens: estimateTokens(text), data: view, jsonBytes: bytes };
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
function linesNaming(content: string, symbols: readonly string[]): string[] | null {
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
  return [...keep].sort((a, b) => a - b).map((index) => capLine(lines[index]!, 400));
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
