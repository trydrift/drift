import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DriftState } from '../src/state.js';
import {
  DriftDependencyTreeProvider,
  ManifestHoverProvider,
  ManifestLensProvider,
  lineMentionsDependency,
} from '../src/ui/dependencies.js';
import type { UpgradeCandidate } from '../src/upgrades.js';

function candidate(over: Partial<UpgradeCandidate> = {}): UpgradeCandidate {
  return {
    id: `${over.name ?? 'react'}@18->19`,
    name: 'react',
    kind: 'runtime',
    ecosystem: 'npm',
    packageManager: 'npm',
    manifestPath: 'package.json',
    current: '18.3.1',
    range: '^18.0.0',
    selected: '19.0.0',
    latest: '19.0.0',
    versions: ['19.0.0'],
    status: 'ready',
    evidenceCount: 1,
    breakingCount: 1,
    impactCount: 1,
    impactFiles: 1,
    impactConfidence: 'high',
    risk: 'medium',
    summary: 'React changed an API this repo uses.',
    gaps: [],
    toolRequests: [],
    ...over,
  };
}

function document(path: string, text: string): vscode.TextDocument {
  const lines = text.split('\n');
  return {
    uri: vscode.Uri.file(path),
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] ?? '' }),
    getText: () => text,
  } as never;
}

describe('dependency scan tree', () => {
  test('expands findings without assigning package-level confidence', () => {
    const state = new DriftState();
    state.setCandidates([
      candidate({
        name: 'twisted',
        plan: {
          breakingChanges: [
            { id: 'removed-export', kind: 'removed-export', summary: 'util.redirectTo is gone', confidence: 'high' },
            { id: 'signature-change', kind: 'signature-change', summary: 'Request.write changed', confidence: 'medium' },
          ],
        } as never,
      }),
    ]);

    const tree = new DriftDependencyTreeProvider(state);
    const [group] = tree.getChildren();
    const [dependency] = tree.getChildren(group);
    const parent = tree.getTreeItem(dependency!);
    const children = tree.getChildren(dependency!);
    assert.equal(parent.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.deepEqual(children.map((child) => tree.getTreeItem(child).description), ['Very confident', 'Fairly confident']);
    assert.equal(tree.getTreeItem(dependency!).description, '18.3.1 -> 19.0.0');
    tree.dispose();
  });

  test('groups the last scan by user-facing severity', () => {
    const state = new DriftState();
    state.setCandidates([
      candidate({ name: 'safe', breakingCount: 2, impactCount: 0, impactFiles: 0 }),
      candidate({ name: 'unchecked', breakingCount: 0, impactCount: 0, impactFiles: 0, recommendation: 'insufficient-evidence' }),
      candidate({ name: 'failed', status: 'error', breakingCount: 0, impactCount: 0, impactFiles: 0 }),
      candidate({ name: 'affected' }),
    ]);

    const tree = new DriftDependencyTreeProvider(state);
    const groups = tree.getChildren();
    assert.deepEqual(groups.map((g) => tree.getTreeItem(g).label), [
      'Affected (1)',
      'Unchecked (1)',
      'Safe (1)',
      'Failed (1)',
    ]);
    tree.dispose();
  });

  test('dependency nodes show current to selected and open the dependency command', () => {
    const state = new DriftState();
    state.setCandidates([candidate({ name: 'zod', current: '3.24.1', selected: '4.0.0' })]);

    const tree = new DriftDependencyTreeProvider(state);
    const [group] = tree.getChildren();
    const [dep] = tree.getChildren(group);
    const item = tree.getTreeItem(dep!);

    assert.equal(item.label, 'zod');
    assert.equal(item.description, '3.24.1 -> 4.0.0');
    assert.deepEqual(item.command, {
      command: 'drift.openDependency',
      title: 'Open Dependency',
      arguments: ['zod@18->19'],
    });
    tree.dispose();
  });
});

describe('manifest CodeLens and hover', () => {
  test('shows a scan lens before any dependency result exists', () => {
    const provider = new ManifestLensProvider(new DriftState());
    const [lens] = provider.provideCodeLenses(document('/repo/package.json', '{"dependencies":{}}'));
    assert.equal((lens!.command as { command: string }).command, 'drift.scanDependencies');
    provider.dispose();
  });

  test('summarises breaking packages above the dependency block', () => {
    const state = new DriftState();
    state.setRoots([{ path: '/repo', label: 'repo', repo: null, gitRoot: null, subprojects: [] }]);
    state.setCandidates([candidate(), candidate({ name: 'lodash', breakingCount: 3, impactCount: 0, impactFiles: 0 })]);

    const provider = new ManifestLensProvider(state);
    const [lens] = provider.provideCodeLenses(
      document('/repo/package.json', '{\n  "dependencies": {\n    "react": "^18.0.0"\n  }\n}'),
    );

    assert.match((lens!.command as { title: string }).title, /2 packages have breaking changes/);
    assert.equal((lens!.command as { command: string }).command, 'drift.showReport');
    assert.equal(lens!.range.start.line, 1);
    provider.dispose();
  });

  test('anchors a single breaking package on its dependency entry and opens its report', () => {
    const state = new DriftState();
    state.setRoots([{ path: '/repo', label: 'repo', repo: null, gitRoot: null, subprojects: [] }]);
    state.setCandidates([candidate({ name: 'zod', current: '3.24.1', selected: '4.0.0' })]);

    const provider = new ManifestLensProvider(state);
    const [lens] = provider.provideCodeLenses(
      document(
        '/repo/package.json',
        [
          '{',
          '  "name": "drift",',
          '  "keywords": [',
          '    "dependencies",',
          '    "breaking changes"',
          '  ],',
          '  "dependencies": {',
          '    "zod": "^3.24.1"',
          '  }',
          '}',
        ].join('\n'),
      ),
    );

    assert.match((lens!.command as { title: string }).title, /1 package have breaking changes/);
    assert.equal(lens!.range.start.line, 7);
    assert.deepEqual(lens!.command, {
      title: '$(warning) Drift: 1 package have breaking changes, 1 affect this repo',
      command: 'drift.openDependency',
      arguments: ['zod@18->19'],
    });
    provider.dispose();
  });

  test('hovers on dependency lines with the last scanned version and severity', () => {
    const state = new DriftState();
    state.setRoots([{ path: '/repo', label: 'repo', repo: null, gitRoot: null, subprojects: [] }]);
    state.setCandidates([candidate()]);

    const provider = new ManifestHoverProvider(state);
    const hover = provider.provideHover(
      document('/repo/package.json', '{\n  "dependencies": {\n    "react": "^18.0.0"\n  }\n}'),
      new vscode.Position(2, 6),
    );

    const value = ((hover as unknown as { contents: { value: string } }).contents.value);
    assert.match(value, /18\.3\.1 -> 19\.0\.0/);
    assert.match(value, /Affects your code/);
    provider.dispose();
  });

  test('recognises the supported manifest line shapes', () => {
    assert.equal(lineMentionsDependency('    "react": "^18"', 'react', 'package.json'), true);
    assert.equal(lineMentionsDependency('\tgithub.com/acme/lib v1.2.3', 'github.com/acme/lib', 'go.mod'), true);
    assert.equal(lineMentionsDependency('serde = "1"', 'serde', 'Cargo.toml'), true);
    assert.equal(lineMentionsDependency('<artifactId>guava</artifactId>', 'guava', 'pom.xml'), true);
    assert.equal(lineMentionsDependency('django==5.0.0', 'django', 'requirements.txt'), true);
    assert.equal(lineMentionsDependency("gem 'rails', '~> 7.0'", 'rails', 'Gemfile'), true);
  });
});
