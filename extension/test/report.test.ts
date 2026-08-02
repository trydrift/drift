import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DriftState } from '../src/state.js';
import { __renderForTest } from '../src/ui/report.js';
import type { RemediationPlan } from '../../src/types.js';

function plan(over: Partial<RemediationPlan> = {}): RemediationPlan {
  return {
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
    risk: 'high',
    blockers: [],
    warnings: [],
    createdAt: '2026-08-02T00:00:00Z',
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
});
