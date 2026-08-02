import { parseApprovalMetadata, type ApprovalMetadata } from './metadata.js';

/**
 * Who is allowed to say `/drift apply`, and on what.
 *
 * `/drift apply` causes Drift to create a branch and hand a coding agent write
 * access to it. That makes an approval comment a privileged operation, and
 * until now it was not treated as one: both runners accepted any comment whose
 * text matched, from anyone, on any issue. On a public repository that is an
 * unauthenticated request to run an agent against a commit of the commenter's
 * choosing.
 *
 * This module is the gate. It is deliberately pure — every input is passed in,
 * including the permission lookup — because the interesting cases here are the
 * ones that must *fail*, and those are only worth having if they are cheap
 * enough to test exhaustively.
 *
 * ## The four independent questions
 *
 * 1. **Is this an approval attempt?** A created comment, matching the command,
 *    on an issue rather than a pull request.
 * 2. **Is the issue really Drift's?** Provenance comes from the `drift` label,
 *    not from the body text. Anyone can paste a footer into an issue they
 *    opened; applying a label requires triage permission on the repository.
 *    Forging provenance therefore costs at least as much permission as
 *    approving does, which is what makes the check meaningful.
 * 3. **Does the footer name one specific plan?** Strictly parsed, so a
 *    hand-written approximation fails.
 * 4. **May this person approve?** Write, maintain, or admin. Not issue author,
 *    not organization member, not "can read the repo".
 *
 * Digest verification is the fifth question and does not live here: it needs
 * the re-analysed plan, so it happens in the runner once the plan exists.
 */

/** Collaborator permission levels, as GitHub reports them. */
export type RepoPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

/** The levels that may approve. Triage and read may not — they cannot push. */
const APPROVER_PERMISSIONS: readonly RepoPermission[] = ['admin', 'maintain', 'write'];

export function canApprove(permission: RepoPermission): boolean {
  return APPROVER_PERMISSIONS.includes(permission);
}

export interface ApprovalRequest {
  /** `payload.action` — only `created` counts. */
  action?: string;
  comment?: { body?: string | null; user?: { login?: string; type?: string } | null } | null;
  issue?: {
    number?: number;
    body?: string | null;
    labels?: readonly (string | { name?: string })[] | null;
    pull_request?: unknown;
    state?: string;
  } | null;
}

export interface AuthorizeOptions {
  request: ApprovalRequest;
  /**
   * Resolve the commenter's permission on this repository.
   *
   * Returns `null` when the answer could not be determined — a 5xx, a network
   * failure, a token without the scope to ask. `null` is refused, never
   * downgraded to a guess.
   */
  lookupPermission: (login: string) => Promise<RepoPermission | null>;
  /**
   * Logins belonging to Drift itself, so it cannot approve its own plans.
   *
   * Drift's own issue body contains the literal text ``/drift apply`` as an
   * instruction to the reader, and its rejection comments quote the command
   * back. Without this, one runner posting a comment could trigger the next.
   */
  selfLogins?: readonly string[];
  /** Label proving Drift filed the issue. */
  requiredLabel?: string;
}

export type AuthorizeResult =
  /** Not an approval attempt. Say nothing; this is an ordinary comment. */
  | { status: 'not-an-approval'; reason: string }
  /** An approval attempt that failed. Explain on the issue. */
  | { status: 'rejected'; reason: string; issueNumber: number; actor: string | null }
  | { status: 'authorized'; metadata: ApprovalMetadata; issueNumber: number; actor: string; permission: RepoPermission };

/**
 * Matches `/drift apply` as a command.
 *
 * Anchored to the start of a line so that quoting the command while discussing
 * it — "you can comment /drift apply to proceed" — is not itself an approval.
 * Drift's own issue body indents the instruction inside prose for this reason.
 */
const APPLY_COMMAND = /^[ \t]*\/drift[ \t]+apply[ \t]*$/m;

export async function authorizeApproval(options: AuthorizeOptions): Promise<AuthorizeResult> {
  const { request, lookupPermission, selfLogins = [], requiredLabel = 'drift' } = options;

  // --- 1. Is this an approval attempt at all? ------------------------------

  if (request.action !== 'created') {
    return { status: 'not-an-approval', reason: `comment action is \`${request.action ?? 'absent'}\`, not \`created\`` };
  }

  const body = request.comment?.body;
  if (!body || !APPLY_COMMAND.test(body)) {
    return { status: 'not-an-approval', reason: 'the comment is not a `/drift apply` command' };
  }

  const issue = request.issue;
  if (!issue || typeof issue.number !== 'number') {
    return { status: 'not-an-approval', reason: 'the event carries no issue' };
  }

  // A pull request is an issue as far as this webhook is concerned, but a PR
  // has no Drift plan footer and approving one is meaningless.
  if (issue.pull_request) {
    return { status: 'not-an-approval', reason: 'the comment is on a pull request, not an approval issue' };
  }

  const actor = request.comment?.user?.login ?? null;

  // Drift must never approve itself. Checked before anything that could post a
  // comment, so a misconfiguration cannot produce a comment loop.
  if (actor && selfLogins.some((login) => login.toLowerCase() === actor.toLowerCase())) {
    return { status: 'not-an-approval', reason: 'the comment was posted by Drift itself' };
  }

  // --- 2. Is this really a Drift approval issue? ---------------------------

  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l?.name ?? ''))).filter(Boolean);

  if (!labels.some((name) => name.toLowerCase() === requiredLabel.toLowerCase())) {
    // Silent: an issue without Drift's label is somebody else's issue, and
    // commenting on it would be noise the repository did not ask for.
    return {
      status: 'not-an-approval',
      reason: `the issue does not carry the \`${requiredLabel}\` label, so Drift did not file it`,
    };
  }

  if (issue.state && issue.state !== 'open') {
    return {
      status: 'rejected',
      reason: `this issue is ${issue.state}. Re-open it, or run Drift again to generate a current plan.`,
      issueNumber: issue.number,
      actor,
    };
  }

  // --- 3. Does the footer name one specific plan? --------------------------

  const parsed = parseApprovalMetadata(issue.body ?? '');
  if (!parsed.ok) {
    return {
      status: 'rejected',
      reason: `Drift could not read the plan record on this issue: ${parsed.reason}.`,
      issueNumber: issue.number,
      actor,
    };
  }

  // --- 4. May this person approve? -----------------------------------------

  if (!actor) {
    return {
      status: 'rejected',
      reason: 'the approval comment has no identifiable author, so Drift cannot check permission.',
      issueNumber: issue.number,
      actor: null,
    };
  }

  let permission: RepoPermission | null;
  try {
    permission = await lookupPermission(actor);
  } catch {
    // Fail closed. An unavailable permissions API must never read as "allowed".
    permission = null;
  }

  if (permission === null) {
    return {
      status: 'rejected',
      reason:
        'Drift could not confirm your permission on this repository, so it stopped. ' +
        'This is deliberate: an unavailable permission check is treated as a refusal, never as approval.',
      issueNumber: issue.number,
      actor,
    };
  }

  if (!canApprove(permission)) {
    return {
      status: 'rejected',
      reason:
        `\`${actor}\` has \`${permission}\` permission on this repository. ` +
        'Applying a Drift plan writes a branch and dispatches a coding agent, so it requires `write`, `maintain`, or `admin`.',
      issueNumber: issue.number,
      actor,
    };
  }

  return {
    status: 'authorized',
    metadata: parsed.metadata,
    issueNumber: issue.number,
    actor,
    permission,
  };
}
