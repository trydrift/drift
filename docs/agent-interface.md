# The coding-agent interface

Drift produces one `RemediationPlan` per dependency change and renders it for two different readers.

| Reader | Surface | What it gets |
| --- | --- | --- |
| A person reviewing or approving | Pull request body, approval issue, check run, `drift analyze --markdown`, `drift explain` | Everything: every upstream breaking change, its evidence and citations, confidence tables, gaps, the review checklist. |
| A coding agent making the upgrade work | `plan_upgrade` over MCP, `drift analyze --agent` | Only what reaches this repository, inside a fixed size budget, with every omitted item resolvable by id. |

The principle:

> Drift stores the full evidence graph but only places locally actionable information in the coding agent's initial context. Full evidence remains available on demand.

## Why the two are separate

A coding agent re-reads its whole context on every turn of its loop. A document handed to it at the start is paid for once per turn, not once. The first development run of the [paired agent benchmark](../eval/agent/README.md) measured what happens when the human report is used as agent context: for an ESLint 8 → 10 upgrade the report was 499k characters describing 293 upstream breaking changes, 5 of which reached the repository. Drift found the right change and the right file in every trial, and the agent still consumed more input tokens with the report than without it (three cases, too few to publish a figure). That run is preserved in [`eval/results/agent/`](../eval/results/agent) as the reason this interface exists.

The human report did not get smaller. The agent got a different renderer.

## The agent brief

`buildAgentBrief(plan)` in [`src/agent-context/brief.ts`](../src/agent-context/brief.ts) is pure and deterministic, and it makes no new decisions: dispositions, confidence, blockers and gaps come from the stages that own them.

**Measured sites are real files.** A verification diagnostic becomes a measured site only if its path resolves, after symlinks, to a regular file inside the checkout and outside `.git`. Tool output that merely looks like `path:line` (Node's `test at test/files.test.js:1:1`, a stack frame) is dropped, and the regression points at the dependency's declaration instead. When verification ran, the build/typecheck/test gap says what it found (a measured regression, a pass, or why it could not run) rather than that no checks were run.

**What goes in.** An upstream breaking change is a finding in the brief when its disposition is `actionable` (a high-confidence located site, or a runtime requirement this repository was shown to violate) or `review-only` (located, but not confidently enough to act on), or when a planned commit unit addresses it. Measured regressions (compiler or test errors the project's own checks reported after the upgrade was installed) are always included, first, with the compiler's message on each line.

**What is counted instead.** Every other upstream change is left out and counted by reason: *no located usage* (the search finished and found nothing, which is not proof of safety), *not searched* (localization did not run or did not finish), and *unaffected*. The counts are broken down by kind. Evidence records are cited by id, never inlined.

**What is never dropped for size.** Protected paths, Drift's blockers, a summary of every gap, and the omission counts are reserved before any finding is placed. A blocker that only restates a listed gap is not repeated.

**Order.** Measured regressions; then actionable work in editable files, in the plan's commit order; then findings whose every site is a protected path; then review-only findings.

**Execution units.** Each commit unit becomes a unit with its goal, finding ids, files, symbols, dependencies on other units, expected checks and layer (units in the same layer have no ordering between them). Where a built-in codemod or an accepted fix plan covers sites deterministically, the unit states how many are covered, which residual sites are left, and whether any agent work remains (`agentWork: none | residual | all`). The brief applies nothing; it keeps work Drift already knows how to do out of the agent's request, and it keeps the shape that lets independent units be dispatched separately later.

**Upstream notes.** Titles and ids of the largest migration guides, changelogs and release notes Drift retrieved, so an agent can ask for Drift's copy instead of searching the web. Listed only when space remains after everything above.

## The budget

`renderAgentBrief(brief)` in [`src/agent-context/render.ts`](../src/agent-context/render.ts) fills to a target of 1,500 estimated tokens and never exceeds 2,000.

Drift ships no tokenizer and cannot know which model is reading, so the estimate is deliberately pessimistic: one token per three UTF-8 bytes. The ceiling is enforced in bytes.

- A finding is placed whole. If it does not fit, it is tried with its site list compacted to a few files and an exact total (`60 sites in 7 files`). If that does not fit either, it is left out and its id is named in the footer (the first 20 by name, the rest as a count). A finding is never cut part-way through.
- Findings that share one kind, state and exact site set are rendered once (three packages raising the same Node floor on the same fifteen workflow lines).
- Execution units and gaps are placed full if they fit the target, otherwise as one-line summaries; the gap summary is always present.
- If a pathological plan's reserved parts alone exceed the ceiling, the output is cut at a line with a statement that it was cut.

The regression tests in [`test/agent-context.test.ts`](../test/agent-context.test.ts) render the three plans from the first benchmark run and fail if any brief exceeds the ceiling or leaves out a locally relevant finding.

## Detail on request

Every id in the brief resolves against the same plan, including upstream changes the brief only counted.

| Call | Returns | Bound |
| --- | --- | --- |
| `get_finding <id>` | One finding: every site with its code excerpt, the required change, before/after signatures, its execution unit, protected files, gaps about its symbols, and related findings (a measured compiler error naming `TxData.v` links to the upstream change "`TxData.v` was removed", and back). | 2,000 tokens |
| `get_evidence` with a finding id | Only the lines of each cited record that name the finding's symbols, and the record's structured findings for those symbols. A type-surface diff describing 278 changes contributes the line about this one. For a measured finding, the failing checks' output. | 2,500 tokens |
| `get_evidence` with an evidence id | That record, paged by `offset`. | 2,500 tokens per page |

Unknown ids are errors that say what a valid id looks like.

## MCP tools

Served by `drift mcp` alongside `check_upgrades`, `explain_upgrade` and `check_installed`, which are unchanged and remain the tools for deciding *whether* to upgrade.

The server's MCP `instructions` (a few sentences, since a client includes them on every turn) say to call `plan_upgrade` first when asked to make an upgrade work, and `check_upgrades` / `explain_upgrade` when deciding whether to upgrade.

- **`plan_upgrade`** — the brief for the dependency change already in the checkout: an uncommitted manifest edit, else the last commit that touched a manifest, or an explicit `before`/`after`. Verified by default: Drift installs the change in a scratch worktree and runs the project's checks, which takes a minute or more and turns predicted locations into measured compiler errors. The plan is computed once per checkout and reused (`refresh: true` re-analyses), because once the agent edits `package.json`, re-detecting "the change in this checkout" would find the agent's own edit.
- **`get_finding`**, **`get_evidence`** — as above.
- **`verify_upgrade`** — runs the project's own build, typecheck and test commands in the working tree as it is now, including the agent's edits. Returns pass/fail per check, the first compiler errors, and each upgraded npm dependency's declared version (so a "fix" that moved the dependency back is visible). Full output goes to log files whose paths are returned. Unlike Deep Verification, nothing is installed or copied.

Tools return text by default. `format: "json"` (and `--json` on the CLI) returns a bounded structured view under the same ceiling. The object is returned both as `structuredContent` and as its text serialization, never alongside the prose: Claude Code 2.1.267 passes `structuredContent` to the model *instead of* a tool's text when both are present.

### Structured views are hard-bounded

No surface can exceed its budget by asking for JSON. Each structured view ([`src/agent-context/fit.ts`](../src/agent-context/fit.ts)) places an irreducible core, then its sections in a fixed priority order, each as a prefix of whole items, measuring the serialized object after every addition. Every list has an exact "not shown" count beside it; a core that cannot fit raises `AgentBudgetExceededError` instead of returning something larger. The prose is rendered from the same view, so text and JSON carry the same selection.

| Surface | Priority after the core |
| --- | --- |
| Brief | dependencies · protected files and blockers · findings · checks · gaps · execution units · upstream notes · ids of findings not shown |
| Finding | protected files · sites · units · evidence records · related findings · gaps · symbols · replacement symbols · before/after (as a pair) |
| Evidence | every record's identity · then an even share per record of structured findings and content (whole lines when narrowed; a page ending at a line, with `nextOffset` in characters, when paged) |

Safety comes before findings in the brief on purpose: an agent told where to edit but not what it must not edit is the worse failure.

### Which plan a call reads

The plan for the change detected in the checkout is held per directory and reused. A `plan_upgrade` with an explicit `before`/`after` is held separately under that range: it never replaces, and is never returned as, the checkout's plan, and its brief says which plan id to pass. `get_finding` and `get_evidence` read the checkout's plan, or exactly the plan named by `plan`. A `refresh` replaces its plan atomically — a refresh that finds no change clears it, so an older plan cannot stay reachable.

Two client behaviours worth knowing:

- Claude Code loads MCP tools on demand through its tool search, so the first Drift call in a session costs an extra step.
- `claude --safe-mode` disables MCP servers entirely, including ones passed with `--mcp-config`.

## CLI

```bash
drift analyze --agent                      # the brief
drift analyze --agent --json               # the brief as structured fields
drift analyze --finding bc_6843abffd2      # one finding in full
drift analyze --evidence bc_6843abffd2     # the evidence behind it
drift analyze --evidence ev_100f063a09 --offset 5784
```

Each invocation re-runs the analysis (seconds without `--verify`); the MCP server holds the plan instead. `drift fix` refuses these flags rather than ignoring them.

## Provenance

Nothing in the brief is new information. Each finding id is the plan's own `BreakingChange.id` (or the `measured:<ecosystem> <name>` key of the verification sites), its sites are the plan's impact sites, its evidence ids are the change's citations, and its unit ids are the plan's commit units. The same plan renders the pull request body, so any line of the brief can be traced to the report a reviewer sees, the evidence record, and its source URL.

## What is not claimed

This interface is being evaluated with the same paired benchmark that measured the report-as-context failure, on the same development cases, with the same success criteria. No token or success figure for it is published until a frozen, held-out suite passes the benchmark's publication gates.
