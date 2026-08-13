# Drift

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/trydrift/drift/badge)](https://scorecard.dev/viewer/?uri=github.com/trydrift/drift)

[![CI](https://github.com/trydrift/drift/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/trydrift/drift/actions/workflows/ci.yml)

**Your dependency updated. Did it break your code? Drift finds out, shows the evidence, and prepares the fix.**

Drift watches dependency changes in your repositories, works out which upstream
changes actually break *your* code, and fixes them — deterministically when it
can prove the fix correct, via a community recipe when one applies and you've
enabled it, and with GitHub Copilot otherwise — in a branch, in separated
commits, in a pull request you review.

It never merges anything.

```
dependency bump → what changed upstream? → where does it bite here? → is it worth it? → fix it
     detect             evidence                  localize              rationale       dispatch
```

---

## The problem

Dependabot tells you a version number changed. It does not tell you whether your
code still works. So the PR sits there, or it gets merged on faith, or someone
spends an afternoon reading a changelog.

The gap is real: **minor and patch releases break consumers often enough that
nobody sensible trusts a version number**, and the breakages that matter come
from changes to a package's public API — changes a version number, by
definition, cannot express.

Drift closes that gap. It answers four questions Dependabot doesn't:

1. **What actually changed upstream?** Not the version number — the API.
2. **Does any of it affect this repository?** Which file, which line, which function.
3. **Is it worth taking anyway?** Which advisories it closes, whether the package
   is still maintained, what the maintainer says you gain.
4. **What is the fix?** Written, committed, and explained.

**Dependencies change. Your codebase should adapt.** That's the direction
this is built toward — see [docs/vision.md](docs/vision.md).

## What makes it trustworthy

An agent that edits your repository unsupervised has to earn that. Drift's design
is mostly about that problem:

| | |
| --- | --- |
| **Evidence, not recall** | Every finding cites a changelog entry, a release note, or a computed API diff you can click. Drift never asks an agent to act on "I think this package changed." |
| **Computed diffs beat prose** | Drift downloads both versions and diffs the actual exported API — `.d.ts` for npm, every importable package at three platforms for Go, rustdoc for cargo, ECMA-335 metadata read straight out of a `.nupkg` for .NET, public headers for C and C++, published `lib/` for Dart, every `def` and `-export` for Elixir and Erlang. Changelogs omit removals; the shipped artefact doesn't. |
| **Static wherever the ecosystem allows it** | Most artefacts are fetched and parsed, never installed or built — `pip download` runs a build backend and a `.nupkg` can carry an install script, so Drift opens the archive instead. Cargo is the one exception: rustdoc only emits its JSON API description for a crate that's actually built, so Drift compiles each version in a throwaway probe crate in an isolated temp directory to get it. Every other computed surface in the table above is read from the published artefact without executing it. |
| **Benefits need a citation too** | The upgrade rationale reports which advisories a version closes and what its maintainer says improved, each linked. A benefit Drift can't cite is a benefit Drift doesn't mention. |
| **Rules, not scores** | The recommendation is a ladder of `if` statements that each record the sentence they fired with. You can disagree with a sentence; you can't disagree with `0.72`. |
| **Import-graph precision** | A file that never imports `express` cannot be broken by an `express` change. Drift searches importers, not the whole repo — following your own barrel files to the code one edge past them — and the names it searches for are read from the package's published artefact rather than guessed. A name this file bound from a *different* package, or declared itself, is not a finding. |
| **Separated commits** | One commit per concern, ordered so build-enabling changes land first. `git revert` and `git bisect` stay meaningful. |
| **Guardrails that downgrade, never drop** | A tripped guardrail turns an automatic run into an approval request. You still see the work. |
| **Approval by default** | Fresh installs analyse and ask. Autonomy is opt-in. |
| **Read-only evaluation** | `drift analyze` runs the full pipeline and prints the report without any write permission at all. Try it before you trust it. |

Drift's intended failure mode is asking you too often. Not editing code it shouldn't have.

---

## Quick start

### 1. Add the workflow

> **Not released yet** — `uses: trydrift/drift@v0` will not resolve until a
> `v0.1.0` tag is pushed and the `v0` tag is moved to it (see
> [`.github/workflows/release.yml`](.github/workflows/release.yml)).
> Until then, reference your own fork, or see
> [testing on a real repo](docs/testing-on-a-real-repo.md).

Copy [`examples/workflows/drift.yml`](examples/workflows/drift.yml) to
`.github/workflows/drift.yml`.

### 2. Add the Copilot token

Drift needs a **user-scoped** token to invoke Copilot on your behalf. GitHub's
agent API rejects the built-in `GITHUB_TOKEN` and any GitHub App installation
token, because Copilot is billed per seat and GitHub needs to know whose seat is
being spent.

Create a fine-grained PAT with **Agent tasks: read and write** (plus the
mandatory **Metadata: read**), then save it as the repository secret
`DRIFT_COPILOT_TOKEN`. That is the only permission the Agent Tasks API checks —
everything else Drift does runs on the workflow's built-in `GITHUB_TOKEN`.

The endpoint is in public preview and GitHub decides which Copilot plans may
call it; if you get a 403, check
[the endpoint docs](https://docs.github.com/en/rest/agent-tasks/agent-tasks)
before assuming Drift is misconfigured.

The token lives in your repository secrets. Drift reads it from the environment at
run time and sends it only to `api.github.com`. It is never stored anywhere else —
[which is why Drift needs no database](docs/copilot-integration.md).

### 3. (Optional) Configure

Copy [`examples/drift.yml`](examples/drift.yml) to `.github/drift.yml`. Every value
is a default, so skipping this is fine. Or build one from the site's `/configure`
page — pick your options and download a ready-to-commit `drift.yml` and workflow.

### 4. Watch it work

Next time a dependency changes, Drift opens an issue with the plan. Comment
`/drift apply` to let it proceed, or set `mode: auto` once you've read a few.

Applying a plan writes a branch and dispatches a coding agent, so it requires
`write`, `maintain`, or `admin` permission — and Drift re-verifies that the plan
it is about to run is byte-for-byte the one recorded on the issue before it acts.
See [trust and safety](docs/trust-and-safety.md#an-unauthorized-user-comments-drift-apply).

### 5. (Optional) See it in the Security tab too

Every plan — breaking or not — can also be uploaded as a code scanning alert,
one per affected package, listing every place its breaking changes are used,
with the same evidence and fix a pull request would carry: which advisories it
closes, where the code that breaks lives (including which workspace, in a
monorepo), and either the exact command for a safe upgrade or the
deterministic fix Drift will make once approved. On by default; turn it off
with `codeScanning.enabled: false`. Rescanning replaces a package's alert
rather than piling up a new one — GitHub retires an alert on its own once the
finding that produced it stops reappearing in a later run.

To also get alerted about dependencies nobody has bumped yet — not just what
changed in the last push — copy
[`examples/workflows/drift-outdated.yml`](examples/workflows/drift-outdated.yml)
and set `outdated.enabled: true`. See [configuration.md](docs/configuration.md#code-scanning).

---

## Try it with zero permissions

> **Not published to npm yet.** `npm install -g @usedrift/cli` will work once
> [`release.yml`](.github/workflows/release.yml) has run against a tag. Until
> then, clone this repo, run `npm install && npm run build`, and use
> `node dist/cli.js` in place of `drift` below.

```bash
npm install -g @usedrift/cli
drift analyze
```

Runs the full pipeline against your working tree and prints the report. Creates no
branches, no issues, no agent tasks — there is no code path in `analyze` that
writes anything.

No token, and no account. `analyze` reads your local checkout directly and
fetches public release notes, changelogs and registry metadata anonymously.
`drift outdated` is the same: read-only, and tokenless. A credential is worth
setting only if you hit GitHub's anonymous API rate limit mid-scan, in which
case Drift picks one up on its own from `$GITHUB_TOKEN` or a signed-in `gh`:

```bash
export GITHUB_TOKEN=ghp_...   # optional — only raises the API rate limit
```

Once you're ready to act on the plan:

```bash
drift fix   # deterministic fix, then a community recipe (if enabled), then AI — never silently
drift pr    # push the branch `fix` built and open a pull request
```

These two do need GitHub write access, because they push a branch and open a
pull request. Drift takes it from `$GITHUB_TOKEN` or `--token`, then from a
signed-in `gh`, and only as a last resort offers a browser sign-in — it never
asks you to paste a token first. Copilot remediation is separate again, and
wants `DRIFT_COPILOT_TOKEN`; nothing else uses it.

`fix` runs entirely in an isolated git worktree, so your working tree is
never touched, and it never merges or force-pushes. See `drift fix --help`
(via `drift --help`) for flags, including `--community-recipes` /
`--no-community-recipes` for non-interactive/CI use.

---

## See it work first

[**trydrift.github.io/Drift**](https://trydrift.github.io/Drift/) replays real
Drift runs against Supabase, Scrapy, GitLab, Kubernetes, Deno and Elasticsearch
— every dependency, every finding, and every progress event with the timestamp
it actually happened at. Not a mock-up: the commit each run was taken against is
linked, so you can check it. Built from [`site/`](site/).

---

## VS Code, CLI, or Action — which one?

All three share the same analysis pipeline and the same remediation priority
(Drift's own deterministic fix, then a community recipe if one applies and is
enabled, then an AI agent) — they differ in where that runs and who's driving.

One caveat worth stating plainly: *the same pipeline* is not *the same result*.
Drift's strongest evidence for several ecosystems needs that ecosystem's own
toolchain present, so a runner without Go installed gets release notes and
changelogs where your laptop got a computed API diff. Drift says so in the
report rather than quietly reporting less, and the shipped workflow carries
commented-out setup steps for Rust, the JVM, .NET and Python next to the Go one
it enables by default. Add the ones your repository needs.

| | Best for | Needs |
| --- | --- | --- |
| **VS Code extension** | Working a dependency bump interactively, reviewing every edit before it lands | Nothing — no token, no account, for analysis. A Copilot/Claude/etc. session only if a commit needs an agent. Pushing uses whatever credential git already pushes with; a signed-in `gh` or a GitHub sign-in only if you want Drift to open the pull request for you |
| **CLI (`drift fix`)** | Scripting a fix locally or in a bespoke CI job, outside GitHub Actions | Nothing for `analyze` and `outdated` — credentials only raise the GitHub API rate limit. GitHub write access (a signed-in `gh`, `$GITHUB_TOKEN`, or `--token`) to push and open a pull request. A Copilot token only if some commit needs an agent |
| **GitHub Action** | Unattended, on every dependency bump, with review via a PR or an approval issue | `DRIFT_COPILOT_TOKEN` repo secret (only required once a commit actually needs an agent) |

They don't behave identically. What each surface actually does:

| Capability | VS Code | CLI | GitHub Action |
| --- | --- | --- | --- |
| Scan for available upgrades | Yes (`/scan`) | Yes (`drift outdated`) | No — it runs on a dependency change, not on a schedule |
| Analyse a dependency change that already happened | Yes | Yes (`drift analyze`) | Yes |
| Evidence / localization | Yes | Yes | Yes |
| Deterministic remediation | Yes | Yes (`drift fix`) | Yes |
| External recipes | Yes — asks before using one | Yes — opt-in flag or interactive prompt | Yes, but only if `remediation.communityRecipes: true` in `drift.yml` — it cannot prompt |
| AI remediation | Yes — Copilot, Claude Code, Codex, Gemini, Aider, OpenCode, or local Ollama | Yes — GitHub Copilot coding agent only | Yes — GitHub Copilot coding agent only |
| Interactive hunk-level review | Yes — Keep/Undo per hunk before committing | No — reviewed as a PR after the fact | No — reviewed as a PR or approval issue |
| Create branch / commit | Yes | Yes | Yes |
| Create PR | Yes — directly, when an authenticated GitHub CLI or GitHub sign-in is available; otherwise it pushes the branch and opens GitHub's pull request page | Yes (`drift pr`) — directly | Yes — files an approval issue by default, and creates or dispatches the PR after approval, or straight away under `mode: auto` |

---

## Or use it in your editor

The same engine ships as a VS Code extension that needs **no tokens and no
account**, because nothing in the analysis requires one. See
[`extension/`](extension/).

```bash
cd extension && npm install && npm run package
```

The panel is a conversation with a composer, the shape Copilot Chat and Claude
use. Type `/scan` and it checks every dependency for a newer version, naming each
step as it goes, then answers the question that actually matters:

> **3 of 14 upgrades affect code in this repository. The other 11 are safe to take as-is.**

That distinction is the point. A package can have seven breaking changes and still
be a five-second upgrade for you, because your code never calls the parts that
changed — so Drift reports it in neutral colour with the upstream detail one click
away. Colour and notifications are reserved for changes that land on a file here.

`/fix` hands the affected code to whichever AI agent you already have — Copilot,
Claude Code, Codex, Gemini, Aider, OpenCode, or a local Ollama model. Its edits
arrive as a **proposal**: written into the working tree so you can read them in
context, tinted, with **Keep** and **Undo** on every hunk, and nothing committed
until you keep it. Keeping a group commits exactly the files the plan named for
it.

When a decision is genuinely yours — two valid migrations, a dirty working tree —
Drift asks in the thread and waits, and the agent can raise a question the same
way instead of guessing.

Shipping is explicit and separate. Drift pushes the reviewed branch with the
credential git already has, then raises the pull request: directly through the
GitHub CLI when you have `gh` installed and signed in, and otherwise by opening
GitHub's own pull request page for the branch. `gh` is a shortcut, never a
requirement — the branch is pushed either way. Drift never force-pushes and
never merges.

---

## How it works

A pipeline of independently testable stages, one directory per stage in `src/`.
Each can legitimately produce nothing — most dependency bumps genuinely don't
break you, and saying so quickly is a feature.

### 1 · Detect

Diffs manifests and lockfiles across sixteen ecosystems: **npm/pnpm/yarn/bun,
pip/poetry/uv, Go modules, Cargo, Maven/Gradle/sbt, Bundler, NuGet, Composer,
Mix, pub (Dart & Flutter), Swift Package Manager, CocoaPods, opam, Conan,
vcpkg, and Arduino/PlatformIO**.

The work is in the cases a regex gets wrong. .NET Central Package Management
means a `.csproj` carries no versions at all. `"org" %% "artifact"` in sbt
depends on `artifact_2.13`, not `artifact`. A pubspec entry sourced from an SDK,
a git ref, or a path pins nothing, and Composer's `require` mixes real packages
with platform constraints like `php` and `ext-mbstring`. Each of those yields
*no version* rather than a wrong one — a missing version reports no upgrade, a
wrong one sends the fix stage editing a dependency that was never there.

Parsers never throw: a half-rebased lockfile degrades the run, it doesn't fail
it.

C and C++ get three entries rather than one, because they have three package
managers and no agreement between them. Conan reads `conanfile.txt`, the literal
`requires` in `conanfile.py`, and `conan.lock`; vcpkg reads `vcpkg.json`,
including the `overrides` that are its only per-port pin; Arduino and PlatformIO
share one ecosystem, because `library.properties` and `platformio.ini` name the
same libraries from the same registry. What they share below the manifest — the
`#include` graph, the header surface diff — is shared where that is actually
true.

Scala and React Native are supported without being separate ecosystems. sbt
coordinates resolve to Maven Central, so `build.sbt` is parsed into `maven` and
inherits its registry, surface diff, and advisories. React Native's JavaScript
half is npm and its native half is CocoaPods — which matters, because a React
Native upgrade routinely moves native pods underneath the JavaScript package,
and a tool that reads only `package.json` reports half the change as all of it.

**What each ecosystem can and cannot do is stated per stage in
[docs/support.md](docs/support.md)**, which is generated from the same data the
pipeline reads at runtime. `Detect` is not `Verify` is not `API surface`, and
collapsing them into one "supported" column is how a tool ends up claiming
things you can disprove in thirty seconds.

Every detected change is then triaged against `drift.yml` — major/minor/patch,
dev-only, transitive-only, ignore lists — and Drift records a reason for
everything it skips rather than dropping it silently.

### 2 · Evidence

Gathers citable ground truth from six sources, weighted by how directly each
speaks to breakage:

| Weight | Source |
| --- | --- |
| 1.00 | **Computed API surface diff** — npm, Go, cargo, Maven, NuGet |
| 1.00 | **OpenAPI spec diff** — computed |
| 0.90 | Computed C/C++ header surface — real, but blind to the preprocessor |
| 0.90 | Computed Python surface — reconstructed, so capped below the rest |
| 0.80 | Computed Dart and Hex surfaces — read from the published *source* under the ecosystem's own visibility rule (`lib/` vs `lib/src/`, `def` vs `defp`), which is one inference more than a compiled artefact makes |
| 0.80 | Migration guide |
| 0.70 | GitHub release notes |
| 0.65 | CHANGELOG |
| 0.40 | Registry metadata |
| 0.25 | Semver heuristic |

A semver bump alone scores *below* the dispatch threshold, deliberately. "The major
number went up" is a reason to look, not a reason to let an agent edit your code.

The computed sources are the differentiator, because they catch the removal
nobody wrote down. For npm, Drift fetches both versions' declarations from
jsDelivr and diffs them with the TypeScript compiler. For Go, it fetches both
versions into the module cache and extracts every importable package's exported
API at three platforms, honouring build tags — which is how it finds that
`golang.org/x/sys` changed `windows.Signal` from `int` to `syscall.Signal`
between v0.26.0 and v0.47.0, a change no changelog mentions. The OpenAPI engine
reports only consumer-breaking direction: tightening what a server accepts, or
loosening what it returns.

### 3 · Analyze

Deterministic rules run first and unconditionally. Prose patterns fire **only on
backtick-quoted identifiers** — that restriction is what stops ordinary English
becoming a search symbol. Corroboration across independent sources raises
confidence: the changelog saying `foo` was removed *and* the `.d.ts` diff showing
`foo` gone is where automatic fixing is actually safe.

Two breaking changes get dedicated handling because they rename nothing and so
no symbol-based rule can catch them: **ESM-only migrations** (which break every
CommonJS consumer) and **raised runtime minimums**. Both are announced as
statements of fact — "This package is now pure ESM" — rather than as warnings.

An optional LLM pass improves recall on unparseable prose. It is off by default,
runs last, never overrides a rule, is capped at `medium` confidence, and is told to
extract only from supplied evidence.

### 4 · Localize

Builds a **Meta-RAG** index — an AST-aligned map of every file's imports, code
units, and signatures — then searches only the files that import the changed
dependency. Word-boundary matching stops `get` matching `getUserById`. Each site
carries its enclosing function and a per-site confidence.

Which names to search for is not guessed. `src/localize/modules.ts` reads them
from the artefact the registry published — a wheel's `top_level.txt`, a jar's
package directories, a `.nupkg`'s namespaces, Packagist's PSR-4 roots, every
`defmodule` in a Hex tarball, a gem's require paths and constants, the target
names in a `Package.swift`, a podspec's `module_name` — opened in memory,
never installed. That is what lets Drift localize PHP, Elixir, Swift and
CocoaPods at all: every one of them declined before because a package name does
not determine the name used in source, and the package itself settles it. Any
failure falls back to the naming conventions Drift used before, so an
unreachable registry costs precision and not correctness.

And the graph is followed rather than only queried: a call behind a barrel
file, or a header reached through another header, is reached across your own
re-export edges and reported at reduced confidence, because an inherited
binding is weaker evidence than an observed one. A symbol your own code
declares is not reported as the dependency's.

### 4a · Verify (optional)

An off-by-default behavioural probe that runs old and new dependency code
side by side to catch breakage no symbol diff would show. It stays off unless
`verification.behavioural.enabled` is set, because it executes real code.

### 5 · Rationale

Answers the question the rest of the pipeline can't: *why would I take this?*
[OSV](https://osv.dev) is queried for **both** versions, so the report can say
whether the upgrade improves, preserves, or worsens known exposure rather than
just listing advisories. Maintenance facts — deprecated, archived, retracted,
raised runtime minimum — are stated with a link and never scored, because a
mature package can be stable without being busy. Release notes are classified,
never generated.

The output is one recommendation from six, derived from rules that each record
the sentence they fired with:

> **`golang.org/x/net` v0.17.0 → v0.38.0 — Upgrade recommended**
> Fixes 4 known vulnerabilities (worst: medium). 10 known vulnerabilities affect
> both versions; this upgrade does not address them. The required Go version
> changed from >=1.17 to >=1.23.0.

License checking lives here too, and is off by default.

### 6 · Plan

Groups findings into **one commit per concern**, ordered so runtime and config
changes land before mechanical renames, which land before semantic rewrites. Scores
risk. Evaluates guardrails.

### 7 · Dispatch

Creates the branch pinned to the analysed commit, then resolves each commit in
priority order: Drift's own deterministic codemod first (anchored to the exact
impact sites localization found, never a whole-file rewrite), a matching
community recipe second — only when `remediation.communityRecipes` is enabled,
and never without an explicit choice on the CLI or in the extension — and
GitHub Copilot last, given a single task carrying the whole remaining plan,
with evidence quoted inline, exact file:line locations, and explicit
prohibitions against the predictable agent failure modes (weakening tests,
fixing unrelated code, inventing replacement APIs). A commit Drift resolved
itself is never handed to Copilot.

### 8 · Report

A pull request body a reviewer can act on: every claim linked to its source, every
uncertainty stated in place rather than buried, and a checklist tailored to what
actually changed.

---

## Research foundation

Drift's localization is an adaptation of **Meta-RAG** from
[*LLM Agents for Automated Dependency Upgrades*](https://arxiv.org/html/2510.03480v1)
(arXiv:2510.03480), which reports ~79.9% token reduction and materially higher
precision than a general-purpose coding agent — 71.4% vs 17.2% on one upgrade.

Drift departs from the paper in three places, deliberately. See
[docs/research.md](docs/research.md) for the full mapping and the reasoning:

| | LADU (paper) | Drift |
| --- | --- | --- |
| Breaking-change detection | Assumes a migration guide exists | Computes API diffs; treats guides as one source of several |
| Summaries | LLM-generated prose | Structural, signature-derived — free, deterministic, cannot hallucinate |
| Output | Working tree | Separated commits + PR + citations |

---

## Documentation

| | |
| --- | --- |
| [Architecture](docs/architecture.md) | Pipeline internals, data model, extension points |
| [Configuration](docs/configuration.md) | Every `drift.yml` option |
| [Copilot integration](docs/copilot-integration.md) | The token constraint, and why it shapes everything |
| [Trust & safety](docs/trust-and-safety.md) | Guardrails, threat model, failure modes |
| [Agent security boundaries](docs/security/agent-boundaries.md) | How local agent output is isolated and validated |
| [Research mapping](docs/research.md) | What Drift took from the paper, and what it changed |
| [Deployment](docs/deployment.md) | Action, CLI, and self-hosted webhook |
| [Testing on a real repo](docs/testing-on-a-real-repo.md) | Four ways to try it, in ascending order of commitment |
| [Telemetry](docs/telemetry.md) | Off by default — what it collects if you turn it on |
| [Vision](docs/vision.md) | Where this is going, and why |
| [The VS Code extension](extension/README.md) | The editor front end — panel, agents, review |

---

## Validated against a real upgrade

Pointed at [`sindresorhus/got`](https://github.com/sindresorhus/got) at the commit
bumping `@szmarczak/http-timer` 4.0.6 → 5.0.1, Drift:

- read the v5.0.0 release notes and extracted **"This package is now pure ESM"**
  and **"Required Node.js >=14.16"** — the two changes that actually break
  consumers, neither of which renames a single export;
- located **9 impact sites across 6 files** — the ESM change at real import
  sites, the runtime bump in CI config and engine fields, not in source comments;
- **blocked automatic dispatch**, because one site was in
  `.github/workflows/main.yml`, a protected path.

The first run of that experiment found nothing at all. Fixing it surfaced four
genuine bugs, [documented in the commit history](https://github.com/trydrift/drift/commits/main).

That walkthrough is one manual example. `test/real-repo-recordings.test.ts` runs
sixteen more automatically — the real captured runs behind the site's demos,
one per supported ecosystem (gitlab, kubernetes, deno, scrapy, and twelve
others) — as a regression check in `npm test`. See
[testing-on-a-real-repo.md](docs/testing-on-a-real-repo.md).

## Status

MVP. The pipeline is complete and tested end to end, covered by the test suite
across every stage, the diff engine the review UI rests on, and the panel's
rendered markup.
Known limitations are documented in [docs/architecture.md](docs/architecture.md#known-limitations)
rather than hidden — including the ones we'd rather not advertise.

## License

PolyForm Shield 1.0.0 — see [LICENSE](LICENSE).

Drift is **free and source-available**. Read it, run it, modify it, use it at
work. The one thing PolyForm Shield does not permit is using it to build a
competing product.

That is deliberately *not* an OSI-approved open-source license, and it is worth
being precise about which words to use: "we open-sourced Drift" is inaccurate
and invites an argument about licensing instead of a conversation about the
product. "Free and source-available" is both accurate and the thing people
actually want to know.
