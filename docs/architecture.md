# Architecture

Drift is a pipeline of seven transforms over a small domain model. Each stage has
one job, produces a typed artifact, and can be used on its own.

```
DependencyChange[]   detect      what versions moved
       ↓
Evidence[]           evidence    what changed upstream, with citations
       ↓
BreakingChange[]     analyze     which upstream changes break consumers
       ↓
ImpactSite[]         localize    where in *this* repo they bite
       ↓
RemediationPlan      plan        ordered, separated commit units + risk + guardrails
       ↓
DispatchResult       dispatch    branch + Copilot task + PR, or an approval issue
```

The ordering is the discipline: establish what changed and where it lands
*before* deciding anything, and decide before acting. Nothing reaches a coding
agent that can't be traced to a citation and a line number.

## Layout

```
src/
├── types.ts              Domain model — every stage speaks this
├── pipeline.ts           Orchestrator
├── config/               drift.yml schema and loading
├── detect/               Stage 1 — manifest diffing
│   ├── version.ts        Semver normalisation across ecosystems
│   └── ecosystems/       npm, python, go, cargo, maven, rubygems, toml
├── evidence/             Stage 2 — citable ground truth
│   ├── registry.ts       npm, PyPI, crates.io, Go proxy, Maven, RubyGems
│   ├── changelog.ts      CHANGELOG + migration guide retrieval and slicing
│   ├── releases.ts       GitHub release notes for a version range
│   ├── openapi.ts        Consumer-breaking spec diff engine
│   └── type-surface.ts   TypeScript .d.ts API diff via the compiler API
├── analyze/              Stage 3 — evidence → breaking changes
│   ├── rules.ts          Deterministic mapping + prose patterns
│   └── llm.ts            Optional recall assist (off by default)
├── index/                Stage 4a — Meta-RAG
│   ├── walk.ts           Source discovery
│   └── metarag.ts        Imports, code units, structural summaries
├── localize/             Stage 4b — impact sites
├── plan/                 Stage 5 — commits, risk, guardrails
├── dispatch/             Stage 6 — Copilot + approval flow
├── report/               Stage 7 — the Drift Report
├── github/               Octokit wrapper
└── runners/              Action, webhook server, entry points
```

---

## Stage notes

### 1 · Detect

Parsers implement one interface and are **total functions**: malformed input
returns what could be read rather than throwing. A half-rebased lockfile must not
take down a run.

Two decisions worth knowing:

- **Manifest beats lockfile.** The same bump appearing in `package.json` and
  `package-lock.json` is one change, reported against the manifest — which records
  what a human decided and knows whether the dependency is `runtime` or `dev`.
- **Triage records a reason for everything it skips.** Drift never silently drops
  a dependency change; unexplained silence is indistinguishable from a bug.

`0.x` minor bumps bypass the `minor` toggle, because semver §4 makes them
breaking and that's a common source of surprise.

### 2 · Evidence

Six sources, weighted 1.00 (computed diff) down to 0.25 (semver guess). The
weighting encodes the central bet: **computed diffs beat prose, prose beats
guessing.**

**Type-surface diff** — fetches the old and new `.d.ts` from jsDelivr and diffs
exported declarations using the TypeScript compiler's own parser (overloads,
generics, and multi-line signatures are exactly what breaks naive matching).
Declarations are *fetched*, not installed: the old version is gone from
`node_modules` after the upgrade, and fetching means never executing a
third-party install script.

**OpenAPI diff** — reports only consumer-breaking direction. Tightening what a
server accepts (new required field, narrowed request enum) or loosening what it
returns (removed field, widened response enum) breaks callers. The mirror cases
are safe and are deliberately not reported: flooding a plan with non-findings a
reviewer must filter is how trust in a tool like this dies.

Only removals and tightenings are reported, everywhere.

### 3 · Analyze

Rules run first and unconditionally. Prose patterns fire **only on
backtick-quoted identifiers** — maintainers reliably code-format API names, and
requiring the backticks is what stops ordinary English words becoming search
symbols.

Confidence: computed diffs start `high`; prose starts `medium`; corroboration
across two independent sources promotes to `high`.

The LLM pass is fenced in on purpose — off by default, runs last, never overrides
a rule, capped at `medium` (so it alone can't clear the dispatch gate), told to
use only supplied evidence, and any finding whose evidence ID can't be verified
is **dropped rather than downgraded**.

### 4 · Localize (Meta-RAG)

An AST-aligned index of imports, code units, and signatures — Drift's adaptation
of the paper's Meta-RAG, with structural rather than LLM-generated summaries
(see [research.md](research.md)).

**The import graph is the precision lever.** A file that never imports `express`
cannot be broken by an `express` change, however many times `Router` appears in
it. Endpoint changes are the exception — HTTP calls have no import edge — and
fall back to a repo-wide search where URL-path symbols are specific enough.

Per-site confidence: `high` when the symbol was actually bound from that import,
`medium` when the file imports the dependency, `low` when no import link could be
established.

Package name ≠ import name often enough to matter (`beautifulsoup4` → `bs4`), so
there's an explicit alias table.

### 5 · Plan

One commit per concern, ordered in three tiers:

1. **Make the build possible** — runtime requirements, config
2. **Mechanical edits** — removed and renamed exports, endpoints
3. **Judgement calls** — signature, type, behaviour, default changes

Later tests can't pass until the toolchain matches, and a reviewer should read
the boring diffs first so their attention lands where it's needed.

Each commit's instructions are **scoped to its own files**. Without that scoping
the agent fixes everything it notices in one pass and the commit boundaries
collapse.

Risk is driven by what Drift is asking to *change* in the repository, not how
alarming the upstream release sounds. The UI calls this **repo risk** on purpose:
an upstream breaking change can be real and still have `none` repo risk when
Drift found no matching local usage and planned no edit. Behaviour and default
changes score highest once they overlap local code: the code compiles either
way, so neither the type checker nor a smoke test catches a wrong fix.

**A guardrail blocker downgrades the run to approval-required — it never discards
the plan.**

### 6 · Dispatch

See [copilot-integration.md](copilot-integration.md).

Drift creates the branch itself, pinned to the analysed commit; if the branch
moved underneath us the impact sites would no longer be trustworthy.

### 7 · Report

Two rules: every claim carries a link to its evidence, and uncertainty is stated
in the same place as the confident findings. Burying caveats at the bottom is how
you teach people to stop reading your output.

---

## Statelessness

Drift stores nothing. All durable state lives in GitHub:

| State | Where |
|---|---|
| Pending approvals | Issues labelled `drift` |
| The approval itself | A `/drift apply` comment |
| Which commit was analysed | An HTML comment in the issue body |
| Fix in progress | The branch and the Copilot task |
| Configuration | `.github/drift.yml` |
| Credentials | Repository secrets |

The keystone is that **plan IDs are content-derived**. Re-running the same
analysis on the same commit produces a byte-identical plan with the same ID, so
Drift can ask GitHub "have I already filed this?" instead of consulting a
database it doesn't have.

---

## Known limitations

Stated plainly, because a tool that hides these hasn't earned trust.

**Localization is single-hop.** Drift finds direct usage of a changed symbol. If
you wrap a dependency in your own abstraction and use *that* everywhere, Drift
flags the wrapper — correct, and the right place to fix it, but it won't trace
downstream consequences through your own indirection.

**Non-JS/TS parsing is pattern-based.** Only TypeScript and JavaScript get real
AST parsing. Python, Go, Rust, Java, and Ruby use declaration-line matching, so
enclosing-symbol attribution can be wrong in unusual formatting. The file and
line are always exact; the symbol is a convenience.

**Type-surface diffing is npm-only.** No equivalent computed signal exists yet
for PyPI, Cargo, Maven, or RubyGems, so those rely on prose evidence.

**Behaviour changes are the weak spot.** A changelog saying "retries are now
exponential" has no symbol to search for and no compile error to catch. Drift
raises risk and flags these for humans rather than pretending to handle them.

**The webhook runner can't localize.** No checkout means no code to search. It
warns at runtime rather than silently reporting zero impact sites. The Action
doesn't have this problem.

**Monorepos are handled naively.** All manifests are analysed together; Drift
doesn't model workspace boundaries, so a change in one package can surface impact
sites in a sibling that shares the dependency.

**No verification of Copilot's output.** Drift dispatches and reports; it does
not currently poll the task to completion and check CI. The scaffolding
(`getTaskStatus`, `isTerminalState`) exists for it.

---

## Extension points

**A new ecosystem** — implement `ManifestParser` in `src/detect/ecosystems/`,
register it in `PARSERS`. Add import extraction in `metarag.ts` and any
distribution→module aliases in `localize/index.ts`.

**A new evidence source** — return `Evidence[]` from `gatherEvidence`, with a
weight that honestly reflects how directly it speaks to breakage. Populate
`findings` if you can compute structure.

**A different coding agent** — `dispatchToCopilot` is the only Copilot-specific
code. `buildTaskPrompt` produces plain markdown that any agent can consume.
