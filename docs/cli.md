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
| `drift explain <package>` | What changed in one upgrade, and every place it reaches this repository. |
| `drift mcp` | Serve Drift to a coding agent over MCP (stdio). |
| `drift help [topic]` | Everything about one command, including every option. |

`drift --help` is the overview; `drift help <command>` (or `drift <command> --help`)
has that command's full options, and `drift help environment` lists the
environment variables Drift reads.

## When Drift can't read the command line

An argument Drift does not recognise stops the run before it does any work,
rather than being ignored: an unknown command, an option no command reads
(`--dry-run`), a short flag (`-z` — Drift writes its options in full), or a
stray word a command has no use for. The message names the argument, suggests
the one that was probably meant where something is close enough, and exits 1.

```console
$ drift outdated --dry-run
drift: `outdated` has no `--dry-run` option.

Nothing ran, so nothing here changed.
Every option `outdated` takes:  drift help outdated
```

If a run stops on an unexpected error, Drift prints the reason rather than a
stack trace; `DRIFT_DEBUG=1` prints the trace too.

## Interactive prompts

Anything Drift asks in a terminal is an arrow-key menu:

```text
? Upgrade one of these now?  (↑/↓ move · enter select · / filter · esc skip)
  1 some-lib          2.1.0 → 3.0.0 · Affects your code — 12 sites in 4 files
→ 2 other-lib         1.4.0 → 1.5.0 · No upstream breaking changes
  3 Skip              leave every manifest as it is
```

| Key | Does |
| --- | --- |
| `↑`/`↓`, `j`/`k` | Move between rows |
| `enter` | Pick the highlighted row |
| a row number | Jump to that row (`12` then `enter` picks row 12) |
| `/` | Filter a long list, `esc` to clear the filter |
| `esc`, `q` | Decline — the same answer a non-interactive run gives, never a choice picked for you |
| `y`/`n` | Answer a yes/no question outright |

Prompts are drawn only when stdin and stderr are a terminal. A pipe, a
redirect, or CI takes the default and carries on, so scripts never hang. Set
`DRIFT_NO_TUI=1` for plain numbered prompts, or `NO_COLOR=1` to drop colour.

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
