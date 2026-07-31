import * as vscode from 'vscode';
import { basename } from 'node:path';
import type { RemediationPlan } from '../../src/types.js';
import type { LocalRepoInfo } from '../../src/repo/local-git.js';
import type { NestedProject } from '../../src/detect/nested.js';

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

/**
 * One open project Drift can scan — a VS Code workspace folder, or a nested
 * project discovered inside one (an undeclared sub-package, or a directory
 * with its own `.git`). Multiple can be active at once: a multi-root VS Code
 * window, or a repository shaped like this one, with a root manifest and an
 * undeclared subdirectory manifest neither npm nor Drift previously knew were
 * related.
 */
export interface RepoRoot {
  /** Absolute filesystem path. */
  path: string;
  /** Shown in the UI — the folder's own name. */
  label: string;
  repo: LocalRepoInfo | null;
  /** From `Git.repoRoot()` — may differ from `path` if it's a subdirectory of a larger repo. */
  gitRoot: string | null;
  /** Undeclared projects found inside this root, from `discoverNestedProjects()`. */
  subprojects: NestedProject[];
}

export class DriftState {
  private _status: DriftStatus = { kind: 'idle' };
  private _roots: RepoRoot[] = [];
  private _activeRootPath: string | null = null;

  private readonly emitter = new vscode.EventEmitter<DriftStatus>();
  readonly onDidChange = this.emitter.event;

  get status(): DriftStatus {
    return this._status;
  }

  /** Every open root Drift knows about. Empty until the first activation pass. */
  get roots(): readonly RepoRoot[] {
    return this._roots;
  }

  /** The root every single-root command acts on, absent an explicit choice. */
  get activeRoot(): RepoRoot | null {
    const active = this._activeRootPath && this._roots.find((r) => r.path === this._activeRootPath);
    return active || this._roots[0] || null;
  }

  get repo(): LocalRepoInfo | null {
    return this.activeRoot?.repo ?? null;
  }

  get workspaceRoot(): string | null {
    return this.activeRoot?.path ?? null;
  }

  /** The current plan, when one exists in any state that carries one. */
  get plan(): RemediationPlan | null {
    const s = this._status;
    return 'plan' in s ? (s.plan ?? null) : null;
  }

  get isBusy(): boolean {
    return this._status.kind === 'analysing' || this._status.kind === 'fixing';
  }

  setRoots(roots: readonly RepoRoot[]): void {
    this._roots = [...roots];
    if (this._activeRootPath && !this._roots.some((r) => r.path === this._activeRootPath)) {
      this._activeRootPath = null;
    }
    // Every view renders from this store, so a root list change is as much a
    // reason to redraw as a status change — the status bar's folder label and
    // the panel's scope both depend on it.
    this.emitter.fire(this._status);
  }

  setActiveRoot(path: string): void {
    if (!this._roots.some((r) => r.path === path)) return;
    this._activeRootPath = path;
    this.emitter.fire(this._status);
  }

  /**
   * Update one root's repo info in place, adding it if it isn't tracked yet.
   *
   * Kept for the single-root call sites (`analyze.ts`'s periodic re-detect,
   * for one) that only ever know about one folder at a time — they don't
   * need to reason about every open root just to refresh their own.
   */
  setRepo(repo: LocalRepoInfo | null, workspaceRoot: string | null): void {
    if (!workspaceRoot) return;
    const existing = this._roots.find((r) => r.path === workspaceRoot);
    if (existing) {
      existing.repo = repo;
    } else {
      this._roots = [
        ...this._roots,
        { path: workspaceRoot, label: basename(workspaceRoot), repo, gitRoot: null, subprojects: [] },
      ];
    }
    this._activeRootPath ??= workspaceRoot;
    this.emitter.fire(this._status);
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
