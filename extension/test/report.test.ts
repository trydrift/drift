import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DriftState } from '../src/state.js';
import { DriftReportPanel, __renderForTest } from '../src/ui/report.js';
import { openDependency } from '../src/ui/dependencies.js';
import type { RemediationPlan } from '../../src/types.js';
import type { UpgradeCandidate } from '../src/upgrades.js';

function plan(over: Partial<RemediationPlan> = {}): RemediationPlan {
  return {
    schemaVersion: 3,
    gaps: [],
    checkedSurfaces: [],
    id: 'p1',
    branchName: 'drift/upgrade-react',
    baseBranch: 'main',
    headSha: 'abc',
    changes: [
      { name: 'react', ecosystem: 'npm', from: '18.0.0', to: '19.0.0', kind: 'runtime', bump: 'major', manifestPath: 'package.json' },
    ],
    evidence: [{ id: 'e1', source: 'changelog', dependency: 'react', title: 'React 19', content: 'breaking', weight: 1, url: 'https://example.test' }],
    breakingChanges: [{ id: 'b1', dependency: 'react', kind: 'signature-change', summary: '<script>alert(1)</script>', remediation: 'Update the call.', symbols: ['render'], confidence: 'high', citations: ['e1'] }],
    impactSites: [{ breakingChangeId: 'b1', file: 'src/app.ts', line: 1, excerpt: 'render()', matchedSymbol: 'render', confidence: 'high' }],
    commits: [],
    planEdges: [],
    upgradeCohorts: [],
    risk: 'high',
    blockers: [],
    warnings: [],
    createdAt: '2026-08-02T00:00:00Z',
    ...over,
  };
}

/** A clean plan: some dependency changes were checked, none are breaking. */
function cleanPlan(over: Partial<RemediationPlan> = {}): RemediationPlan {
  return plan({
    breakingChanges: [],
    impactSites: [],
    risk: 'none',
    ...over,
  });
}

function candidate(over: Partial<UpgradeCandidate> = {}): UpgradeCandidate {
  return {
    id: `${over.name ?? 'wails'}@2.12.0->2.13.0`,
    name: 'wails',
    kind: 'runtime',
    ecosystem: 'go',
    packageManager: 'go',
    manifestPath: 'go.mod',
    current: '2.12.0',
    range: '2.12.0',
    selected: '2.13.0',
    latest: '2.13.0',
    versions: ['2.13.0'],
    status: 'ready',
    evidenceCount: 1,
    breakingCount: 1,
    impactCount: 1,
    impactFiles: 1,
    risk: 'high',
    summary: 'Breaking change found.',
    gaps: [],
    toolRequests: [],
    ...over,
  };
}

describe('report rendering', () => {
  test('renders the affected-file count from DriftState.plan', () => {
    const state = new DriftState();
    state.set({ kind: 'findings', plan: plan(), at: Date.now() });
    const html = __renderForTest(state);
    assert.match(html, /1[\s\S]*file affected here/);
    assert.match(html, /src\/app\.ts/);
  });

  test('escapes upstream prose before it reaches the webview', () => {
    const state = new DriftState();
    state.set({ kind: 'findings', plan: plan(), at: Date.now() });
    const html = __renderForTest(state);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert/);
  });

  test('renders full evidence markdown with relative links', () => {
    const state = new DriftState();
    const content = `Read [the migration notes](./migration-notes.md).\n\n${'detail '.repeat(700)}report-tail-visible`;
    state.set({
      kind: 'findings',
      plan: plan({
        evidence: [
          {
            id: 'e1',
            source: 'migration-guide',
            dependency: 'react',
            title: 'React migration',
            content,
            weight: 1,
            url: 'https://raw.githubusercontent.com/acme/react/main/docs/migration.md',
          },
        ],
      }),
      at: Date.now(),
    });

    const html = __renderForTest(state);

    assert.doesNotMatch(html, /\[the migration notes\]\(\.\/migration-notes\.md\)/);
    assert.match(html, /data-url="https:\/\/raw\.githubusercontent\.com\/acme\/react\/main\/docs\/migration-notes\.md"/);
    assert.match(html, /report-tail-visible/);
  });

  test('formats before and after signatures in remediation and evidence', () => {
    const state = new DriftState();
    state.set({
      kind: 'findings',
      plan: plan({
        evidence: [
          {
            id: 'e1',
            source: 'type-surface-diff',
            dependency: 'react',
            title: 'API diff',
            content: 'before: old(<tag>)\nafter: next(value)',
            weight: 1,
          },
        ],
        breakingChanges: [
          {
            id: 'b1',
            dependency: 'react',
            kind: 'signature-change',
            summary: 'signature changed',
            remediation: 'Update calls.\n  before: render(<App />)\n  after:  createRoot(node).render(<App />)',
            symbols: ['render'],
            confidence: 'high',
            citations: ['e1'],
          },
        ],
      }),
      at: Date.now(),
    });

    const html = __renderForTest(state);
    // Syntax highlighting wraps tokens like `render` in their own <span>, so
    // assertions about the escaped source text strip tags first rather than
    // expecting it to survive as one contiguous run.
    const text = html.replace(/<[^>]+>/g, '');

    assert.match(html, /<figcaption>before<\/figcaption>/);
    assert.match(text, /render\(&lt;App \/&gt;\)/);
    assert.match(text, /old\(&lt;tag&gt;\)/);
    assert.doesNotMatch(html, /render\(<App \/>/);
  });

  test('a candidateId focus renders that candidate\'s plan, not the global one', () => {
    const state = new DriftState();
    state.set({ kind: 'clean', summary: 'nothing breaking', at: Date.now(), plan: cleanPlan() });
    state.setCandidates([candidate({ plan: plan() })]);

    const html = __renderForTest(state, { candidateId: 'wails@2.12.0->2.13.0' });
    assert.doesNotMatch(html, /No breaking changes found/);
    assert.match(html, /1[\s\S]*file affected here/);
  });

  test('without a candidateId focus, the global plan is used', () => {
    const state = new DriftState();
    state.set({ kind: 'clean', summary: 'nothing breaking', at: Date.now(), plan: cleanPlan() });
    state.setCandidates([candidate({ plan: plan() })]);

    const html = __renderForTest(state);
    assert.match(html, /No breaking changes found/);
  });

  test('two candidates sharing a dependency name stay distinguishable by id', () => {
    const state = new DriftState();
    state.set({ kind: 'clean', summary: 'nothing breaking', at: Date.now(), plan: cleanPlan() });
    state.setCandidates([
      candidate({
        id: 'wails@repo-a',
        repoRoot: '/repo-a',
        plan: plan({ id: 'plan-a', changes: [{ name: 'wails', ecosystem: 'go', from: '2.12.0', to: '2.13.0', kind: 'runtime', bump: 'minor', manifestPath: 'go.mod' }] }),
      }),
      candidate({
        id: 'wails@repo-b',
        repoRoot: '/repo-b',
        plan: cleanPlan({ id: 'plan-b', changes: [{ name: 'wails', ecosystem: 'go', from: '2.12.0', to: '2.13.0', kind: 'runtime', bump: 'minor', manifestPath: 'go.mod' }] }),
      }),
    ]);

    const affected = __renderForTest(state, { candidateId: 'wails@repo-a' });
    assert.doesNotMatch(affected, /No breaking changes found/);

    const clean = __renderForTest(state, { candidateId: 'wails@repo-b' });
    assert.match(clean, /No breaking changes found/);
  });
});

describe('report panel focus (end-to-end through openDependency)', () => {
  test('clicking a candidate opens its own plan, not the global one', async () => {
    DriftReportPanel.__resetForTest();
    const state = new DriftState();
    state.set({ kind: 'clean', summary: 'nothing breaking', at: Date.now(), plan: cleanPlan() });
    const c = candidate({ plan: plan() });
    state.setCandidates([c]);

    await openDependency(state, c.id);

    const html = (vscode.window as unknown as { __lastWebviewPanel?: { webview: { html: string } } })
      .__lastWebviewPanel!.webview.html;
    assert.doesNotMatch(html, /No breaking changes found/);
    assert.match(html, /1[\s\S]*file affected here/);
    DriftReportPanel.__resetForTest();
  });

  test('the selected candidate survives a state.onDidChange re-render', async () => {
    DriftReportPanel.__resetForTest();
    const state = new DriftState();
    state.set({ kind: 'clean', summary: 'nothing breaking', at: Date.now(), plan: cleanPlan() });
    const c = candidate({ plan: plan() });
    state.setCandidates([c]);

    await openDependency(state, c.id);

    // Something unrelated changes state (a fresh scan finishing, say) and
    // fires onDidChange. The panel must stay on the candidate it was opened for.
    state.set({ kind: 'clean', summary: 'rescanned', at: Date.now(), plan: cleanPlan() });

    const html = (vscode.window as unknown as { __lastWebviewPanel?: { webview: { html: string } } })
      .__lastWebviewPanel!.webview.html;
    assert.doesNotMatch(html, /No breaking changes found/);
    assert.match(html, /1[\s\S]*file affected here/);
    DriftReportPanel.__resetForTest();
  });

  test('drift.showReport with no candidate still shows the global plan', async () => {
    DriftReportPanel.__resetForTest();
    const state = new DriftState();
    state.set({ kind: 'findings', plan: plan(), at: Date.now() });

    DriftReportPanel.show(state);

    const html = (vscode.window as unknown as { __lastWebviewPanel?: { webview: { html: string } } })
      .__lastWebviewPanel!.webview.html;
    assert.match(html, /1[\s\S]*file affected here/);
    DriftReportPanel.__resetForTest();
  });
});
