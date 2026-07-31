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
│   ├── package-manager.ts  Which tool owns a directory, and what it runs
│   ├── workspace.ts      Monorepo members, and where each package ends
│   └── ecosystems/       npm, python, go, cargo, maven, rubygems, toml
├── evidence/             Stage 2 — citable ground truth
│   ├── registry.ts       npm, PyPI, crates.io, Go proxy, Maven, RubyGems
│   ├── changelog.ts      CHANGELOG + migration guide retrieval and slicing
│   ├── releases.ts       GitHub release notes for a version range
│   ├── openapi.ts        Consumer-breaking spec diff engine
│   ├── type-surface.ts   TypeScript .d.ts API diff via the compiler API
│   └── surface/          Computed API diffs for cargo, go, maven, pypi
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
├── repo/                 RepoProvider seam — GitHub API or local git
└── runners/              Action, webhook server, entry points
```

The VS Code extension is a second front end over the same stages 1–6. It adds no
analysis of its own; everything below either drives the shared pipeline or renders
its output.

```
extension/src/
├── extension.ts          Activation, commands, wiring
├── analyze.ts            Picks a commit range, then calls analyzeRepository
├── upgrades.ts           Scans every detected registry and runs 1–5 per package
├── fix.ts                Branch, per-commit agent run, scoped commit
├── severity.ts           Repo-relative verdict. No imports — see below
├── labels.ts             Composer setting names. No imports
├── diff.ts               LCS line diff → hunks, for review
├── git.ts                The git commands the extension shells out to
├── checkpoint.ts         Pre-message tree snapshots, for rewind
├── session.ts            The panel transcript, context, and per-turn settings
├── history.ts            Past conversations, per workspace
├── state.ts              The status every surface renders from
├── github-auth.ts        VS Code's own OAuth, only where an identity is needed
├── review/
│   ├── store.ts          Pending edits; keep/undo per hunk, file, or group
│   └── ui.ts             Line tinting, per-hunk CodeLenses, native diff
├── agents/               One adapter per AI agent, plus discovery
└── ui/
    ├── home.ts           Panel controller — messages in, thread items out
    ├── webview.ts        Pure render function for the whole panel
    ├── report.ts         The full-page Drift Report
    ├── statusbar.ts      The status-bar item
    └── diagnostics.ts    Problems panel + code actions
```

`severity.ts` and `labels.ts` import nothing at all, and `webview.ts` imports no
`vscode`. That is load-bearing rather than tidy: it means the entire panel can be
rendered and asserted against in plain Node (`extension/test/panel.test.ts`),
which is the only automated check on several thousand lines of generated markup.

### The panel owns no widgets

`webview.ts` renders no `<select>`, and the test suite asserts it never will. A
form control inside a webview is drawn by the operating system: it ignores the
colour theme, it mis-centres its own label, and it has nowhere to put the
sentence explaining what an option does.

So every control in the composer — context, model, tools, effort, mode,
permission — opens one themed menu, drawn in the webview and anchored under the
button that summoned it. `home.ts` supplies it as data (`MenuSection[]`) and gets
back the id of whatever was chosen; the webview holds the open state, the filter
text and the drill-in, so opening a menu is a class change rather than a round
trip. The two native inputs left are the menu's filter box and the effort dial's
range input, both of which VS Code themes itself.

What is still handed to the host is the choice that is genuinely a search:
picking a file or folder to attach, where the editor's fuzzy path picker beats
anything a webview could draw. That one opens immediately as a live quick pick
over a path index warmed in the background, rather than after a project walk.

### Severity is repo-relative

One judgement, in one place, because the UI depends on getting it right:

| Severity | Meaning |
|---|---|
| `affected` | A breaking change matches code in this repository |
| `upstream-only` | Breaking changes exist; nothing here calls them |
| `clean` | No breaking change found for the target version |
| `error` | Drift could not finish checking |

Only `affected` earns colour, a notification, or a status-bar background. An
upstream breaking change that no local code calls is information, and presenting
it as an alert is how a tool trains people to dismiss it.

### Review is a proposal, not a commit

`fix.ts` snapshots every file in a commit unit *before* the agent runs, which is
the only way to get an honest baseline from a CLI agent that edits the working
tree itself. Afterwards, `review/store.ts` diffs snapshot against disk and holds
the result.

Keep and undo both shrink the diff to nothing, from opposite ends — keep moves the
baseline forward onto the new lines, undo moves the file back onto the baseline —
so there is never a half-resolved state to reason about. When a group has nothing
left, and only then, the store's commit handler commits exactly the files the plan
named for it. Hunks record their ranges on *both* sides precisely so that
resolving one cannot corrupt the line numbers of the others.

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

**Which manifest to read is a different question from which tool to run.**
`package-manager.ts` answers the second: it maps a directory listing to the
package managers that claim it, preferring lockfiles over manifests, and
produces the exact argv that installs a chosen version. Where two lockfiles
claim one ecosystem — the residue of a half-finished migration — that is
reported as an ambiguity for a human to settle rather than guessed at, because
guessing writes the wrong lockfile into someone's repository. Gradle has no
command that pins a version, and says so instead of running something that
changes nothing.

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

**API-surface diff, elsewhere** — the same question in five ecosystems, each
answered by that ecosystem's own tool, each returning the same `SurfaceChange[]`
so nothing downstream learns which produced it:

| Ecosystem | Tool | Weight | Reads |
|---|---|---|---|
| npm | TypeScript compiler API | 1.00 | published `.d.ts` |
| cargo | `cargo public-api` | 1.00 | rustdoc JSON |
| go | `go doc -all` in a scratch module | 1.00 | exported symbols |
| maven | `japicmp` | 1.00 | classfiles of both jars |
| pypi | `ast` in a Python subprocess | 0.90 | sources or `.pyi` stubs |
| rubygems | — | — | prose only |

Every one of these depends on a tool Drift does not ship. A missing toolchain is
an ordinary outcome with a stated reason — "`cargo public-api` is not installed"
and "that version was yanked" lead a developer to different actions, and
collapsing both into "could not check" throws that away.

Python sits at 0.90 on purpose, which caps a lone Python surface diff at
`medium` confidence. It is a reconstruction rather than a reading of what
shipped, and its known false negatives are: re-exports through `import *`,
symbols created at import time by a decorator or metaclass, and anything
conditional on the Python version or platform. Archives are downloaded and
unpacked, never installed — `pip download` would execute the package's own build
backend, and Drift does not run a third party's code to find out what is in it.

Ruby is deliberately absent. There is no reliable static public surface for a
gem, and forcing a low-confidence signal into the highest-weight slot is a lie
told by a number.

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

**The workspace boundary is the second precision lever.** A monorepo is many
projects sharing a checkout, not one project with many manifests. A bump in
`packages/api/package.json` is localized against `packages/api` alone — a
sibling that shares the dependency declares its own version and gets its own
analysis. The *index* stays repository-wide, so an import crossing a package
boundary still resolves; only the impact sites are scoped. Members are read
from `workspaces`/`pnpm-workspace.yaml`, Cargo `[workspace]`, `go.work`, Maven
`<modules>`, and Gradle `settings.gradle[.kts]`; a Cargo virtual manifest is
correctly *not* a member of its own workspace. Findings carry the member's
package name wherever a repository has more than one.

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

**Computed API diffs need a local toolchain.** Only npm's works with no
installed tool. Cargo, Go, Maven, and PyPI diffs degrade to prose evidence, with
the reason stated, when their tool is missing. RubyGems has no computed signal
at all.

**Go surfaces read the module root only.** `go doc -all` is run against the
module path, so an API that lives entirely in subpackages is not compared.
Grouped `const (...)` blocks are also not read.

**Behaviour changes are the weak spot.** A changelog saying "retries are now
exponential" has no symbol to search for and no compile error to catch. Drift
raises risk and flags these for humans rather than pretending to handle them.

**The webhook runner can't localize.** No checkout means no code to search. It
warns at runtime rather than silently reporting zero impact sites. The Action
doesn't have this problem.

**Workspace patterns are read literally.** Member globs support a literal path
and a trailing `*` or `**`. Anything more elaborate — brace expansion, mid-segment
wildcards, exclusions beyond a leading `!` — yields a missing member rather than
a wrong one, which is the direction that fails visibly.

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
