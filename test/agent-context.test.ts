import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  agentBriefView,
  AGENT_BRIEF_BUDGET,
  BYTES_PER_TOKEN,
  UnknownAgentIdError,
  buildAgentBrief,
  estimateTokens,
  evidenceDetail,
  findingDetail,
  renderAgentBrief,
} from '../dist/agent-context/index.js';
import { renderPullRequestBody } from '../dist/report/markdown.js';
import { DEFAULT_CONFIG } from '../dist/config/schema.js';
import { applyVerificationToPlan, reconcileVerificationGap } from '../dist/verification/apply.js';
import type { RemediationPlan } from '../dist/types.js';

/**
 * The coding agent's view of a plan.
 *
 * The first paired agent benchmark (eval/results/agent, run v1-dev-*) found
 * Drift's localization right in every trial and the agent still paying more
 * tokens, because it was handed the reviewer's report: 499k characters for an
 * ESLint 8 → 10 upgrade where five of 293 upstream changes reached the
 * repository. These tests pin the structural fix — only local facts in the
 * hot context, a hard size budget, and every omitted thing still one id away
 * — against a plan shaped like that one.
 */

const MEASURED = 'measured:npm acme';

function site(breakingChangeId: string, file: string, line: number, extra: Record<string, unknown> = {}) {
  return { breakingChangeId, file, line, excerpt: `line ${line} of ${file}`, matchedSymbol: 'x', confidence: 'high', ...extra };
}

function change(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    dependency: 'acme',
    kind: 'removed-export',
    summary: `\`Upstream.${id}\` was removed.`,
    remediation: `Stop using \`Upstream.${id}\`.`,
    symbols: [`Upstream.${id}`],
    confidence: 'high',
    citations: ['ev_surface'],
    ...extra,
  };
}

function commit(id: string, order: number, breakingChangeIds: string[], files: string[], extra: Record<string, unknown> = {}) {
  return {
    id,
    order,
    message: `fix(acme): ${id}`,
    body: '',
    breakingChangeIds,
    files,
    allowedFiles: files,
    instructions: 'x'.repeat(600),
    dependsOn: [],
    dependencyReasons: [],
    executionLayer: order,
    expectedChecks: [{ id: `check_${id}`, kind: 'test', command: 'npm test', reason: 'tests' }],
    invalidationTriggers: [],
    ...extra,
  };
}

interface PlanShape {
  upstreamOnly?: number;
  localSites?: number;
  protectedRuntime?: boolean;
  measured?: boolean;
  extraLocal?: number;
}

/** A plan shaped like the ESLint case: hundreds of upstream changes, a handful local. */
function plan(shape: PlanShape = {}): RemediationPlan {
  const upstreamOnly = shape.upstreamOnly ?? 288;
  const breakingChanges = [
    change('bc_local', { kind: 'required-field-added', summary: '`RuleTester.valid` is now required.', remediation: 'Supply `valid` at every construction site.' }),
    change('bc_review', { confidence: 'low', summary: 'Default of `strict` changed.' }),
    change('bc_runtime', { kind: 'runtime-requirement', summary: 'Supported node versions are now >=20', remediation: 'Raise the declared Node version.', symbols: ['Node.js'], citations: ['ev_registry'] }),
    change('bc_runtime_ok', { kind: 'runtime-requirement', summary: 'Minimum node version is now >=16', symbols: ['Node.js'], citations: ['ev_registry'] }),
    change('bc_TxData_v', { summary: '`TxData.v` was removed.', symbols: ['TxData.v', 'v'] }),
    ...Array.from({ length: shape.extraLocal ?? 0 }, (_, i) => change(`bc_extra_${String(i).padStart(3, '0')}`, { summary: `Local extra change number ${i} with a reasonably long summary sentence.` })),
    ...Array.from({ length: upstreamOnly }, (_, i) => change(`bc_up_${String(i).padStart(3, '0')}`)),
  ];

  const localSites = Array.from({ length: shape.localSites ?? 1 }, (_, i) => site('bc_local', `src/rules/r${i % 7}.test.js`, 11 + i));
  const runtimeSites = shape.protectedRuntime === false
    ? [site('bc_runtime', 'package.json', 71, { siteKind: 'runtime-declaration', runtimeVerdict: 'incompatible' })]
    : [
        site('bc_runtime', '.github/workflows/build.yml', 22, { runtimeVerdict: 'incompatible' }),
        site('bc_runtime', '.github/workflows/lint.yml', 27, { runtimeVerdict: 'incompatible' }),
        site('bc_runtime', 'package.json', 71, { runtimeVerdict: 'incompatible' }),
      ];
  const reviewSites = [site('bc_review', 'src/config.ts', 4, { confidence: 'low' })];
  const extraSites = Array.from({ length: shape.extraLocal ?? 0 }, (_, i) => site(`bc_extra_${String(i).padStart(3, '0')}`, `src/extra/file-${i}.ts`, 3 + i));
  const measuredSites = shape.measured === false
    ? []
    : [
        site(MEASURED, 'src/keyring.ts', 343, { excerpt: "TS2339: Property 'v' does not exist on type 'TxData'.", matchedSymbol: 'TS2339' }),
        site(MEASURED, 'src/keyring.ts', 329, { excerpt: 'TS2554: Expected 0 arguments, but got 1.', matchedSymbol: 'TS2554' }),
      ];

  const extraIds = Array.from({ length: shape.extraLocal ?? 0 }, (_, i) => `bc_extra_${String(i).padStart(3, '0')}`);
  const dispositions = [
    { changeId: 'bc_local', state: 'actionable', reason: 'high-confidence-impact', sites: localSites, actionableSites: localSites },
    { changeId: 'bc_review', state: 'review-only', reason: 'low-confidence-impact', sites: reviewSites, actionableSites: [] },
    { changeId: 'bc_runtime', state: 'actionable', reason: 'runtime-incompatible', sites: runtimeSites, actionableSites: runtimeSites },
    { changeId: 'bc_runtime_ok', state: 'unaffected', reason: 'runtime-compatible', sites: [], actionableSites: [] },
    { changeId: 'bc_TxData_v', state: 'unknown', reason: 'impact-unresolved', sites: [], actionableSites: [] },
    ...extraIds.map((id, i) => ({ changeId: id, state: 'actionable', reason: 'high-confidence-impact', sites: [extraSites[i]], actionableSites: [extraSites[i]] })),
    ...breakingChanges.filter((c) => c.id.startsWith('bc_up_')).map((c, i) => ({
      changeId: c.id,
      state: 'unknown',
      reason: i % 50 === 0 ? 'localization-incomplete' : 'impact-unresolved',
      sites: [],
      actionableSites: [],
    })),
  ];

  const surfaceFindings = breakingChanges.map((c) => ({ code: 'member-removed', symbol: c.symbols[0], detail: `${c.summary}` }));

  return {
    schemaVersion: 1,
    id: 'plan_acme',
    branchName: 'drift/acme',
    baseBranch: 'main',
    headSha: 'abc',
    changes: [{ name: 'acme', ecosystem: 'npm', from: '8.57.1', to: '10.0.0', kind: 'dev', bump: 'major', manifestPath: 'package.json' }],
    evidence: [
      {
        id: 'ev_surface',
        source: 'type-surface-diff',
        dependency: 'acme',
        title: `${breakingChanges.length} API surface change(s) in acme`,
        content: breakingChanges.map((c) => `- ${c.summary}`).join('\n'),
        findings: surfaceFindings,
        weight: 1,
      },
      { id: 'ev_registry', source: 'registry-metadata', dependency: 'acme', title: 'acme requires Node >=20', content: 'engines.node >=20', weight: 1 },
      { id: 'ev_notes', source: 'github-release', dependency: 'acme', title: 'acme v10.0.0 release notes', content: 'Flat config is now the only format. '.repeat(400), weight: 1 },
    ],
    breakingChanges,
    upstreamBreakingCount: breakingChanges.length,
    impactSites: [...localSites, ...runtimeSites, ...reviewSites, ...extraSites, ...measuredSites],
    dispositions,
    localizationRan: true,
    localizationComplete: true,
    commits: [
      commit('unit_runtime', 0, ['bc_runtime'], ['.github/workflows/build.yml']),
      commit('unit_local', 1, ['bc_local'], [...new Set(localSites.map((s) => s.file))], {
        dependsOn: ['unit_runtime', 'unit_runtime'],
        allowedSymbols: ['RuleTester', 'RuleTester.valid'],
        fixPlan: {
          plan: { id: 'fp_valid', migration: 'Supply `valid`.', ops: [] },
          assurance: 'checked',
          files: ['src/rules/r0.test.js'],
          anchors: [],
          covered: 1,
          residual: 1,
          residualSites: [{ file: 'src/rules/r1.test.js', line: 12, reason: 'spread arguments' }],
        },
      }),
      ...extraIds.map((id, i) => commit(`unit_${id}`, 2 + i, [id], [`src/extra/file-${i}.ts`], { codemod: [{ ruleId: `rule_${i}`, from: 'a', to: 'b', files: [`src/extra/file-${i}.ts`], anchors: [{ file: `src/extra/file-${i}.ts`, line: 'a', lineNumber: 3 + i }] }] })),
    ],
    planEdges: [],
    upgradeCohorts: [],
    risk: 'high',
    gaps: [
      { stage: 'evidence', dependency: 'esquery', surface: 'upstream release evidence', reason: 'No changelog could be retrieved for esquery.', severity: 'significant', automaticExecution: 'blocks', remediation: 'Review by hand.' },
      { stage: 'evidence', dependency: 'flat-cache', surface: 'upstream release evidence', reason: 'No changelog could be retrieved for flat-cache.', severity: 'significant', automaticExecution: 'blocks', remediation: 'Review by hand.' },
      ...['require', 'Logger', 'Container'].map((symbol) => ({
        stage: 'localize',
        dependency: 'acme',
        surface: `reachability of ${symbol}`,
        reason: `\`${symbol}\` is only observable at runtime.`,
        severity: 'significant',
        automaticExecution: 'degrades',
        remediation: 'Confirm by exercising the affected paths.',
      })),
    ],
    checkedSurfaces: [],
    verification: shape.measured === false
      ? undefined
      : {
          status: 'failed',
          checks: [
            { kind: 'build', label: 'npm run build', compileCapable: true, status: 'failed', durationMs: 1, output: "src/keyring.ts(343,5): error TS2339: Property 'v' does not exist on type 'TxData'." },
            { kind: 'test', label: 'npm test', compileCapable: false, status: 'passed', durationMs: 1, output: 'ok' },
          ],
          failedFiles: ['src/keyring.ts'],
        },
    confirmedRegressions: shape.measured === false ? [] : ['npm acme'],
    blockers: [
      'Impact sites fall inside protected paths: .github/workflows/build.yml. Drift will not direct an agent to edit these.',
      'No changelog could be retrieved for esquery. Drift will not dispatch a fix based on a version number alone.',
      'Assessed risk is `high`, above the `maxAutoRisk` ceiling of `medium`.',
    ],
    warnings: Array.from({ length: 30 }, (_, i) => `Skipped \`pkg-${i}\`: newly added dependency.`),
    createdAt: '2026-09-16T00:00:00.000Z',
  } as unknown as RemediationPlan;
}

describe('agent brief — what reaches the initial context', () => {
  test('a locally actionable finding is included with its sites and fix', () => {
    const brief = buildAgentBrief(plan());
    const local = brief.findings.find((f) => f.id === 'bc_local');
    assert.ok(local);
    assert.equal(local.state, 'actionable');
    assert.deepEqual(local.files, ['src/rules/r0.test.js']);
    const { text } = renderAgentBrief(brief);
    assert.match(text, /RuleTester\.valid` is now required/);
    assert.match(text, /src\/rules\/r0\.test\.js:11/);
    assert.match(text, /Supply `valid` at every construction site/);
  });

  test('an upstream change with no located usage is not in the brief, verbatim or otherwise', () => {
    const brief = buildAgentBrief(plan());
    const { text } = renderAgentBrief(brief);
    assert.equal(brief.findings.some((f) => f.id.startsWith('bc_up_')), false);
    assert.doesNotMatch(text, /bc_up_\d+/);
    assert.doesNotMatch(text, /Upstream\.bc_up_/);
    assert.doesNotMatch(text, /TxData\.v` was removed/);
  });

  test('omitted upstream changes are counted exactly, split by why they were left out', () => {
    const brief = buildAgentBrief(plan());
    // 288 upstream-only (6 of them localization-incomplete), plus TxData.v
    // (unresolved) and bc_runtime_ok (unaffected).
    assert.deepEqual(
      { noLocatedUsage: brief.omitted.noLocatedUsage, notSearched: brief.omitted.notSearched, unaffected: brief.omitted.unaffected },
      { noLocatedUsage: 283, notSearched: 6, unaffected: 1 },
    );
    assert.equal(brief.counts.upstreamBreakingChanges, 293);
    const { text } = renderAgentBrief(brief);
    assert.match(text, /283 upstream breaking changes with no located usage in this repository \(a search, not proof of safety\)/);
    assert.match(text, /6 not searched for in this repository \(uncertain\)/);
  });

  test('a runtime requirement this repository violates is included; one it meets is not', () => {
    const brief = buildAgentBrief(plan());
    assert.ok(brief.findings.some((f) => f.id === 'bc_runtime' && f.state === 'actionable'));
    assert.equal(brief.findings.some((f) => f.id === 'bc_runtime_ok'), false);
  });

  test('a measured verification failure comes first, with the compiler messages', () => {
    const brief = buildAgentBrief(plan());
    assert.equal(brief.findings[0]!.id, MEASURED);
    assert.equal(brief.findings[0]!.source, 'verification');
    const { text } = renderAgentBrief(brief);
    assert.match(text, /npm run build passed before acme 8\.57\.1 → 10\.0\.0 and fail after it/);
    assert.match(text, /src\/keyring\.ts:329 TS2554: Expected 0 arguments, but got 1\./);
    assert.match(text, /src\/keyring\.ts:343 TS2339: Property 'v' does not exist on type 'TxData'\./);
    assert.match(text, /npm run build: failed after the upgrade, before any fix/);
  });

  test('review-only findings stay visible and labelled as such', () => {
    const { text } = renderAgentBrief(buildAgentBrief(plan()));
    assert.match(text, /### \[\d\] bc_review\nacme · removed-export · review-only · confidence low/);
  });

  test('the human report is untouched and still lists every upstream change', () => {
    const body = renderPullRequestBody(plan(), DEFAULT_CONFIG);
    assert.match(body, /Upstream\.bc_up_000/);
    assert.match(body, /Upstream\.bc_up_287/);
  });
});

describe('agent brief — budget', () => {
  test('the ESLint-shaped plan renders within the production ceiling', () => {
    const rendered = renderAgentBrief(buildAgentBrief(plan()));
    assert.ok(rendered.estimatedTokens <= AGENT_BRIEF_BUDGET.maxTokens, `${rendered.estimatedTokens} tokens`);
    assert.equal(rendered.bytes, Buffer.byteLength(rendered.text));
    assert.equal(rendered.estimatedTokens, Math.ceil(rendered.bytes / BYTES_PER_TOKEN));
    assert.deepEqual(rendered.findings.omittedForBudget, []);
  });

  test('a plan with far more local work than fits stays under the ceiling and names what it left out', () => {
    const rendered = renderAgentBrief(buildAgentBrief(plan({ extraLocal: 120, localSites: 60 })));
    assert.ok(rendered.estimatedTokens <= AGENT_BRIEF_BUDGET.maxTokens, `${rendered.estimatedTokens} tokens`);
    assert.ok(rendered.findings.omittedForBudget.length > 0);
    assert.match(rendered.text, /Left out for size, still locally relevant: /);
    // The first twenty by name, the rest as an exact count, so the footer is bounded too.
    for (const id of rendered.findings.omittedForBudget.slice(0, 20)) assert.match(rendered.text, new RegExp(`\\b${id}\\b`));
    const total = rendered.findings.omittedForBudget.length;
    if (total > 20) assert.match(rendered.text, new RegExp(`and ${total - 20} more \\(${total} in all`));
  });

  test('a finding is either whole or absent — never cut part-way', () => {
    const rendered = renderAgentBrief(buildAgentBrief(plan({ extraLocal: 120, localSites: 60 })), {
      budget: { targetTokens: 900, maxTokens: 1200 },
    });
    const shown = [...rendered.findings.full, ...rendered.findings.compacted];
    for (const id of shown) {
      const block = rendered.text.split('\n### ').find((b) => b.split('\n')[0]!.includes(id));
      assert.ok(block, `${id} has a block`);
      assert.match(block, /\nChange/, `${id} keeps its change`);
    }
    for (const id of rendered.findings.omittedForBudget) {
      assert.equal(rendered.text.split('\n### ').some((b) => b.split('\n')[0]!.includes(id)), false, `${id} has no partial block`);
    }
    assert.ok(Buffer.byteLength(rendered.text) <= 1200 * BYTES_PER_TOKEN);
  });

  test('a compacted site list still states the exact total', () => {
    // Find a budget at which the 60-site finding fits only compacted, rather
    // than hard-coding a byte count that shifts with every wording change.
    const brief = buildAgentBrief(plan({ localSites: 60 }));
    const compacted = Array.from({ length: 80 }, (_, i) => 600 + i * 25)
      .map((targetTokens) => renderAgentBrief(brief, { budget: { targetTokens, maxTokens: 2000 } }))
      .find((rendered) => rendered.findings.compacted.includes('bc_local'));
    assert.ok(compacted, 'some budget compacts bc_local');
    assert.match(compacted.text, /\(60 sites in 7 files; get the rest with bc_local\)/);
    assert.match(compacted.text, /src\/rules\/r0\.test\.js:11,18,25,\+6/);
  });

  test('identical input renders byte-identical output', () => {
    const a = renderAgentBrief(buildAgentBrief(plan({ extraLocal: 40 })));
    const b = renderAgentBrief(buildAgentBrief(plan({ extraLocal: 40 })));
    assert.equal(a.text, b.text);
    assert.deepEqual(buildAgentBrief(plan()), buildAgentBrief(plan()));
  });

  test('findings sharing one site set are rendered once, not once per package', () => {
    const shared = plan();
    const copy = { ...change('bc_runtime_2', { kind: 'runtime-requirement', summary: 'eslint-scope needs node >=20', symbols: ['Node.js'] }) };
    const sites = shared.impactSites.filter((s) => s.breakingChangeId === 'bc_runtime').map((s) => ({ ...s, breakingChangeId: 'bc_runtime_2' }));
    shared.breakingChanges.push(copy as never);
    shared.impactSites.push(...sites);
    shared.dispositions!.push({ changeId: 'bc_runtime_2', state: 'actionable', reason: 'runtime-incompatible', sites, actionableSites: sites });
    const { text } = renderAgentBrief(buildAgentBrief(shared));
    assert.match(text, /### \[\d\] bc_runtime, bc_runtime_2/);
    assert.equal(text.match(/\.github\/workflows\/lint\.yml:27/g)?.length, 1);
  });

  test('the estimate is conservative against real prose', () => {
    // One token per three bytes over-counts English, which is the safe side.
    const prose = 'Supply an explicit value at every construction site to preserve the previous default behaviour.';
    assert.ok(estimateTokens(prose) >= Math.ceil(prose.length / 4));
  });
});

describe('agent brief — safety is never traded for size', () => {
  test('protected paths and blockers are stated, and a blocker that restates a gap is not repeated', () => {
    const brief = buildAgentBrief(plan());
    assert.deepEqual(brief.constraints.protectedFiles, ['.github/workflows/build.yml', '.github/workflows/lint.yml']);
    const { text } = renderAgentBrief(brief);
    assert.match(text, /Protected by drift\.yml guardrails, do not edit: \.github\/workflows\/\*\* \(2 files with sites below\)/);
    assert.match(text, /Drift blocker: Assessed risk is `high`/);
    assert.equal(brief.constraints.blockers.some((b) => b.includes('esquery')), false);
    assert.equal(brief.constraints.blockers.length, 2);
  });

  test('uncertainty survives the tightest budget, at least as a summary', () => {
    const rendered = renderAgentBrief(buildAgentBrief(plan({ extraLocal: 120, localSites: 60 })), {
      budget: { targetTokens: 700, maxTokens: 1200 },
    });
    assert.match(rendered.text, /## What Drift could not establish/);
    assert.match(rendered.text, /upstream release evidence \[esquery, flat-cache\]/);
    assert.match(rendered.text, /3 × reachability \[acme\]: Confirm by exercising the affected paths/);
    assert.match(rendered.text, /Drift blocker: Assessed risk is `high`/);
  });

  test('a finding whose every site is protected ranks below one in editable code', () => {
    const brief = buildAgentBrief(plan());
    const order = brief.findings.map((f) => f.id);
    assert.ok(order.indexOf('bc_local') < order.indexOf('bc_review'));
    const allProtected = buildAgentBrief(plan());
    const runtime = allProtected.findings.find((f) => f.id === 'bc_runtime')!;
    assert.equal(runtime.protectedFiles.length, 2);
  });

  test('guardrails come from the repository config when given', () => {
    const brief = buildAgentBrief(plan(), { config: { guardrails: { ...DEFAULT_CONFIG.guardrails, protectedPaths: ['package.json'] } } });
    assert.deepEqual(brief.constraints.protectedFiles, ['package.json']);
  });
});

describe('agent brief — execution units and deterministic work', () => {
  test('units keep order, layer, scope and deduplicated dependencies', () => {
    const brief = buildAgentBrief(plan());
    const unit = brief.units.find((u) => u.id === 'unit_local')!;
    assert.equal(unit.layer, 1);
    assert.deepEqual(unit.dependsOn, ['unit_runtime']);
    assert.deepEqual(unit.symbols, ['RuleTester', 'RuleTester.valid']);
    assert.deepEqual(unit.checks, ['npm test']);
  });

  test('a fix plan splits covered from residual sites, and a full codemod is not agent work', () => {
    const brief = buildAgentBrief(plan({ extraLocal: 2 }));
    const partial = brief.units.find((u) => u.id === 'unit_local')!;
    assert.equal(partial.agentWork, 'residual');
    assert.deepEqual(partial.deterministic, {
      mechanism: 'fix-plan',
      ids: ['fp_valid'],
      covered: 1,
      residualSites: [{ file: 'src/rules/r1.test.js', line: 12, reason: 'spread arguments' }],
    });
    const codemod = brief.units.find((u) => u.id === 'unit_bc_extra_000')!;
    assert.equal(codemod.agentWork, 'none');
    const { text } = renderAgentBrief(brief);
    assert.match(text, /deterministic: codemod rule_0 covers all 1 site; not agent work/);
    assert.match(text, /deterministic: fix-plan fp_valid covers 1; agent handles src\/rules\/r1\.test\.js:12/);
  });

  test('units with no dependency between them can be told apart as independent', () => {
    const brief = buildAgentBrief(plan({ extraLocal: 3 }));
    const independent = brief.units.filter((u) => u.dependsOn.length === 0).map((u) => u.id);
    assert.ok(independent.includes('unit_runtime'));
    assert.ok(independent.includes('unit_bc_extra_000'));
  });
});

describe('agent detail — provenance and progressive disclosure', () => {
  test('every finding id in the brief resolves to the plan object it came from', () => {
    const p = plan();
    const brief = buildAgentBrief(p);
    for (const finding of brief.findings) {
      const { data } = findingDetail(p, finding.id);
      assert.equal(data.id, finding.id);
      if (finding.source === 'analysis') {
        const original = p.breakingChanges.find((c) => c.id === finding.id)!;
        assert.equal(data.summary, original.summary);
        assert.equal(data.change, original.remediation);
        assert.deepEqual(data.evidence.map((e) => e.id).sort(), [...original.citations].sort());
        assert.equal(data.siteCount, p.impactSites.filter((s) => s.breakingChangeId === finding.id).length);
        const planSites = p.impactSites.filter((s) => s.breakingChangeId === finding.id).map((s) => `${s.file}:${s.line}`).sort();
        assert.deepEqual(data.sites.map((s) => `${s.file}:${s.line}`).sort(), planSites);
      }
      for (const id of finding.evidenceIds) assert.ok(p.evidence.some((e) => e.id === id), `${id} exists`);
      for (const id of finding.unitIds) assert.ok(p.commits.some((c) => c.id === id), `${id} exists`);
    }
  });

  test('an omitted upstream change still resolves on request, labelled as omitted', () => {
    const { data, text } = findingDetail(plan(), 'bc_up_001');
    assert.equal(data.state, 'omitted');
    assert.equal(data.disposition, 'unknown');
    assert.match(text, /impact-unresolved/);
  });

  test('finding detail returns only the requested finding', () => {
    const { text } = findingDetail(plan(), 'bc_local');
    assert.match(text, /^# bc_local/);
    assert.doesNotMatch(text, /bc_runtime|bc_up_|bc_review/);
  });

  test('a measured failure links to the upstream change its diagnostics name', () => {
    const { data } = findingDetail(plan(), MEASURED);
    assert.deepEqual(data.related.map((r) => r.id), ['bc_TxData_v']);
  });

  test('evidence for a finding is narrowed to that finding, not the whole record', () => {
    const { data, text } = evidenceDetail(plan(), { findingId: 'bc_local' });
    assert.equal(data.records.length, 1);
    assert.deepEqual(data.records[0]!.findings.map((f) => f.symbol), ['Upstream.bc_local']);
    assert.doesNotMatch(text, /bc_up_/);
    assert.doesNotMatch(text, /bc_runtime/);
  });

  test('a long evidence record is paged, with the next offset stated', () => {
    const p = plan();
    const first = evidenceDetail(p, { evidenceId: 'ev_notes' });
    const record = first.data.records[0]!;
    assert.ok(record.nextOffset !== null && record.nextOffset > 0);
    assert.ok(first.estimatedTokens <= 2500);
    const second = evidenceDetail(p, { evidenceId: 'ev_notes', offset: record.nextOffset! });
    assert.equal(second.data.records[0]!.offset, record.nextOffset);
  });

  test('a measured finding’s evidence is the failing check output', () => {
    const { data } = evidenceDetail(plan(), { findingId: MEASURED });
    assert.deepEqual(data.records.map((r) => r.id), ['check:npm run build']);
    assert.match(data.records[0]!.excerpt, /TS2339/);
  });

  test('unknown ids fail with a message saying what a valid id looks like', () => {
    assert.throws(() => findingDetail(plan(), 'bc_nope'), (err: unknown) => err instanceof UnknownAgentIdError && /No finding with id "bc_nope"/.test((err as Error).message));
    assert.throws(() => evidenceDetail(plan(), { evidenceId: 'ev_nope' }), /No evidence with id "ev_nope"/);
    assert.throws(() => evidenceDetail(plan(), {}), /Pass a finding id, an evidence id, or both/);
  });
});

describe('agent brief — real plans from the first agent benchmark', () => {
  // Plans Drift produced for the three development cases of the paired agent
  // benchmark (`drift analyze --verify` on each case's start commit), gzipped,
  // with local temp paths scrubbed. They are the regression fixture for the
  // budget: if the brief for any of them grows past the ceiling, this fails.
  const fixtures = ['eslint-8-to-10', 'winston-2-to-3', 'ethereumjs-tx-4-to-5', 'glob-8-to-13-smoke'] as const;
  const load = (name: (typeof fixtures)[number]): RemediationPlan =>
    JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/agent-context/${name}.plan.json.gz`, import.meta.url))).toString('utf8'));

  for (const name of fixtures) {
    test(`${name}: every locally relevant finding fits inside the production ceiling`, () => {
      const p = load(name);
      const brief = buildAgentBrief(p);
      const rendered = renderAgentBrief(brief);
      assert.ok(rendered.estimatedTokens <= AGENT_BRIEF_BUDGET.maxTokens, `${rendered.estimatedTokens} estimated tokens`);
      assert.deepEqual(rendered.findings.omittedForBudget, []);
      for (const change of p.breakingChanges) {
        const included = brief.findings.some((f) => f.id === change.id);
        const state = p.dispositions?.find((d) => d.changeId === change.id)?.state;
        if (state === 'actionable' || state === 'review-only') assert.ok(included, `${change.id} (${state}) is in the brief`);
        if (state === 'unknown' || state === 'unaffected') assert.doesNotMatch(rendered.text, new RegExp(`\\b${change.id}\\b`));
      }
      assert.equal(renderAgentBrief(buildAgentBrief(load(name))).text, rendered.text, 'deterministic');
    });
  }

  for (const name of fixtures) {
    test(`${name}: no measured site names text that is not a repository path`, () => {
      const p = load(name);
      for (const site of p.impactSites.filter((s) => s.breakingChangeId.startsWith('measured:'))) {
        assert.doesNotMatch(site.file, /^(test at |at )|\s|^\//, site.file);
      }
      const { text } = renderAgentBrief(buildAgentBrief(p));
      assert.doesNotMatch(text, /test at |at Object\.<anonymous>/);
    });

    test(`${name}: verification messaging agrees with what ran`, () => {
      const p = load(name);
      const { text } = renderAgentBrief(buildAgentBrief(p));
      if (p.verification && p.verification.checks.some((c) => c.status === 'passed' || c.status === 'failed')) {
        assert.doesNotMatch(text, /No checks were run/);
      }
    });

    test(`${name}: every text and JSON surface for every finding stays within its ceiling`, () => {
      const p = load(name);
      const brief = buildAgentBrief(p);
      assert.ok(agentBriefView(brief).bytes <= AGENT_BRIEF_BUDGET.maxTokens * BYTES_PER_TOKEN);
      assert.ok(renderAgentBrief(brief).bytes <= AGENT_BRIEF_BUDGET.maxTokens * BYTES_PER_TOKEN);
      const ids = [...brief.findings.map((f) => f.id), ...p.breakingChanges.slice(0, 40).map((c) => c.id)];
      for (const id of new Set(ids)) {
        const finding = findingDetail(p, id);
        assert.ok(finding.jsonBytes <= 2_000 * BYTES_PER_TOKEN && finding.bytes <= 2_000 * BYTES_PER_TOKEN, id);
        assert.equal(Buffer.byteLength(JSON.stringify(finding.data)), finding.jsonBytes);
        const evidence = evidenceDetail(p, { findingId: id });
        assert.ok(evidence.jsonBytes <= 2_500 * BYTES_PER_TOKEN && evidence.bytes <= 2_500 * BYTES_PER_TOKEN, id);
      }
      for (const record of p.evidence) {
        const page = evidenceDetail(p, { evidenceId: record.id });
        assert.ok(page.jsonBytes <= 2_500 * BYTES_PER_TOKEN && page.bytes <= 2_500 * BYTES_PER_TOKEN, record.id);
      }
    });
  }

  test('glob 8 → 13 (smoke): the Node test-runner line is not a measured site', () => {
    const p = load('glob-8-to-13-smoke');
    const measured = p.impactSites.filter((s) => s.breakingChangeId === 'measured:npm glob').map((s) => s.file);
    assert.equal(measured.includes('test at test/files.test.js'), false);
    assert.deepEqual(measured, ['package.json'], 'the failure falls back to the dependency declaration');
  });

  test('eslint 8 → 10: five findings in the brief, where the human report carried 293', () => {
    const p = load('eslint-8-to-10');
    const brief = buildAgentBrief(p);
    assert.deepEqual(brief.findings.map((f) => f.id).sort(), ['bc_2ba7ffc9b7', 'bc_3ab894d22c', 'bc_6843abffd2', 'bc_a770541f05', 'bc_c5df06643e']);
    assert.equal(brief.omitted.noLocatedUsage, 286);
    const human = renderPullRequestBody(p, DEFAULT_CONFIG);
    const agent = renderAgentBrief(brief);
    assert.ok(Buffer.byteLength(human) > 50 * agent.bytes, `${Buffer.byteLength(human)} vs ${agent.bytes} bytes`);
  });

  test('@ethereumjs/tx 4 → 5: the measured compiler errors lead, and link to the omitted upstream changes', () => {
    const p = load('ethereumjs-tx-4-to-5');
    const brief = buildAgentBrief(p);
    assert.equal(brief.findings[0]!.id, 'measured:npm @ethereumjs/tx');
    assert.equal(brief.findings[0]!.sites.length, 7);
    const related = findingDetail(p, 'measured:npm @ethereumjs/tx').data.related.map((r) => r.summary);
    assert.ok(related.includes('`TxData.v` was removed.'), related.join(' | '));
  });

  test('winston 2 → 3: no stack-trace text is presented as a file', () => {
    const brief = buildAgentBrief(load('winston-2-to-3'));
    for (const finding of brief.findings) {
      for (const file of finding.files) assert.doesNotMatch(file, /^at |^\//, file);
    }
  });
});

describe('verification messaging is consistent with what ran', () => {
  const notRun = {
    stage: 'verify',
    surface: 'build, typecheck, and test',
    reason: 'No checks were run against this plan, so nothing confirms the findings were understood correctly or that a fix would compile.',
    severity: 'significant',
    automaticExecution: 'degrades',
    remediation: 'Configure the repository checks Drift should run.',
  };
  const withVerification = (verification: unknown) =>
    ({ ...plan({ measured: false }), gaps: [notRun], verification } as unknown as RemediationPlan);
  const check = (label: string, status: string) => ({ kind: 'test', label, compileCapable: false, status, durationMs: 1, output: '' });

  test('a failed verification never sits beside "No checks were run"', () => {
    const reconciled = reconcileVerificationGap(withVerification({ status: 'failed', checks: [check('npm test', 'failed')], failedFiles: [] }));
    const { text } = renderAgentBrief(buildAgentBrief(reconciled));
    assert.match(text, /Verification: failed/);
    assert.doesNotMatch(text, /No checks were run/);
    assert.match(text, /npm test\) ran with the upgrade installed and failed where they passed before: a measured regression/);
    // The uncertainty is kept, at the same weight.
    assert.equal(reconciled.gaps[0]!.severity, 'significant');
    assert.equal(reconciled.gaps[0]!.automaticExecution, 'degrades');
  });

  test('passed, could-not-run and not-run each say what actually happened', () => {
    assert.match(reconcileVerificationGap(withVerification({ status: 'passed', checks: [check('npm run build', 'passed')], failedFiles: [] })).gaps[0]!.reason, /passed with the upgrade installed, before any fix/);
    assert.match(reconcileVerificationGap(withVerification({ status: 'skipped', reason: '`npm install` failed', checks: [], failedFiles: [] })).gaps[0]!.reason, /Verification did not run the project's checks: `npm install` failed/);
    const untouched = { ...plan({ measured: false }), gaps: [notRun], verification: undefined } as unknown as RemediationPlan;
    assert.equal(reconcileVerificationGap(untouched).gaps[0]!.reason, notRun.reason);
  });

  test('applying a verification result reconciles the gap on every path', () => {
    const applied = applyVerificationToPlan(withVerification(undefined), { status: 'failed', checks: [check('npm test', 'failed')], failedFiles: [] } as never);
    assert.doesNotMatch(applied.gaps[0]!.reason, /No checks were run/);
  });
});
