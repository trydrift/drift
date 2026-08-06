import * as vscode from 'vscode';
import { join } from 'node:path';
import type { CheckOutcome } from '../verify.js';
import {
  acceptInBaseline,
  diffHunks,
  revertInCurrent,
  statOf,
  type FileDiffStat,
  type Hunk,
} from '../diff.js';

/**
 * Pending agent changes, held for review.
 *
 * The rule this enforces: an agent's edits are a *proposal* until a human says
 * otherwise. Drift writes them into the working tree so they can be read in
 * context with real syntax highlighting and real type errors, but it remembers
 * what every file looked like beforehand and refuses to commit anything the
 * developer has not explicitly kept.
 *
 * Changes are grouped by commit unit, because that is the unit the planner
 * reasoned about and the unit that eventually becomes a commit. Within a group
 * a developer can work at whatever altitude they want — keep the whole group,
 * keep one file, or keep a single hunk and undo the rest.
 *
 * Both "keep" and "undo" shrink the diff to nothing, from opposite ends: keep
 * moves the baseline forward onto the new lines, undo moves the file back onto
 * the baseline. Neither leaves a half-state to reason about.
 */

export interface ReviewFile {
  /** Workspace-relative, `/`-separated. */
  path: string;
  /** Contents before the agent ran. */
  baseline: string;
  /** Contents right now. */
  current: string;
  hunks: Hunk[];
  stat: FileDiffStat;
}

export interface ReviewGroup {
  /** Commit unit order from the plan; 0 for changes made outside a plan. */
  order: number;
  /** Commit subject. */
  title: string;
  /** Commit body. */
  body?: string;
  files: ReviewFile[];
  /**
   * Every path snapshotted for this group, kept even after its files are
   * resolved. The commit handler runs *after* the last change is resolved, at
   * which point `files` is empty — so this is what tells it what to commit.
   */
  paths: string[];
  /** Set once this group has been committed. */
  committed?: { sha: string; branch: string };
  /**
   * Set when every hunk was resolved but the commit itself failed.
   *
   * The group is deliberately kept out of `committed` and its accepted edits
   * are left in place rather than dropped, so `retryCommit` has something to
   * act on and the developer does not have to redo the keep/undo decisions
   * that already resolved it.
   */
  commitError?: string;
  /**
   * Results of the project's own checks, run after the agent edited this group.
   *
   * Never gates anything. A reviewer deciding whether to keep an edit is better
   * served by "your test suite fails here" than by Drift withholding the choice.
   */
  checks?: CheckOutcome[];
  /** True while those checks are still running. */
  checking?: boolean;
}

export interface ReviewTotals {
  files: number;
  hunks: number;
  added: number;
  removed: number;
  groups: number;
}

export type CommitHandler = (group: ReviewGroup) => Promise<{ sha: string; branch: string } | null>;

export class DriftReview implements vscode.Disposable {
  private root: string | null = null;
  private readonly order: number[] = [];
  private readonly entries = new Map<number, ReviewGroup>();
  private commitHandler: CommitHandler | null = null;

  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    // A file the developer edits by hand while reviewing is still under review;
    // re-reading it keeps the hunks and CodeLenses honest rather than stale.
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.has(event.document.uri)) void this.refresh(event.document.uri);
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }

  setCommitHandler(handler: CommitHandler | null): void {
    this.commitHandler = handler;
  }

  get workspaceRoot(): string | null {
    return this.root;
  }

  /** Start a fresh review session. Anything previously pending is dropped. */
  begin(root: string): void {
    this.root = root;
    this.order.length = 0;
    this.entries.clear();
    this.emitter.fire();
  }

  get isEmpty(): boolean {
    return this.totals().files === 0;
  }

  groups(): ReviewGroup[] {
    return this.order
      .map((order) => this.entries.get(order))
      .filter((group): group is ReviewGroup => Boolean(group) && group!.files.length > 0);
  }

  group(order: number): ReviewGroup | undefined {
    return this.entries.get(order);
  }

  totals(): ReviewTotals {
    const groups = this.groups();
    let files = 0;
    let hunks = 0;
    let added = 0;
    let removed = 0;

    for (const group of groups) {
      if (group.committed) continue;
      for (const file of group.files) {
        files += 1;
        hunks += file.hunks.length;
        added += file.stat.added;
        removed += file.stat.removed;
      }
    }

    return { files, hunks, added, removed, groups: groups.filter((g) => !g.committed).length };
  }

  /**
   * Record what a set of files looked like before an agent touched them.
   *
   * Called with pre-edit contents, before the agent runs. Snapshotting up front
   * is the only way to get an honest baseline for CLI agents, which edit the
   * working tree themselves and never tell Drift what they replaced.
   */
  snapshot(
    group: { order: number; title: string; body?: string },
    files: readonly { path: string; content: string }[],
  ): void {
    const existing = this.entries.get(group.order);
    if (!existing) {
      this.order.push(group.order);
      this.entries.set(group.order, { ...group, files: [], paths: [] });
    }

    const entry = this.entries.get(group.order)!;
    entry.title = group.title;
    entry.body = group.body;

    for (const file of files) {
      if (!entry.paths.includes(file.path)) entry.paths.push(file.path);
      if (entry.files.some((f) => f.path === file.path)) continue;
      entry.files.push({
        path: file.path,
        baseline: file.content,
        current: file.content,
        hunks: [],
        stat: { added: 0, removed: 0 },
      });
    }
  }

  /**
   * Re-read every snapshotted file in a group and keep only the ones that
   * actually changed. Run this after the agent finishes.
   */
  async settle(order: number): Promise<ReviewGroup | undefined> {
    const entry = this.entries.get(order);
    if (!entry || !this.root) return undefined;

    const kept: ReviewFile[] = [];
    for (const file of entry.files) {
      const current = await this.read(file.path);
      if (current === null) continue;
      const hunks = diffHunks(file.baseline, current);
      if (hunks.length === 0) continue;
      kept.push({ ...file, current, hunks, stat: statOf(hunks) });
    }

    entry.files = kept;
    this.emitter.fire();
    return entry.files.length > 0 ? entry : undefined;
  }

  /**
   * Attach local check results to a group.
   *
   * Deliberately separate from `settle`: verification is slower than diffing,
   * and the review surface must be usable the moment the agent stops rather
   * than after a test suite finishes.
   */
  setChecks(order: number, checks: CheckOutcome[] | null, running = false): void {
    const entry = this.entries.get(order);
    if (!entry) return;
    if (checks) entry.checks = checks;
    else delete entry.checks;
    entry.checking = running;
    this.emitter.fire();
  }

  checksFor(order: number): CheckOutcome[] | undefined {
    return this.entries.get(order)?.checks;
  }

  /** Files under review, for the CodeLens and decoration providers. */
  fileFor(uri: vscode.Uri): { group: ReviewGroup; file: ReviewFile } | null {
    const path = this.relative(uri);
    if (!path) return null;
    for (const group of this.groups()) {
      if (group.committed) continue;
      const file = group.files.find((f) => f.path === path);
      if (file) return { group, file };
    }
    return null;
  }

  has(uri: vscode.Uri): boolean {
    return this.fileFor(uri) !== null;
  }

  baselineOf(uri: vscode.Uri): string | null {
    return this.fileFor(uri)?.file.baseline ?? null;
  }

  /* ---------------------------------------------------------------- */
  /* Keep                                                              */
  /* ---------------------------------------------------------------- */

  async keepHunk(path: string, hunkId: string): Promise<void> {
    const found = this.locate(path);
    if (!found) return;
    const hunk = found.file.hunks.find((h) => h.id === hunkId);
    if (!hunk) return;

    found.file.baseline = acceptInBaseline(found.file.baseline, hunk);
    this.recompute(found.file);
    await this.afterChange(found.group);
  }

  async keepFile(path: string): Promise<void> {
    const found = this.locate(path);
    if (!found) return;
    found.file.baseline = found.file.current;
    this.recompute(found.file);
    await this.afterChange(found.group);
  }

  async keepGroup(order: number): Promise<void> {
    const group = this.entries.get(order);
    if (!group) return;
    for (const file of group.files) {
      file.baseline = file.current;
      this.recompute(file);
    }
    await this.afterChange(group);
  }

  async keepAll(): Promise<void> {
    for (const group of this.groups()) await this.keepGroup(group.order);
  }

  /* ---------------------------------------------------------------- */
  /* Undo                                                              */
  /* ---------------------------------------------------------------- */

  async undoHunk(path: string, hunkId: string): Promise<void> {
    const found = this.locate(path);
    if (!found) return;
    const hunk = found.file.hunks.find((h) => h.id === hunkId);
    if (!hunk) return;

    await this.write(found.file.path, revertInCurrent(found.file.current, hunk));
    await this.reload(found.file);
    await this.afterChange(found.group);
  }

  async undoFile(path: string): Promise<void> {
    const found = this.locate(path);
    if (!found) return;
    await this.write(found.file.path, found.file.baseline);
    await this.reload(found.file);
    await this.afterChange(found.group);
  }

  async undoGroup(order: number): Promise<void> {
    const group = this.entries.get(order);
    if (!group) return;
    for (const file of [...group.files]) {
      await this.write(file.path, file.baseline);
      await this.reload(file);
    }
    await this.afterChange(group);
  }

  async undoAll(): Promise<void> {
    for (const group of this.groups()) await this.undoGroup(group.order);
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * A group with nothing left to review is settled. If every hunk in it was
   * kept rather than undone, the files on disk differ from the baseline Drift
   * started from, and that is exactly what deserves a commit.
   *
   * The resolved files are only cleared from the group once the commit
   * attempt is known to have succeeded, or once we know there was genuinely
   * nothing to commit (the handler returns `null` without throwing — a fully
   * undone group, say). If the handler throws, `group.files` is left exactly
   * as it was: still non-empty, so `groups()` keeps returning the group, and
   * still holding the accepted content, so `retryCommit` can try again
   * without the developer re-doing any keep/undo decisions.
   */
  private async afterChange(group: ReviewGroup): Promise<void> {
    const before = group.files.length;
    const filtered = group.files.filter((file) => file.hunks.length > 0);
    const resolved = filtered.length === 0 && before > 0;

    if (!resolved || group.committed) {
      group.files = filtered;
      this.emitter.fire();
      return;
    }

    if (!this.commitHandler) {
      group.files = filtered;
      this.emitter.fire();
      return;
    }

    await this.attemptCommit(group, filtered);
  }

  /**
   * Try the commit handler and record the outcome on the group.
   *
   * Shared by `afterChange` (the first attempt, right after the last hunk is
   * resolved) and `retryCommit` (any attempt after a failure), so the two
   * paths cannot drift apart on what "succeeded" or "failed" means.
   */
  private async attemptCommit(group: ReviewGroup, onSuccess: ReviewFile[]): Promise<void> {
    delete group.commitError;
    try {
      const committed = await this.commitHandler!(group);
      if (committed) {
        group.committed = committed;
        group.files = onSuccess;
      } else {
        // The handler decided there was nothing to commit — a legitimate
        // outcome (for example every hunk in the group was undone rather than
        // kept), not a failure to retry.
        group.files = onSuccess;
      }
    } catch (err) {
      group.commitError = err instanceof Error ? err.message : String(err);
    }
    this.emitter.fire();
  }

  /**
   * Re-attempt the commit for a group whose last attempt failed.
   *
   * A no-op for a group that is not in that state, so a stray call (a stale
   * button in a webview that has not re-rendered yet) cannot double-commit or
   * clobber a group that resolved through some other path in the meantime.
   */
  async retryCommit(order: number): Promise<void> {
    const group = this.entries.get(order);
    if (!group || group.committed || !group.commitError || !this.commitHandler) return;
    await this.attemptCommit(group, group.files.filter((file) => file.hunks.length > 0));
  }

  private locate(path: string): { group: ReviewGroup; file: ReviewFile } | null {
    for (const group of this.groups()) {
      if (group.committed) continue;
      const file = group.files.find((f) => f.path === path);
      if (file) return { group, file };
    }
    return null;
  }

  private recompute(file: ReviewFile): void {
    file.hunks = diffHunks(file.baseline, file.current);
    file.stat = statOf(file.hunks);
  }

  private async reload(file: ReviewFile): Promise<void> {
    const current = await this.read(file.path);
    file.current = current ?? file.baseline;
    this.recompute(file);
  }

  private async refresh(uri: vscode.Uri): Promise<void> {
    const found = this.fileFor(uri);
    if (!found) return;
    const document = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    found.file.current = document ? document.getText() : ((await this.read(found.file.path)) ?? found.file.current);
    this.recompute(found.file);
    this.emitter.fire();
  }

  private async read(path: string): Promise<string | null> {
    if (!this.root) return null;
    const uri = vscode.Uri.file(join(this.root, path));
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (open) return open.getText();
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return null;
    }
  }

  /**
   * Writes go through `WorkspaceEdit`, never `fs`, so an undo lands in VS Code's
   * own undo stack and in any editor the developer already has open. A revert
   * the editor does not know about is a revert the developer cannot take back.
   */
  private async write(path: string, content: string): Promise<void> {
    if (!this.root) return;
    const uri = vscode.Uri.file(join(this.root, path));
    const document = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
      content,
    );
    await vscode.workspace.applyEdit(edit);
    await document.save();
  }

  private relative(uri: vscode.Uri): string | null {
    if (!this.root) return null;
    const prefix = this.root.endsWith('/') ? this.root : `${this.root}/`;
    const path = uri.fsPath.replace(/\\/g, '/');
    const normalizedPrefix = prefix.replace(/\\/g, '/');
    return path.startsWith(normalizedPrefix) ? path.slice(normalizedPrefix.length) : null;
  }
}
