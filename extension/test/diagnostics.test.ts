import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { DriftState } from '../src/state.js';
import { DriftReview } from '../src/review/store.js';
import { DriftCodeActionProvider, DriftDiagnostics } from '../src/ui/diagnostics.js';
import type { RemediationPlan } from '../../src/types.js';

function plan(): RemediationPlan {
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
    breakingChanges: [{ id: 'b1', dependency: 'react', kind: 'signature-change', summary: 'render changed', remediation: 'Update the render call.', symbols: ['render'], confidence: 'high', citations: ['e1'] }],
    impactSites: [{ breakingChangeId: 'b1', file: 'src/app.ts', line: 1, excerpt: 'render()', matchedSymbol: 'render', confidence: 'high' }],
    commits: [{
      id: 'unit-1',
      order: 1,
      message: 'fix(react): update render call',
      body: 'Update the changed render API.',
      breakingChangeIds: ['b1'],
      files: ['src/app.ts'],
      allowedFiles: ['src/app.ts'],
      allowedSymbols: ['render'],
      instructions: 'fix it',
      dependsOn: [],
      dependencyReasons: [],
      executionLayer: 0,
      expectedChecks: [],
      invalidationTriggers: [],
    }],
    planEdges: [],
    upgradeCohorts: [],
    risk: 'high',
    blockers: [],
    warnings: [],
    createdAt: '2026-08-02T00:00:00Z',
  };
}

function document(path: string, text = 'render()\n'): vscode.TextDocument {
  return {
    uri: vscode.Uri.file(path),
    lineCount: text.split('\n').length,
    getText: () => text,
    lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
  } as never;
}

describe('DriftCodeActionProvider', () => {
  test('offers analysis-time fix and explain actions from Drift diagnostics', () => {
    const state = new DriftState();
    state.setRoots([{ path: '/repo', label: 'repo', repo: null, gitRoot: null, subprojects: [] }]);
    const diagnostics = new DriftDiagnostics(state);
    state.set({ kind: 'findings', plan: plan(), at: Date.now() });

    const provider = new DriftCodeActionProvider(state, diagnostics);
    const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 6), 'render changed', vscode.DiagnosticSeverity.Error);
    diagnostic.source = 'Drift';

    const actions = provider.provideCodeActions(document('/repo/src/app.ts'), new vscode.Range(0, 0, 0, 1), {
      diagnostics: [diagnostic],
    } as never);

    assert.deepEqual(actions.map((a) => (a.command as { command: string }).command), [
      'drift.fixCommit',
      'drift.explainChange',
      'drift.disableEditorSignals',
      'drift.fixAll',
    ]);
    diagnostics.dispose();
  });

  test('offers review-time keep and undo actions without requiring a diagnostic', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-diagnostics-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/app.ts'), 'before\n');

      const review = new DriftReview();
      review.begin(root);
      review.snapshot({ order: 1, title: 'fix: app' }, [{ path: 'src/app.ts', content: 'before\n' }]);
      writeFileSync(join(root, 'src/app.ts'), 'after\n');
      await review.settle(1);

      const provider = new DriftCodeActionProvider(new DriftState(), new DriftDiagnostics(new DriftState()), review);
      const actions = provider.provideCodeActions(
        document(join(root, 'src/app.ts'), 'after\n'),
        new vscode.Range(0, 0, 0, 1),
        { diagnostics: [] } as never,
      );

      assert.deepEqual(actions.map((a) => (a.command as { command: string }).command), [
        'drift.keepHunk',
        'drift.undoHunk',
        'drift.keepFile',
        'drift.undoFile',
      ]);
      review.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
