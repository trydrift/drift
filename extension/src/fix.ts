import * as vscode from 'vscode';
import { join } from 'node:path';
import type { CommitUnit, RemediationPlan } from '../../src/types.js';
import { Git } from './git.js';
import type { DriftState } from './state.js';
import type { SessionPermission } from './session.js';
import type { DriftReview } from './review/store.js';
import { resolveAgent, type RegistryContext } from './agents/registry.js';
import type { FixAgent, FixOutcome, FixTask } from './agents/types.js';

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
  /** Puts a question to the developer in the panel thread. */
  ask?: (question: string, options?: string[]) => Promise<string>;
  /** Mirrors agent chatter into the panel thread. */
  onLog?: (message: string) => void;
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
  const branchResult = await git.createBranch(plan.branchName);
  progress.report({
    message: branchResult.created
      ? `Created branch ${plan.branchName}`
      : `Switched to existing branch ${plan.branchName}`,
  });

  const warnings: string[] = [];
  let committed = 0;
  let pendingFiles = 0;
  const step = 100 / commits.length;

  if (review) review.begin(root);

  for (const commit of commits) {
    if (token.isCancellationRequested) {
      return { status: 'cancelled', branch: plan.branchName, commits: committed, warnings, message: 'Cancelled.' };
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
          branch: plan.branchName,
          commits: committed,
          pendingFiles,
          warnings,
          message: 'Stopped before editing anything else.',
        };
      }
      if (/^skip/i.test(answer)) {
        warnings.push(`Skipped commit ${commit.order} ("${commit.message}") at your request.`);
        progress.report({ increment: step });
        continue;
      }
    }

    const before = await readFiles(root, commit.files);
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
    });

    if (outcome.warnings?.length) warnings.push(...outcome.warnings);

    if (outcome.status === 'failed') {
      return {
        status: 'failed',
        branch: plan.branchName,
        commits: committed,
        pendingFiles,
        warnings,
        message: `Commit ${commit.order} failed: ${outcome.message}`,
      };
    }

    if (outcome.status !== 'applied') {
      progress.report({ increment: step });
      continue;
    }

    // With a review store, edits stay uncommitted until a human keeps them, and
    // the store's commit handler does the commit at that point. Without one —
    // or in full-auto — commit here, as before.
    if (review && permission !== 'full-auto') {
      const settled = await review.settle(commit.order);
      const files = settled?.files.length ?? 0;
      pendingFiles += files;
      if (files === 0) {
        warnings.push(`Commit ${commit.order} ("${commit.message}") produced no changes.`);
      }
      progress.report({ increment: step, message: `${files} file(s) ready for review` });
      continue;
    }

    const sha = await git.commitPaths(commit.files, commit.message, commit.body);
    if (sha) {
      committed += 1;
      progress.report({ increment: step, message: `Committed ${sha.slice(0, 7)}` });
    } else {
      // The agent ran but produced nothing inside this commit's scope.
      warnings.push(`Commit ${commit.order} ("${commit.message}") produced no changes.`);
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
    state.set({ kind: 'reviewing', plan, branch: plan.branchName, files: pendingFiles, warnings });
    return {
      status: 'proposed',
      branch: plan.branchName,
      commits: committed,
      pendingFiles,
      warnings,
      message: `${agent.label} changed ${pendingFiles} file${pendingFiles === 1 ? '' : 's'} on ${plan.branchName}. Nothing is committed — keep or undo each change.`,
    };
  }

  state.set({ kind: 'fixed', plan, branch: plan.branchName, commits: committed, warnings });

  return {
    status: 'committed',
    branch: plan.branchName,
    commits: committed,
    warnings,
    message: `${committed} commit(s) on ${plan.branchName}. Review with: git diff ${startRef.slice(0, 7)}`,
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
  };

  try {
    const outcome = await agent.run(task, {
      report: (message) => {
        progress.report({ message: `${commit.order}: ${message}` });
        args.onLog?.(message);
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

function fail(message: string): FixResult {
  return { status: 'failed', commits: 0, warnings: [], message };
}

function empty(): FixResult {
  return { status: 'nothing', commits: 0, warnings: [], message: '' };
}
