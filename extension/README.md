# Drift — Dependency Breaking Changes

**Your dependency updated. Something broke. Drift finds out what, proves it, and fixes it with the AI agent you already use.**

No API keys. No tokens to paste. No account.

---

## What it does

You bump a dependency. Drift immediately tells you:

1. **What actually changed upstream** — not the version number, the API. It diffs the old and new TypeScript declarations, reads release notes and changelogs, and diffs OpenAPI specs.
2. **Where it breaks *your* code** — the exact file, line, and function. Flagged inline, in the Problems panel, with a lightbulb.
3. **How to fix it** — handed to your AI agent, applied as separate commits, one per concern.

It never merges anything, and never pushes without you asking.

## Zero configuration

Open a repository. Drift works out which dependency changed and analyses it. That's the whole setup.

It works **signed out**, because nothing in the analysis needs an account:

| Stage | Where it runs |
|---|---|
| Detect the change | your local git |
| Gather evidence | public registries — npm, PyPI, crates.io, GitHub releases |
| Find affected code | your local files |
| Fix it | your AI agent |
| Commit | your local git |

Sign-in is asked for exactly once, and only if you choose GitHub's cloud agent or want Drift to push a branch. It's VS Code's own one-click OAuth — no token to create or store.

## Bring your own agent

Drift doesn't ship a model and doesn't want your API key. It drives what you already have:

| Agent | Setup |
|---|---|
| **GitHub Copilot** | Nothing — uses the model already in your editor |
| **GitHub Copilot cloud agent** | One-click sign-in. Runs on GitHub, opens a PR |
| **Claude Code** | Already installed and logged in? It's detected |
| **Codex CLI** | Same |
| **Gemini CLI** | Same |
| **Aider** / **OpenCode** | Same |
| **Ollama** | A model on your own machine. Nothing leaves your laptop |

Run **Drift: Select AI Agent** to choose from agents Drift can use right now. The Drift side panel keeps unavailable agents in a collapsed setup section, so the normal picker stays compact.

## Upgrade candidates

The Drift side panel can scan installed npm packages and compare them with newer registry versions.

Each package is collapsible and separates:

- **Found in this repo** — upstream breaking changes whose symbols were found in your code. These are the only items Drift plans AI edits for.
- **Not found in this repo** — upstream breaking changes that exist, but whose affected symbols were not found locally. They are shown for awareness without inflating repo risk.

The risk label is **repo risk**. A package can have upstream breaking changes and still show `none` when Drift found no local code to edit.

Upgrade actions are intentionally split:

- **Safe upgrade** installs the newest version that satisfies the declared npm range, or the nearest compatible semver band when the range cannot be interpreted.
- **Force latest** installs the latest registry version with npm `--force`. Use it when you deliberately want to cross compatibility boundaries and review dependency conflicts yourself.

Evidence links open release notes, changelogs, or the exact repo line Drift matched. Long evidence and required-fix text are collapsed by default.

## Why you can trust it with your code

| | |
|---|---|
| **Evidence, not recall** | Every finding cites a changelog entry, release note, or computed API diff — with a link. Drift never asks an agent to act on "I think this changed." |
| **Computed diffs beat prose** | Changelogs omit removals. Drift diffs the actual `.d.ts` and catches what nobody wrote down. |
| **Import-graph precision** | A file that never imports `express` can't be broken by an `express` change. Drift searches importers, not your whole repo. |
| **Separated commits** | One per concern, ordered so build-enabling changes land first. `git revert` and `git bisect` stay meaningful. |
| **Never on a dirty tree** | Drift asks before mixing its edits with your work in progress. |
| **Scoped edits** | Each commit touches only its own files. Edits outside that scope are refused. |
| **Everything is undoable** | Edits go through the workspace API, so they're in your undo stack. |

## Using it

| Command | What it does |
|---|---|
| **Drift: Check for Breaking Changes** | Analyse now |
| **Drift: Fix All Breaking Changes** | Hand the plan to your agent |
| **Drift: Show Report** | The full report with evidence |
| **Drift: Select AI Agent** | See what's available, pick one |
| **Drift: Sign in to GitHub** | Only needed for the cloud agent or pushing |

Or just use the **Drift icon** in the activity bar.

### Reviewing a fix

Drift makes commits — it doesn't push. Review with `git diff`, the Source Control panel, or the report. Then push when you're happy, or `git checkout -` and delete the branch if you're not.

## Settings

All in the normal settings UI (**Drift: Open Settings**). The one worth setting:

**`drift.fix.customInstructions`** — your repo's conventions, passed to every agent. The highest-leverage setting for output quality:

> This repo uses Vitest, not Jest. Prefer named exports.
> All HTTP goes through `src/lib/http.ts` — never call fetch directly.

Others: which agent to prefer, whether to analyse on startup, whether to include patch/dev/transitive changes, packages to ignore, and whether to show inline diagnostics.

If your repo has a `.github/drift.yml` (used by the [Drift GitHub Action](https://github.com/RodolpheKouyoumdjian/Drift)), the extension reads it too. Your VS Code settings layer on top — the file is the team's policy, settings are your local preference.

## Supported ecosystems

npm/yarn/pnpm · pip/poetry/uv · Go modules · Cargo · Maven/Gradle · Bundler

Computed API diffing is npm-only today; the others rely on changelog and release-note evidence.

## Also available as a GitHub Action

Same engine, running in CI on every dependency bump, filing a PR. See the [repository](https://github.com/RodolpheKouyoumdjian/Drift).

## Known limitations

Stated plainly, because a tool that hides these hasn't earned trust:

- **Localization is single-hop.** If you wrap a dependency in your own abstraction, Drift flags the wrapper — correct, but it won't trace further.
- **Non-JS/TS parsing is pattern-based.** File and line are always exact; the enclosing symbol can be off in unusual formatting.
- **Behaviour changes are the weak spot.** "Retries are now exponential" has no symbol to search for and no compile error to catch. Drift raises risk and flags it rather than pretending.
- **Small local models struggle** with whole-file rewrites. Use a coding-tuned model with Ollama.

## License

MIT
