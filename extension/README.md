# Drift — Dependency Breaking Changes

**Which upgrades actually break your code? Drift finds out, proves it, and fixes them with the AI agent you already use.**

No API keys. No tokens to paste. No account.

---

## What it does

Open the Drift panel and it starts checking your dependencies, naming each step as it goes — the package, the version pair, whether it is reading a changelog or searching your code. When it finishes you get the one number that matters:

> **3 of 14 upgrades affect code in this repository. The other 11 are safe to take as-is.**

That distinction is the product. A package can have seven breaking changes and still be a five-second upgrade for you, because your code never calls the parts that changed. Drift says so plainly, in neutral colour, with the upstream detail one click away — because a warning that turns out to be nothing is how a tool teaches you to ignore it.

For the upgrades that *do* affect you, Drift shows the exact file and line, hands the work to your AI agent, and holds every edit for review before anything is committed.

## The panel

One conversation with a composer underneath, the same shape as Copilot Chat and Claude. Results appear beneath the message that caused them.

Type `/` for commands:

| Command | What it does |
|---|---|
| `/scan` | Check every dependency for a newer version and what would break |
| `/recent` | Analyse the dependency change already in your git history |
| `/upgrade <package>` | Upgrade one package and check the impact |
| `/fix [package]` | Let your AI agent fix the affected code |
| `/review` | Show changes waiting to be kept or undone |
| `/agent` | Choose which AI agent does the work |
| `/help` | What Drift can do |

Anything that isn't a command and isn't an answer to a question becomes a standing instruction for the agent — see `drift.fix.customInstructions` below.

### The composer controls

Four pickers, sitting where the thing they affect happens:

- **Agent** — which AI does the editing. Drift drives one you already have.
- **Ask / Agent** — Ask analyses and explains, and never edits. Agent edits files.
- **Effort** — this changes what is *actually analysed*, not how long it takes. Quick covers runtime dependencies and stops at 25 packages. Balanced covers every runtime dependency. Thorough adds dev, optional and peer dependencies, and patch releases.
- **Permission** — how much rope the agent gets:
  - *Ask first* — Drift asks in the thread before editing each group of files.
  - *Edit, then review* (default) — edits are written, nothing is committed until you keep it.
  - *Edit and commit* — edits and commits each group without stopping.

### Attaching context

The paperclip adds a file, a folder, or the current editor selection as reference material. Attachments tell the agent where to look for a convention or a helper; they never widen which files it is allowed to edit.

### Drift asks questions

When a decision is genuinely the developer's — two valid migrations, an ambiguous call site, a dirty working tree — Drift asks in the thread with buttons, and waits. You can also just type an answer. The agent itself can raise a question this way rather than guessing, because a confident guess about a behaviour change is the most expensive thing an unsupervised agent can produce.

## Reviewing what the agent did

Agent edits are a **proposal**. They are written into your working tree so you can read them in context, with real syntax highlighting and real type errors — but nothing is committed until you say so.

In the editor:

- changed lines are tinted, with a marker in the overview ruler;
- every hunk carries its own **Keep** and **Undo**, right above it;
- the file header shows the change count and offers **Keep file** / **Undo file** / the native side-by-side diff;
- `Alt+D` jumps to the next unresolved change.

In the panel, the change list groups files by planned commit, shows `+`/`−` per file, and opens the real diff editor on click. **Keep & commit** on a group commits exactly the files the plan named for it — one commit per concern, so `git revert` and `git bisect` stay meaningful. **Undo** restores the file through the workspace API, so it lands in your normal undo stack too.

Drift commits. It never pushes and never merges.

## Zero configuration

Open a repository. That's the setup. Drift works **signed out**, because nothing in the analysis needs an account:

| Stage | Where it runs |
|---|---|
| Detect the change | your local git |
| Gather evidence | public registries — npm, PyPI, crates.io, GitHub releases |
| Find affected code | your local files |
| Fix it | your AI agent |
| Commit | your local git |

Sign-in is asked for once, and only if you choose GitHub's cloud agent or want Drift to push a branch. It is VS Code's own one-click OAuth — no token to create or store.

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

The agent picker shows what Drift can use right now. **Drift: Select AI Agent** lists unavailable ones too, each with a one-line reason and how to fix it — hiding them would just leave you wondering why yours isn't there.

## Upgrading

Two deliberately separate actions:

- **Upgrade** installs the newest version that satisfies the range already in `package.json`, or the nearest compatible semver band when the range can't be interpreted.
- **Upgrade to `<latest>`** installs the latest published version with `npm --force`. Drift asks first, because that widens your declared range and can leave peer dependencies unsatisfied.

## Why you can trust it with your code

| | |
|---|---|
| **Evidence, not recall** | Every finding cites a changelog entry, release note, or computed API diff — with a link. Drift never asks an agent to act on "I think this changed." |
| **Computed diffs beat prose** | Changelogs omit removals. Drift diffs the actual `.d.ts` and catches what nobody wrote down. |
| **Import-graph precision** | A file that never imports `express` can't be broken by an `express` change. Drift searches importers, not your whole repo. |
| **Nothing is committed until you keep it** | On the default permission mode, every edit waits for a human. |
| **Separated commits** | One per concern, ordered so build-enabling changes land first. |
| **Never on a dirty tree** | Drift asks before mixing its edits with your work in progress. |
| **Scoped edits** | Each commit touches only its own files. Edits outside that scope are refused. |
| **Everything is undoable** | Edits and reverts go through the workspace API, so they're in your undo stack. |
| **Alerts are earned** | Colour and notifications are reserved for changes that land on code in *this* repository. |

## Commands

| Command | What it does |
|---|---|
| **Drift: New Session** | Clear the thread |
| **Drift: Check for Breaking Changes** | Analyse the dependency change in git |
| **Drift: Review Changes** | Open the panel on what's waiting |
| **Drift: Go to Next Change** | Jump to the next unresolved hunk (`Alt+D`) |
| **Drift: Keep All Changes** / **Undo All Changes** | Resolve everything at once |
| **Drift: Show Report** | The full report, with evidence |
| **Drift: Select AI Agent** | See what's available, pick one |
| **Drift: Sign in to GitHub** | Only for the cloud agent or pushing |

Or just use the **Drift icon** in the activity bar.

## Settings

All in the normal settings UI (**Drift: Open Settings**). The one worth setting:

**`drift.fix.customInstructions`** — your repo's conventions, passed to every agent. The highest-leverage setting for output quality:

> This repo uses Vitest, not Jest. Prefer named exports.
> All HTTP goes through `src/lib/http.ts` — never call fetch directly.

The composer pickers write to `drift.session.mode`, `drift.session.effort` and `drift.session.permission`, so a team can set a default in workspace settings. Others: which agent to prefer, whether to analyse on startup, whether to include patch/dev/transitive changes, packages to ignore, and inline diagnostics.

If your repo has a `.github/drift.yml` (used by the [Drift GitHub Action](https://github.com/RodolpheKouyoumdjian/Drift)), the extension reads it too. Your VS Code settings layer on top — the file is the team's policy, settings are your local preference.

## Supported ecosystems

npm/yarn/pnpm · pip/poetry/uv · Go modules · Cargo · Maven/Gradle · Bundler

Computed API diffing is npm-only today; the others rely on changelog and release-note evidence. The upgrade scanner (`/scan`) is npm-only; `/recent` works across all of them.

## Also available as a GitHub Action

Same engine, running in CI on every dependency bump, filing a PR. See the [repository](https://github.com/RodolpheKouyoumdjian/Drift).

## Known limitations

Stated plainly, because a tool that hides these hasn't earned trust:

- **Localization is single-hop.** If you wrap a dependency in your own abstraction, Drift flags the wrapper — correct, but it won't trace further.
- **Non-JS/TS parsing is pattern-based.** File and line are always exact; the enclosing symbol can be off in unusual formatting.
- **Behaviour changes are the weak spot.** "Retries are now exponential" has no symbol to search for and no compile error to catch. Drift raises risk and flags it rather than pretending.
- **Small local models struggle** with whole-file rewrites. Use a coding-tuned model with Ollama.
- **`/scan` is a network sweep.** On a large `package.json` the first run takes a while; Quick effort exists for exactly that reason, and every step is named while it runs.

## License

MIT
