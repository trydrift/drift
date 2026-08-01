import * as vscode from 'vscode';
import { join } from 'node:path';
import type { CommitUnit, RemediationPlan } from '../../src/types.js';
import { Git } from './git.js';
import { diffHunks, statOf, type Hunk } from './diff.js';
import type { DriftState } from './state.js';
import {
  readEffort,
  type SessionBranchMode,
  type SessionCommitMode,
  type SessionEffort,
  type SessionPermission,
  type TaskActivityInput,
} from './session.js';
import { activityFromReport } from './agent-activity.js';
import type { DriftReview } from './review/store.js';
import { resolveAgent, type RegistryContext } from './agents/registry.js';
import type { AttachedContext, FixAgent, FixOutcome, FixTask } from './agents/types.js';

/**
 * The fix flow.
 *
 * One commit unit at a time, in the order the planner chose, each committed
 * separately and scoped to its own files. That scoping is what makes the
 * separation real: if an agent also touched something unrelated, it does not
 * get swept into this commit.
 *
 * Safety properties, in order of how much they matter:
 *   - Never runs on a dirty tree without the user's explicit say-so.
 *   - Works on a new branch, never the one you were on.
 *   - Applies edits through the workspace API, so everything lands in undo.
 *   - Nothing is committed until a human keeps it, unless they asked for that.
 *   - Commits only the files the plan named.
 *   - Never pushes, never merges. Leaving is `git checkout -`.
 */

export interface FixOptions {
  state: DriftState;
  plan: RemediationPlan;
  /** Restrict to a single commit unit; otherwise all of them. */
  onlyCommit?: number;
  progress: vscode.Progress<{ message?: string; increment?: number }>;
  token: vscode.CancellationToken;
  /** Holds edits for keep/undo review. Without it, edits commit immediately. */
  review?: DriftReview;
  /** How much the agent may do unsupervised. Defaults to `auto-edit`. */
  permission?: SessionPermission;
  /**
   * Whether to branch first. Defaults to `new`.
   *
   * `current` is the developer explicitly taking the safety net down, so it is
   * never inferred — an absent value means branch.
   */
  branchMode?: SessionBranchMode;
  /** Whether Drift may write git history unattended. Defaults to `approve`. */
  commitMode?: SessionCommitMode;
  /**
   * The project's own check output, grouped and counted, for the agent.
   *
   * Measured evidence rather than predicted, so it is passed straight through
   * to every commit unit — a compiler error in one file is often explained by
   * the change another unit is about.
   */
  diagnostics?: string;
  /** Puts a question to the developer in the panel thread. */
  ask?: (question: string, options?: string[]) => Promise<string>;
  /** Files, folders or selections the developer attached as reference material. */
  context?: AttachedContext[];
  /** Mirrors agent chatter into the panel thread. */
  onLog?: (message: string) => void;
  /** Mirrors structured work into the panel's per-commit activity drawer. */
  onActivity?: (commit: CommitUnit, activity: TaskActivityInput) => void;
  /**
   * Called as each commit unit is picked up and put down.
   *
   * This is what lets the panel show a checklist rather than a transcript: the
   * caller knows exactly which concern is in progress, and which files actually
   * changed when it finished — including "none", which is a real answer and not
   * a failure.
   */
  onCommitStart?: (commit: CommitUnit) => void;
  onCommitEnd?: (
    commit: CommitUnit,
    outcome: 'done' | 'unchanged' | 'skipped' | 'failed',
    changedFiles: readonly string[],
  ) => void;
}

export interface FixResult {
  status: 'committed' | 'proposed' | 'delegated' | 'nothing' | 'failed' | 'cancelled';
  branch?: string;
  commits: number;
  /** Files waiting for keep/undo, when the result is `proposed`. */
  pendingFiles?: number;
  url?: string;
  warnings: string[];
  message: string;
}

export async function runFix(options: FixOptions): Promise<FixResult> {
  const { state, plan, progress, token, review } = options;
  const permission: SessionPermission = options.permission ?? 'auto-edit';
  const commitMode: SessionCommitMode = options.commitMode ?? 'approve';

  const root = state.workspaceRoot;
  const repo = state.repo;
  if (!root || !repo) {
    return fail('No git repository is open.');
  }

  const git = new Git(root);

  const registryContext: RegistryContext = { slug: repo.slug, baseBranch: repo.branch };
  const resolved = await resolveAgent(registryContext);

  if (!resolved) {
    return fail(
      'No AI agent is available. Install one (Copilot, Claude Code, Codex, Gemini, or Ollama) and run "Drift: Select AI Agent".',
    );
  }

  const { agent, fellBackFrom } = resolved;
  if (fellBackFrom) {
    void vscode.window.showWarningMessage(
      `Drift: "${fellBackFrom}" is not available right now, using ${agent.label} instead.`,
    );
  }

  // The cloud agent does the whole plan on GitHub in one session; branching
  // and committing locally would conflict with what it does remotely.
  if (agent.kind === 'cloud') {
    return runCloudAgent(agent, plan, state, progress, token);
  }

  const guard = await ensureCleanTree(git, options.ask);
  if (!guard.ok) return fail(guard.message);

  const commits = options.onlyCommit
    ? plan.commits.filter((c) => c.order === options.onlyCommit)
    : plan.commits;

  if (commits.length === 0) return { ...empty(), message: 'Nothing to fix.' };

  const startRef = await git.headSha();

  // Where the work happens, and the one decision here that is hard to take
  // back. Branching is the default because it makes everything downstream
  // cheap to undo; staying put is only ever done because the developer said so.
  const branchMode: SessionBranchMode = options.branchMode ?? 'new';
  const workingBranch = branchMode === 'new' ? plan.branchName : await git.currentBranch();

  if (branchMode === 'new') {
    const branchResult = await git.createBranch(plan.branchName);
    progress.report({
      message: branchResult.created
        ? `Created branch ${plan.branchName}`
        : `Switched to existing branch ${plan.branchName}`,
    });
  } else {
    progress.report({ message: `Working on ${workingBranch}` });
  }

  const warnings: string[] = [];
  let committed = 0;
  let pendingFiles = 0;
  const step = 100 / commits.length;

  if (review) review.begin(root);

  for (const commit of commits) {
    if (token.isCancellationRequested) {
      return { status: 'cancelled', branch: workingBranch, commits: committed, warnings, message: 'Cancelled.' };
    }

    state.set({
      kind: 'fixing',
      plan,
      commitOrder: commit.order,
      detail: commit.message,
    });
    progress.report({ message: `(${commit.order}/${plan.commits.length}) ${commit.message}` });

    // Asking before touching anything is the point of `ask` mode: at this
    // moment nothing has been written, so declining costs nothing.
    if (permission === 'ask' && options.ask) {
      const answer = await options.ask(
        `Let ${agent.label} edit ${commit.files.length} file${commit.files.length === 1 ? '' : 's'} for "${commit.message}"?`,
        ['Yes, go ahead', 'Skip this one', 'Stop'],
      );
      if (/^stop/i.test(answer)) {
        return {
          status: 'cancelled',
          branch: workingBranch,
          commits: committed,
          pendingFiles,
          warnings,
          message: 'Stopped before editing anything else.',
        };
      }
      if (/^skip/i.test(answer)) {
        warnings.push(`Skipped commit ${commit.order} ("${commit.message}") at your request.`);
        options.onCommitEnd?.(commit, 'skipped', []);
        progress.report({ increment: step });
        continue;
      }
    }

    options.onCommitStart?.(commit);
    options.onActivity?.(commit, {
      kind: 'status',
      title: 'Scope files',
      detail: `${commit.files.length} planned file${commit.files.length === 1 ? '' : 's'}`,
      output: commit.files.join('\n'),
    });

    const before = await readFiles(root, commit.files);
    options.onActivity?.(commit, {
      kind: 'status',
      title: 'Read workspace snapshot',
      detail: `${before.length} file${before.length === 1 ? '' : 's'} available`,
      output: before.map((file) => `${file.path} (${file.content.split('\n').length} lines)`).join('\n'),
    });
    review?.snapshot(
      { order: commit.order, title: commit.message, body: commit.body },
      before,
    );

    const outcome = await applyOneCommit({
      agent,
      plan,
      commit,
      root,
      token,
      progress,
      files: before,
      ask: options.ask,
      onLog: options.onLog,
      onActivity: (activity) => options.onActivity?.(commit, activity),
      context: options.context,
      // The composer's two choices, carried through to whatever backend can act
      // on them. An agent that ignores either is no worse off for being told.
      model: driftConfig().get<Record<string, string>>('agent.models', {})?.[agent.id],
      effort: readEffort(agent.id),
      fast: Boolean(driftConfig().get<Record<string, boolean>>('agent.fast', {})?.[agent.id]),
      diagnostics: options.diagnostics,
    });

    if (outcome.warnings?.length) warnings.push(...outcome.warnings);
    options.onActivity?.(commit, {
      kind: outcome.status === 'failed' ? 'status' : 'thinking',
      title: outcome.status === 'failed' ? 'Agent failed' : 'Agent result',
      detail: outcome.message,
    });

    if (outcome.status === 'failed') {
      options.onCommitEnd?.(commit, 'failed', []);
      return {
        status: 'failed',
        branch: workingBranch,
        commits: committed,
        pendingFiles,
        warnings,
        message: `Commit ${commit.order} failed: ${outcome.message}`,
      };
    }

    if (outcome.status !== 'applied') {
      options.onCommitEnd?.(commit, 'unchanged', []);
      progress.report({ increment: step });
      continue;
    }

    const after = await readFiles(root, commit.files);
    for (const activity of diffActivities(before, after)) {
      options.onActivity?.(commit, activity);
    }

    // With a review store, edits stay uncommitted until a human keeps them, and
    // the store's commit handler does the commit at that point. Without one —
    // or when the developer has asked for auto-commit — commit here.
    //
    // `full-auto` still implies auto-commit so an existing setting keeps
    // behaving the way it did, but the git picker's own switch is what a
    // developer reaches for now: "the agent may edit unattended" and "Drift may
    // write my history unattended" are separate permissions, and only ever
    // having the first meant the second came along silently.
    const autoCommit = commitMode === 'auto' || permission === 'full-auto';
    if (review && !autoCommit) {
      const settled = await review.settle(commit.order);
      const files = settled?.files.length ?? 0;
      pendingFiles += files;
      options.onActivity?.(commit, {
        kind: 'status',
        title: 'Ready for review',
        detail: `${files} changed file${files === 1 ? '' : 's'}`,
      });
      if (files === 0) {
        warnings.push(`Commit ${commit.order} ("${commit.message}") produced no changes.`);
      }
      options.onCommitEnd?.(
        commit,
        files === 0 ? 'unchanged' : 'done',
        settled?.files.map((file) => file.path) ?? [],
      );
      progress.report({ increment: step, message: `${files} file(s) ready for review` });
      continue;
    }

    const sha = await git.commitPaths(commit.files, commit.message, commit.body);
    if (sha) {
      committed += 1;
      options.onActivity?.(commit, {
        kind: 'bash',
        title: 'Commit',
        detail: commit.message,
        input: `git add ${commit.files.join(' ')}\ngit commit -m ${commit.message}`,
        output: sha,
      });
      options.onCommitEnd?.(commit, 'done', commit.files);
      progress.report({ increment: step, message: `Committed ${sha.slice(0, 7)}` });
    } else {
      // The agent ran but produced nothing inside this commit's scope.
      warnings.push(`Commit ${commit.order} ("${commit.message}") produced no changes.`);
      options.onCommitEnd?.(commit, 'unchanged', []);
      progress.report({ increment: step });
    }
  }

  if (committed === 0 && pendingFiles === 0) {
    // Leave the user where they started rather than on an empty branch.
    await git.checkout(repo.branch).catch(() => undefined);
    return {
      status: 'nothing',
      commits: 0,
      warnings,
      message: `${agent.label} made no changes. You are back on ${repo.branch}.`,
    };
  }

  if (pendingFiles > 0) {
    state.set({ kind: 'reviewing', plan, branch: workingBranch, files: pendingFiles, warnings });
    return {
      status: 'proposed',
      branch: workingBranch,
      commits: committed,
      pendingFiles,
      warnings,
      message: `${agent.label} changed ${pendingFiles} file${pendingFiles === 1 ? '' : 's'} on ${workingBranch}. Nothing is committed — keep or undo each change.`,
    };
  }

  state.set({ kind: 'fixed', plan, branch: workingBranch, commits: committed, warnings });

  return {
    status: 'committed',
    branch: workingBranch,
    commits: committed,
    warnings,
    message: `${committed} commit(s) on ${workingBranch}. Review with: git diff ${startRef.slice(0, 7)}`,
  };
}

async function applyOneCommit(args: {
  agent: FixAgent;
  plan: RemediationPlan;
  commit: CommitUnit;
  root: string;
  token: vscode.CancellationToken;
  progress: vscode.Progress<{ message?: string }>;
  files: { path: string; content: string }[];
  ask?: (question: string, options?: string[]) => Promise<string>;
  onLog?: (message: string) => void;
  onActivity?: (activity: TaskActivityInput) => void;
  context?: AttachedContext[];
  model?: string;
  effort?: SessionEffort;
  fast?: boolean;
  diagnostics?: string;
}): Promise<FixOutcome> {
  const { agent, plan, commit, root, token, progress, files } = args;

  const controller = new AbortController();
  const cancelSub = token.onCancellationRequested(() => controller.abort());

  const task: FixTask = {
    plan,
    commit,
    workspaceRoot: root,
    files,
    customInstructions: plan.commits.length
      ? vscode.workspace.getConfiguration('drift').get<string>('fix.customInstructions', '')
      : '',
    context: args.context,
    model: args.model,
    effort: args.effort,
    fast: args.fast,
    diagnostics: args.diagnostics,
  };

  try {
    const outcome = await agent.run(task, {
      report: (message) => {
        progress.report({ message: `${commit.order}: ${message}` });
        args.onLog?.(message);
        args.onActivity?.(activityFromReport(message));
      },
      ask: args.ask,
      signal: controller.signal,
    });

    // In-editor agents hand back text; Drift writes it via the workspace API so
    // every change is a normal, undoable editor edit rather than a surprise
    // mutation behind the user's back.
    if (outcome.status === 'applied' && outcome.edits?.length) {
      await applyEdits(root, outcome.edits, commit.files);
    }

    return outcome;
  } finally {
    cancelSub.dispose();
  }
}


function diffActivities(
  before: readonly { path: string; content: string }[],
  after: readonly { path: string; content: string }[],
): TaskActivityInput[] {
  const beforeByPath = new Map(before.map((file) => [file.path, file.content]));
  const out: TaskActivityInput[] = [];

  for (const file of after) {
    const baseline = beforeByPath.get(file.path);
    if (baseline === undefined || baseline === file.content) continue;
    const hunks = diffHunks(baseline, file.content);
    const stat = statOf(hunks);
    out.push({
      kind: 'edit',
      title: 'Edit',
      file: file.path,
      detail: `${signed(stat.added)} ${plural(stat.added, 'line')} added, ${signed(-stat.removed)} ${plural(stat.removed, 'line')} removed`,
      added: stat.added,
      removed: stat.removed,
      lines: previewLines(hunks),
    });
  }

  return out;
}

function previewLines(hunks: readonly Hunk[]): { kind: 'add' | 'del' | 'context'; text: string }[] {
  const lines: { kind: 'add' | 'del' | 'context'; text: string }[] = [];
  for (const hunk of hunks.slice(0, 4)) {
    lines.push({ kind: 'context', text: `@@ -${hunk.baselineStart + 1},${hunk.baselineLines.length} +${hunk.start + 1},${hunk.modifiedLines.length} @@` });
    for (const line of hunk.baselineLines.slice(0, 12)) lines.push({ kind: 'del', text: line });
    for (const line of hunk.modifiedLines.slice(0, 12)) lines.push({ kind: 'add', text: line });
  }
  return lines.slice(0, 80);
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function plural(count: number, word: string): string {
  return `${word}${count === 1 ? '' : 's'}`;
}

async function readFiles(
  root: string,
  paths: readonly string[],
): Promise<{ path: string; content: string }[]> {
  const files: { path: string; content: string }[] = [];

  for (const path of paths) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(join(root, path)));
      files.push({ path, content: Buffer.from(bytes).toString('utf8') });
    } catch {
      // A planned file that no longer exists is not fatal; the agent is told
      // which files are in scope and can work with what is actually there.
    }
  }

  return files;
}

/**
 * Write agent edits into the workspace.
 *
 * Uses `WorkspaceEdit` rather than raw `fs` so the changes are undoable, are
 * visible in open editors immediately, and respect the user's formatting and
 * file-watcher setup.
 *
 * Edits outside the commit's declared scope are refused. An agent wandering
 * into unrelated files is exactly what the commit-scoping is there to prevent,
 * and silently accepting it would make the separation cosmetic.
 */
async function applyEdits(
  root: string,
  edits: readonly { path: string; content: string }[],
  allowedPaths: readonly string[],
): Promise<void> {
  const allowed = new Set(allowedPaths);
  const edit = new vscode.WorkspaceEdit();
  const rejected: string[] = [];

  for (const { path, content } of edits) {
    const normalized = path.replace(/^\.\//, '').replace(/\\/g, '/');

    if (!allowed.has(normalized)) {
      rejected.push(normalized);
      continue;
    }

    const uri = vscode.Uri.file(join(root, normalized));
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      rejected.push(normalized);
      continue;
    }

    const whole = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length),
    );
    edit.replace(uri, whole, content);
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) throw new Error('VS Code refused to apply the edits.');

  await vscode.workspace.saveAll(false);

  if (rejected.length > 0) {
    void vscode.window.showWarningMessage(
      `Drift ignored edits to ${rejected.length} file(s) outside this commit's scope: ${rejected.slice(0, 3).join(', ')}`,
    );
  }
}

async function runCloudAgent(
  agent: FixAgent,
  plan: RemediationPlan,
  state: DriftState,
  progress: vscode.Progress<{ message?: string }>,
  token: vscode.CancellationToken,
): Promise<FixResult> {
  const controller = new AbortController();
  const sub = token.onCancellationRequested(() => controller.abort());

  try {
    const outcome = await agent.run(
      {
        plan,
        commit: plan.commits[0]!,
        workspaceRoot: state.workspaceRoot ?? '',
        files: [],
        customInstructions: vscode.workspace
          .getConfiguration('drift')
          .get<string>('fix.customInstructions', ''),
      },
      { report: (message) => progress.report({ message }), signal: controller.signal },
    );

    if (outcome.status === 'delegated') {
      state.set({ kind: 'delegated', plan, url: outcome.url, message: outcome.message });
      return {
        status: 'delegated',
        commits: 0,
        url: outcome.url,
        warnings: outcome.warnings ?? [],
        message: outcome.message,
      };
    }

    return fail(outcome.message);
  } finally {
    sub.dispose();
  }
}

/**
 * Refuse to start on a dirty tree unless the user says otherwise.
 *
 * Mixing an agent's edits with work in progress makes the result impossible to
 * review and hard to undo. Asking costs one click; getting this wrong costs
 * someone their afternoon.
 */
async function ensureCleanTree(
  git: Git,
  ask?: (question: string, options?: string[]) => Promise<string>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const dirty = await git.dirtyFiles();
  if (dirty.length === 0) return { ok: true };

  // In the panel, asking in the thread beats a modal: the developer can see the
  // file list Drift is worried about while they decide.
  if (ask) {
    const answer = await ask(
      `You have ${dirty.length} uncommitted change${dirty.length === 1 ? '' : 's'} (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''}). Mixing them with Drift's edits makes the result hard to review.`,
      ['Stash mine and continue', 'Continue anyway', 'Cancel'],
    );
    if (/^stash/i.test(answer)) {
      await git.stash('drift: work in progress before fix');
      return { ok: true };
    }
    if (/^continue/i.test(answer)) return { ok: true };
    return { ok: false, message: 'Cancelled — your working tree was left untouched.' };
  }

  const choice = await vscode.window.showWarningMessage(
    `You have ${dirty.length} uncommitted change(s). Drift's edits would be mixed in with them, which makes the result hard to review.`,
    { modal: true, detail: dirty.slice(0, 10).join('\n') },
    'Stash my changes and continue',
    'Continue anyway',
  );

  if (choice === 'Stash my changes and continue') {
    await git.stash('drift: work in progress before fix');
    return { ok: true };
  }
  if (choice === 'Continue anyway') return { ok: true };

  return { ok: false, message: 'Cancelled — your working tree was left untouched.' };
}

function driftConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('drift');
}

function fail(message: string): FixResult {
  return { status: 'failed', commits: 0, warnings: [], message };
}

function empty(): FixResult {
  return { status: 'nothing', commits: 0, warnings: [], message: '' };
}
