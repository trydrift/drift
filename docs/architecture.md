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
│       ├── go.ts         Module-cache fetch + per-package extraction
│       ├── go-apidump.ts The Go extractor, as embedded source
│       └── go-toolchain.ts  Toolchain probing and required-version lookup
├── analyze/              Stage 3 — evidence → breaking changes
│   ├── rules.ts          Deterministic mapping + prose patterns
│   └── llm.ts            Optional recall assist (off by default)
├── index/                Stage 4a — Meta-RAG
│   ├── walk.ts           Source discovery
│   └── metarag.ts        Imports, code units, structural summaries
├── localize/             Stage 4b — impact sites
├── rationale/            Stage 5 — why an upgrade is worth taking
│   ├── osv.ts            Known vulnerabilities, both versions compared
│   ├── maintenance.ts    Deprecation, archival, release recency, runtimes
│   ├── license.ts        License changes and policy, off by default
│   ├── summary.ts        Plain-English classification of upstream changes
│   └── assess.ts         The recommendation, as transparent rules
├── plan/                 Stage 6 — commits, risk, guardrails
├── dispatch/             Stage 7 — Copilot + approval flow
├── report/               Stage 8 — the Drift Report
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
| go | `go/build` + `go/parser`, run from a scratch module | 1.00 | every importable package, per platform |
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

**How the Go diff works, and why it is not `go doc`.** Drift writes a small
standard-library Go program into a scratch module and runs it against the module
cache. The program walks every importable package of the module — skipping
`internal`, `vendor`, and `testdata`, none of which a consumer can reach — and
records exported functions, methods, types, interfaces, struct fields, constants
and variables with their full signatures, type parameters included.

Three decisions are load-bearing:

- **`go mod download`, not `go get`.** The module is fetched by path and version
  with no build list, without resolving its own dependencies, and without
  touching the user's `go.mod`. The second look at a version Go already has is a
  cache hit and no network at all, and a module whose dependencies no longer
  resolve is still analysable because Drift reads its source rather than
  building it.
- **Parsing, not type-checking.** The predecessor ran `go doc -all` against the
  module root, which prints nothing for a module whose API lives in subpackages.
  That is the shape of `golang.org/x/sys`, `golang.org/x/net`, and most of the
  ecosystem, so the check reported "no public surface" precisely where it was
  most needed.
- **Three platforms, not one.** Go's build constraints make the exported API a
  function of GOOS and GOARCH. `golang.org/x/sys/windows` does not exist on
  Linux and half of `unix` does not exist on Windows, so a single-platform
  comparison would find both sides empty — invisible rather than wrong, which is
  worse. A symbol that loses a platform is reported as a removal that names the
  platform.

What it deliberately does *not* report matters as much. A removed package is one
finding, not the four hundred symbol removals underneath it. A method that
vanished with its type intact is reported once, through the type. Bulk constant
churn from a regenerated platform header collapses into a single counted line.
One unparseable package is recorded and skipped, never fatal.

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

### 5 · Rationale

The other half of the question. Every stage above answers *what might this
break?*, which is the harder half and the more useful one — but on its own it is
a machine that only ever argues against upgrading, and a tool that never finds a
reason to move is a tool people stop opening.

Four sources, each attached to a specific upgrade rather than collected into a
dashboard. Drift is not becoming a scanner:

| Source | Answers | Off switch |
|---|---|---|
| OSV | Does taking this improve, preserve, or worsen known exposure? | `rationale.security` |
| Registry + GitHub | Deprecated, archived, retracted, yanked, raised runtime minimum | `rationale.maintenance` |
| Release notes | What the maintainer said changed, classified | `rationale.summary` |
| Registry license fields | Did the license change, and does it violate a configured policy? | `licenses.enabled` (off by default) |

**OSV is queried for both versions**, because the answer lives in the
difference. A target that fixes three advisories and introduces one is a
trade-off worth showing, and asking only about the installed version hides it.
Advisories are merged across their aliases — the single HTTP/2 flaw OSV returns
as `GO-2024-2687`, `GHSA-4v7x-pqxf-cx7m`, and `CVE-2023-45288` is one finding —
and matched between the two queries on identifier sets rather than primary ids,
because which record OSV leads with varies per query.

**Maintenance states facts and refuses to score.** There is no health metric,
deliberately. A mature library can go eighteen months without a commit because it
is finished, and a score that reads that as decay talks teams out of dependencies
that were never a problem — while a package that ships weekly and was archived
yesterday scores beautifully right up until it stops. Exactly three things are
marked concerning: the maintainer said stop, the repository is archived, or the
proposed version is itself withdrawn.

**Summaries are classified, never generated.** Every line is a sentence a
maintainer published, trimmed and sorted. A line the classifier cannot place
becomes an "improvement" — the weakest label available — and it never promotes a
line to breaking or security without the maintainer having used those words.
Performance claims appear only where someone made one; "newer is probably
faster" is a guess, and a guess printed beside a computed API diff borrows
credibility it has not earned.

**The recommendation is a ladder of rules, not a score.** Six outcomes — safe to
upgrade, upgrade recommended, upgrade after review, manual migration required,
insufficient evidence, do not upgrade yet — decided in an order that encodes a
priority: *don't make things worse* beats *fix your code* beats *take the
security fix* beats *this is fine*. Every rule that fires records the sentence it
fired with, and those sentences are the output. A developer who disagrees with
`0.72` has nothing to push back on; one who disagrees with "one change requires a
decision about behaviour" can point at it and say why.

`insufficient-evidence` is checked *last* among the negative outcomes, so a real
finding — which proves something was readable — always outranks the absence of
others. A surface diff that ran and found nothing counts as having looked;
"Drift checked and this is clean" and "Drift could not check" are different
sentences and only one of them is reassuring.

**Gaps are assembled in one place and deduplicated.** This is what stops the
report printing the same missing toolchain twice, once as the failure and once
as the summary that restates it.

### 6 · Plan

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

### 7 · Dispatch

See [copilot-integration.md](copilot-integration.md).

Drift creates the branch itself, pinned to the analysed commit; if the branch
moved underneath us the impact sites would no longer be trustworthy.

### 8 · Report

Two rules: every claim carries a link to its evidence, and uncertainty is stated
in the same place as the confident findings. Burying caveats at the bottom is how
you teach people to stop reading your output.

---

## Confidence in three dimensions

A single confidence field had to answer two unrelated questions at once: *did
this change happen upstream?* and *does it break this repository?* Those have
different evidence and routinely different answers. A machine-computed `.d.ts`
diff settles the first about as well as anything can while saying nothing at all
about the second.

Collapsing them produced one specific over-claim — a `high` earned entirely on
upstream grounds, read by a human as "safe to apply", attached to a local claim
nothing had verified. So they are now scored separately, by one calculation in
`confidence/calibrate.ts`.

| Dimension | Question | Evidence |
|---|---|---|
| `upstream` | Did this change really happen? | Retrieved release evidence, weighted by origin class |
| `localImpact` | Does it reach code here? | Import edges, symbol binding, reachability qualifiers |
| `verification` | Did anything run to confirm it? | Which checks ran, whether they passed, what they cover |

Each carries a 0–1 score, a display band, the contributions and penalties that
produced it, and the calibration version — so a report can show its working
instead of asserting a band.

**Corroboration counts independent origins, not records.** A GitHub release body
and a CHANGELOG entry are routinely the same text published twice; counting them
as two agreeing sources took a single unverified maintainer sentence to `high`.
Evidence is grouped into origin classes — computed artifact, migration guide,
maintainer narrative, registry, heuristic — and byte-identical content collapses
regardless of declared source.

`automaticExecutionEligible` is derived and is false whenever any dimension is
unestablished. Absence of evidence is never eligibility.

### The taxonomy

`BreakingChangeKind` stays what it always was: the remediation-strategy field.
Alongside it, `ChangeTaxonomy` answers four questions that field could not:

- **nature** — what sort of contract broke
- **detectability** — what would have to run to notice
- **scope** — how much surface it covers
- **visibility** — how a consumer reaches it

`detectability` is the one that earns its keep. A removed export and a changed
default are both "breaking", but one stops the build and the other ships quietly
and misbehaves in production. Reporting them at the same severity is how a tool
teaches people its warnings are interchangeable noise.

Classification is deterministic — a lookup on the finding code where a computed
differ produced one, falling back to a `kind` mapping. An LLM may *propose* a
taxonomy but never define one: anything outside the closed vocabulary is dropped
in favour of the deterministic mapping rather than coerced to the nearest label.

### Gaps: unchecked is not clean

Everything Drift could not establish is a first-class record on the plan, not
prose in `warnings`. Each says what went unchecked, how much it matters, and
what it means for acting automatically.

This is the rule the whole model serves: **"searched and found nothing" and
"could not search" produce the same empty list and mean opposite things.** They
get different sentences everywhere they surface — the Markdown report, the
Action summary, the extension panel.

Reports avoid the word "safe". A finding is described as one of:

- no incompatible change detected in the checked surfaces
- incompatible change detected upstream, but not locally reachable
- this repository is affected
- insufficient evidence to say
- verification incomplete

---

## State

Almost all durable state lives in GitHub:

| State | Where |
|---|---|
| Pending approvals | Issues labelled `drift` |
| The approval itself | A `/drift apply` comment |
| Which plan was approved | A machine-readable footer in the issue body |
| Whether it already ran | A dispatch marker in a Drift-authored comment |
| Fix in progress | The branch and the Copilot task |
| Configuration | `.github/drift.yml` |
| Credentials | Repository secrets |

Re-running the same analysis on the same commit reproduces the same plan, so
Drift asks GitHub "have I already filed this?" instead of consulting a database.

The Action and the CLI store nothing at all. The self-hosted webhook runner is
the one exception: it keeps a local queue of accepted deliveries, because a
`202` to GitHub is a promise it cannot otherwise honour across a restart. See
[deployment](deployment.md#the-delivery-queue).

### Approving a plan

`/drift apply` is the one comment that causes code to be written, so it is
treated as a privileged operation. An approval is honoured only when **all** of
the following hold:

| Check | Why |
|---|---|
| The comment is newly created, on an issue, not a PR | An edit to an old comment is not a new decision |
| The issue carries the `drift` label | Provenance. Anyone can paste a footer into an issue they opened; applying a label needs triage permission, so forging provenance costs at least as much access as approving does |
| The footer parses strictly | Every key present exactly once, full 40-character SHAs, a known schema version |
| The commenter has `write`, `maintain`, or `admin` | Not issue author, not org member, not read access |
| The reviewed commit still exists, and the base branch has not moved | The impact analysis describes one commit |
| The recomputed plan digest matches the recorded one | The plan being executed is the plan that was read |
| No dispatch marker for this digest already exists | A repeated approval is a no-op, not a second branch |

Every one of these fails closed. An unavailable permissions API is a refusal,
never an assumption.

**Why a digest, not just the plan ID.** Plan IDs are derived from
`owner/repo/commit`, so two genuinely different analyses of one commit share an
ID. Approving an ID would approve whichever plan happened to be computed at
execution time. The digest is a SHA-256 over a canonical serialization of the
whole plan — findings, impact sites, commit units, and the quoted evidence —
with volatile fields such as `createdAt` excluded so it is stable across runs.

A digest mismatch is not a bug: it means the evidence changed after the plan was
filed, so what a human approved is no longer what would run. Drift says exactly
that and asks for a fresh plan.

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
