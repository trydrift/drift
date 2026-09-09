# Drift

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/trydrift/drift/badge)](https://scorecard.dev/viewer/?uri=github.com/trydrift/drift)
[![CI](https://github.com/trydrift/drift/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/trydrift/drift/actions/workflows/ci.yml)

**Dependency upgrades, checked against your code.** Drift downloads both published versions, diffs their real API, and searches your repository for the code that uses whatever changed. It never guesses, and it never merges for you.

```console
$ drift outdated

2 of 2 direct dependencies have a newer version

Package    Current  Wanted  Latest  Declared in
glob         8.1.0   8.1.0  13.0.6  package.json
lru-cache   7.18.3  7.18.3  11.5.2  package.json

  ▲ glob 8.1.0 → 13.0.6  Affects your code · 1 actionable site in 1 file · …
  ? lru-cache 7.18.3 → 11.5.2  Runtime Unknown · Upstream requires Node 20.x || >=22 · …
```

Ask it why, and every claim comes with its evidence and its location:

```console
$ drift explain glob          # your agent gets the same answer over MCP

glob  8.1.0 → 13.0.6  (npm, declared in package.json)

Verdict: BREAKS THIS CODE — a breaking change with located call sites in this repository
Upgrade after review. 1 place in this repository uses an API that glob changed.

Breaking changes upstream (14):
  [removed-export] the default export of glob
      `glob` no longer has a default export (was a function).
  [removed-export] glob.sync, sync
      `glob.sync` is no longer exported (was a function).
  …

Where it reaches this repository (1):
  src/app.js:2  sync
      export function findAll() { return glob.sync('**/*.ts'); }
```

Nothing above came from a changelog. `glob.sync` was read out of the two published `.d.ts` files, and `src/app.js:2` came from searching this repository for it.

## Why this is not just `npm outdated`

An update bot tells you a newer version exists. Drift tells you whether you can take it.

| | Dependabot / Renovate | OpenRewrite / Moderne | Drift |
| --- | --- | --- | --- |
| Finds available upgrades | yes | no | yes |
| Says **what broke** upstream | no | via curated recipes | computed from the artifacts |
| Says **where it breaks in your code** | no | n/a | file and line |
| Works on packages nobody wrote a recipe for | n/a | no | yes |
| Refuses to claim "safe" without evidence | n/a | n/a | yes |

OpenRewrite is the better tool once you have *decided* to migrate — it rewrites the code, and Drift does not. Drift answers the question before that one: which of these ninety upgrades can I take, and what will the rest cost me?

## Measured, not asserted

Drift is scored against public research corpora, including two with real negative controls — the only ones that can support a precision at all.

| Corpus | Scored | Negatives | Precision | Recall | F1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| [Kong](https://zenodo.org/records/13857646) — real-world npm API changes | 16,333 | **16,168** | 83.9% | 97.6% | 0.902 |
| [Roseau](https://doi.org/10.5281/zenodo.15536418) — hand-labelled Java pairs | 255 | 157 | 99.0% | 100% | 0.995 |

Recall against consumer-impact corpora (BUMP, SWE-Bump, TimeMachine) is reported separately, because those are positives-only and cannot support a precision. Every number, every refusal to compute one, and the runs behind them: **[benchmarks](https://trydrift.github.io/drift/benchmarks/)**.

## What Drift will not tell you

- **That an upgrade is safe, without evidence.** When the API surface cannot be computed, the verdict is `insufficient-evidence`, not "clean".
- **That your code is unaffected because a search found nothing.** A completed search is not proof; only an isolated build-and-test run turns "found nothing" into "unaffected".
- **Everything.** Localization is a search. It misses dynamic dispatch, reflection, and behaviour changes with no signature. `drift outdated --verify` installs each upgrade and runs your own build and tests, which is the only thing that can settle it.

## Install

```bash
npm install -g @usedrift/cli     # Node.js 22.6+
drift outdated
```

**Coding agent (MCP)** — Drift as a tool your agent calls, so it stops guessing what a version pair changed. Runs locally over stdio; there is no service.

```bash
claude mcp add drift -- npx -y @usedrift/cli mcp
```

**VS Code** — install *Drift — Safe Dependency Upgrades* (`drift.drift`) · [docs](extension/README.md)

**GitHub Action** — copy [`examples/workflows/drift.yml`](examples/workflows/drift.yml); approval mode is the default.

```yaml
- uses: trydrift/drift@v0
  with:
    repo-token: ${{ secrets.GITHUB_TOKEN }}
```

## Commands

| Command | What it does |
| --- | --- |
| `drift outdated` | Find available upgrades and check their impact. |
| `drift analyze` | Check a dependency change already in git. |
| `drift upgrade` | Install only the upgrades Drift found safe. |
| `drift fix` | Prepare fixes, push a branch, open a PR. |
| `drift explain <package>` | What changed in one upgrade, and where it lands. |
| `drift diff <eco> <pkg> <from> <to>` | Real `git diff` between two published versions. |
| `drift mcp` | Serve Drift to a coding agent over MCP. |

Add `--verify` to install each upgrade in a scratch worktree and run your project's own checks against it.

## Ecosystems

npm, PyPI and Maven are the three measured against research corpora. Detection also covers Go, Cargo, NuGet, Packagist, RubyGems, Hex, Pub, Conan, vcpkg, Swift, CocoaPods, OPAM and Arduino — with capabilities per ecosystem in [supported ecosystems](docs/support.md).

## Documentation

[Why Drift](docs/overview.md) · [CLI](docs/cli.md) · [Architecture](docs/architecture.md) · [Configuration](docs/configuration.md) · [Ecosystems](docs/support.md) · [Fix plans](docs/fix-plans.md) · [Trust & safety](docs/trust-and-safety.md) · [Deployment](docs/deployment.md) · [Research](docs/research.md) · [Telemetry](docs/telemetry.md)

Real runs, published: [trydrift.github.io/drift](https://trydrift.github.io/drift/)
