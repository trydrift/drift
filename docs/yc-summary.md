# Drift — summary

## One line

Drift finds out which dependency updates actually break your code, proves it, and
drives the AI agent you already have to fix them — in your editor, or as a
reviewable pull request.

## The problem

Dependabot tells you a version number changed. It does not tell you whether your
code still works.

So one of three things happens: the PR sits open for weeks, or it gets merged on
faith, or an engineer spends an afternoon reading a changelog to find out. All
three are bad, and the third is the expensive one.

The gap is measurable. **Around 5% of npm packages have been broken by a minor or
patch release of a dependency**, and the majority of those breakages come from
changes to the package's public API — changes a version number, by definition,
cannot express.

Dependency updates are one of the few engineering tasks that are simultaneously
mandatory (security), frequent (weekly), low-status (nobody wants it), and
genuinely risky. That combination is why they pile up.

## What Drift does

Three questions Dependabot doesn't answer:

1. **What actually changed upstream?** Not the version — the API. Drift downloads
   the old and new TypeScript declarations and diffs the exported surface. It
   diffs OpenAPI specs. It reads release notes, changelogs, and migration guides.
2. **Does any of it affect this repository?** Which file, which line, which
   function. Drift builds an import graph and searches only the files that
   actually import the changed dependency.
3. **What's the fix?** A branch, separated commits ordered so build-enabling
   changes land first, and a pull request whose description cites every source it
   relied on.

It never merges anything.

## Two front ends, one engine

**A GitHub Action.** Runs on every dependency bump, files an issue with the plan,
and opens a pull request once approved. Zero infrastructure — see the business
model below.

**A VS Code extension.** The same six analysis stages, running locally, with no
token and no account, because nothing in the analysis needs one. This is the
distribution wedge: a developer can install it and get an answer in one minute
without talking to anyone or asking their org for permission.

The extension's panel is a conversation, the shape developers already know from
Copilot Chat and Claude. It leads with the number that decides what they do next —
*"3 of 14 upgrades affect code in this repository"* — and treats the other eleven
as safe, in neutral colour, because an alert that turns out to be nothing is how a
tool teaches people to dismiss it.

Fixes arrive as a proposal: written into the working tree so they can be read in
context, with Keep and Undo on every hunk, and nothing committed until a human
keeps it. When a decision is genuinely the developer's, Drift asks in the thread
and waits — and so can the agent, rather than guessing.

## Why it can be trusted

This is the whole product. An agent that edits production repositories has to
earn that, and most of Drift's design is about earning it.

**Evidence, not recall.** No finding exists without a citation — a changelog
entry, a release note, or a computed API diff, each with a URL. Drift structurally
cannot act on "I think this package changed." A semver bump alone is weighted
*below* the threshold at which Drift will dispatch anything.

**Computed diffs beat prose.** Changelogs lie by omission; the most common cause
of a "minor" upgrade breaking a build is a removal nobody wrote down. Diffing the
actual `.d.ts` catches it.

**Precision over coverage.** The research this builds on measured a
general-purpose coding agent on the same task: it removed 128 lines to get 22
right — 17.2% precision. A tool that fixes your breakage while rewriting 100
unrelated lines has handed you a bigger review, not a solution. Every guardrail in
Drift is a response to that number.

**Guardrails that downgrade, never drop.** A tripped guardrail turns an automatic
run into an approval request. You still see the work. Drift's intended failure
mode is asking too often — never editing code it shouldn't have.

**Evaluable with zero permissions.** `drift analyze` runs the entire pipeline and
prints the report without any write access at all. The best answer to "why should
I trust this?" is "don't — run it read-only first."

## Why now

Three things became true recently, and Drift needs all three:

1. **Coding agents can do the mechanical work.** GitHub Copilot's coding agent
   shipped a public API in 2026. The refactor was never the hard part.
2. **The hard part is knowing what to change** — and that's a retrieval and
   verification problem, not a generation problem. It's solvable deterministically.
3. **Supply-chain pressure made updates mandatory.** Teams can no longer defer
   dependency upgrades indefinitely, so the cost of the manual process is now
   being paid every week rather than deferred.

## Business model

Free, using the customer's own Copilot seat.

That's deliberate, and it's also what makes the architecture work. Because
GitHub's agent API requires a **user-scoped** token — Copilot is billed per seat —
the token stays in the customer's own repository secrets and Drift's
infrastructure never touches it.

Which means the MVP ships with **no backend, no database, and no authentication
system**. Not a corner cut: a deployment model chosen so the question doesn't
arise. It's also the answer every security reviewer wants — *"Where do you store
my token?" "We don't."*

Adoption cost is one workflow file and one secret. No sales call, no trial, no
data leaving the customer's boundary.

Monetisation comes later and from the org, not the individual: cross-repo
dependency risk dashboards, policy enforcement across an organisation, private
registry support, SLAs. The free tool is the wedge, and it's genuinely free
because the expensive part (inference) is already paid for by someone else.

## Status

Working MVP. Seven-stage pipeline complete, six package ecosystems, two front
ends, 132 tests, verified end to end against a real upgrade in a real repository.

Known limitations are documented rather than hidden — including single-hop
localization, npm-only computed diffs, and prompt injection via
attacker-influenced changelogs as mitigated rather than solved.
[docs/architecture.md § Known limitations](architecture.md#known-limitations)

## Technical differentiators

| | |
|---|---|
| **Computed API diffing** | Fetches both versions' `.d.ts` and diffs the exported surface with the TypeScript compiler. Catches undocumented removals. |
| **Consumer-direction OpenAPI diffing** | Reports only what breaks *callers* — tightened requests, loosened responses. Catches upstream service changes no package manager can see. |
| **Import-graph localization** | Search scoped to actual importers, not the whole repo. This is the precision lever. |
| **Meta-RAG index** | AST-aligned, adapted from arXiv:2510.03480 — with structural summaries instead of LLM-generated ones, so the core pipeline needs no model at all. |
| **Separated commits** | One per concern, dependency-ordered. `git revert` and `git bisect` stay meaningful. |
| **Zero-infrastructure deployment** | Runs entirely inside the customer's trust boundary. |
| **Agent-agnostic** | Drives Copilot, Claude Code, Codex, Gemini, Aider, OpenCode, or a local Ollama model. Drift ships no model and asks for no API key, so inference is already paid for. |
| **Repo-relative severity** | The judgement of whether a breaking change matters *here* is a single testable function, and only it earns colour or a notification. |
| **Hunk-level review** | Agent edits are held as a proposal with per-hunk Keep and Undo. The invariant — resolving one hunk cannot corrupt the others — is tested directly. |

## Research foundation

Built on *LLM Agents for Automated Dependency Upgrades* (arXiv:2510.03480),
which reports ~79.9% token reduction and 71.4% vs 17.2% precision against a
general-purpose agent baseline.

Drift adapts the Meta-RAG mechanism and departs in three places — computed
evidence instead of assumed migration guides, structural instead of LLM
summaries, and reviewable commits instead of a working tree. Each departure and
its reasoning is recorded in [docs/research.md](research.md).

## Try it

```bash
npm install -g drift
export GITHUB_TOKEN=ghp_...
drift analyze
```

Full pipeline, real report, nothing written.

Or, with no token at all:

```bash
cd extension && npm install && npm run package
```

Then open the Drift panel in any repository and type `/scan`.
