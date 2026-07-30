import * as vscode from 'vscode';
import { join } from 'node:path';
import type { DriftReview } from './store.js';

/**
 * In-editor review surface.
 *
 * Reviewing a diff in a side panel means reading code without its context. So
 * the primary review surface is the editor itself: changed lines are tinted,
 * and every hunk carries its own Keep / Undo affordance right above it — the
 * same shape Copilot and Claude use, for the same reason. The panel's change
 * list is a table of contents, not the place the decision gets made.
 */

export const BASELINE_SCHEME = 'drift-baseline';

export class DriftReviewUi implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  private readonly changedLine = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  private readonly removedMarker = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    before: {
      contentText: '',
      border: '1px solid',
      borderColor: new vscode.ThemeColor('diffEditor.removedTextBorder'),
    },
  });

  constructor(private readonly review: DriftReview) {
    const lens = new HunkLensProvider(review);

    this.disposables.push(
      lens,
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lens),
      vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
        provideTextDocumentContent: (uri) => this.baselineFor(uri),
      }),
      review.onDidChange(() => this.paint()),
      vscode.window.onDidChangeActiveTextEditor(() => this.paint()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.paint()),
      this.changedLine,
      this.removedMarker,
    );

    this.paint();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  /**
   * Open the native side-by-side diff.
   *
   * VS Code's diff editor is better than anything a webview can draw, and it is
   * the editor developers already know how to read. Drift's job is only to
   * supply the left-hand side.
   */
  async openDiff(path: string): Promise<void> {
    const root = this.review.workspaceRoot;
    if (!root) return;

    const file = vscode.Uri.file(join(root, path));
    const baseline = file.with({ scheme: BASELINE_SCHEME, query: `p=${encodeURIComponent(path)}` });

    await vscode.commands.executeCommand(
      'vscode.diff',
      baseline,
      file,
      `${path} — Drift proposal`,
      { preview: true } satisfies vscode.TextDocumentShowOptions,
    );
  }

  /** Reveal the next unresolved hunk anywhere in the review. */
  async revealNext(): Promise<void> {
    const root = this.review.workspaceRoot;
    const group = this.review.groups().find((g) => !g.committed && g.files.length > 0);
    const file = group?.files[0];
    if (!root || !file) {
      void vscode.window.showInformationMessage('Drift: nothing left to review.');
      return;
    }

    const hunk = file.hunks[0];
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, file.path)));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    if (!hunk) return;

    const range = new vscode.Range(hunk.start, 0, Math.max(hunk.start, hunk.end - 1), 0);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private baselineFor(uri: vscode.Uri): string {
    const path = new URLSearchParams(uri.query).get('p');
    const root = this.review.workspaceRoot;
    if (!path || !root) return '';
    return this.review.fileFor(vscode.Uri.file(join(root, path)))?.file.baseline ?? '';
  }

  private paint(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const found = this.review.fileFor(editor.document.uri);
      if (!found) {
        editor.setDecorations(this.changedLine, []);
        editor.setDecorations(this.removedMarker, []);
        continue;
      }

      const changed: vscode.DecorationOptions[] = [];
      const deletions: vscode.DecorationOptions[] = [];

      for (const hunk of found.file.hunks) {
        if (hunk.end > hunk.start) {
          const last = Math.min(hunk.end - 1, Math.max(0, editor.document.lineCount - 1));
          changed.push({
            range: new vscode.Range(hunk.start, 0, last, 0),
            hoverMessage: hunkHover(found.file.path, hunk.id, hunk.baselineLines),
          });
        } else if (hunk.baselineLines.length > 0) {
          // A pure deletion has no line to tint, so mark the seam instead.
          const line = Math.min(hunk.start, Math.max(0, editor.document.lineCount - 1));
          deletions.push({
            range: new vscode.Range(line, 0, line, 0),
            hoverMessage: hunkHover(found.file.path, hunk.id, hunk.baselineLines),
          });
        }
      }

      editor.setDecorations(this.changedLine, changed);
      editor.setDecorations(this.removedMarker, deletions);
    }
  }
}

/** One CodeLens row per hunk, plus a file-level row at the top. */
class HunkLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly review: DriftReview) {
    this.sub = review.onDidChange(() => this.emitter.fire());
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const found = this.review.fileFor(document.uri);
    if (!found) return [];

    const { file } = found;
    const lenses: vscode.CodeLens[] = [];
    const top = new vscode.Range(0, 0, 0, 0);
    const plural = file.hunks.length === 1 ? 'change' : 'changes';

    lenses.push(
      new vscode.CodeLens(top, {
        title: `$(git-pull-request) Drift · ${file.hunks.length} ${plural} · +${file.stat.added} −${file.stat.removed}`,
        command: 'drift.openChangeDiff',
        arguments: [file.path],
      }),
      new vscode.CodeLens(top, {
        title: '$(check-all) Keep file',
        tooltip: 'Accept every Drift change in this file',
        command: 'drift.keepFile',
        arguments: [file.path],
      }),
      new vscode.CodeLens(top, {
        title: '$(discard) Undo file',
        tooltip: 'Restore this file to how it was before Drift ran',
        command: 'drift.undoFile',
        arguments: [file.path],
      }),
    );

    for (const hunk of file.hunks) {
      const line = Math.min(hunk.start, Math.max(0, document.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);

      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(check) Keep',
          tooltip: 'Accept this change',
          command: 'drift.keepHunk',
          arguments: [file.path, hunk.id],
        }),
        new vscode.CodeLens(range, {
          title: '$(discard) Undo',
          tooltip: 'Revert these lines to how they were',
          command: 'drift.undoHunk',
          arguments: [file.path, hunk.id],
        }),
        new vscode.CodeLens(range, {
          title: '$(diff) Diff',
          command: 'drift.openChangeDiff',
          arguments: [file.path],
        }),
      );
    }

    return lenses;
  }
}

function hunkHover(path: string, hunkId: string, baselineLines: readonly string[]): vscode.MarkdownString {
  const lines = ['**Drift change**', ''];

  if (baselineLines.length > 0) {
    lines.push('Before:', '```', ...baselineLines.slice(0, 12), '```');
    if (baselineLines.length > 12) lines.push(`_…${baselineLines.length - 12} more line(s)_`);
  } else {
    lines.push('_New lines; nothing was replaced._');
  }

  const keep = encodeURIComponent(JSON.stringify([path, hunkId]));
  lines.push(
    '',
    `[Keep](command:drift.keepHunk?${keep}) · [Undo](command:drift.undoHunk?${keep})`,
  );

  const md = new vscode.MarkdownString(lines.join('\n'));
  md.isTrusted = true;
  return md;
}
