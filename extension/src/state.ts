import * as vscode from 'vscode';
import type { RemediationPlan } from '../../src/types.js';
import type { LocalRepoInfo } from '../../src/repo/local-git.js';

/**
 * Extension state.
 *
 * A single observable store. Every view — the tree, the status bar, the
 * diagnostics, the report — renders from here and re-renders on change, so
 * there is exactly one source of truth about what Drift currently knows.
 */

export type DriftStatus =
  | { kind: 'idle' }
  | { kind: 'no-repo' }
  | { kind: 'analysing'; detail: string }
  | { kind: 'clean'; summary: string; at: number; plan?: RemediationPlan }
  | { kind: 'findings'; plan: RemediationPlan; at: number }
  | { kind: 'fixing'; plan: RemediationPlan; commitOrder: number; detail: string }
  | { kind: 'reviewing'; plan: RemediationPlan; branch: string; files: number; warnings: string[] }
  | { kind: 'fixed'; plan: RemediationPlan; branch: string; commits: number; warnings: string[] }
  | { kind: 'delegated'; plan: RemediationPlan; url?: string; message: string }
  | { kind: 'error'; message: string };

export class DriftState {
  private _status: DriftStatus = { kind: 'idle' };
  private _repo: LocalRepoInfo | null = null;
  private _workspaceRoot: string | null = null;

  private readonly emitter = new vscode.EventEmitter<DriftStatus>();
  readonly onDidChange = this.emitter.event;

  get status(): DriftStatus {
    return this._status;
  }

  get repo(): LocalRepoInfo | null {
    return this._repo;
  }

  get workspaceRoot(): string | null {
    return this._workspaceRoot;
  }

  /** The current plan, when one exists in any state that carries one. */
  get plan(): RemediationPlan | null {
    const s = this._status;
    return 'plan' in s ? (s.plan ?? null) : null;
  }

  get isBusy(): boolean {
    return this._status.kind === 'analysing' || this._status.kind === 'fixing';
  }

  setRepo(repo: LocalRepoInfo | null, workspaceRoot: string | null): void {
    this._repo = repo;
    this._workspaceRoot = workspaceRoot;
  }

  set(status: DriftStatus): void {
    this._status = status;
    this.emitter.fire(status);
    // Drives `when` clauses in package.json so menu items appear and disappear
    // in step with real state rather than being always-on and sometimes broken.
    void vscode.commands.executeCommand('setContext', 'drift.status', status.kind);
    void vscode.commands.executeCommand(
      'setContext',
      'drift.hasFindings',
      status.kind === 'findings' || status.kind === 'fixing',
    );
    // Only true when something in *this* repository is affected; it gates the
    // "fix" affordances, which are meaningless without a local impact site.
    void vscode.commands.executeCommand(
      'setContext',
      'drift.hasImpact',
      'plan' in status ? Boolean(status.plan?.impactSites.length) : false,
    );
    void vscode.commands.executeCommand('setContext', 'drift.reviewing', status.kind === 'reviewing');
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** One-line summary for the status bar. */
export function describeStatus(status: DriftStatus): string {
  switch (status.kind) {
    case 'idle':
      return 'Drift: ready';
    case 'no-repo':
      return 'Drift: no git repository';
    case 'analysing':
      return `Drift: ${status.detail}`;
    case 'clean':
      return status.plan?.changes.length
        ? `Drift: ${status.plan.changes.length} dependency change${status.plan.changes.length === 1 ? '' : 's'} checked`
        : 'Drift: no breaking changes';
    case 'findings': {
      const n = status.plan.breakingChanges.length;
      const files = new Set(status.plan.impactSites.map((s) => s.file)).size;
      // An upstream breaking change that this repository never calls is not
      // something to put a number in front of a developer about.
      if (files === 0) return `Drift: ${n} upstream change${n === 1 ? '' : 's'}, none used here`;
      return `Drift: ${files} file${files === 1 ? '' : 's'} affected`;
    }
    case 'fixing':
      return `Drift: fixing (${status.commitOrder}/${status.plan.commits.length})`;
    case 'reviewing':
      return `Drift: ${status.files} file${status.files === 1 ? '' : 's'} to review`;
    case 'fixed':
      return `Drift: ${status.commits} commit${status.commits === 1 ? '' : 's'} on ${status.branch}`;
    case 'delegated':
      return 'Drift: running on GitHub';
    case 'error':
      return 'Drift: error';
  }
}
