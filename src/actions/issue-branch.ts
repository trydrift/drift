import type { BreakingChange } from '../types.js';

/**
 * The one-click "file this" action offered wherever Drift shows a breaking
 * change — content-only. Everything here is pure and side-effect free on
 * purpose: the CLI's interactive prompt and the VS Code extension's report
 * webview each drive their own git/`gh`/Octokit calls (different runtimes,
 * different credentials), but both need the exact same title, body, marker,
 * and branch name for the same finding. Building that text in one place is
 * what keeps an issue filed from the terminal indistinguishable from one
 * filed by clicking a button in the editor.
 */

export type IssueBranchAction = 'issue' | 'branch' | 'both';
export type IssueBranchScope = 'change' | 'package';

/** One or more breaking changes bundled into a single issue/branch. */
export interface IssueBranchTarget {
  dependency: string;
  changes: readonly BreakingChange[];
}

/**
 * Group breaking changes for the action's scope.
 *
 * `'package'` folds every finding for one dependency into a single target,
 * matching `codeScanning.granularity`'s `'package'` mode. `'change'` gives
 * each finding its own target, one per element of `changes` — used when the
 * action is triggered from an individual row rather than a group header.
 */
export function groupForAction(
  changes: readonly BreakingChange[],
  scope: IssueBranchScope,
): IssueBranchTarget[] {
  if (scope === 'change') {
    return changes.map((change) => ({ dependency: change.dependency, changes: [change] }));
  }

  const byDependency = new Map<string, BreakingChange[]>();
  for (const change of changes) {
    const list = byDependency.get(change.dependency);
    if (list) list.push(change);
    else byDependency.set(change.dependency, [change]);
  }
  return [...byDependency.entries()].map(([dependency, grouped]) => ({ dependency, changes: grouped }));
}

/**
 * A hidden HTML-comment marker embedded in every issue this feature files,
 * mirroring `codeScanning.createIssuesPerAlert`'s dedup marker
 * (`src/runners/action.ts`). Content-derived from the target's dependency
 * and finding ids, so re-triggering the same action always looks up the
 * same marker and finds the issue it already filed rather than piling up
 * duplicates.
 */
export function issueMarker(target: IssueBranchTarget): string {
  const ids = [...target.changes.map((change) => change.id)].sort().join(',');
  return `drift-issue:${target.dependency}:${ids}`;
}

export interface IssueContent {
  title: string;
  body: string;
  labels: string[];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Deterministic branch name for a target, safe as a git ref component. */
export function branchNameFor(target: IssueBranchTarget): string {
  if (target.changes.length === 1) {
    return `drift/${slugify(target.dependency)}/${slugify(target.changes[0]!.id)}`;
  }
  return `drift/${slugify(target.dependency)}`;
}

/**
 * The issue's title and body for a target, optionally linking to a branch
 * already created for the same finding(s) — the `'both'` action's contract.
 */
export function buildIssueContent(target: IssueBranchTarget, linkedBranch?: string): IssueContent {
  const title =
    target.changes.length === 1
      ? `Drift: ${target.dependency} — ${target.changes[0]!.summary}`
      : `Drift: ${target.dependency} — ${target.changes.length} breaking changes`;

  const sections = target.changes.map((change) => {
    const lines = [`### ${change.summary}`, '', change.remediation];
    if (change.before || change.after) {
      lines.push('', '```diff', change.before ? `- ${change.before}` : '', change.after ? `+ ${change.after}` : '', '```');
    }
    return lines.filter((line) => line !== '').join('\n');
  });

  const bodyParts = [
    `Drift flagged ${target.changes.length === 1 ? 'a breaking change' : `${target.changes.length} breaking changes`} in **${target.dependency}**.`,
    ...sections,
  ];
  if (linkedBranch) bodyParts.push(`Tracking branch: \`${linkedBranch}\``);
  bodyParts.push(`<!-- ${issueMarker(target)} -->`);

  return {
    title,
    body: bodyParts.join('\n\n'),
    labels: ['drift', `drift:${target.dependency}`],
  };
}

/**
 * What the action did, in terms a caller can act on without inspecting an
 * error object. Mirrors `GhPullRequestOutcome`'s discriminated-union shape
 * (`extension/src/gh.ts`): every reason the action could not run is named,
 * so the CLI and the extension can both fail soft — a log line or a
 * dismissable toast, never a thrown error.
 */
export type IssueBranchOutcome =
  | { kind: 'issue'; status: 'created' | 'existing'; number: number; url: string }
  | { kind: 'branch'; status: 'created' | 'existing'; name: string }
  | {
      kind: 'unavailable';
      reason: 'no-git-repo' | 'no-remote' | 'gh-not-installed' | 'gh-not-authenticated' | 'no-token';
    }
  | { kind: 'failed'; message: string };
