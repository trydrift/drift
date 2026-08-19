# Agent Boundaries

Local agents run in isolated disposable worktrees before their output is replayed
into the developer checkout. Drift captures the baseline SHA and validates the
actual patch before accepting a unit.

Boundary rules:

- Every changed, added, deleted, renamed, and untracked path is enumerated.
- Paths outside `allowedFiles` are rejected.
- Protected paths are rejected regardless of prompt instructions.
- Symlinks, path traversal, and submodule changes are rejected.
- Workflow and lockfile changes require explicit file scope.
- Patch size, file count, likely secrets, skipped tests, assertion removal, and
  test deletion are checked deterministically.
- Rejected worktrees are discarded rather than partially committed.

Agent prompts are guidance, not a security boundary. The boundary is the
worktree, patch parser, scope validator, and configured verification.

Drift never runs agents directly in the user's primary worktree for local fix
units, and it never treats skipped checks as passed.

Cloud agents are different. A provider such as Copilot Cloud edits a remote
branch asynchronously, so Drift cannot validate the diff before the provider
writes it. Drift still owns the repository workflow: branch naming, base SHA,
PR creation, labels/reviewers, verification, and approval fallback stay in
Drift. The cloud adapter only delegates the editing task.

When cloud completion is awaited, or when the webhook reconciler later observes
a terminal task, Drift compares the resulting branch against the recorded
remediation plan and marks protected-path or out-of-scope file changes as
violations. If a deployment fires a cloud task and has no later reconciliation
mechanism, that run must be treated as fire-and-forget: review the branch/PR
manually rather than assuming local transactional guardrails were enforced.
