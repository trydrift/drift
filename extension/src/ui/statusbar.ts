import * as vscode from 'vscode';
import { describeStatus, type DriftState } from '../state.js';

/**
 * Status bar entry.
 *
 * Ambient, never demanding. It turns amber when there is something to look at
 * and stays quiet otherwise — a persistent red badge for a routine dependency
 * bump would be noise, and noise gets ignored.
 */
export class DriftStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  /** Shown only with more than one open root — which one every command acts on. */
  private readonly rootItem: vscode.StatusBarItem;

  constructor(private readonly state: DriftState) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.item.name = 'Drift';
    this.rootItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
    this.rootItem.name = 'Drift: Repository';
    this.rootItem.command = 'drift.switchRepo';
    state.onDidChange(() => this.render());
    this.render();
  }

  private render(): void {
    const status = this.state.status;

    this.item.text = `$(${iconFor(status.kind)}) ${describeStatus(status)}`;
    this.item.tooltip = tooltipFor(this.state);
    this.item.command = commandFor(status.kind);

    // Only code in *this* repository earns a colour. Upstream breaking changes
    // nobody here calls are information, not an alert, and colouring them is how
    // a tool trains people to dismiss it.
    const affected = status.kind === 'findings' && status.plan.impactSites.length > 0;
    this.item.backgroundColor = affected
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : status.kind === 'error'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : undefined;

    if (status.kind === 'no-repo') this.item.hide();
    else this.item.show();

    // A single-folder window has nothing to disambiguate — showing a picker
    // that always offers exactly one, unchanging choice would be a control
    // that does nothing, which is worse than no control.
    const roots = this.state.roots;
    if (roots.length > 1) {
      const active = this.state.activeRoot;
      this.rootItem.text = `$(repo) ${active?.label ?? 'choose a repository'}`;
      this.rootItem.tooltip = `Drift is scoped to ${active?.label ?? 'no repository'}. ${roots.length} repositories are open — click to switch.`;
      this.rootItem.show();
    } else {
      this.rootItem.hide();
    }
  }

  dispose(): void {
    this.item.dispose();
    this.rootItem.dispose();
  }
}

function iconFor(kind: string): string {
  switch (kind) {
    case 'analysing':
    case 'fixing':
      return 'loading~spin';
    case 'reviewing':
      return 'git-pull-request';
    case 'findings':
      return 'warning';
    case 'clean':
      return 'pass';
    case 'fixed':
      return 'git-commit';
    case 'delegated':
      return 'github';
    case 'error':
      return 'error';
    default:
      return 'package';
  }
}

function commandFor(kind: string): string {
  switch (kind) {
    case 'reviewing':
      return 'drift.reviewChanges';
    case 'findings':
    case 'fixed':
    case 'delegated':
      return 'drift.showReport';
    case 'error':
      return 'drift.showLog';
    default:
      return 'drift.analyze';
  }
}

function tooltipFor(state: DriftState): vscode.MarkdownString {
  const status = state.status;
  const lines: string[] = ['**Drift**', ''];

  switch (status.kind) {
    case 'findings': {
      const plan = status.plan;
      const files = new Set(plan.impactSites.map((s) => s.file)).size;
      lines.push(
        files > 0
          ? `${plan.breakingChanges.length} breaking change(s), affecting ${files} file(s) here.`
          : `${plan.breakingChanges.length} breaking change(s) upstream. None of them touch this repository.`,
      );
      lines.push('');
      for (const change of plan.breakingChanges.slice(0, 5)) {
        lines.push(`- ${change.summary}`);
      }
      lines.push('', '_Click to open the report._');
      break;
    }
    case 'reviewing':
      lines.push(
        `${status.files} file(s) changed on \`${status.branch}\` and waiting for you to keep or undo them.`,
        '',
        '_Nothing has been committed._',
      );
      break;
    case 'clean':
      lines.push(status.summary);
      if (status.plan?.changes.length) {
        lines.push('', `Checked ${status.plan.changes.length} dependency change(s).`);
        for (const change of status.plan.changes.slice(0, 5)) {
          lines.push(`- ${change.name}: ${change.from ?? '—'} → ${change.to ?? '—'}`);
        }
      }
      lines.push('', '_Click to re-analyse._');
      break;
    case 'fixed':
      lines.push(`${status.commits} commit(s) on \`${status.branch}\`.`, '', '_Click to open the report._');
      break;
    case 'error':
      lines.push(status.message);
      break;
    default:
      lines.push('_Click to check for breaking dependency changes._');
  }

  const md = new vscode.MarkdownString(lines.join('\n'));
  md.isTrusted = true;
  return md;
}
