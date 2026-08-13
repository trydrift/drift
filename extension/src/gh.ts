import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { envWithShellPath } from './shell-path.js';
import type { PullRequest } from './ship.js';

/**
 * The GitHub CLI, used only to open a pull request.
 *
 * Drift already pushes with git's own credentials, so by the time anything here
 * runs the work is safe on the remote. `gh` is an *enhancement* on top of that:
 * when a developer already has it signed in — and a large number do, for other
 * reasons — Drift can raise the pull request itself instead of handing back a
 * compare link and asking them to finish the job in a browser. It is never a
 * requirement. Nothing in this file is allowed to block a push, prompt an
 * install, or turn a missing binary into an error.
 *
 * Encapsulated here rather than spread through the extension so that there is
 * exactly one place that knows how to shell out to `gh`, one place that decides
 * what "authenticated" means, and one place a test has to fake.
 *
 * Also deliberately narrow: `pr create` and `pr view`. There is no code path
 * here that merges, force-pushes, or closes anything.
 */

const execFileAsync = promisify(execFile);

/** How a `gh` invocation is actually run. Injected so tests need no binary. */
export interface GhRunner {
  (args: readonly string[], options: { cwd: string }): Promise<{ stdout: string }>;
}

const defaultRunner: GhRunner = async (args, options) => {
  // The PATH a GUI-launched VS Code sees rarely includes Homebrew or a user's
  // own bin directory, which is exactly where `gh` lives on most machines.
  const env = await envWithShellPath();
  const { stdout } = await execFileAsync('gh', [...args], {
    cwd: options.cwd,
    env,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout };
};

export interface GhAvailability {
  /** `gh` is on PATH. */
  installed: boolean;
  /** `gh auth status` succeeded, so it holds a usable credential. */
  authenticated: boolean;
}

/**
 * Whether `gh` can open a pull request right now.
 *
 * Two separate questions, kept separate: "not installed" and "installed but
 * signed out" lead to the same fallback but not to the same sentence, and a
 * developer who has `gh` sitting there signed out is one `gh auth login` away
 * from the better path.
 */
export async function ghAvailability(
  cwd: string,
  run: GhRunner = defaultRunner,
): Promise<GhAvailability> {
  try {
    await run(['--version'], { cwd });
  } catch {
    return { installed: false, authenticated: false };
  }

  try {
    await run(['auth', 'status'], { cwd });
    return { installed: true, authenticated: true };
  } catch {
    return { installed: true, authenticated: false };
  }
}

export interface GhPullRequestRequest {
  /** A directory inside the repository the pull request belongs to. */
  cwd: string;
  /** The branch holding the work. Already pushed by the time this runs. */
  head: string;
  /** The branch it merges into. */
  base: string;
  title: string;
  /** The Drift report. Passed as a file so no shell ever sees it. */
  body: string;
  draft?: boolean;
  labels?: readonly string[];
  reviewers?: readonly string[];
  /**
   * Called once `gh` is known to be usable, immediately before `pr create`.
   *
   * The availability probe costs a `gh auth status`, which talks to GitHub, so
   * it happens exactly once. This hook is how a caller starts showing progress
   * at the moment the attempt actually begins — without it, the UI would either
   * announce an attempt that never happens on a machine with no `gh`, or pay
   * for a second probe to find out whether to announce it.
   */
  onAttempt?: () => void;
}

/**
 * What `gh` did, in terms the caller can act on.
 *
 * `unavailable` and `failed` are distinct because only one of them is worth
 * mentioning: a missing `gh` is not news to anybody, while `gh` refusing to
 * create the pull request is something the developer may want to read.
 */
export type GhPullRequestOutcome =
  | { kind: 'opened'; pr: PullRequest }
  | { kind: 'unavailable'; reason: 'not-installed' | 'not-authenticated' }
  | { kind: 'failed'; message: string };

/**
 * Open the pull request with `gh`, or report why it could not.
 *
 * The one genuinely subtle case is re-running against a branch that already has
 * a pull request. `gh pr create` exits non-zero for that, with wording that has
 * changed between versions, so the answer is not parsed out of stderr — `gh pr
 * view` is asked directly instead. An existing pull request is a success:
 * the commits are already on it, and the developer wanted a link to it either
 * way.
 */
export async function createPullRequestWithGh(
  request: GhPullRequestRequest,
  run: GhRunner = defaultRunner,
): Promise<GhPullRequestOutcome> {
  const availability = await ghAvailability(request.cwd, run);
  if (!availability.installed) return { kind: 'unavailable', reason: 'not-installed' };
  if (!availability.authenticated) return { kind: 'unavailable', reason: 'not-authenticated' };

  request.onAttempt?.();

  const dir = await mkdtemp(join(tmpdir(), 'drift-pr-'));
  const bodyPath = join(dir, 'body.md');

  try {
    await writeFile(bodyPath, request.body, 'utf8');

    const args = [
      'pr',
      'create',
      '--head',
      request.head,
      '--base',
      request.base,
      '--title',
      request.title,
      '--body-file',
      bodyPath,
    ];
    if (request.draft) args.push('--draft');
    for (const label of request.labels ?? []) args.push('--label', label);
    for (const reviewer of request.reviewers ?? []) args.push('--reviewer', reviewer);

    let created: string | null = null;
    try {
      const { stdout } = await run(args, { cwd: request.cwd });
      created = pullRequestUrlIn(stdout);
    } catch (err) {
      const existing = await findExistingPullRequest(request, run);
      if (existing) return { kind: 'opened', pr: existing };
      return { kind: 'failed', message: describe(err) };
    }

    if (created) return { kind: 'opened', pr: pullRequestFor(created, false) };

    // `gh` exited zero but printed nothing recognisable — treat the branch as
    // possibly having a pull request rather than claiming one was opened.
    const existing = await findExistingPullRequest(request, run);
    if (existing) return { kind: 'opened', pr: existing };
    return { kind: 'failed', message: 'The GitHub CLI did not report a pull request URL.' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The pull request already open for this branch, if there is one. */
async function findExistingPullRequest(
  request: GhPullRequestRequest,
  run: GhRunner,
): Promise<PullRequest | null> {
  try {
    const { stdout } = await run(['pr', 'view', request.head, '--json', 'url,number'], {
      cwd: request.cwd,
    });
    const parsed = JSON.parse(stdout) as { url?: string; number?: number };
    if (!parsed.url) return null;
    return { url: parsed.url, number: parsed.number ?? numberIn(parsed.url), existing: true };
  } catch {
    return null;
  }
}

/**
 * The URL out of `gh pr create` output.
 *
 * `gh` prints the URL on the last line, but versions differ in what they print
 * before it (a "Creating pull request…" banner, warnings about the base). The
 * last line that looks like a pull request URL is the stable answer.
 */
function pullRequestUrlIn(stdout: string): string | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    if (/^https?:\/\/\S+\/pull\/\d+$/.test(line)) return line;
  }
  return null;
}

function pullRequestFor(url: string, existing: boolean): PullRequest {
  return { url, number: numberIn(url), existing };
}

function numberIn(url: string): number {
  return Number(/\/(?:pull|issues)\/(\d+)/.exec(url)?.[1] ?? 0);
}

function describe(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const stderr = e.stderr?.trim();
  if (stderr) return stderr.split('\n').filter(Boolean).slice(-3).join(' ');
  return e.message ?? 'The GitHub CLI failed.';
}

export interface GhIssueRequest {
  /** A directory inside the repository the issue belongs to. */
  cwd: string;
  title: string;
  /** Passed as a file so no shell ever sees it, same as the PR body. */
  body: string;
  labels?: readonly string[];
  /**
   * A hidden marker already embedded in `body` — searched for first so a
   * repeat of the same action finds the issue it already filed instead of
   * piling up duplicates. See `src/actions/issue-branch.ts#issueMarker`.
   */
  marker: string;
}

export type GhIssueOutcome =
  | { kind: 'opened'; number: number; url: string; existing: boolean }
  | { kind: 'unavailable'; reason: 'not-installed' | 'not-authenticated' }
  | { kind: 'failed'; message: string };

/**
 * File a GitHub issue with `gh`, or find the one already filed for the same
 * marker. Mirrors `createPullRequestWithGh`'s shape and the same
 * never-throw contract — a missing or signed-out `gh` is reported, not
 * raised, since this always runs from a button click with no one watching
 * a stack trace.
 */
export async function createIssueWithGh(request: GhIssueRequest, run: GhRunner = defaultRunner): Promise<GhIssueOutcome> {
  const availability = await ghAvailability(request.cwd, run);
  if (!availability.installed) return { kind: 'unavailable', reason: 'not-installed' };
  if (!availability.authenticated) return { kind: 'unavailable', reason: 'not-authenticated' };

  const existing = await findIssueWithGh(request.cwd, request.marker, run);
  if (existing) return { kind: 'opened', number: existing.number, url: existing.url, existing: true };

  const dir = await mkdtemp(join(tmpdir(), 'drift-issue-'));
  const bodyPath = join(dir, 'body.md');

  try {
    await writeFile(bodyPath, request.body, 'utf8');

    const baseArgs = ['issue', 'create', '--title', request.title, '--body-file', bodyPath];
    const labelArgs = (request.labels ?? []).flatMap((label) => ['--label', label]);

    try {
      const { stdout } = await run([...baseArgs, ...labelArgs], { cwd: request.cwd });
      const url = issueUrlIn(stdout);
      if (url) return { kind: 'opened', number: numberIn(url), url, existing: false };
      return { kind: 'failed', message: 'The GitHub CLI did not report an issue URL.' };
    } catch (err) {
      const message = describe(err);

      // `gh` refuses to create the issue at all when a label it was asked to
      // apply does not exist yet in the repository — most repositories have
      // never had a `drift` label created. The label is a courtesy, not a
      // requirement, so the issue itself should not be lost over it.
      if (labelArgs.length > 0 && /label\b[^\n]*not found/i.test(message)) {
        try {
          const { stdout } = await run(baseArgs, { cwd: request.cwd });
          const url = issueUrlIn(stdout);
          if (url) return { kind: 'opened', number: numberIn(url), url, existing: false };
        } catch (retryErr) {
          return { kind: 'failed', message: describe(retryErr) };
        }
      }

      return { kind: 'failed', message };
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Comment on an already-filed issue — how a branch created after the fact
 * gets linked to it, since the issue's body was already written without
 * knowing the branch's name yet.
 */
export async function commentOnIssueWithGh(
  cwd: string,
  number: number,
  body: string,
  run: GhRunner = defaultRunner,
): Promise<boolean> {
  try {
    await run(['issue', 'comment', String(number), '--body', body], { cwd });
    return true;
  } catch {
    return false;
  }
}

/** The open issue already carrying `marker` in its body, if any. */
async function findIssueWithGh(
  cwd: string,
  marker: string,
  run: GhRunner,
): Promise<{ number: number; url: string } | null> {
  try {
    const { stdout } = await run(
      ['search', 'issues', `"${marker}"`, '--state', 'open', '--json', 'number,url', '--limit', '1'],
      { cwd },
    );
    const results = JSON.parse(stdout) as Array<{ number: number; url: string }>;
    const match = results[0];
    return match ? { number: match.number, url: match.url } : null;
  } catch {
    return null;
  }
}

function issueUrlIn(stdout: string): string | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    if (/^https?:\/\/\S+\/issues\/\d+$/.test(line)) return line;
  }
  return null;
}
