# Drift — Dependency Breaking Changes

**Which upgrades actually break your code? Drift finds out, proves it, and fixes them — deterministically when it can, with a community recipe when one applies, or with the AI agent you already use otherwise.**

No API keys. No tokens to paste. No account.

---

## What it does

Open the Drift panel and it starts checking your dependencies, naming each step as it goes — the package, the version pair, whether it is reading a changelog or searching your code. When it finishes you get the one number that matters:

> **3 of 14 upgrades affect code in this repository. The other 11 are safe to take as-is.**

That distinction is the product. A package can have seven breaking changes and still be a five-second upgrade for you, because your code never calls the parts that changed. Drift says so plainly, in neutral colour, with the upstream detail one click away — because a warning that turns out to be nothing is how a tool teaches you to ignore it.

For the upgrades that *do* affect you, Drift shows the exact file and line, then resolves each fix in order: its own deterministic transform first, a community recipe if one applies and you've enabled it, and your AI agent for whatever's left — holding every edit for review before anything is committed.

## The panel

One conversation with a composer underneath, the same shape as Copilot Chat and Claude. Results appear beneath the message that caused them.

Type `/` for commands:

| Command | What it does |
|---|---|
| `/scan` | Check every dependency for a newer version and what would break |
| `/recent` | Analyse the dependency change already in your git history |
| `/upgrade <package>` | Upgrade one package and check the impact |
| `/upgrade-all` | Install every upgrade that does not affect your code |
| `/fix [package]` | Fix the affected code — deterministically, via a recipe, or with your AI agent |
| `/review` | Show changes waiting to be kept or undone |
| `/agent` | Choose which AI agent does the work |
| `/clear` | Start a new conversation |
| `/help` | What Drift can do |

The same list is a click away under **Tools** in the composer, for the commands you have not learned yet.

Anything that isn't a command and isn't an answer to a question becomes a standing instruction for the agent — see `drift.fix.customInstructions` below.

### Scan results

A scan produces one card, not a scatter of boxes: a header with the counts that decide what to do next, then **Affects your code** listed openly, and **Safe to upgrade** collapsed behind a count. Rows are separated by hairlines inside the card rather than each drawing its own frame, so fourteen packages read as one answer instead of fourteen widgets. Expanding a row shows the summary, the target-version picker, the breaking changes Drift matched to your files, and the evidence it read to decide.

### The composer controls

Every control sits in the composer, where the thing it affects happens, and each
one opens the same themed menu anchored under its own button — with a filter box,
arrow-key navigation, and the sentence that explains each option. Only the
sections belonging to the button you pressed are shown, so no control hides a
setting it does not name.

- **+** — context, and which subscription and model does the work. Picking a subscription drills into its models inside the same menu; *Set up an agent…* opens the full list, including the ones that need a sign-in or an install.
- **Tools** — everything Drift itself can do: scan, check the last dependency change, upgrade, fix, review, help. The slash commands, made clickable.
- **Effort** — how hard your agent thinks about each fix, in that agent's own vocabulary: Claude runs Low, Medium, High and **Ultracode**; Codex runs Low, Medium, High and **Extra High**. Backends with no reasoning budget — Copilot's in-editor models, Ollama — show no dial at all rather than a control that does nothing. Effort never changes which dependencies Drift checks or which fixes it attempts; every level does all of the work found, and only the thinking per fix changes.
- **Ask / Agent** and **Permission** — Ask analyses and explains, and never edits. Agent edits, under one of:
  - *Ask first* — Drift asks in the thread before editing each group of files.
  - *Edit, then review* (default) — edits are written, nothing is committed until you keep it.
  - *Edit and commit* — edits and commits each group without stopping.

### Attaching context

Under **+**:

- **Add a file / Add a folder** — searches *this project* in VS Code's own filterable list, opened immediately over a path index kept warm in the background. Type three characters of a path to find a file, pick a folder to scope the agent to one area, or attach the lines currently selected in your editor.
- **Upload from computer** — the system browser, for the one case it is genuinely better at: reference material that lives outside the workspace.

Attachments tell the agent where to look for a convention or a helper; they never widen which files it is allowed to edit.

### Conversations

`+` in the view's title bar files the current thread and opens an empty one, immediately. **Drift: Conversation History** reopens anything from the last 40 threads in this workspace, and **Drift: Clear Conversation History** deletes all of them — transcripts hold your package names, file paths and your own words about the repository, so there is a way to be rid of them that is not "delete the workspace".

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

Drift commits automatically once you keep a group. Pushing the branch is a separate, explicit step — **Push branch**, or **Drift: Push Branch** — and Drift never merges.

## Zero configuration

Open a repository. That's the setup. Drift works **signed out**, because nothing in the analysis needs an account:

| Stage | Where it runs |
|---|---|
| Detect the change | your local git |
| Gather evidence | public registries — npm, PyPI, crates.io, GitHub releases |
| Find affected code | your local files |
| Fix it | Drift's own codemod, then a community recipe if enabled, then your AI agent |
| Commit | your local git |

Sign-in is asked for once, and only if you choose GitHub's cloud agent or want Drift to push a branch. It is VS Code's own one-click OAuth — no token to create or store.

## Bring your own agent

Drift doesn't ship a model and doesn't want your API key. It drives what you already have:

| Agent | Setup |
|---|---|
| **GitHub Copilot** | Nothing — uses the model already in your editor |
| **GitHub Copilot cloud agent** | One-click sign-in. Runs on GitHub, opens a PR |
| **Claude Code** | Already installed and logged in? It's detected |
| **Codex** | Same |
| **Gemini CLI** | Same |
| **Aider** / **OpenCode** | Same |
| **Ollama** | A model on your own machine. Nothing leaves your laptop |

The agent picker shows what Drift can use right now. **Drift: Select AI Agent** lists unavailable ones too, each with a one-line reason and how to fix it — hiding them would just leave you wondering why yours isn't there.

## Upgrading

Two deliberately separate actions:

- **Upgrade** installs the newest version that satisfies the range already in `package.json`, or the nearest compatible semver band when the range can't be interpreted.
- **Upgrade to `<latest>`** installs the latest published version, past the range your manifest declares (with `npm --force`, where the package manager has such a flag). Drift asks first, because that widens your declared range and can leave peer dependencies unsatisfied — and it re-runs the breaking-change analysis for that version first, since the evidence on screen was gathered for the in-range one.

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
| **Drift: New Session** | File the thread and start an empty one |
| **Drift: Conversation History** | Reopen an earlier conversation |
| **Drift: Clear Conversation History** | Delete every saved conversation in this workspace |
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

The composer writes to `drift.session.mode` and `drift.session.permission` (per workspace, so a team can set a default), and to `drift.agent.models` and `drift.agent.efforts` (per subscription, globally — "when I use Claude, use Opus on Ultracode" is a statement about Claude, not about this repository). Others: which agent to prefer, whether to analyse on startup, whether to include patch/dev/transitive changes, packages to ignore, and inline diagnostics.

How much Drift analyses is a settings question, never an effort question: `drift.analysis.includeDev` and `drift.analysis.includePatch` decide what a scan covers, and they mean the same thing at every effort level.

If your repo has a `.github/drift.yml` (used by the [Drift GitHub Action](https://github.com/trydrift/drift)), the extension reads it too. Your VS Code settings layer on top — the file is the team's policy, settings are your local preference.

## Supported ecosystems

npm/yarn/pnpm/bun · pip/poetry/uv · Go modules · Cargo · Maven/Gradle/sbt · Bundler · NuGet · Composer · Mix · pub · Swift Package Manager · CocoaPods · opam · Conan · vcpkg · Arduino/PlatformIO — the same set the CLI and Action detect, scoped by `drift.analysis.ecosystems`.

Computed API-surface diffing (not just changelog evidence) is available for npm, NuGet, Hex, pub, Conan, vcpkg and Arduino with nothing installed, and for Go, Cargo, Maven and Python when their toolchain is present; the rest rely on changelog and release-note evidence. See [docs/support.md](https://github.com/trydrift/drift/blob/main/docs/support.md) for exactly what's checked per ecosystem, and how deep the support goes.

## Also available as a GitHub Action

Same engine, running in CI on every dependency bump, filing a PR. See the [repository](https://github.com/trydrift/drift).

## Known limitations

Stated plainly, because a tool that hides these hasn't earned trust:

- **Localization is single-hop.** If you wrap a dependency in your own abstraction, Drift flags the wrapper — correct, but it won't trace further.
- **Non-JS/TS parsing is pattern-based.** File and line are always exact; the enclosing symbol can be off in unusual formatting.
- **Behaviour changes are the weak spot.** "Retries are now exponential" has no symbol to search for and no compile error to catch. Drift raises risk and flags it rather than pretending.
- **Small local models struggle** with whole-file rewrites. Use a coding-tuned model with Ollama.
- **`/scan` is a network sweep.** On a large `package.json` the first run takes a while — it checks every direct dependency rather than a sample, results fill in as they arrive, and every step is named while it runs. Narrow it with `drift.analysis.ignore` or by leaving `drift.analysis.includeDev` off.

## License

PolyForm Shield 1.0.0
