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
