# CLI

Install Drift globally:

```bash
npm install -g @usedrift/cli
```

Requires Node.js 22.6 or newer.

## Commands

| Command | Purpose |
| --- | --- |
| `drift analyze` | Check a dependency change already in git. Read-only. |
| `drift outdated` | Find available upgrades and check their impact. Read-only unless `--upgrade` is used. |
| `drift upgrade` | Install all upgrades Drift proved safe for this repository. |
| `drift fix` | Analyse, prepare fixes in an isolated worktree, push a branch, and open a PR. |
| `drift pr` | Push the current branch and open a PR. |
| `drift diff <eco> <pkg> <from> <to>` | Show the published source diff for supported ecosystems. |

Use `drift --help` for all options.

## Typical workflow

```bash
drift outdated
drift fix --plan
drift fix
```

Use `--verify` with `analyze` or `outdated` to run your project's checks against the candidate dependency in a disposable worktree.

## How `outdated` reports upgrades

`drift outdated` first lists available upgrades, then checks whether their upstream changes affect code in this repository.

Example:

```text
Package              Current  Wanted  Latest
some-lib             2.1.0    2.4.0   3.0.0

▲ some-lib 2.1.0 → 3.0.0
  Affects your code · 12 sites in 4 files
  src/client.ts:88
  src/retry.ts:24
```

`Wanted` is the newest version allowed by the range already declared in your manifest. `Latest` is the newest published version.

Progress is written to stderr and the report to stdout, so piping and redirection work normally:

```bash
drift outdated > report.txt
drift outdated --json
```

To install one result:

```bash
drift outdated --upgrade some-lib
```

Add `--latest` when you explicitly want the newest published version rather than the newest version allowed by the current range.

## Credentials

`analyze` and normal `outdated` scans do not require an account or token for public sources. A GitHub token can raise API rate limits.

`fix` and `pr` need GitHub write access. Drift can use a signed-in `gh`, `GITHUB_TOKEN`, or `--token`.

For deployment and authentication details, see [Deployment](deployment.md). For scan and verification settings, see [Configuration](configuration.md). For safety guarantees, see [Trust & safety](trust-and-safety.md).
