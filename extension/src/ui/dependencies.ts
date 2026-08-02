import * as vscode from 'vscode';
import { basename, join } from 'node:path';
import type { UpgradeCandidate } from '../upgrades.js';
import type { DriftState } from '../state.js';
import { describeSeverity, severityOf, type UpgradeSeverity } from '../severity.js';
import { DriftReportPanel } from './report.js';

const MANIFESTS = new Set(['package.json', 'go.mod', 'Cargo.toml', 'pom.xml', 'requirements.txt', 'Gemfile']);
const ORDER: UpgradeSeverity[] = ['affected', 'unchecked', 'clean', 'error'];

type DependencyNode =
  | { kind: 'group'; severity: UpgradeSeverity; candidates: UpgradeCandidate[] }
  | { kind: 'candidate'; candidate: UpgradeCandidate };

export class DriftDependencyTreeProvider
  implements vscode.TreeDataProvider<DependencyNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly state: DriftState) {
    this.sub = state.onDidChange(() => this.emitter.fire());
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }

  getChildren(element?: DependencyNode): DependencyNode[] {
    if (element?.kind === 'group') {
      return [...element.candidates]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((candidate) => ({ kind: 'candidate', candidate }));
    }
    if (element) return [];

    const grouped = new Map<UpgradeSeverity, UpgradeCandidate[]>();
    for (const candidate of this.state.candidates) {
      const severity = severityOf(candidate);
      const key = severity === 'upstream-only' ? 'clean' : severity;
      const bucket = grouped.get(key);
      if (bucket) bucket.push(candidate);
      else grouped.set(key, [candidate]);
    }

    return ORDER.filter((severity) => (grouped.get(severity)?.length ?? 0) > 0).map((severity) => ({
      kind: 'group',
      severity,
      candidates: grouped.get(severity)!,
    }));
  }

  getTreeItem(element: DependencyNode): vscode.TreeItem {
    if (element.kind === 'group') {
      const count = element.candidates.length;
      const item = new vscode.TreeItem(
        `${groupLabel(element.severity)} (${count})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = `driftDependencyGroup:${element.severity}`;
      item.iconPath = new vscode.ThemeIcon(iconFor(element.severity));
      return item;
    }

    const candidate = element.candidate;
    const item = new vscode.TreeItem(candidate.name, vscode.TreeItemCollapsibleState.None);
    item.description = `${candidate.current} -> ${candidate.selected}`;
    item.tooltip = `${candidate.name} ${candidate.current} -> ${candidate.selected}\n${describeSeverity(candidate)}\n${candidate.manifestPath}`;
    item.contextValue = `driftDependency:${severityOf(candidate)}`;
    item.iconPath = new vscode.ThemeIcon(iconFor(severityOf(candidate)));
    item.command = {
      command: 'drift.openDependency',
      title: 'Open Dependency',
      arguments: [candidate.id],
    };
    return item;
  }
}

export class ManifestLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly state: DriftState) {
    this.sub = state.onDidChange(() => this.emitter.fire());
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('drift').get<boolean>('ui.showManifestCodeLens', true)) {
      return [];
    }
    if (!isManifest(document.uri.fsPath)) return [];
    const line = dependencyBlockLine(document);
    const range = new vscode.Range(line, 0, line, 0);
    const candidates = candidatesForDocument(this.state, document.uri);

    if (candidates.length === 0) {
      return [
        new vscode.CodeLens(range, {
          title: '$(search) Drift: scan dependencies',
          command: 'drift.scanDependencies',
        }),
      ];
    }

    const breaking = candidates.filter((candidate) => candidate.breakingCount > 0);
    if (breaking.length === 0) return [];
    const affected = breaking.filter((candidate) => severityOf(candidate) === 'affected').length;
    const suffix = affected > 0 ? `, ${affected} affect this repo` : '';
    return [
      new vscode.CodeLens(range, {
        title: `$(warning) Drift: ${breaking.length} package${breaking.length === 1 ? '' : 's'} have breaking changes${suffix}`,
        command: 'drift.showReport',
      }),
    ];
  }
}

export class ManifestHoverProvider implements vscode.HoverProvider, vscode.Disposable {
  private readonly sub: vscode.Disposable;

  constructor(private readonly state: DriftState) {
    this.sub = state.onDidChange(() => undefined);
  }

  dispose(): void {
    this.sub.dispose();
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (!isManifest(document.uri.fsPath)) return undefined;
    const line = document.lineAt(position.line).text;
    const candidate = candidatesForDocument(this.state, document.uri).find((c) =>
      lineMentionsDependency(line, c.name, basename(c.manifestPath)),
    );
    if (!candidate) return undefined;

    const md = new vscode.MarkdownString(
      [
        `**Drift: ${candidate.name}**`,
        '',
        `${candidate.current} -> ${candidate.selected}`,
        '',
        describeSeverity(candidate),
      ].join('\n'),
    );
    md.isTrusted = true;
    return new vscode.Hover(md);
  }
}

export async function openDependency(state: DriftState, id: string): Promise<void> {
  const candidate = state.candidates.find((entry) => entry.id === id);
  if (!candidate) return;

  if (candidate.plan) {
    DriftReportPanel.show(state, { dependency: candidate.name });
    return;
  }

  const root = candidate.repoRoot ?? state.workspaceRoot;
  if (!root) return;
  const uri = vscode.Uri.file(join(root, candidate.manifestPath));
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: true });
  const line = findDependencyLine(document, candidate.name, basename(candidate.manifestPath));
  const range = new vscode.Range(line, 0, line, 0);
  editor.selection = new vscode.Selection(range.start, range.start);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

export function candidatesForDocument(state: DriftState, uri: vscode.Uri): UpgradeCandidate[] {
  const doc = uri.fsPath.replace(/\\/g, '/');
  return state.candidates.filter((candidate) => {
    const root = (candidate.repoRoot ?? state.workspaceRoot ?? '').replace(/\\/g, '/');
    const manifest = root ? `${root}/${candidate.manifestPath}` : candidate.manifestPath;
    return doc === manifest || doc.endsWith(`/${candidate.manifestPath}`);
  });
}

export function lineMentionsDependency(line: string, name: string, manifestName: string): boolean {
  const escaped = escapeRegExp(name);
  switch (manifestName) {
    case 'package.json':
      return new RegExp(`^\\s*"${escaped}"\\s*:`).test(line);
    case 'go.mod':
      return new RegExp(`^\\s*${escaped}\\s+v?\\d`).test(line);
    case 'Cargo.toml':
      return new RegExp(`^\\s*${escaped}\\s*=`).test(line);
    case 'pom.xml':
      return new RegExp(`<artifactId>\\s*${escaped}\\s*</artifactId>`).test(line);
    case 'requirements.txt':
      return new RegExp(`^\\s*${escaped}(\\[[^\\]]+\\])?\\s*(==|~=|>=|<=|>|<)`, 'i').test(line);
    case 'Gemfile':
      return new RegExp(`^\\s*gem\\s+["']${escaped}["']`).test(line);
    default:
      return false;
  }
}

function isManifest(path: string): boolean {
  return MANIFESTS.has(basename(path));
}

function candidatesForTextDocument(state: DriftState, document: vscode.TextDocument): UpgradeCandidate[] {
  return candidatesForDocument(state, document.uri);
}

function dependencyBlockLine(document: vscode.TextDocument): number {
  const name = basename(document.uri.fsPath);
  const markers =
    name === 'package.json'
      ? ['"dependencies"', '"devDependencies"', '"peerDependencies"', '"optionalDependencies"']
      : name === 'Cargo.toml'
        ? ['[dependencies]', '[dev-dependencies]', '[build-dependencies]']
        : name === 'pom.xml'
          ? ['<dependencies>']
          : [];
  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    if (markers.some((marker) => text.includes(marker))) return i;
  }
  return 0;
}

function findDependencyLine(document: vscode.TextDocument, name: string, manifestName: string): number {
  for (let i = 0; i < document.lineCount; i++) {
    if (lineMentionsDependency(document.lineAt(i).text, name, manifestName)) return i;
  }
  return dependencyBlockLine(document);
}

function groupLabel(severity: UpgradeSeverity): string {
  switch (severity) {
    case 'affected':
      return 'Affected';
    case 'unchecked':
      return 'Unchecked';
    case 'clean':
    case 'upstream-only':
      return 'Safe';
    case 'error':
      return 'Failed';
  }
}

function iconFor(severity: UpgradeSeverity): string {
  switch (severity) {
    case 'affected':
      return 'warning';
    case 'unchecked':
      return 'question';
    case 'clean':
    case 'upstream-only':
      return 'pass';
    case 'error':
      return 'error';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
