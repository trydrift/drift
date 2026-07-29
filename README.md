# Drift

**Your dependency updated. Something broke. Drift finds out what, proves it, and fixes it.**

Drift watches dependency changes in your repositories, works out which upstream
changes actually break *your* code, and drives GitHub Copilot to fix them — in a
branch, in separated commits, in a pull request you review.

It never merges anything.

```
dependency bump  →  what changed upstream?  →  where does it bite here?  →  fix it
     detect              evidence                    localize                 dispatch
```

---

## The problem

Dependabot tells you a version number changed. It does not tell you whether your
code still works. So the PR sits there, or it gets merged on faith, or someone
spends an afternoon reading a changelog.

The gap is real and measurable: **around 5% of npm packages have been broken by a
minor or patch release of a dependency**, and the majority of those breakages come
from changes to the package's public API — changes a version number cannot express.

Drift closes that gap. It answers three questions Dependabot doesn't:

1. **What actually changed upstream?** Not the version number — the API.
2. **Does any of it affect this repository?** Which file, which line, which function.
3. **What is the fix?** Written, committed, and explained.

## What makes it trustworthy

An agent that edits your repository unsupervised has to earn that. Drift's design
is mostly about that problem:

| | |
|---|---|
| **Evidence, not recall** | Every finding cites a changelog entry, a release note, or a computed API diff you can click. Drift never asks an agent to act on "I think this package changed." |
| **Computed diffs beat prose** | Drift downloads the old and new TypeScript declarations and diffs the actual exported API. Changelogs omit removals; `.d.ts` files don't. |
| **Import-graph precision** | A file that never imports `express` cannot be broken by an `express` change. Drift searches importers, not the whole repo. |
| **Separated commits** | One commit per concern, ordered so build-enabling changes land first. `git revert` and `git bisect` stay meaningful. |
| **Guardrails that downgrade, never drop** | A tripped guardrail turns an automatic run into an approval request. You still see the work. |
| **Approval by default** | Fresh installs analyse and ask. Autonomy is opt-in. |
| **Read-only evaluation** | `drift analyze` runs the full pipeline and prints the report without any write permission at all. Try it before you trust it. |

Drift's intended failure mode is asking you too often. Not editing code it shouldn't have.

---

## Quick start

### 1. Add the workflow

Copy [`examples/workflows/drift.yml`](examples/workflows/drift.yml) to
`.github/workflows/drift.yml`.

### 2. Add the Copilot token

Drift needs a **user-scoped** token to invoke Copilot on your behalf. GitHub's
agent API rejects the built-in `GITHUB_TOKEN` and any GitHub App installation
token, because Copilot is billed per seat and GitHub needs to know whose seat is
being spent.

Create a fine-grained PAT with read+write on **actions**, **contents**, **issues**,
and **pull requests**, then save it as the repository secret `DRIFT_COPILOT_TOKEN`.

The token lives in your repository secrets. Drift reads it from the environment at
run time and sends it only to `api.github.com`. It is never stored anywhere else —
[which is why Drift needs no database](docs/copilot-integration.md).

### 3. (Optional) Configure

Copy [`examples/drift.yml`](examples/drift.yml) to `.github/drift.yml`. Every value
is a default, so skipping this is fine.

### 4. Watch it work

Next time a dependency changes, Drift opens an issue with the plan. Comment
`/drift apply` to let it proceed, or set `mode: auto` once you've read a few.

---

## Try it with zero permissions

```bash
npm install -g drift
export GITHUB_TOKEN=ghp_...   # public read access is enough for public repos
drift analyze
```

Runs the full pipeline against your working tree and prints the report. Creates no
branches, no issues, no agent tasks — there is no code path in `analyze` that
writes anything.

---

## How it works

Seven stages. Each is independently testable, and each can legitimately produce
nothing — most dependency bumps genuinely don't break you, and saying so quickly
is a feature.

### 1 · Detect
Diffs manifests and lockfiles across **npm/yarn/pnpm, pip/poetry/uv, Go modules,
Cargo, Maven/Gradle, and Bundler**. Handles `${property}` references in POMs,
`// indirect` in `go.mod`, PEP 508 markers, and Ruby's `~> 4.1`. Parsers never
throw — a half-rebased lockfile degrades the run, it doesn't fail it.

### 2 · Evidence
Gathers citable ground truth from six sources, weighted by how directly each
speaks to breakage:

| Weight | Source |
|---|---|
| 1.00 | **TypeScript `.d.ts` surface diff** — computed |
| 1.00 | **OpenAPI spec diff** — computed |
| 0.80 | Migration guide |
| 0.70 | GitHub release notes |
| 0.65 | CHANGELOG |
| 0.40 | Registry metadata |
| 0.25 | Semver heuristic |

A semver bump alone scores *below* the dispatch threshold, deliberately. "The major
number went up" is a reason to look, not a reason to let an agent edit your code.

The two computed sources are the differentiator. Drift fetches both versions'
declarations from jsDelivr and diffs the exported API with the TypeScript compiler —
so it catches the removal nobody wrote down. The OpenAPI engine reports only
consumer-breaking direction: tightening what a server accepts, or loosening what it
returns.

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

### 5 · Plan
Groups findings into **one commit per concern**, ordered so runtime and config
changes land before mechanical renames, which land before semantic rewrites. Scores
risk. Evaluates guardrails.

### 6 · Dispatch
Creates the branch pinned to the analysed commit, then hands Copilot a single task
carrying the whole ordered plan — with evidence quoted inline, exact file:line
locations, and explicit prohibitions against the predictable agent failure modes
(weakening tests, fixing unrelated code, inventing replacement APIs).

### 7 · Report
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
|---|---|---|
| Breaking-change detection | Assumes a migration guide exists | Computes API diffs; treats guides as one source of several |
| Summaries | LLM-generated prose | Structural, signature-derived — free, deterministic, cannot hallucinate |
| Output | Working tree | Separated commits + PR + citations |

---

## Documentation

| | |
|---|---|
| [Architecture](docs/architecture.md) | Pipeline internals, data model, extension points |
| [Configuration](docs/configuration.md) | Every `drift.yml` option |
| [Copilot integration](docs/copilot-integration.md) | The token constraint, and why it shapes everything |
| [Trust & safety](docs/trust-and-safety.md) | Guardrails, threat model, failure modes |
| [Research mapping](docs/research.md) | What Drift took from the paper, and what it changed |
| [Deployment](docs/deployment.md) | Action, CLI, and self-hosted webhook |

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
genuine bugs, [documented in the commit history](../../commits/main).

## Status

MVP. The pipeline is complete and tested end to end; 106 tests cover every stage.
Known limitations are documented in [docs/architecture.md](docs/architecture.md#known-limitations)
rather than hidden — including the ones we'd rather not advertise.

## License

MIT
