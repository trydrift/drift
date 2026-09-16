import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_BRIEF_BUDGET,
  AgentBudgetExceededError,
  BYTES_PER_TOKEN,
  EVIDENCE_PAGE_BUDGET,
  FINDING_DETAIL_BUDGET,
  agentBriefView,
  buildAgentBrief,
  evidenceDetail,
  findingDetail,
  renderAgentBrief,
} from '../dist/agent-context/index.js';
import type { RemediationPlan } from '../dist/types.js';

/**
 * No agent-facing surface can exceed its budget, in text or in JSON, however
 * large the plan behind it. Every test here ends by measuring the exact bytes
 * a client would receive, and checks that what was left out is counted.
 */

const bytes = (value: string | object) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
const ceiling = (budget: { maxTokens: number }) => budget.maxTokens * BYTES_PER_TOKEN;

interface Shape {
  findings?: number;
  sitesPerFinding?: number;
  blockers?: number;
  gaps?: number;
  checks?: number;
  notes?: number;
  units?: number;
  upstream?: number;
  structuredFindings?: number;
  evidenceChars?: number;
  citedRecords?: number;
  checkOutputLines?: number;
  longText?: number;
}

/** A plan with every variable-size part as large as a test asks. */
function huge(shape: Shape): RemediationPlan {
  const n = (k: keyof Shape) => shape[k] ?? 0;
  const pad = (s: string) => (shape.longText ? `${s} ${'lorem ipsum '.repeat(shape.longText)}` : s);
  const findingIds = Array.from({ length: n('findings') }, (_, i) => `bc_local_${String(i).padStart(4, '0')}`);
  const upstreamIds = Array.from({ length: n('upstream') }, (_, i) => `bc_up_${String(i).padStart(4, '0')}`);
  const recordIds = Array.from({ length: Math.max(1, n('citedRecords')) }, (_, i) => `ev_${String(i).padStart(4, '0')}`);
  const sitesFor = (id: string) =>
    Array.from({ length: n('sitesPerFinding') }, (_, j) => ({
      breakingChangeId: id,
      file: `src/deep/nested/module-${j % 50}/file-${j}.ts`,
      line: j + 1,
      excerpt: pad(`const value${j} = legacyApi.call(${j});`),
      matchedSymbol: 'legacyApi.call',
      confidence: 'high',
    }));
  const sites = findingIds.flatMap(sitesFor);
  const measuredSites = Array.from({ length: n('sitesPerFinding') }, (_, j) => ({
    breakingChangeId: 'measured:npm acme',
    file: `src/measured-${j}.ts`,
    line: j + 1,
    excerpt: pad(`TS2339: Property 'call${j}' does not exist on type 'Legacy'.`),
    matchedSymbol: 'TS2339',
    confidence: 'high',
  }));

  return {
    schemaVersion: 1,
    id: 'plan_huge',
    branchName: 'drift/huge',
    baseBranch: 'main',
    headSha: 'abc',
    changes: [{ name: 'acme', ecosystem: 'npm', from: '1.0.0', to: '2.0.0', kind: 'runtime', bump: 'major', manifestPath: 'package.json' }],
    evidence: recordIds.map((id, i) => ({
      id,
      source: 'type-surface-diff',
      dependency: 'acme',
      title: pad(`API surface change(s) in acme, record ${i}`),
      content: Array.from({ length: Math.max(1, Math.ceil(n('evidenceChars') / 60)) }, (_, j) => `- \`Legacy.member${j}\` was removed; see line ${j}.`).join('\n').slice(0, Math.max(1, n('evidenceChars'))),
      findings: Array.from({ length: n('structuredFindings') }, (_, j) => ({
        code: 'member-removed',
        symbol: j % 2 === 0 ? 'legacyApi.call' : `Legacy.member${j}`,
        detail: pad(`\`Legacy.member${j}\` was removed.`),
        before: pad(`member${j}(a: string): void`),
        after: pad(`member${j}(a: string, b: number): Promise<void>`),
      })),
      weight: 1,
    })),
    breakingChanges: [
      ...findingIds.map((id, i) => ({
        id,
        dependency: 'acme',
        kind: 'signature-change',
        summary: pad(`The signature of \`legacyApi.call\` changed (${i}).`),
        remediation: pad('Update every call to pass the new second argument.'),
        before: pad('call(a: string): void'),
        after: pad('call(a: string, b: number): Promise<void>'),
        symbols: ['legacyApi.call', ...Array.from({ length: 300 }, (_, j) => `Legacy.member${j}`)],
        replacementSymbols: Array.from({ length: 200 }, (_, j) => `Modern.member${j}`),
        confidence: 'high',
        citations: recordIds,
      })),
      ...upstreamIds.map((id) => ({ id, dependency: 'acme', kind: 'removed-export', summary: `${id} removed`, remediation: 'x', symbols: [id], confidence: 'high', citations: [] })),
    ],
    upstreamBreakingCount: findingIds.length + upstreamIds.length,
    impactSites: [...sites, ...measuredSites],
    dispositions: [
      ...findingIds.map((id) => ({ changeId: id, state: 'actionable', reason: 'high-confidence-impact', sites: sitesFor(id), actionableSites: sitesFor(id) })),
      ...upstreamIds.map((id) => ({ changeId: id, state: 'unknown', reason: 'impact-unresolved', sites: [], actionableSites: [] })),
    ],
    localizationRan: true,
    localizationComplete: true,
    commits: Array.from({ length: n('units') }, (_, i) => ({
      id: `unit_${String(i).padStart(4, '0')}`,
      order: i,
      message: pad(`fix(acme): unit ${i}`),
      body: '',
      breakingChangeIds: findingIds.length ? [findingIds[i % findingIds.length]!] : [],
      files: [`src/unit-${i}.ts`],
      allowedFiles: Array.from({ length: 20 }, (_, j) => `src/unit-${i}/file-${j}.ts`),
      instructions: '',
      dependsOn: i > 0 ? [`unit_${String(i - 1).padStart(4, '0')}`] : [],
      dependencyReasons: [],
      executionLayer: i,
      expectedChecks: [],
      invalidationTriggers: [],
    })),
    planEdges: [],
    upgradeCohorts: [],
    risk: 'high',
    gaps: Array.from({ length: n('gaps') }, (_, i) => ({
      stage: i % 2 ? 'localize' : 'evidence',
      dependency: 'acme',
      surface: `reachability of legacyApi.call ${i}`,
      reason: pad(`Gap ${i} about legacyApi.call.`),
      severity: 'significant',
      automaticExecution: 'degrades',
      remediation: pad(`Remedy ${i % 3}.`),
    })),
    checkedSurfaces: [],
    verification: {
      status: 'failed',
      checks: Array.from({ length: Math.max(1, n('checks')) }, (_, i) => ({
        kind: 'test',
        label: pad(`npm run check-${i}`),
        compileCapable: false,
        status: 'failed',
        durationMs: 1,
        output: Array.from({ length: n('checkOutputLines') }, (_, j) => `line ${j} of output ${'x'.repeat(80)}`).join('\n'),
      })),
      failedFiles: [],
    },
    confirmedRegressions: ['npm acme'],
    blockers: Array.from({ length: n('blockers') }, (_, i) => pad(`Blocker ${i}: impact sites fall inside protected paths.`)),
    warnings: [],
    createdAt: '2026-09-16T00:00:00.000Z',
    ...(n('notes')
      ? {}
      : {}),
  } as unknown as RemediationPlan;
}

function withNotes(plan: RemediationPlan, count: number): RemediationPlan {
  const notes = Array.from({ length: count }, (_, i) => ({
    id: `ev_note_${String(i).padStart(4, '0')}`,
    source: 'github-release',
    dependency: 'acme',
    title: `acme v${i}.0.0 release notes`,
    content: 'n'.repeat(400),
    weight: 1,
  }));
  return { ...plan, evidence: [...plan.evidence, ...notes] } as RemediationPlan;
}

describe('structured brief — hard ceiling', () => {
  const pathological = () =>
    withNotes(huge({ findings: 400, sitesPerFinding: 40, blockers: 300, gaps: 300, checks: 200, units: 0, upstream: 500 }), 300);

  test('hundreds of findings, blockers, gaps, checks and notes with zero units stay within the ceiling, counted exactly', () => {
    const brief = buildAgentBrief(pathological());
    assert.equal(brief.units.length, 0);
    const { view, bytes: size } = agentBriefView(brief);
    assert.ok(size <= ceiling(AGENT_BRIEF_BUDGET), `${size} bytes`);
    assert.equal(bytes(view), size);
    assert.equal(view.findings.length + view.findingsNotShown, brief.findings.length);
    assert.equal(view.constraints.blockers.length + view.constraints.blockersNotShown, brief.constraints.blockers.length);
    assert.equal(view.checks.length + view.checksNotShown, brief.checks.length);
    assert.equal(view.gaps.length + view.gapsNotShown, brief.gaps.length);
    assert.equal(view.notes.length + view.notesNotShown, brief.notes.length);
    assert.equal(view.units.length + view.unitsNotShown, 0);
    for (const f of view.findings) assert.ok(f.siteCount >= (f.sites?.length ?? 0));
    assert.ok(view.constraints.blockers.length > 0, 'safety comes before findings');
  });

  test('every budget from just above the core to the default ends within its ceiling, and accounting stays exact', () => {
    const brief = buildAgentBrief(pathological());
    let smallestThatFits: number | null = null;
    for (let maxTokens = 100; maxTokens <= 2000; maxTokens += 50) {
      const budget = { targetTokens: maxTokens, maxTokens };
      try {
        const { view, bytes: size } = agentBriefView(brief, { budget });
        smallestThatFits ??= maxTokens;
        assert.ok(size <= maxTokens * BYTES_PER_TOKEN, `${size} > ${maxTokens * BYTES_PER_TOKEN}`);
        assert.equal(bytes(view), size);
        assert.equal(view.findings.length + view.findingsNotShown, brief.findings.length);
        assert.ok(view.findingIdsNotShown.length <= view.findingsNotShown);
      } catch (err) {
        assert.ok(err instanceof AgentBudgetExceededError, String(err));
        assert.equal(smallestThatFits, null, 'a larger budget never fails after a smaller one fit');
      }
    }
    assert.notEqual(smallestThatFits, null);
  });

  test('a budget smaller than the irreducible core fails loudly instead of returning an oversized object', () => {
    assert.throws(() => agentBriefView(buildAgentBrief(pathological()), { budget: { targetTokens: 10, maxTokens: 10 } }), AgentBudgetExceededError);
  });

  test('structured selection is deterministic', () => {
    assert.equal(JSON.stringify(agentBriefView(buildAgentBrief(pathological())).view), JSON.stringify(agentBriefView(buildAgentBrief(pathological())).view));
  });

  test('the prose brief stays within the same ceiling on the same plan', () => {
    const rendered = renderAgentBrief(buildAgentBrief(pathological()));
    assert.ok(rendered.bytes <= ceiling(AGENT_BRIEF_BUDGET), `${rendered.bytes} bytes`);
    assert.equal(bytes(rendered.text), rendered.bytes);
  });

  test('a note added by a surface is counted inside the budget', () => {
    const note = `(${'reused '.repeat(20)})`;
    const rendered = renderAgentBrief(buildAgentBrief(pathological()), { note });
    assert.ok(rendered.text.includes(note));
    assert.ok(rendered.bytes <= ceiling(AGENT_BRIEF_BUDGET));
  });
});

describe('finding detail — text and JSON bounded', () => {
  test('a finding with thousands of sites, hundreds of symbols, units, gaps and long signatures', () => {
    const plan = huge({ findings: 3, sitesPerFinding: 3000, units: 200, gaps: 300, longText: 40 });
    const detail = findingDetail(plan, 'bc_local_0000');
    const limit = ceiling(FINDING_DETAIL_BUDGET);
    assert.ok(detail.jsonBytes <= limit, `${detail.jsonBytes} bytes of JSON`);
    assert.equal(bytes(detail.data), detail.jsonBytes);
    assert.ok(detail.bytes <= limit, `${detail.bytes} bytes of text`);
    const v = detail.data;
    assert.equal(v.siteCount, 3000);
    assert.equal(v.sites.length + v.sitesNotShown, v.siteCount);
    assert.equal(v.symbols.length + v.symbolsNotShown, 301);
    assert.equal(v.replacementSymbols.length + v.replacementSymbolsNotShown, 200);
    assert.ok(v.sitesNotShown > 0);
    assert.match(detail.text, new RegExp(`${v.sitesNotShown} more sites not shown for size`));
  });

  test('a measured finding with thousands of compiler errors, and every related upstream change counted', () => {
    const plan = huge({ findings: 0, sitesPerFinding: 2500, upstream: 0 });
    const detail = findingDetail(plan, 'measured:npm acme');
    assert.ok(detail.jsonBytes <= ceiling(FINDING_DETAIL_BUDGET));
    assert.ok(detail.bytes <= ceiling(FINDING_DETAIL_BUDGET));
    assert.equal(detail.data.sites.length + detail.data.sitesNotShown, 2500);
    assert.equal(detail.data.related.length + detail.data.relatedNotShown, detail.data.related.length + detail.data.relatedNotShown);
  });

  test('text and JSON carry the same selection', () => {
    const detail = findingDetail(huge({ findings: 2, sitesPerFinding: 800 }), 'bc_local_0001');
    for (const site of detail.data.sites) assert.ok(detail.text.includes(`${site.file}:${site.line}`), `${site.file}:${site.line} in text`);
    const lastShown = detail.data.sites.at(-1)!;
    const firstHidden = `src/deep/nested/module-${detail.data.sites.length % 50}/file-${detail.data.sites.length}.ts:${detail.data.sites.length + 1}`;
    assert.ok(detail.text.includes(`${lastShown.file}:${lastShown.line}`));
    assert.ok(!detail.text.includes(firstHidden));
  });

  test('a finding whose irreducible core cannot fit fails loudly', () => {
    const plan = huge({ findings: 1, sitesPerFinding: 1, longText: 2000 });
    assert.throws(() => findingDetail(plan, 'bc_local_0000'), AgentBudgetExceededError);
  });
});

describe('evidence detail — text and JSON bounded and pageable', () => {
  test('a one-megabyte record is paged, and the pages reassemble the record exactly', () => {
    const plan = huge({ findings: 1, sitesPerFinding: 1, evidenceChars: 60_000 });
    const record = plan.evidence[0]!;
    let offset = 0;
    let rebuilt = '';
    let pages = 0;
    for (;;) {
      const page = evidenceDetail(plan, { evidenceId: record.id, offset });
      assert.ok(page.jsonBytes <= ceiling(EVIDENCE_PAGE_BUDGET), `${page.jsonBytes} bytes of JSON`);
      assert.ok(page.bytes <= ceiling(EVIDENCE_PAGE_BUDGET), `${page.bytes} bytes of text`);
      const entry = page.data.records[0]!;
      assert.equal(entry.offset, offset);
      assert.ok(entry.excerpt.length > 0, 'every page advances');
      rebuilt += entry.excerpt;
      pages += 1;
      if (entry.nextOffset === null) break;
      assert.equal(entry.nextOffset, offset + entry.excerpt.length);
      offset = entry.nextOffset;
    }
    assert.equal(rebuilt, record.content);
    assert.ok(pages > 5);

    const megabyte = huge({ findings: 1, sitesPerFinding: 1, evidenceChars: 1_000_000 });
    const first = evidenceDetail(megabyte, { evidenceId: megabyte.evidence[0]!.id });
    assert.ok(first.jsonBytes <= ceiling(EVIDENCE_PAGE_BUDGET));
    assert.ok(first.data.records[0]!.nextOffset! > 0);
  });

  test('narrowed evidence for a finding keeps to its symbols and counts what did not fit', () => {
    const plan = huge({ findings: 1, sitesPerFinding: 1, structuredFindings: 5000, evidenceChars: 200_000, longText: 3 });
    const detail = evidenceDetail(plan, { findingId: 'bc_local_0000' });
    assert.ok(detail.jsonBytes <= ceiling(EVIDENCE_PAGE_BUDGET), `${detail.jsonBytes}`);
    assert.ok(detail.bytes <= ceiling(EVIDENCE_PAGE_BUDGET));
    const entry = detail.data.records[0]!;
    assert.equal(entry.mode, 'narrowed');
    // The finding's symbols include every Legacy.memberN, so thousands match; they are counted.
    const symbols = plan.breakingChanges.find((c) => c.id === 'bc_local_0000')!.symbols;
    const matching = plan.evidence[0]!.findings!.filter((f) => symbols.includes(f.symbol)).length;
    assert.equal(matching, 2650);
    assert.equal(entry.findings.length + entry.findingsNotShown, matching);
    assert.ok(entry.linesNotShown > 0);
  });

  test('a finding citing fifty records names every record it could not show', () => {
    const plan = huge({ findings: 1, sitesPerFinding: 1, citedRecords: 50, evidenceChars: 5000, longText: 30 });
    const detail = evidenceDetail(plan, { findingId: 'bc_local_0000' });
    assert.ok(detail.jsonBytes <= ceiling(EVIDENCE_PAGE_BUDGET));
    assert.equal(detail.data.records.length + detail.data.recordsNotShown, 50);
    assert.ok(detail.data.recordIdsNotShown.length <= detail.data.recordsNotShown);
  });

  test('a failing check with a huge log returns its last lines, bounded', () => {
    const plan = huge({ findings: 0, sitesPerFinding: 3, checks: 3, checkOutputLines: 50_000 });
    const detail = evidenceDetail(plan, { findingId: 'measured:npm acme' });
    assert.ok(detail.jsonBytes <= ceiling(EVIDENCE_PAGE_BUDGET));
    assert.ok(detail.bytes <= ceiling(EVIDENCE_PAGE_BUDGET));
    for (const entry of detail.data.records) {
      assert.equal(entry.mode, 'check-output');
      assert.match(entry.excerpt, /line 49999 of output/);
      assert.ok(entry.linesNotShown > 0);
    }
  });
});

describe('untrusted text cannot make grouping slow', () => {
  test('a gap surface of thousands of " of " repetitions groups in linear time', () => {
    const plan = huge({ findings: 1, sitesPerFinding: 1 });
    const surface = `x${' of'.repeat(50_000)} of`;
    (plan.gaps as unknown[]).push(
      { stage: 'localize', dependency: 'acme', surface, reason: 'r', severity: 'significant', automaticExecution: 'degrades', remediation: 'm' },
      { stage: 'localize', dependency: 'acme', surface: `${surface}2`, reason: 'r', severity: 'significant', automaticExecution: 'degrades', remediation: 'm' },
    );
    const started = performance.now();
    const brief = buildAgentBrief(plan);
    renderAgentBrief(brief, { budget: { targetTokens: 400, maxTokens: 2000 } });
    assert.ok(performance.now() - started < 2000, `${performance.now() - started}ms`);
    assert.equal(brief.gaps.find((g) => g.surfaces.includes(surface))?.surfaces.length, 2);
  });
});
