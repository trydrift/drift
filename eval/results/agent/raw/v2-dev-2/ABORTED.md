# v2-dev-2 — aborted, exploratory only

Started 2026-09-16 ~16:49 UTC as one of three parallel per-case runs (v2-dev-1 winston, v2-dev-2 @ethereumjs/tx, v2-dev-3 ESLint) for the agent-context-v2 comparison. Stopped at ~17:30 UTC after one completed trial (the first baseline repetition) because review of #321/#322 found implementation and experimental-design defects that affect what these runs measure:

- measured impact sites could still be built from non-path verification output (e.g. Node test-runner lines);
- JSON forms of the finding, evidence and brief surfaces were not hard-bounded;
- the MCP held-plan cache could serve a stale or cross-range plan;
- the brief could say "No checks were run" after verification ran;
- session isolation was not verified against a fresh config directory;
- the four-condition schedule used forward/reverse ordering, which biases position;
- wall-clock did not separate pre-session Drift analysis from the agent session;
- `compare` did not reject incompatible runs beyond the model.

The artifacts here are kept unmodified. They must never be pooled into, or presented as, the architecture-selection comparison. The corrected experiment uses new run ids.
