import * as vscode from 'vscode';
import { branchNameFor, buildIssueContent, issueMarker, type IssueBranchTarget } from '../../src/actions/issue-branch.js';
import { Git } from './git.js';
import { createIssueWithGh } from './gh.js';
import { remoteSlug } from './ship.js';

/**
 * The extension's side of the one-click issue/branch action. Reuses the
 * same content builders the CLI's interactive prompt does
 * (`src/actions/issue-branch.ts`) so a finding filed from a webview button
 * reads identically to one filed from the terminal, but drives it with the
 * extension's own `Git` wrapper and `gh` helper rather than the CLI's raw
 * `execFile` calls and `GitHubClient`.
 *
 * Every path here ends in a VS Code notification, never a thrown error —
 * this always runs from a button click with nothing watching a stack trace,
 * and a folder with no git repo, no remote, or no `gh` signed in is a
 * routine outcome, not a bug.
 */

export type IssueBranchAction = 'issue' | 'branch' | 'both';

export async function runIssueBranchAction(
  workspaceRoot: string,
  action: IssueBranchAction,
  target: IssueBranchTarget,
): Promise<void> {
  const git = new Git(workspaceRoot);

  const repoRoot = await git.repoRoot();
  if (!repoRoot) {
    void vscode.window.showWarningMessage('Drift: this folder is not a git repository.');
    return;
  }

  let branchName: string | undefined;
  if (action === 'branch' || action === 'both') {
    const outcome = await createBranch(git, target);
    if (!outcome) {
      if (action === 'branch') return;
    } else {
      branchName = outcome.name;
      if (action === 'branch') {
        void vscode.window.showInformationMessage(
          outcome.created ? `Drift: created branch ${outcome.name}.` : `Drift: switched to branch ${outcome.name}.`,
        );
      }
    }
  }

  if (action === 'issue' || action === 'both') {
    await createIssue(git, workspaceRoot, target, branchName);
  }
}

async function createBranch(git: Git, target: IssueBranchTarget): Promise<{ created: boolean; name: string } | null> {
  const name = branchNameFor(target);
  try {
    const { created } = await git.createBranch(name);
    return { created, name };
  } catch (err) {
    void vscode.window.showWarningMessage(`Drift: could not create branch ${name} — ${(err as Error).message}`);
    return null;
  }
}

async function createIssue(
  git: Git,
  workspaceRoot: string,
  target: IssueBranchTarget,
  linkedBranch: string | undefined,
): Promise<void> {
  const remote = await git.remoteUrl();
  const slug = remoteSlug(remote);
  const content = buildIssueContent(target, linkedBranch);

  if (!slug) {
    void vscode.window.showWarningMessage('Drift: no GitHub remote configured — cannot file an issue.');
    return;
  }

  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Drift: filing a GitHub issue' },
    () =>
      createIssueWithGh({
        cwd: workspaceRoot,
        title: content.title,
        body: content.body,
        labels: content.labels,
        marker: issueMarker(target),
      }),
  );

  if (outcome.kind === 'opened') {
    const choice = await vscode.window.showInformationMessage(
      outcome.existing
        ? `Drift: issue #${outcome.number} was already open — ${outcome.url}`
        : `Drift: filed issue #${outcome.number} — ${outcome.url}`,
      'Open issue',
    );
    if (choice === 'Open issue') await vscode.env.openExternal(vscode.Uri.parse(outcome.url));
    return;
  }

  if (outcome.kind === 'failed') {
    void vscode.window.showWarningMessage(`Drift: could not file the issue — ${outcome.message}`);
    return;
  }

  // `gh` is missing or signed out — never a dead end: GitHub's own "new
  // issue" page, prefilled, is one click away either way.
  const url = newIssueUrl(slug, content);
  const choice = await vscode.window.showWarningMessage(
    outcome.reason === 'not-installed'
      ? 'Drift: the GitHub CLI is not installed.'
      : 'Drift: the GitHub CLI is not signed in.',
    'Open a prefilled issue on GitHub',
  );
  if (choice === 'Open a prefilled issue on GitHub') await vscode.env.openExternal(vscode.Uri.parse(url));
}

function newIssueUrl(slug: string, content: { title: string; body: string; labels: string[] }): string {
  const params = new URLSearchParams({ title: content.title, body: content.body });
  if (content.labels.length) params.set('labels', content.labels.join(','));
  return `https://github.com/${slug}/issues/new?${params.toString()}`;
}
