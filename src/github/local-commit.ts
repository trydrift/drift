import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommitUnit, RemediationPlan, RepoContext } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import type { GitHubClient } from './client.js';
import { execCommand, type Exec } from '../util/exec.js';
import { remediationKindFor } from '../remediation/partition.js';
import { applyBuiltinCodemod, applyCommitFixPlan } from '../remediation/apply.js';
import { dispositionFor } from '../fixplan/policy.js';
import { renderFixPlanDocument } from '../fixplan/document.js';

/**
 * Apply the commits of a plan that Drift can resolve itself — built-in
 * codemod first, then a validated deterministic fix plan — directly to the
 * Action's remediation branch.
 *
 * This is what lets `dispatch()` skip Copilot entirely for a plan it can
 * fully resolve on its own, and dispatch only the commits it could not
 * resolve for the rest. Each commit is applied and committed independently,
 * in plan order, against `repo.workspace` (the Action's own checkout) — later
 * commits see earlier ones' edits on disk, the same layering the codemod
 * engine's anchor design and the VS Code extension's worktree batching both
 * already rely on. A commit this function could not safely resolve is left
 * untouched on disk and reported as unresolved so the caller can fall back
 * to an agent for it, never guessed at.
 *
 * The Action is the surface that cannot ask anyone anything, which is why it
 * consults `dispositionFor` rather than deciding for itself: a plan that
 * comes back `'review'` here is not applied and not silently dropped either —
 * it stays in the plan, its document goes into the approval issue and the
 * pull request body, and a human decides. That is the same "guardrails
 * downgrade, never drop" rule the rest of the Action already follows.
 */
export async function applyDeterministicRemediation(options: {
  repo: RepoContext;
  plan: RemediationPlan;
  config: DriftConfig;
  github: GitHubClient;
  logger: Logger;
  exec?: Exec;
}): Promise<{ committedIds: Set<string> }> {
  const { repo, plan, config, github, logger } = options;
  const exec = options.exec ?? execCommand;
  const committedIds = new Set<string>();

  if (!repo.workspace) return { committedIds };

  for (const commit of plan.commits) {
    const kind = remediationKindFor(commit);
    if (kind === 'ai') continue;

    try {
      if (kind === 'builtin') {
        // A built-in codemod never writes to disk unless it fully applied
        // (see `applyBuiltinCommit`), so `commit.files` is always the right
        // set to revert on failure — nothing else could have changed.
        const resolved = await applyBuiltinCommit(repo.workspace, commit);
        if (!resolved) {
          await revertWorkspaceFiles(repo.workspace, commit.files, exec);
          continue;
        }

        const committed = await github.commitFiles(
          repo,
          plan.branchName,
          resolved.edits,
          `${commit.message}\n\n${commit.body}\n\n${resolved.message}`,
        );

        if (committed) {
          committedIds.add(commit.id);
          logger.info(`Resolved commit ${commit.order} directly (builtin): ${resolved.message}`);
        } else {
          await revertWorkspaceFiles(repo.workspace, commit.files, exec);
        }
        continue;
      }

      // A fix plan only edits lines it anchored, and every anchor came from
      // one of this commit's own impact sites, so `commit.files` is the
      // complete revert set exactly as it is for a built-in codemod.
      const fixPlan = commit.fixPlan!;
      const disposition = dispositionFor(
        {
          plan: fixPlan.plan,
          verdict: fixPlan.residual === 0 ? 'accepted' : 'partial',
          assurance: fixPlan.assurance,
          sites: [],
          covered: fixPlan.covered,
          residual: fixPlan.residual,
          rejections: [],
          anchors: fixPlan.anchors,
        },
        config,
        { verificationPassed: plan.verification?.status === 'passed' },
      );

      if (disposition.action !== 'apply') {
        logger.info(
          `Commit ${commit.order} has a validated fix plan that will not be applied unattended: ${disposition.reason} The plan document is included for review.`,
        );
        continue;
      }

      const resolved = await applyFixPlanCommit(repo.workspace, commit);
      if (!resolved) {
        await revertWorkspaceFiles(repo.workspace, commit.files, exec);
        continue;
      }

      const committed = await github.commitFiles(
        repo,
        plan.branchName,
        resolved.edits,
        [
          `${commit.message}`,
          '',
          commit.body,
          '',
          resolved.message,
          '',
          renderFixPlanDocument(
            {
              plan: fixPlan.plan,
              verdict: fixPlan.residual === 0 ? 'accepted' : 'partial',
              assurance: fixPlan.assurance,
              sites: [],
              covered: fixPlan.covered,
              residual: fixPlan.residual,
              rejections: [],
              anchors: fixPlan.anchors,
            },
            { sites: false, headingLevel: 2 },
          ),
        ].join('\n'),
      );

      if (committed) {
        committedIds.add(commit.id);
        logger.info(`Resolved commit ${commit.order} directly (fix plan): ${resolved.message}`);
      } else {
        await revertWorkspaceFiles(repo.workspace, commit.files, exec);
      }
    } catch (err) {
      logger.warn(
        `Deterministic remediation failed for commit ${commit.order}, falling back to an agent: ${(err as Error).message}`,
      );
      await revertWorkspaceFiles(repo.workspace, commit.files, exec);
    }
  }

  return { committedIds };
}

async function applyBuiltinCommit(
  workspace: string,
  commit: CommitUnit,
): Promise<{ edits: { path: string; content: string }[]; message: string } | null> {
  const contents = new Map<string, string>();
  for (const file of commit.files) {
    try {
      contents.set(file, await readFile(join(workspace, file), 'utf8'));
    } catch {
      // Missing file — applyBuiltinCodemod skips anything it wasn't given.
    }
  }

  const result = applyBuiltinCodemod(commit, contents);
  if (result.status !== 'applied') return null;

  for (const edit of result.edits) {
    await writeFile(join(workspace, edit.path), edit.content, 'utf8');
  }

  return { edits: result.edits, message: result.message };
}

/**
 * Apply a commit's fix plan to the Action's checkout, and write the result.
 *
 * Mirrors `applyBuiltinCommit` exactly, because at this point the two tiers
 * differ only in where the rule came from: both are Drift's own operations,
 * both are anchored to Drift's own localized impact sites, and both are
 * re-derived against live file contents rather than replayed from a snapshot.
 */
async function applyFixPlanCommit(
  workspace: string,
  commit: CommitUnit,
): Promise<{ edits: { path: string; content: string }[]; message: string } | null> {
  const contents = new Map<string, string>();
  for (const file of commit.fixPlan?.files ?? []) {
    try {
      contents.set(file, await readFile(join(workspace, file), 'utf8'));
    } catch {
      // Missing file — applyCommitFixPlan skips anything it wasn't given.
    }
  }

  const result = applyCommitFixPlan(commit, contents);
  if (result.status !== 'applied') return null;

  for (const edit of result.edits) {
    await writeFile(join(workspace, edit.path), edit.content, 'utf8');
  }

  return { edits: result.edits, message: result.message };
}

async function revertWorkspaceFiles(workspace: string, files: readonly string[], exec: Exec): Promise<void> {
  if (files.length === 0) return;
  await exec('git', ['checkout', '--', ...files], { cwd: workspace });
}
