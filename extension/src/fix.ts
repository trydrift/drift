import * as vscode from 'vscode';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import type { CommitUnit, RemediationPlan } from '../../src/types.js';
import { applyCodemodTransform } from '../../src/codemod/index.js';
import { executeCommunityRecipe } from '../../src/remediation/execute-recipe.js';
import { WORKING_TREE } from '../../src/repo/local-git.js';
import { Git } from './git.js';
import { diffHunks, statOf, type Hunk } from './diff.js';
import { validateAgentWorktree, type ChangedPath } from './scope.js';
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
import { CLEAN_TYPECHECK_MARKER } from './diagnostics-digest.js';
import { taxonomyOf } from '../../src/confidence/taxonomy.js';
import type { DriftReview } from './review/store.js';
import { resolveAgent, type RegistryContext } from './agents/registry.js';
import type {
  AttachedContext,
  FixAgent,
  FixOutcome,
  FixTask,
  RevisionRequest,
} from './agents/types.js';

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
  /**
   * A rejected previous attempt and what the developer said about it.
   *
   * Turns "run it again" into "run it again, differently" — without this the
   * agent sees the identical prompt and reliably produces the identical answer.
   */
  revision?: RevisionRequest;
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
    /**
     * Why, when the answer was "nothing changed".
     *
     * A commit unit that ends `unchanged` is Drift half-retracting a breakage
     * it reported, and a bare "No change needed" gives the developer no way to
     * tell a considered verdict from an agent that gave up. The agent's own
     * explanation is the answer, and it is one line, so it travels with the
     * outcome rather than being left for the reader to dig out of the drawer.
     */
    reason?: string,
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
  /**
   * Why a `failed` result failed, for callers that want to offer something
   * more useful than the message alone. `'stale-plan'` is the only reason a
   * rescan actually resolves — the checkout moved past the commit the plan
   * was analysed against, and re-scanning is the fix.
   */
  reason?: 'stale-plan';
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

  // The plan names the commit it was analysed against. If the active
  // repository has moved on since — most concretely, a multi-root switch
  // that leaves an old plan attached to state (see `DriftState.setActiveRoot`)
  // — applying it here would edit the wrong repository's files under a scope
  // computed for a different tree.
  //
  // `headSha` is only ever a real commit for plans built from a committed
  // range. Plans analysed against uncommitted manifest edits are built
  // against `WORKING_TREE` (see `chooseRange` in analyze.ts) — there is no
  // commit for that state to compare against, so skip the guard rather than
  // rejecting the normal "edit, analyse, fix" flow outright.
  const currentHead = await git.headSha().catch(() => null);
  if (plan.headSha && plan.headSha !== WORKING_TREE && currentHead && plan.headSha !== currentHead) {
    return fail(
      'This plan was analysed against a different commit than what is currently checked out.',
      'stale-plan',
    );
  }

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

  if (!(await git.supportsWorktrees())) {
    return fail('This git installation cannot create disposable worktrees, so Drift will not run a local agent.');
  }

  const guard = await ensureCleanTree(git, options.ask);
  if (!guard.ok) return fail(guard.message);

  const commits = options.onlyCommit
    ? plan.commits.filter((c) => c.order === options.onlyCommit)
    : plan.commits;

  if (commits.length === 0) {
    if (guard.stashed) await git.stashPop().catch(() => undefined);
    return { ...empty(), message: 'Nothing to fix.' };
  }

  const startRef = await git.headSha();

  // What agent worktrees are built from. When the tree was dirty, this is a
  // floating commit of the working tree as it was — including the
  // dependency-upgrade edit an agent needs to see — not `startRef` itself,
  // which is one commit behind that edit whenever it was still uncommitted.
  const worktreeBase = guard.snapshotTree
    ? await git.commitTree(guard.snapshotTree, startRef, 'drift: uncommitted changes at the start of this fix')
    : startRef;

  try {
    return await runFixOnBranch({ options, state, plan, progress, token, review, permission, commitMode, root, repo, git, agent, commits, startRef, worktreeBase });
  } finally {
    if (guard.stashed) {
      try {
        await git.stashPop();
      } catch {
        void vscode.window.showWarningMessage(
          "Drift couldn't restore your stashed changes automatically — they're still in the stash (git stash list) and popping them by hand may need a conflict resolved first.",
        );
      }
    }
  }
}

async function runFixOnBranch(args: {
  options: FixOptions;
  state: DriftState;
  plan: RemediationPlan;
  progress: vscode.Progress<{ message?: string; increment?: number }>;
  token: vscode.CancellationToken;
  review?: DriftReview;
  permission: SessionPermission;
  commitMode: SessionCommitMode;
  root: string;
  repo: NonNullable<DriftState['repo']>;
  git: Git;
  agent: FixAgent;
  commits: readonly CommitUnit[];
  startRef: string;
  worktreeBase: string;
}): Promise<FixResult> {
  const { options, state, plan, progress, token, review, permission, commitMode, root, repo, git, agent, commits: rawCommits, startRef, worktreeBase } = args;

  // A community recipe is only ever run after an explicit choice in this
  // session — the ask-gate below is the only place that choice can happen.
  // Any permission mode that skips asking (`auto-edit`, `full-auto`) must
  // never reach a recipe at all, so it is stripped here rather than trusted
  // to stay unused deeper in the pipeline. `codemod` is unaffected: Drift's
  // own fix remains trusted and available without permission, as before.
  const commits = permission === 'ask' ? rawCommits : rawCommits.map((c) => (c.recipe ? { ...c, recipe: undefined } : c));

  // Where the work happens, and the one decision here that is hard to take
  // back. Branching is the default because it makes everything downstream
  // cheap to undo; staying put is only ever done because the developer said so.
  const branchMode: SessionBranchMode = options.branchMode ?? 'new';
  let workingBranch = branchMode === 'new' ? plan.branchName : await git.currentBranch();

  if (branchMode === 'new') {
    const branchResult = await git.createBranch(plan.branchName);
    workingBranch = branchResult.name;
    progress.report({
      message: branchResult.created
        ? `Created branch ${workingBranch}`
        : `Switched to existing branch ${workingBranch}`,
    });
  } else {
    progress.report({ message: `Working on ${workingBranch}` });
  }

  const warnings: string[] = [];
  let committed = 0;
  let pendingFiles = 0;
  const step = 100 / commits.length;

  if (review) review.begin(root);

  // Advances after every batch so a later batch's worktrees are built from
  // what the previous batch actually produced — committed changes and, when a
  // review is pending, edits already applied to the working tree but not yet
  // committed. Without this, two sequential units that depend on each other
  // (or two that happen to touch the same file across batches) would each
  // start an agent from the state the whole run began in, and the later one
  // could silently overwrite the earlier one's work.
  let base = worktreeBase;

  const selection = {
    // The composer's two choices, carried through to whatever backend can act
    // on them. An agent that ignores either is no worse off for being told.
    model: driftConfig().get<Record<string, string>>('agent.models', {})?.[agent.id],
    effort: readEffort(agent.id),
    fast: Boolean(driftConfig().get<Record<string, boolean>>('agent.fast', {})?.[agent.id]),
  };

  /** Everything that happens before an agent is handed a commit unit. */
  const openCommit = async (commit: CommitUnit): Promise<{ path: string; content: string }[]> => {
    const files = scopeFiles(commit);
    options.onCommitStart?.(commit);
    options.onActivity?.(commit, {
      kind: 'status',
      title: 'Scope files',
      detail: `${files.length} planned file${files.length === 1 ? '' : 's'}`,
      output: files.join('\n'),
    });

    const before = await readFiles(root, files);
    options.onActivity?.(commit, {
      kind: 'read',
      title: 'Read workspace snapshot',
      detail: `${before.length} file${before.length === 1 ? '' : 's'} available`,
      output: before.map((file) => `${file.path} (${file.content.split('\n').length} lines)`).join('\n'),
    });
    review?.snapshot({ order: commit.order, title: commit.message, body: commit.body }, before);

    return before;
  };

  /**
   * Everything that happens once an agent has finished with a commit unit and
   * its edits are in the real working tree.
   *
   * Returns a `FixResult` only when the run must stop; `null` means carry on.
   * Identical for a sequential run and a parallel one — which is the point of
   * pulling it out, because "what happens to a fix after the agent" is exactly
   * the logic that must not fork into two versions that drift apart.
   */
  const closeCommit = async (
    commit: CommitUnit,
    outcome: FixOutcome,
    before: readonly { path: string; content: string }[],
  ): Promise<FixResult | null> => {
    if (outcome.warnings?.length) warnings.push(...outcome.warnings);
    options.onActivity?.(commit, {
      kind: outcome.status === 'failed' ? 'status' : 'thinking',
      title: outcome.status === 'failed' ? 'Agent failed' : 'Agent result',
      detail: outcome.message,
    });

    if (outcome.status === 'failed') {
      options.onCommitEnd?.(commit, 'failed', []);
      // Whatever `state` was last set to inside the loop above — 'fixing',
      // spinning — is stale the moment this run stops. Left alone, that is
      // the bug behind a status bar reading "fixing" forever after a commit
      // actually failed. Pending review files still need attention first;
      // otherwise there is nothing left to review and the plan itself (still
      // unfixed) is the honest thing to show.
      if (pendingFiles > 0) state.set({ kind: 'reviewing', plan, branch: workingBranch, files: pendingFiles, warnings });
      else state.set({ kind: 'findings', plan, at: Date.now() });
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
      options.onCommitEnd?.(commit, 'unchanged', [], outcome.message);
      progress.report({ increment: step });
      return null;
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
        files === 0 ? outcome.message : undefined,
      );
      progress.report({ increment: step, message: `${files} file(s) ready for review` });
      return null;
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
      options.onCommitEnd?.(commit, 'unchanged', [], outcome.message);
      progress.report({ increment: step });
    }

    return null;
  };

  // How many agents this run may put to work at once, and how the plan splits
  // to allow it. One is the default and the sequential path below is exactly
  // what it always was.
  const concurrency = await resolveConcurrency({ git, agent, permission, commits, ask: options.ask });
  const batches = batchCommits(commits, concurrency);

  if (concurrency > 1) {
    const parallel = batches.filter((batch) => batch.length > 1).length;
    if (parallel > 0) {
      progress.report({
        message: `Running up to ${concurrency} agents at once, each in its own worktree`,
      });
    }
  }

  // A cancelled run must leave `state` describing what actually happened,
  // not the last `'fixing'` commit it was on when the token fired — that
  // stale status is what left the status bar reading "Drift: fixing" long
  // after the run had stopped.
  const settleCancelled = (message: string): FixResult => {
    if (pendingFiles > 0) state.set({ kind: 'reviewing', plan, branch: workingBranch, files: pendingFiles, warnings });
    else state.set({ kind: 'findings', plan, at: Date.now() });
    return { status: 'cancelled', branch: workingBranch, commits: committed, pendingFiles, warnings, message };
  };

  for (const batch of batches) {
    if (token.isCancellationRequested) {
      return settleCancelled('Cancelled.');
    }

    /* ---- One commit unit, isolated in a disposable worktree ---------- */
    if (batch.length === 1) {
      let commit = batch[0]!;

      state.set({ kind: 'fixing', plan, commitOrder: commit.order, detail: commit.message });
      progress.report({ message: `(${commit.order}/${plan.commits.length}) ${commit.message}` });

      const cleared = clearedByCompiler(commit, plan, options.diagnostics);
      if (cleared) {
        options.onActivity?.(commit, { kind: 'status', title: 'Already compatible', detail: cleared });
        options.onCommitEnd?.(commit, 'unchanged', [], cleared);
        progress.report({ increment: step });
        continue;
      }

      // Asking before touching anything is the point of `ask` mode: at this
      // moment nothing has been written, so declining costs nothing.
      if (permission === 'ask' && options.ask) {
        const recipe = !commit.codemod ? commit.recipe?.[0] : undefined;
        const answer = commit.codemod
          ? await options.ask(
              `Drift found a deterministic fix for "${commit.message}" (${renameSummary(commit.codemod)}, ` +
                `${commit.files.length} file${commit.files.length === 1 ? '' : 's'}). Apply it directly, or use ` +
                `${agent.label} instead?`,
              ['Apply deterministic fix', `Use ${agent.label} instead`, 'Skip this one', 'Stop'],
            )
          : recipe
            ? await options.ask(
                `A community-maintained recipe is available for "${commit.message}": ` +
                  `${recipeSummary(commit.recipe!)} from ${recipe.publisher}. Use community recipe, or continue with ${agent.label}?`,
                ['Use community recipe', `Continue with ${agent.label}`, 'Skip this one', 'Stop'],
              )
            : await options.ask(
                `Let ${agent.label} edit ${commit.files.length} file${commit.files.length === 1 ? '' : 's'} for "${commit.message}"?`,
                ['Yes, go ahead', 'Skip this one', 'Stop'],
              );
        if (/^stop/i.test(answer)) {
          return settleCancelled('Stopped before editing anything else.');
        }
        if (/^skip/i.test(answer)) {
          warnings.push(`Skipped commit ${commit.order} ("${commit.message}") at your request.`);
          options.onCommitEnd?.(commit, 'skipped', []);
          progress.report({ increment: step });
          continue;
        }
        // The user chose the agent over an available deterministic fix or
        // community recipe — drop `codemod`/`recipe` so downstream code takes
        // the ordinary agent path instead of silently re-applying the fix or
        // recipe it was just declined. "Use community recipe" is the one
        // answer that keeps the offer as-is.
        if (answer === `Use ${agent.label} instead` || answer === `Continue with ${agent.label}`) {
          commit = { ...commit, codemod: undefined, recipe: undefined };
        }
      }

      const [entry] = await runBatchInWorktrees({
        git,
        agent,
        plan,
        batch: [commit],
        root,
        base,
        token,
        progress,
        openCommit,
        onLog: options.onLog,
        onActivity: options.onActivity,
        context: options.context,
        selection,
        diagnostics: options.diagnostics,
        ask: options.ask,
        ...(options.revision ? { revision: options.revision } : {}),
      });

      if (!entry) continue;
      if (entry.edits.length > 0) {
        await applyEdits(root, entry.edits, scopeFiles(entry.commit));
      }
      const stop = await closeCommit(entry.commit, entry.outcome, entry.before);
      if (stop) return stop;
      base = await advanceBase(git, base);
      continue;
    }

    /* ---- Several commit units at once, one worktree each ------------- */
    state.set({ kind: 'fixing', plan, commitOrder: batch[0]!.order, detail: batch[0]!.message });
    progress.report({
      message: `${batch.length} concerns at once: ${batch.map((c) => c.order).join(', ')} of ${plan.commits.length}`,
    });

    const outcomes = await runBatchInWorktrees({
      git,
      agent,
      plan,
      batch,
      root,
      base,
      token,
      progress,
      openCommit,
      onLog: options.onLog,
      onActivity: options.onActivity,
      context: options.context,
      selection,
      diagnostics: options.diagnostics,
      ...(options.revision ? { revision: options.revision } : {}),
    });

    // Reconciled in plan order, never in the order the agents happened to
    // finish. A fix's commits are ordered because their concerns are, and a
    // review queue that reordered itself by which model was quickest would be
    // both arbitrary and different on every run.
    for (const entry of outcomes) {
      if (entry.edits.length > 0) {
        await applyEdits(root, entry.edits, scopeFiles(entry.commit));
      }
      const stop = await closeCommit(entry.commit, entry.outcome, entry.before);
      if (stop) return stop;
    }
    base = await advanceBase(git, base);
  }

  if (committed === 0 && pendingFiles === 0) {
    // Leave the user where they started rather than on an empty branch.
    await git.checkout(repo.branch).catch(() => undefined);
    // Same stale-`fixing`-status bug the failed-commit path above guards
    // against: every commit came back unchanged/skipped rather than failed,
    // but `state` is still sitting on whichever one was active last.
    state.set({ kind: 'findings', plan, at: Date.now() });
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

/* ------------------------------------------------------------------ */
/* Running several agents at once                                       */
/* ------------------------------------------------------------------ */

/**
 * Split a plan into groups that may run at the same time.
 *
 * Two rules, and neither is a heuristic — together they are what makes the
 * result identical to a sequential run:
 *
 *   Disjoint files.  Two agents that never touch the same file cannot disagree
 *                    about that file, so reconciling their output afterwards is
 *                    a merge with no conflicts by construction.
 *   `dependsOn`.     The planner already says which commits must land before
 *                    which. A commit whose prerequisite is still in flight has
 *                    to wait, whatever its file scope looks like.
 *
 * Order is preserved. A commit that conflicts with anything already in the
 * current batch closes it and starts the next rather than being skipped over:
 * the plan orders its commits because their concerns are ordered, and quietly
 * running commit 4 before commit 2 would change what the later agents see.
 *
 * Exported because the batching rule is the whole safety argument for this
 * feature, and an argument that cannot be tested directly is not one.
 */
export function batchCommits(commits: readonly CommitUnit[], limit: number): CommitUnit[][] {
  if (limit <= 1) return commits.map((commit) => [commit]);

  const batches: CommitUnit[][] = [];
  const byLayer = new Map<number, CommitUnit[]>();
  for (const commit of commits) {
    const bucket = byLayer.get(commit.executionLayer);
    if (bucket) bucket.push(commit);
    else byLayer.set(commit.executionLayer, [commit]);
  }

  for (const [, layer] of [...byLayer.entries()].sort(([a], [b]) => a - b)) {
    let current: CommitUnit[] = [];
    let claimed = new Set<string>();

    for (const commit of [...layer].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
      const files = commit.allowedFiles ?? commit.files;
      const conflicts = files.some((file) => claimed.has(file));

      if (current.length > 0 && (conflicts || current.length >= limit)) {
        batches.push(current);
        current = [];
        claimed = new Set();
      }

      current.push(commit);
      for (const file of files) claimed.add(file);
    }

    if (current.length > 0) batches.push(current);
  }

  return batches;
}

/**
 * How many agents this run may actually put to work at once.
 *
 * The setting is a ceiling, not an instruction. Everything below is a reason
 * the ceiling cannot be reached, and each of them is a case where running in
 * parallel would take away something the developer is relying on rather than
 * merely being slower:
 *
 *   `ask` permission   The developer approves each unit before it runs. Three
 *                      approval prompts arriving at once is not that.
 *   cloud agents       The work is not happening locally; there is no tree to
 *                      give it.
 *   no worktree support  Ancient git, or a repository state that will not take
 *                      a second working tree.
 */
async function resolveConcurrency(args: {
  git: Git;
  agent: FixAgent;
  permission: SessionPermission;
  commits: readonly CommitUnit[];
  ask?: (question: string, options?: string[]) => Promise<string>;
}): Promise<number> {
  const configured = driftConfig().get<number>('fix.maxAgents', 1) ?? 1;
  const wanted = Math.max(1, Math.min(16, Math.floor(configured)));

  if (wanted === 1 || args.commits.length < 2) return 1;
  if (args.permission === 'ask') return 1;
  if (args.agent.kind === 'cloud') return 1;
  if (!(await args.git.supportsWorktrees())) return 1;

  return Math.min(wanted, args.commits.length);
}

interface BatchOutcome {
  commit: CommitUnit;
  outcome: FixOutcome;
  before: { path: string; content: string }[];
  /** What to write into the real working tree. Empty when nothing changed. */
  edits: { path: string; content: string | null }[];
}

/**
 * Run a batch of commit units side by side, each in its own worktree.
 *
 * Nothing here writes to the developer's working tree. Each agent gets a
 * private checkout at the same commit, does whatever it does there, and the
 * result comes back as a list of file contents for the caller to apply through
 * the workspace API in plan order — so parallel fixes land in VS Code's undo
 * stack exactly like sequential ones, and the review store sees the same shape
 * of change either way.
 *
 * Worktrees are torn down on every path out, including cancellation and a
 * throwing agent. Leaving one behind would leave a stale entry in
 * `git worktree list` and a directory inside `.git` that nothing cleans up.
 */
async function runBatchInWorktrees(args: {
  git: Git;
  agent: FixAgent;
  plan: RemediationPlan;
  batch: readonly CommitUnit[];
  root: string;
  /**
   * The commit every worktree in this batch is built from.
   *
   * The first batch gets `worktreeBase` from {@link runFix} — either `HEAD`,
   * or, when the tree had uncommitted changes at the start of the fix, a
   * floating commit built from a snapshot of them, so an agent sees the
   * dependency upgrade it is fixing code against even if that upgrade was
   * never committed. Every batch after the first gets a fresh snapshot taken
   * once that batch's edits landed in the real working tree (see
   * `advanceBase`), so later batches see earlier ones' output instead of
   * starting over from the run's original state.
   */
  base: string;
  token: vscode.CancellationToken;
  progress: vscode.Progress<{ message?: string }>;
  openCommit: (commit: CommitUnit) => Promise<{ path: string; content: string }[]>;
  onLog?: (message: string) => void;
  onActivity?: (commit: CommitUnit, activity: TaskActivityInput) => void;
  context?: AttachedContext[];
  selection: { model?: string; effort?: SessionEffort; fast?: boolean };
  diagnostics?: string;
  ask?: (question: string, options?: string[]) => Promise<string>;
  revision?: RevisionRequest;
}): Promise<BatchOutcome[]> {
  const { git, batch, root, base } = args;

  const home = join(await git.gitDir(), 'drift-worktrees');
  await git.pruneWorktrees();

  const trees: { commit: CommitUnit; path: string; before: { path: string; content: string }[] }[] = [];

  try {
    for (const commit of batch) {
      const before = await args.openCommit(commit);
      const path = join(home, `commit-${commit.order}`);

      // A directory left by a killed run would make `worktree add` refuse.
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      await git.addWorktree(path, base);

      args.onActivity?.(commit, {
        kind: 'bash',
        title: 'Isolate',
        detail: `Working alongside ${batch.length - 1} other agent${batch.length === 2 ? '' : 's'}`,
        input: `git worktree add --detach ${path} ${base.slice(0, 7)}`,
      });

      trees.push({ commit, path, before });
    }

    const results = await Promise.all(
      trees.map(async ({ commit, path, before }): Promise<BatchOutcome> => {
        const { outcome } = await applyOneCommit({
          agent: args.agent,
          plan: args.plan,
          commit,
          root: path,
          token: args.token,
          progress: args.progress,
          // Read from the worktree, not the workspace: identical content today,
          // but the agent is going to be told these are the files at `path`,
          // and handing it contents from somewhere else would be a lie waiting
          // to become a bug.
          files: await readFiles(path, scopeFiles(commit)),
          // No `ask` in parallel. The panel has one question slot, and two
          // agents reaching for it at once would strand both. Agents are
          // documented to treat a missing `ask` as "make the safe choice and
          // flag it", which is the right behaviour unattended anyway.
          ask: args.ask,
          onLog: args.onLog,
          onActivity: (activity) => args.onActivity?.(commit, activity),
          context: args.context,
          ...args.selection,
          diagnostics: args.diagnostics,
          ...(args.revision ? { revision: args.revision } : {}),
        });

        if (outcome.status !== 'applied') return { commit, outcome, before, edits: [] };

        const validation = await validateAgentWorktree({
          root: path,
          baselineRef: base,
          commit,
          forbidTestWeakening: true,
        });
        for (const warning of validation.warnings) {
          args.onActivity?.(commit, { kind: 'status', title: 'Review warning', detail: warning });
        }
        if (!validation.ok) {
          return {
            commit,
            before,
            edits: [],
            outcome: {
              status: 'failed',
              message: `Agent output was rejected by scope validation: ${validation.reasons.join(' ')}`,
              warnings: validation.warnings,
            },
          };
        }

        return {
          commit,
          outcome: { ...outcome, warnings: [...(outcome.warnings ?? []), ...validation.warnings] },
          before,
          edits: await editsFromWorktree(path, validation.changed),
        };
      }),
    );

    return results;
  } finally {
    for (const { path } of trees) {
      await git.removeWorktree(path).catch(() => undefined);
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
    await git.pruneWorktrees().catch(() => undefined);
  }
}

/** A short, human-readable list of the renames a codemod would apply, for the confirm prompt. */
/**
 * Whether the project's own compiler has already answered this commit unit.
 *
 * Drift's analysis predicts breakage; a typecheck against the installed
 * upgrade *measures* it. When the two disagree and every change in a unit is
 * one the compiler would have caught, the compiler is right — it read the
 * actual declarations that shipped, while the analysis compared published
 * surfaces and reasoned about what a call site might do with them.
 *
 * Drift was already running that typecheck and already telling the agent to
 * "change nothing you cannot justify". It then dispatched an agent per unit
 * anyway, and each one spent a few thousand tokens rediscovering that the code
 * was fine and came back "No change needed". That is the loop this closes: the
 * question was answered before the agent was asked.
 *
 * Deliberately narrow. A unit is only cleared when the typecheck ran, passed
 * with no errors at all, and *every* change under it is detectable at compile
 * time. A behaviour change — a default that moved, a method that now throws
 * instead of returning null — is invisible to a typecheck, and skipping those
 * on a green compile is how a real break ships. That asymmetry is the whole
 * design: a needless agent run costs tokens, a missed break costs production.
 *
 * Returns the sentence to show the developer, or null to run the agent.
 */
export function clearedByCompiler(
  commit: CommitUnit,
  plan: RemediationPlan,
  diagnostics: string | undefined,
): string | null {
  if (!diagnostics?.includes(CLEAN_TYPECHECK_MARKER)) return null;

  const changes = plan.changes.filter((change) => commit.breakingChangeIds.includes(change.id));
  // No change to reason about is not evidence of safety, it is an absence of
  // evidence, and the agent is the better answer.
  if (changes.length === 0) return null;

  const compileTime = changes.every((change) =>
    taxonomyOf(change).detectability.some((how) => how === 'compile-time' || how === 'link-or-import'),
  );
  if (!compileTime) return null;

  const sites = plan.impactSites.filter((site) => commit.allowedFiles.includes(site.file)).length;
  const symbols = [...new Set(changes.flatMap((change) => change.symbols))].slice(0, 6);
  return (
    'Your typecheck passes against the upgraded version, and every change here' +
    `${symbols.length > 0 ? ` — ${symbols.map((symbol) => `\`${symbol}\``).join(', ')} —` : ''}` +
    ' is one it would have caught.' +
    `${sites > 0 ? ` The ${sites} predicted site${sites === 1 ? '' : 's'} here compile${sites === 1 ? 's' : ''} against the new declarations.` : ''}` +
    ' No agent was run.'
  );
}

function renameSummary(codemod: NonNullable<CommitUnit['codemod']>): string {
  return codemod.map((t) => `\`${t.from}\` → \`${t.to}\``).join(', ');
}

/** A short, human-readable list of the recipe(s) offered for a commit, for the confirm prompt. */
function recipeSummary(recipe: NonNullable<CommitUnit['recipe']>): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const candidate of recipe) {
    const key = `${candidate.name}@${candidate.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(`\`${key}\``);
  }
  return names.join(', ');
}

/**
 * Run a commit's matched community recipe(s) directly against the worktree
 * at `root`. Unlike `applyCommitCodemod`, this writes to disk itself (the
 * recipe tool edits files in place) rather than returning in-memory content
 * — the caller's post-run worktree diff (`editsFromWorktree`, driven by
 * `validateAgentWorktree`) is what turns those writes into reviewable edits,
 * the same path an agent's or a codemod's output already goes through.
 */
export async function applyCommitRecipe(
  commit: CommitUnit,
  root: string,
  run: typeof executeCommunityRecipe = executeCommunityRecipe,
): Promise<FixOutcome> {
  const candidates = commit.recipe ?? [];
  if (candidates.length === 0) {
    return { status: 'no-changes', message: 'No community recipe was available for this commit.' };
  }

  const seen = new Set<string>();
  const messages: string[] = [];
  let applied = false;

  for (const candidate of candidates) {
    const key = `${candidate.provider}:${candidate.name}@${candidate.version}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const result = await run(candidate, root);
    if (result.status === 'failed') return { status: 'failed', message: result.message };
    if (result.status === 'applied') {
      applied = true;
      messages.push(result.message);
    }
  }

  return applied
    ? { status: 'applied', message: messages.join(' ') }
    : { status: 'no-changes', message: 'The community recipe produced no changes here.' };
}

/**
 * Apply a commit's precomputed codemod transforms against the files as they
 * actually exist right now — not the content Drift last saw at analysis
 * time. Re-deriving the edit is what makes this correct after other commits
 * have already landed on the same run, or after any amount of time has
 * passed since the plan was built; see `applyCodemodTransform`'s own doc
 * comment for why replaying a stored snapshot instead would be unsafe.
 */
export function applyCommitCodemod(
  commit: CommitUnit,
  files: readonly { path: string; content: string }[],
): FixOutcome {
  const byPath = new Map(files.map((file) => [file.path, file.content]));

  for (const transform of commit.codemod ?? []) {
    for (const file of transform.files) {
      const content = byPath.get(file);
      if (content === undefined) continue;
      byPath.set(file, applyCodemodTransform(content, transform, file));
    }
  }

  const edits: { path: string; content: string }[] = [];
  for (const file of files) {
    const updated = byPath.get(file.path);
    if (updated !== undefined && updated !== file.content) edits.push({ path: file.path, content: updated });
  }

  if (edits.length === 0) {
    return {
      status: 'no-changes',
      message: 'The deterministic fix produced no changes here — likely already applied by an earlier commit.',
    };
  }

  const fileCount = new Set(edits.map((edit) => edit.path)).size;
  const ruleCount = commit.codemod?.length ?? 0;
  return {
    status: 'applied',
    edits,
    message: `Applied ${ruleCount} deterministic rename${ruleCount === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'} — no agent call was made.`,
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
  revision?: RevisionRequest;
  /**
   * Hand the edits back instead of writing them.
   *
   * Set when the agent is working in a worktree: `root` is then not the
   * developer's working tree, and applying there would put the fix somewhere
   * that is about to be deleted.
   */
  deferEdits?: boolean;
}): Promise<{ outcome: FixOutcome; edits: { path: string; content: string }[] }> {
  const { agent, plan, commit, root, token, progress, files } = args;

  // The planner already proved this commit needs no agent at all — every
  // breaking change in it was resolved by Drift's own codemod engine. Skip
  // the model call entirely; the edits below still go through the same
  // scope validation, review, and verification an agent's output would.
  if (commit.codemod) {
    const outcome = applyCommitCodemod(commit, files);
    args.onActivity?.({
      kind: outcome.status === 'applied' ? 'edit' : 'status',
      title: 'Deterministic fix',
      detail: outcome.message,
    });
    const edits = outcome.status === 'applied' ? (outcome.edits ?? []) : [];
    if (!args.deferEdits && edits.length > 0) {
      await applyEdits(root, edits, scopeFiles(commit));
      return { outcome, edits: [] };
    }
    return { outcome, edits: [...edits] };
  }

  // Same idea as the codemod branch above, one tier down: a community
  // recipe present here already passed the ask-gate (or was never offered,
  // for a permission mode that skips asking — see `runFixOnBranch`), so it
  // is safe to run without a model call. The recipe writes directly to
  // `root`; nothing to hand to `applyEdits` here.
  if (commit.recipe) {
    const outcome = await applyCommitRecipe(commit, root);
    args.onActivity?.({
      kind: outcome.status === 'applied' ? 'edit' : 'status',
      title: 'Community recipe',
      detail: outcome.message,
    });
    return { outcome, edits: [] };
  }

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
    ...(args.revision ? { revision: args.revision } : {}),
  };

  try {
    const outcome = await agent.run(task, {
      report: (message) => {
        progress.report({ message: `${commit.order}: ${message}` });
        args.onLog?.(message);
        args.onActivity?.(activityFromReport(message));
      },
      // An agent that already knows what it did says so directly, rather than
      // printing a line and hoping the classifier reconstructs it.
      activity: (activity) => {
        const line = activity.detail ?? activity.input ?? activity.title;
        progress.report({ message: `${commit.order}: ${activity.title}` });
        args.onLog?.(line);
        args.onActivity?.(activity);
      },
      ask: args.ask,
      signal: controller.signal,
    });

    const edits = outcome.status === 'applied' ? (outcome.edits ?? []) : [];

    // In-editor agents hand back text; Drift writes it via the workspace API so
    // every change is a normal, undoable editor edit rather than a surprise
    // mutation behind the user's back.
    if (!args.deferEdits && edits.length > 0) {
      await applyEdits(root, edits, scopeFiles(commit));
      return { outcome, edits: [] };
    }

    return { outcome, edits: [...edits] };
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
  edits: readonly { path: string; content: string | null }[],
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
    if (content === null) {
      edit.deleteFile(uri, { ignoreIfNotExists: true });
      continue;
    }

    let document: vscode.TextDocument | null = null;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      // Not on disk. A planned file the agent was asked to create is a
      // legitimate edit, and refusing it would silently drop the fix — the
      // scope check above has already confirmed the plan named this path.
      // This matters most for a worktree run, where a created file has no way
      // into the working tree other than through here.
      edit.createFile(uri, { ignoreIfExists: true, contents: Buffer.from(content, 'utf8') });
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

function scopeFiles(commit: CommitUnit): string[] {
  return [...new Set((commit.allowedFiles?.length ? commit.allowedFiles : commit.files).map((file) => file.replace(/^\.\//, '').replace(/\\/g, '/')))];
}

/**
 * A floating commit of the working tree as it stands right now, parented on
 * `previous`.
 *
 * Called after every batch. `applyEdits` already wrote that batch's result
 * into the real working tree — committed to the branch when auto-commit is
 * on, merely on disk and pending review otherwise — so a plain snapshot picks
 * up both cases without the caller needing to know which one happened.
 * Reachable only by the SHA this returns, exactly like the run's initial
 * snapshot, so it never pollutes `git log` or the branch the developer sees.
 */
async function advanceBase(git: Git, previous: string): Promise<string> {
  const tree = await git.snapshotTree();
  return git.commitTree(tree, previous, 'drift: snapshot after a fix batch');
}

async function editsFromWorktree(
  root: string,
  changed: readonly ChangedPath[],
): Promise<{ path: string; content: string | null }[]> {
  const edits: { path: string; content: string | null }[] = [];
  const seen = new Set<string>();

  for (const entry of changed) {
    if (entry.oldPath && entry.oldPath !== entry.path && !seen.has(entry.oldPath)) {
      edits.push({ path: entry.oldPath, content: null });
      seen.add(entry.oldPath);
    }
    if (entry.status === 'deleted') {
      if (!seen.has(entry.path)) edits.push({ path: entry.path, content: null });
      seen.add(entry.path);
      continue;
    }
    if (seen.has(entry.path)) continue;
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(join(root, entry.path)));
    edits.push({ path: entry.path, content: Buffer.from(bytes).toString('utf8') });
    seen.add(entry.path);
  }

  return edits;
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
interface CleanTreeGuard {
  ok: true;
  /**
   * The working tree as it was when this ran, captured before any stash.
   *
   * Undefined when the tree was already clean — there is nothing an agent
   * worktree could be missing in that case, so `headSha()` alone is enough.
   * When set, it is what an uncommitted dependency upgrade lives in, and the
   * caller turns it into a real commit so agent worktrees are built from it
   * instead of from a `HEAD` that predates the very change being fixed.
   */
  snapshotTree?: string;
  /** Whether the developer's uncommitted work was moved into a stash. */
  stashed: boolean;
}

async function ensureCleanTree(
  git: Git,
  ask?: (question: string, options?: string[]) => Promise<string>,
): Promise<CleanTreeGuard | { ok: false; message: string }> {
  const dirty = await git.dirtyFiles();
  if (dirty.length === 0) return { ok: true, stashed: false };

  // Captured before the developer's choice takes effect: "stash mine and
  // continue" is about to remove these edits from the working tree, and this
  // is the only chance to record them before that happens.
  const snapshotTree = await git.snapshotTree();

  // In the panel, asking in the thread beats a modal: the developer can see the
  // file list Drift is worried about while they decide.
  if (ask) {
    const answer = await ask(
      `You have ${dirty.length} uncommitted change${dirty.length === 1 ? '' : 's'} (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''}). Mixing them with Drift's edits makes the result hard to review.`,
      ['Stash mine and continue', 'Continue anyway', 'Cancel'],
    );
    if (/^stash/i.test(answer)) {
      await git.stash('drift: work in progress before fix');
      return { ok: true, snapshotTree, stashed: true };
    }
    if (/^continue/i.test(answer)) return { ok: true, snapshotTree, stashed: false };
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
    return { ok: true, snapshotTree, stashed: true };
  }
  if (choice === 'Continue anyway') return { ok: true, snapshotTree, stashed: false };

  return { ok: false, message: 'Cancelled — your working tree was left untouched.' };
}

function driftConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('drift');
}

function fail(message: string, reason?: FixResult['reason']): FixResult {
  return { status: 'failed', commits: 0, warnings: [], message, ...(reason ? { reason } : {}) };
}

function empty(): FixResult {
  return { status: 'nothing', commits: 0, warnings: [], message: '' };
}
