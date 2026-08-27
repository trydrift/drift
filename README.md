# Drift

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/trydrift/drift/badge)](https://scorecard.dev/viewer/?uri=github.com/trydrift/drift)
[![CI](https://github.com/trydrift/drift/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/trydrift/drift/actions/workflows/ci.yml)

**Your dependency updated. Did it break your code? Drift finds out, shows the evidence, and prepares the fix.**

Drift checks dependency upgrades against the code that actually uses them. It shows which upstream changes matter, where they affect your repository, and prepares reviewable fixes using deterministic transforms, validated fix plans, or your existing AI agent. Drift never merges for you.

See [Why Drift](docs/overview.md) for the product rationale and [Architecture](docs/architecture.md) for how the pipeline works.

## Install

### CLI

Requires Node.js 22.6 or newer.

```bash
npm install -g @usedrift/cli
```

### VS Code extension

Install **Drift — Safe Dependency Upgrades** from the VS Code Marketplace (`drift.drift`).

For local development instead:

```bash
cd extension
npm install
npm run package
```

Then use **Extensions: Install from VSIX...** in VS Code to install the generated package.

### GitHub Action

Copy [`examples/workflows/drift.yml`](examples/workflows/drift.yml) to `.github/workflows/drift.yml`.

The minimal Action step is:

```yaml
- uses: trydrift/drift@v0
  with:
    repo-token: ${{ secrets.GITHUB_TOKEN }}
```

Drift runs in approval mode by default. Full Action setup, permissions, agent configuration, scheduled outdated scans, and inputs are documented in [Deployment](docs/deployment.md) and [Configuration](docs/configuration.md).

## CLI

Run commands from the repository you want Drift to inspect.

| Command | What it does |
| --- | --- |
| `drift analyze` | Analyse a dependency change already present in git and print the report. Read-only. |
| `drift outdated` | Find available dependency upgrades and show which ones affect this codebase. Read-only unless `--upgrade` is supplied. |
| `drift upgrade` | Install every upgrade Drift proved safe for this repository; affected and unchecked packages are left alone. |
| `drift fix` | Analyse the change, apply resolvable fixes in an isolated worktree, push the fix branch, and open a pull request. |
| `drift pr` | Push the current branch and open a pull request. |
| `drift diff <eco> <pkg> <from> <to>` | Show a source diff between two published package versions where the ecosystem supports it. |
| `drift action` | Internal entrypoint used by the GitHub Action. |
| `drift serve` | Run Drift's self-hosted webhook server. |
| `drift telemetry print` | Print the exact telemetry event shape. |
| `drift --version` | Print the installed version. |

Common examples:

```bash
drift analyze                 # check a dependency change already made
drift outdated                # see available upgrades
drift outdated --verify       # run Deep Verification too
drift outdated --upgrade pkg  # install one selected upgrade
drift upgrade                 # install all upgrades proven safe
drift fix --plan              # inspect deterministic fix plans; write nothing
drift fix                     # prepare fixes and open a PR
drift pr                      # open a PR for the current branch
```

Use `drift --help` for every option. Analysis commands need no account or token for normal public-repository use; write operations need GitHub access. See [Deployment](docs/deployment.md#2--cli) for credential and workflow details.

## VS Code extension

Open the **Drift** icon in the activity bar. The panel provides the same analysis pipeline with interactive review before changes are committed.

| Command | What it does |
| --- | --- |
| `/scan` | Check every dependency for a newer version and determine what would affect your code. |
| `/recent` | Analyse the dependency change already in git history. |
| `/upgrade <package>` | Upgrade one package and re-check its impact. |
| `/upgrade-all` | Install every upgrade that does not affect your code. |
| `/fix [package]` | Fix affected code using Drift's deterministic path first, then a configured agent where needed. |
| `/review` | Review proposed changes waiting to be kept or undone. |
| `/agent` | Choose the AI agent used for unresolved edits. |
| `/clear` | Start a new conversation. |
| `/help` | Show extension help. |

The extension also exposes equivalent commands through the Command Palette and keeps agent edits reviewable with Keep/Undo actions. See [the extension documentation](extension/README.md) for the full editor workflow and settings.

## GitHub Action

The Action watches dependency changes in CI, runs the same analysis, and either files an approval issue or prepares the fix automatically according to `.github/drift.yml`.

Start with the provided workflow:

```bash
mkdir -p .github/workflows
cp examples/workflows/drift.yml .github/workflows/drift.yml
```

Optional configuration:

```bash
cp examples/drift.yml .github/drift.yml
```

Useful Action inputs include `mode`, `dry-run`, `scan-mode`, `verify-mode`, `dependency-scope`, and `agent`. See [`action.yml`](action.yml) for the complete input/output contract and [Deployment](docs/deployment.md#1--github-action-recommended) for setup.

## Documentation

| | |
| --- | --- |
| [Why Drift](docs/overview.md) | Product rationale, design principles, validation, status, and licensing |
| [Architecture](docs/architecture.md) | Pipeline internals, data model, extension points |
| [Configuration](docs/configuration.md) | Every `drift.yml` option |
| [Supported ecosystems](docs/support.md) | What each ecosystem supports at each pipeline stage |
| [Fix plans](docs/fix-plans.md) | How validated deterministic migration plans work |
| [Copilot integration](docs/copilot-integration.md) | Copilot Cloud authentication and constraints |
| [Trust & safety](docs/trust-and-safety.md) | Guardrails, threat model, failure modes |
| [Agent security boundaries](docs/security/agent-boundaries.md) | How local agent output is isolated and validated |
| [Deployment](docs/deployment.md) | Action, CLI, and self-hosted webhook |
| [Testing on a real repo](docs/testing-on-a-real-repo.md) | Ways to evaluate Drift against real repositories |
| [Research mapping](docs/research.md) | Research foundation and design departures |
| [Benchmarks](eval/README.md) | Accuracy evaluation and benchmark limitations |
| [Telemetry](docs/telemetry.md) | What optional telemetry collects |
| [Vision](docs/vision.md) | Product direction |
| [VS Code extension](extension/README.md) | Editor workflow, agents, settings, and review |

See the live demos at [trydrift.github.io/drift](https://trydrift.github.io/drift/).
