import * as vscode from 'vscode';
import { branchNameFor, buildIssueContent, issueMarker, type IssueBranchTarget } from '../../src/actions/issue-branch.js';
import { Git } from './git.js';
import { commentOnIssueWithGh, createIssueWithGh } from './gh.js';
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

/**
 * A second surface for the outcome, alongside the VS Code notification this
 * module always shows. The notification is easy to miss or dismiss without
 * reading; a caller with a chat transcript (the main panel's `/issue`) wires
 * this up to post the same fact — with a working link — into the
 * conversation, where it stays scrollable-back-to instead of vanishing with
 * the toast.
 */
export interface IssueBranchReport {
  onIssue?: (result: { status: 'created' | 'existing'; number: number; url: string }) => void;
  onBranch?: (result: { status: 'created' | 'existing'; name: string }) => void;
}

export async function runIssueBranchAction(
  workspaceRoot: string,
  action: IssueBranchAction,
  target: IssueBranchTarget,
  report?: IssueBranchReport,
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
      report?.onBranch?.({ status: outcome.created ? 'created' : 'existing', name: outcome.name });
      if (action === 'branch') {
        void vscode.window.showInformationMessage(
          outcome.created ? `Drift: created branch ${outcome.name}.` : `Drift: switched to branch ${outcome.name}.`,
        );
      }
    }
  }

  if (action === 'issue' || action === 'both') {
    await createIssue(git, workspaceRoot, target, branchName, report);
  }
}

async function createBranch(git: Git, target: IssueBranchTarget): Promise<{ created: boolean; name: string } | null> {
  const name = branchNameFor(target);
  try {
    return await git.createBranch(name);
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
  report: IssueBranchReport | undefined,
): Promise<void> {
  const remote = await git.remoteUrl();
  const slug = remoteSlug(remote);

  if (!slug) {
    void vscode.window.showWarningMessage('Drift: no GitHub remote configured — cannot create an issue.');
    return;
  }

  // The impact-site links in the issue body point at this exact commit, not
  // a branch that can move out from under them — a `#L42` link against
  // `main` reads as wrong the moment someone pushes past that line.
  const headSha = await git.headSha().catch(() => null);
  const repoBlobUrl = headSha ? `https://github.com/${slug}/blob/${headSha}` : undefined;
  const content = buildIssueContent({ ...target, repoBlobUrl }, linkedBranch);

  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Drift: creating a GitHub issue' },
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
    report?.onIssue?.({ status: outcome.existing ? 'existing' : 'created', number: outcome.number, url: outcome.url });

    // A branch is only offered when this call did not already link one —
    // `action: 'both'` already put the tracking line in the body above, and
    // asking again would be a second, redundant offer for the same thing.
    const buttons = linkedBranch ? ['Open issue'] : ['Open issue', 'Create linked branch'];
    const choice = await vscode.window.showInformationMessage(
      outcome.existing
        ? `Drift: issue #${outcome.number} was already open — ${outcome.url}`
        : `Drift: created issue #${outcome.number} — ${outcome.url}`,
      ...buttons,
    );
    if (choice === 'Open issue') await vscode.env.openExternal(vscode.Uri.parse(outcome.url));
    if (choice === 'Create linked branch') await createLinkedBranch(git, workspaceRoot, target, outcome.number, report);
    return;
  }

  if (outcome.kind === 'failed') {
    // A failure on the way to `gh` — a missing label, a permissions error, a
    // network blip — is no more a dead end than `gh` being absent outright.
    // GitHub's own prefilled "new issue" page is one click away either way.
    const url = newIssueUrl(slug, content);
    const choice = await vscode.window.showWarningMessage(
      `Drift: could not create the issue — ${outcome.message}`,
      'Open a prefilled issue on GitHub',
    );
    if (choice === 'Open a prefilled issue on GitHub') await vscode.env.openExternal(vscode.Uri.parse(url));
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

/**
 * The branch a created issue did not already know about, added after the
 * fact — one click, no need to remember `git checkout -b` or come back and
 * paste the branch name into the issue by hand.
 */
async function createLinkedBranch(
  git: Git,
  workspaceRoot: string,
  target: IssueBranchTarget,
  issueNumber: number,
  report: IssueBranchReport | undefined,
): Promise<void> {
  const created = await createBranch(git, target);
  if (!created) return;

  await commentOnIssueWithGh(workspaceRoot, issueNumber, `Tracking branch: \`${created.name}\``);
  report?.onBranch?.({ status: created.created ? 'created' : 'existing', name: created.name });
  void vscode.window.showInformationMessage(
    created.created
      ? `Drift: created branch ${created.name}, linked to issue #${issueNumber}.`
      : `Drift: switched to ${created.name}, linked to issue #${issueNumber}.`,
  );
}

/**
 * Create (or switch to) `target`'s branch and link it to an issue already
 * filed for the same finding(s) — the same thing the "Create linked branch"
 * button on the issue-created notification does, exposed for a caller (the
 * main panel's chat) that asks the same question in its own transcript
 * instead of through that toast.
 */
export async function linkBranchToIssue(
  workspaceRoot: string,
  target: IssueBranchTarget,
  issueNumber: number,
  report?: IssueBranchReport,
): Promise<void> {
  await createLinkedBranch(new Git(workspaceRoot), workspaceRoot, target, issueNumber, report);
}

/**
 * Switch to a branch that already exists and link it to an issue — the
 * "already have a branch for this" half of the same offer `linkBranchToIssue`
 * covers for "make me a new one".
 */
export async function linkExistingBranchToIssue(
  workspaceRoot: string,
  branchName: string,
  issueNumber: number,
): Promise<{ ok: boolean }> {
  const git = new Git(workspaceRoot);
  try {
    await git.checkout(branchName);
  } catch (err) {
    void vscode.window.showWarningMessage(`Drift: could not switch to ${branchName} — ${(err as Error).message}`);
    return { ok: false };
  }
  await commentOnIssueWithGh(workspaceRoot, issueNumber, `Tracking branch: \`${branchName}\``);
  void vscode.window.showInformationMessage(`Drift: switched to ${branchName}, linked to issue #${issueNumber}.`);
  return { ok: true };
}

/**
 * A body that fits comfortably in a GraphQL `createIssue` call can still be
 * too long once URL-encoded into a query string — GitHub's `issues/new`
 * page silently drops the prefill (surfacing as "link not found" once the
 * browser opens it) well before it would hit any encoded-length limit on
 * the body alone. Trimmed further here, specifically for this fallback.
 */
const MAX_PREFILL_BODY_CHARS = 4000;

function newIssueUrl(slug: string, content: { title: string; body: string; labels: string[] }): string {
  const body =
    content.body.length > MAX_PREFILL_BODY_CHARS
      ? `${content.body.slice(0, MAX_PREFILL_BODY_CHARS)}…\n\n(truncated to fit this prefilled link — open Drift's report in the editor for the rest)`
      : content.body;
  const params = new URLSearchParams({ title: content.title, body });
  if (content.labels.length) params.set('labels', content.labels.join(','));
  return `https://github.com/${slug}/issues/new?${params.toString()}`;
}
