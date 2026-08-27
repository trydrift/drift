# Drift

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/trydrift/drift/badge)](https://scorecard.dev/viewer/?uri=github.com/trydrift/drift)
[![CI](https://github.com/trydrift/drift/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/trydrift/drift/actions/workflows/ci.yml)

**Your dependency updated. Did it break your code? Drift finds out, shows the evidence, and prepares the fix.**

Drift checks dependency upgrades against the code that actually uses them. It shows what changed, where it affects your repo, and prepares reviewable fixes. It never merges for you.

More: [Why Drift](docs/overview.md) · [How it works](docs/architecture.md)

## Install

### CLI

```bash
npm install -g @usedrift/cli
```

Requires Node.js 22.6+.

### VS Code extension

Install **Drift — Safe Dependency Upgrades** from the VS Code Marketplace (`drift.drift`).

More: [Extension docs](extension/README.md)

### GitHub Action

Copy [`examples/workflows/drift.yml`](examples/workflows/drift.yml) to `.github/workflows/drift.yml`.

```yaml
- uses: trydrift/drift@v0
  with:
    repo-token: ${{ secrets.GITHUB_TOKEN }}
```

Drift uses approval mode by default.

More: [Action setup](docs/deployment.md#1--github-action-recommended) · [Configuration](docs/configuration.md)

## CLI

| Command | What it does |
| --- | --- |
| `drift analyze` | Check a dependency change already in git. |
| `drift outdated` | Find available upgrades and check their impact. |
| `drift upgrade` | Install upgrades Drift proved safe. |
| `drift fix` | Prepare fixes, push a branch, and open a PR. |
| `drift pr` | Push the current branch and open a PR. |
| `drift diff <eco> <pkg> <from> <to>` | Compare two published package versions. |

```bash
drift outdated
drift fix --plan
drift fix
```

More: [CLI guide](docs/cli.md) · `drift --help`

## VS Code extension

Open the **Drift** icon in the activity bar.

| Command | What it does |
| --- | --- |
| `/scan` | Check available upgrades. |
| `/recent` | Check the latest dependency change. |
| `/upgrade <package>` | Upgrade one package and re-check it. |
| `/upgrade-all` | Install upgrades that do not affect your code. |
| `/fix [package]` | Fix affected code. |
| `/review` | Review proposed edits. |
| `/agent` | Choose an AI agent. |
| `/help` | Show help. |

More: [Extension docs](extension/README.md)

## GitHub Action

The Action runs Drift in CI when dependencies change. It can file an approval issue or prepare the fix automatically based on `.github/drift.yml`.

More: [Deployment](docs/deployment.md) · [`action.yml`](action.yml) · [Configuration](docs/configuration.md)

## Documentation

- [Why Drift](docs/overview.md) — what Drift is and why it exists
- [CLI](docs/cli.md) — commands, examples, credentials
- [Architecture](docs/architecture.md) — how the pipeline works
- [Configuration](docs/configuration.md) — all settings
- [Supported ecosystems](docs/support.md) — capabilities by ecosystem
- [Fix plans](docs/fix-plans.md) — deterministic migrations
- [Trust & safety](docs/trust-and-safety.md) — guardrails and threat model
- [Deployment](docs/deployment.md) — Action, CLI, webhook
- [Testing](docs/testing-on-a-real-repo.md) — real-repo examples and validation
- [Research](docs/research.md) — research foundation
- [Telemetry](docs/telemetry.md) — optional telemetry
- [Vision](docs/vision.md) — product direction

See real Drift runs at [trydrift.github.io/drift](https://trydrift.github.io/drift/).
