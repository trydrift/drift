import * as vscode from 'vscode';
import { join } from 'node:path';
import type { CommitUnit, RemediationPlan } from '../../src/types.js';
import { Git } from './git.js';
import type { DriftState } from './state.js';
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
}

export interface FixResult {
  status: 'committed' | 'delegated' | 'nothing' | 'failed' | 'cancelled';
  branch?: string;
  commits: number;
  url?: string;
  warnings: string[];
  message: string;
}

export async function runFix(options: FixOptions): Promise<FixResult> {
  const { state, plan, progress, token } = options;

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

  const guard = await ensureCleanTree(git);
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
  const step = 100 / commits.length;

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

    const outcome = await applyOneCommit({ agent, plan, commit, git, root, token, progress });

    if (outcome.warnings?.length) warnings.push(...outcome.warnings);

    if (outcome.status === 'failed') {
      return {
        status: 'failed',
        branch: plan.branchName,
        commits: committed,
        warnings,
        message: `Commit ${commit.order} failed: ${outcome.message}`,
      };
    }

    if (outcome.status === 'applied') {
      const sha = await git.commitPaths(commit.files, commit.message, commit.body);
      if (sha) {
        committed += 1;
        progress.report({ increment: step, message: `Committed ${sha.slice(0, 7)}` });
      } else {
        // The agent ran but produced nothing inside this commit's scope.
        warnings.push(`Commit ${commit.order} ("${commit.message}") produced no changes.`);
        progress.report({ increment: step });
      }
    } else {
      progress.report({ increment: step });
    }
  }

  if (committed === 0) {
    // Leave the user where they started rather than on an empty branch.
    await git.checkout(repo.branch).catch(() => undefined);
    return {
      status: 'nothing',
      commits: 0,
      warnings,
      message: `${agent.label} made no changes. You are back on ${repo.branch}.`,
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
  git: Git;
  root: string;
  token: vscode.CancellationToken;
  progress: vscode.Progress<{ message?: string }>;
}): Promise<FixOutcome> {
  const { agent, plan, commit, root, token, progress } = args;

  const files = await readFiles(root, commit.files);

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
      report: (message) => progress.report({ message: `${commit.order}: ${message}` }),
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
async function ensureCleanTree(git: Git): Promise<{ ok: true } | { ok: false; message: string }> {
  const dirty = await git.dirtyFiles();
  if (dirty.length === 0) return { ok: true };

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
