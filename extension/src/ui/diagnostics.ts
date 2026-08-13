import * as vscode from 'vscode';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { BreakingChange, ImpactSite, RemediationPlan } from '../../../src/types.js';
import type { DriftState } from '../state.js';
import type { DriftReview } from '../review/store.js';

/**
 * Inline flagging.
 *
 * This is the feature that makes Drift feel like part of the editor rather than
 * a report you have to go and read. Every impact site becomes a squiggle on the
 * exact line, an entry in the Problems panel, and a lightbulb offering the fix.
 *
 * Severity maps to Drift's confidence, so the visual weight of a marker matches
 * how sure Drift actually is — a `low`-confidence guess must not look identical
 * to a computed API diff.
 */

const SOURCE = 'Drift';

export class DriftDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('drift');
  /** Diagnostic -> the change it came from, for the code-action provider. */
  private readonly index = new Map<string, BreakingChange>();

  constructor(private readonly state: DriftState) {
    state.onDidChange(() => this.render());
  }

  render(): void {
    this.collection.clear();
    this.index.clear();

    const root = this.state.workspaceRoot;
    if (!root) return;

    if (!vscode.workspace.getConfiguration('drift').get<boolean>('ui.showInlineDiagnostics', true)) {
      return;
    }

    const byFile = new Map<string, vscode.Diagnostic[]>();
    const push = (file: string, diagnostic: vscode.Diagnostic) => {
      const bucket = byFile.get(file);
      if (bucket) bucket.push(diagnostic);
      else byFile.set(file, [diagnostic]);
    };

    const plan = this.state.plan;
    if (plan) {
      const changeById = new Map(plan.breakingChanges.map((c) => [c.id, c]));
      const pending = isPendingUpgradePlan(plan, this.state);

      for (const site of plan.impactSites) {
        const change = changeById.get(site.breakingChangeId);
        if (!change) continue;
        const uri = vscode.Uri.file(join(root, site.file));
        push(site.file, this.toDiagnostic(site, change, plan, uri, pending));
      }
    }

    for (const [file, diagnostics] of byFile) {
      this.collection.set(vscode.Uri.file(join(root, file)), diagnostics);
    }
  }

  private toDiagnostic(
    site: ImpactSite,
    change: BreakingChange,
    plan: RemediationPlan,
    uri: vscode.Uri,
    pendingUpgrade: boolean,
  ): vscode.Diagnostic {
    const range = rangeForSite(uri, site);

    const diagnostic = new vscode.Diagnostic(
      range,
      diagnosticMessage(change, plan, pendingUpgrade),
      severityFor(change, pendingUpgrade),
    );
    diagnostic.source = SOURCE;
    diagnostic.code = {
      value: `${change.dependency} ${change.kind}`,
      // Links the marker to its evidence, so "why do you think that?" is one
      // click away from the squiggle itself.
      target: vscode.Uri.parse(evidenceUrl(change, plan) ?? 'https://github.com/trydrift/drift'),
    };

    const evidence = plan.evidence.filter((e) => change.citations.includes(e.id));
    diagnostic.relatedInformation = evidence.slice(0, 3).map(
      (e) =>
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(uri, range),
          `Evidence: ${e.title}`,
        ),
    );

    this.index.set(keyFor(uri, range, change.id), change);
    return diagnostic;
  }

  /** Look up the change behind a diagnostic, for the code-action provider. */
  changeFor(uri: vscode.Uri, diagnostic: vscode.Diagnostic): BreakingChange | undefined {
    for (const [key, change] of this.index) {
      if (key.startsWith(`${uri.toString()}|${diagnostic.range.start.line}|`)) return change;
    }
    return undefined;
  }

  clear(): void {
    this.collection.clear();
    this.index.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}

/**
 * Confidence determines severity.
 *
 * `high` is an Error because it is a computed fact or two sources agreeing —
 * this code is broken. `low` is Information because Drift is genuinely unsure,
 * and dressing a guess up as an error trains people to ignore the markers.
 */
function severityFor(change: BreakingChange, pendingUpgrade: boolean): vscode.DiagnosticSeverity {
  if (pendingUpgrade && change.confidence === 'high') {
    return vscode.DiagnosticSeverity.Warning;
  }

  switch (change.confidence) {
    case 'high':
      return vscode.DiagnosticSeverity.Error;
    case 'medium':
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

function diagnosticMessage(
  change: BreakingChange,
  plan: RemediationPlan,
  pendingUpgrade: boolean,
): string {
  if (!pendingUpgrade) return change.summary;

  const target = plan.changes.find((entry) => entry.name === change.dependency)?.to;
  const version = target ? `${change.dependency}@${target}` : change.dependency;
  return `This breaks in ${version}: ${lowerFirst(change.summary)}`;
}

function lowerFirst(text: string): string {
  return text ? `${text[0]!.toLocaleLowerCase()}${text.slice(1)}` : text;
}

function evidenceUrl(change: BreakingChange, plan: RemediationPlan): string | undefined {
  for (const id of change.citations) {
    const evidence = plan.evidence.find((e) => e.id === id);
    if (evidence?.url) return evidence.url;
  }
  return undefined;
}

function rangeForSite(uri: vscode.Uri, site: ImpactSite): vscode.Range {
  const line = Math.max(0, site.line - 1);
  const sourceLine = sourceLineAt(uri, line) ?? site.excerpt;
  const symbolColumn = sourceLine.indexOf(site.matchedSymbol);

  if (symbolColumn >= 0) {
    return new vscode.Range(line, symbolColumn, line, symbolColumn + site.matchedSymbol.length);
  }

  const excerpt = site.excerpt.trim();
  const excerptColumn = excerpt ? sourceLine.indexOf(excerpt) : -1;
  if (excerptColumn >= 0) {
    return new vscode.Range(line, excerptColumn, line, excerptColumn + excerpt.length);
  }

  const start = sourceLine.search(/\S/);
  const from = start >= 0 ? start : 0;
  const to = Math.max(from + 1, sourceLine.length);
  return new vscode.Range(line, from, line, to);
}

function sourceLineAt(uri: vscode.Uri, line: number): string | undefined {
  const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
  if (open && line < open.lineCount) return open.lineAt(line).text;

  try {
    return readFileSync(uri.fsPath, 'utf8').split(/\r?\n/)[line];
  } catch {
    return undefined;
  }
}

function isPendingUpgradePlan(plan: RemediationPlan, state: DriftState): boolean {
  if (state.status.kind !== 'findings') return false;
  return state.candidates.some((candidate) => {
    if (candidate.current === candidate.selected) return false;
    if (candidate.plan?.id === plan.id) return true;
    return plan.changes.some(
      (change) =>
        change.name === candidate.name &&
        change.from === candidate.current &&
        change.to === candidate.selected,
    );
  });
}

function keyFor(uri: vscode.Uri, range: vscode.Range, changeId: string): string {
  return `${uri.toString()}|${range.start.line}|${changeId}`;
}

/**
 * Lightbulb actions on a flagged line.
 *
 * Offers the targeted fix first (just this commit), then the broader one, then
 * the explanation. Ordering matters: the narrowest action is the one most
 * likely to be wanted and the least likely to surprise.
 */
export class DriftCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  constructor(
    private readonly state: DriftState,
    private readonly diagnostics: DriftDiagnostics,
    private readonly review?: DriftReview,
  ) {}

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const plan = this.state.plan;
    const reviewActions = this.reviewActions(document, _range);
    if (!plan) return reviewActions;

    const driftDiagnostics = context.diagnostics.filter((d) => d.source === SOURCE);
    if (driftDiagnostics.length === 0) return reviewActions;

    const actions: vscode.CodeAction[] = [...reviewActions];
    const seenCommits = new Set<number>();

    for (const diagnostic of driftDiagnostics) {
      const change = this.diagnostics.changeFor(document.uri, diagnostic);
      if (!change) continue;

      const commit = plan.commits.find((c) => c.breakingChangeIds.includes(change.id));

      if (commit && !seenCommits.has(commit.order)) {
        seenCommits.add(commit.order);

        const fix = new vscode.CodeAction(
          `Drift: fix "${truncate(commit.message, 50)}"`,
          vscode.CodeActionKind.QuickFix,
        );
        fix.command = {
          command: 'drift.fixCommit',
          title: 'Fix with Drift',
          arguments: [commit.order],
        };
        fix.diagnostics = [diagnostic];
        fix.isPreferred = true;
        actions.push(fix);
      }

      const explain = new vscode.CodeAction(
        'Drift: why is this flagged?',
        vscode.CodeActionKind.QuickFix,
      );
      explain.command = {
        command: 'drift.explainChange',
        title: 'Explain',
        arguments: [change.id],
      };
      explain.diagnostics = [diagnostic];
      actions.push(explain);

      const mute = new vscode.CodeAction(
        'Drift: hide editor flags',
        vscode.CodeActionKind.QuickFix,
      );
      mute.command = {
        command: 'drift.disableEditorSignals',
        title: 'Hide Drift editor flags',
      };
      mute.diagnostics = [diagnostic];
      actions.push(mute);
    }

    if (actions.length > 0) {
      const all = new vscode.CodeAction('Drift: upgrade and fix everything', vscode.CodeActionKind.QuickFix);
      all.command = { command: 'drift.fixAll', title: 'Upgrade and fix all' };
      actions.push(all);
    }

    return actions;
  }

  private reviewActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] {
    const found = this.review?.fileFor(document.uri);
    if (!found) return [];

    const actions: vscode.CodeAction[] = [];
    const touched = found.file.hunks.filter((hunk) => rangeTouchesHunk(range, hunk.start, hunk.end));
    const hunks = touched.length > 0 ? touched : found.file.hunks;

    for (const hunk of hunks) {
      const keep = new vscode.CodeAction('Drift: keep this change', vscode.CodeActionKind.QuickFix);
      keep.command = {
        command: 'drift.keepHunk',
        title: 'Keep change',
        arguments: [found.file.path, hunk.id],
      };
      keep.isPreferred = true;
      actions.push(keep);

      const undo = new vscode.CodeAction('Drift: undo this change', vscode.CodeActionKind.QuickFix);
      undo.command = {
        command: 'drift.undoHunk',
        title: 'Undo change',
        arguments: [found.file.path, hunk.id],
      };
      actions.push(undo);
    }

    const keepFile = new vscode.CodeAction('Drift: keep file', vscode.CodeActionKind.QuickFix);
    keepFile.command = { command: 'drift.keepFile', title: 'Keep file', arguments: [found.file.path] };
    actions.push(keepFile);

    const undoFile = new vscode.CodeAction('Drift: undo file', vscode.CodeActionKind.QuickFix);
    undoFile.command = { command: 'drift.undoFile', title: 'Undo file', arguments: [found.file.path] };
    actions.push(undoFile);

    return actions;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function rangeTouchesHunk(range: vscode.Range | vscode.Selection, start: number, end: number): boolean {
  const last = Math.max(start, end - 1);
  return range.end.line >= start && range.start.line <= last;
}
