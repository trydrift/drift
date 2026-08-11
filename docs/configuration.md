# Configuration reference

Drift reads `.github/drift.yml`. Every option has a default, so the file is
optional — without one, Drift runs in `approve` mode and asks before doing
anything.

Searched in order: `.github/drift.yml`, `.github/drift.yaml`, `drift.yml`,
`drift.yaml`.

**A malformed config never fails a run.** Drift reports the problem in the run
output and falls back to defaults — which are the safe, approval-required
settings.

A copy-paste starting point: [`examples/drift.yml`](../examples/drift.yml).

---

## Autonomy

### `mode`
`auto` | `approve` — default **`approve`**

- **`approve`** — Drift analyses, files an issue with the full plan, and waits
  for a `/drift apply` comment from someone with `write`, `maintain`, or `admin`
  permission on the repository. The command must be on a line of its own, so
  quoting it while discussing it does not approve anything.
- **`auto`** — Drift dispatches as soon as it detects a breaking change, subject
  to every guardrail below.

Start on `approve`. Read a few plans. Move to `auto` when they stop surprising
you.

### `maxAutoRisk`
`none` | `low` | `medium` | `high` — default **`medium`**

The highest risk level eligible for automatic dispatch. Anything above falls back
to approval — it is not dropped.

```yaml
maxAutoRisk: low   # only let Drift act unattended on the boring cases
```

### `watchBranches`
`string[]` — default **`[main, master, develop]`**

Glob patterns. Pushes to other branches are ignored.

This is the single source of truth, and the shipped workflow is deliberately
*not* filtered by branch so that it can be. The workflow used to subscribe to
`branches: [main]` as well, which meant a repository that set
`watchBranches: [develop]` was configured for a branch its workflow would never
start on — and nothing anywhere said so. GitHub starts the job on any push that
touches a dependency file; the Action then checks this setting and exits early
with a message naming the branch when it does not match.

---

## Selection

### `ecosystems`
default **all** — every ecosystem Drift can detect: `npm`, `pypi`, `go`, `cargo`,
`maven`, `rubygems`, `nuget`, `composer`, `cocoapods`, `hex`, `opam`, `pub`,
`swift` (see [support.md](support.md) for what each can do)

### `triggerOn`

| Key | Default | Notes |
|---|---|---|
| `major` | `true` | |
| `minor` | `true` | |
| `patch` | `false` | Breakage here is usually accidental, but real |
| `transitive` | `false` | Lockfile-only churn is constant and rarely actionable |
| `dev` | `false` | Dev dependencies rarely break production paths |

**`0.x` minor bumps are always analysed**, regardless of `minor`, because semver
§4 makes them breaking.

### `ignore`
`string[]` — default **`[]`**

Glob patterns matched against the package name. Never analysed.

```yaml
ignore:
  - "@types/*"
  - "eslint*"
```

### `alwaysApprove`
`string[]` — default **`[]`**

Matching dependencies always require a human, even in `auto` mode. Use this for
the ones that would ruin your week.

```yaml
alwaysApprove:
  - "stripe"
  - "next"
```

---

## Evidence

### `evidence.githubReleases` · `evidence.changelog`
`boolean` — default **`true`**

Release notes and `CHANGELOG` / migration-guide retrieval from the dependency's
source repository.

### `evidence.typeSurface`
`boolean` — default **`true`**

Diffs the actual TypeScript declarations of the old and new versions. **The
strongest signal available for npm**, and the answer to changelogs that omit a
removal. npm only; packages without declarations simply produce no evidence from
this source.

### `evidence.openapi` · `evidence.openapiSpecs`
`boolean` / `string[]` — default **`true`** / **`[]`**

`openapiSpecs` lists OpenAPI documents *this repo consumes*. Drift diffs them
between commits and finds the client code that breaks.

This catches something no package manager can see: an upstream HTTP service
changing its contract. If you vendor a partner's spec, list it here.

```yaml
evidence:
  openapiSpecs:
    - "api/openapi.yaml"
    - "spec/partner-api.json"
```

Literal paths only — globs are not yet resolved.

### `evidence.maxReleases`
`number` — default **`25`**

Cap on release notes fetched per dependency.

---

## Verification

### `verification.behavioural`

Experimental, npm/TypeScript only, and off by default.

```yaml
verification:
  behavioural:
    enabled: false
    sandbox: required
    maxSymbols: 10
    maxCasesPerSymbol: 20
    timeoutSeconds: 120
    network: false
    memoryMb: 1024
    cpuLimit: 1
    retainArtifacts: false
```

When enabled, Drift can run bounded old-vs-new probes for changed APIs that are
supported by upstream evidence and locally reachable. The runner uses separate
old and new package environments, disables network by default, restricts file
access, bounds output and wall time, and records differential observations as
evidence.

No observed difference is **not** proof of behavioural compatibility. It only
raises verification confidence for the tested contract and generated input
domain, and the report records the limitations.

**Known limitation (v0.1):** the worker process this spawns is located via
`import.meta.url`, which esbuild's CJS output leaves empty. That resolution
works in the published CLI (its `dist/` build keeps ES modules), but breaks
if `enabled: true` is set for the GitHub Action or the VS Code extension,
both of which ship as single-file bundles. Leave this disabled outside the
CLI until that is fixed.

## Telemetry

Telemetry is off by default. See [telemetry.md](telemetry.md) for the allow-list,
kill switches, retention target, deletion approach, and the `drift telemetry
print` command that shows the exact event shape before collection is enabled.

---

## Upgrade rationale

Why an upgrade might be worth taking, alongside what it might cost. On by
default, because a tool that only ever argues against upgrading is a tool people
stop opening.

### `rationale.security`
`boolean` — default **`true`**

Query [OSV](https://osv.dev) for both the installed and the target version, and
report which advisories the upgrade resolves, carries, and introduces. The
question asked is not "does this package have vulnerabilities" — that is a
scanner's question — but whether *taking this upgrade* improves, preserves, or
worsens known exposure.

Covers npm, PyPI, Go, crates.io, Maven, and RubyGems. Unreachable OSV degrades
the assessment to "not checked", never to an all-clear.

### `rationale.maintenance`
`boolean` — default **`true`**

Deprecation notices, archived repositories, Go `retract` directives, PyPI and
crates.io yanks, release dates, the latest stable version, and raised runtime
minimums.

Deliberately produces no health score. A mature library can go eighteen months
without a commit because it is finished; scoring that as decay is how a
dashboard talks a team out of a dependency that was never a problem.

### `rationale.summary`
`boolean` — default **`true`**

A plain-English summary of what changed upstream, separated into breaking
changes, security fixes, improvements, and fixes, each citing its source.

Nothing is generated: every line is a sentence a maintainer published. A line
that cannot be classified becomes an "improvement", the weakest label available.

## Licenses (optional)

Off by default. A license check with no configured policy has nothing to compare
against, and reporting "the license is MIT" on every upgrade is noise.

Drift reports what the metadata says and how it compares to the policy in this
file. **It does not give legal advice.**

### `licenses.enabled`
`boolean` — default **`false`**

Turn on license checking. Note that a *change* of declared license between the
two versions is reported whether or not this is enabled — MIT becoming AGPL
inside a version bump is a decision being made silently, and that is worth
surfacing regardless of policy.

### `licenses.allow` · `licenses.deny`
`string[]` — default **`[]`**

SPDX identifiers. `deny` always wins over `allow`. An empty `allow` list permits
everything not denied.

```yaml
licenses:
  enabled: true
  allow: [MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC]
  deny: [AGPL-3.0, SSPL-1.0]
```

A disjunction such as `MIT OR Apache-2.0` is satisfied by any permitted branch,
because the consumer chooses; a conjunction such as `MIT AND AGPL-3.0` binds the
consumer to both, so both must be permitted.

The check also looks at dependencies the target version newly introduces. This
covers the upgraded package's own declared dependencies — resolving the full
transitive graph would mean running the package manager, which analysis never
does — and the report says so rather than implying whole-graph coverage.

### `licenses.requireDeclared`
`boolean` — default **`false`**

Treat a missing or unreadable license as a violation. Off by default: many
registries simply do not publish the field — Go publishes none at all — and
failing an upgrade over an empty registry column is the kind of false alarm that
gets a policy check switched off entirely.

## Guardrails

### `guardrails.protectedPaths`
`string[]` — default:

```yaml
- ".github/workflows/**"
- "**/*.lock"
- "infra/**"
- "terraform/**"
- "**/secrets/**"
```

Drift will not direct an agent to edit anything matching these. Enforced twice:
as a blocker when impact sites fall inside them, and as an explicit prohibition
in the agent prompt.

### `guardrails.maxFilesChanged`
`number` — default **`50`**

A plan wider than this asks for a human. A change nobody can meaningfully review
is not a change Drift should make unattended.

### `guardrails.maxDependenciesPerRun`
`number` — default **`10`**

Batched upgrades make it hard to attribute a regression to the dependency that
caused it.

### `guardrails.requireEvidence`
`boolean` — default **`true`**

Refuse to dispatch when the only evidence is a semver bump. **Strongly recommend
leaving this on** — it's the difference between Drift and guessing.

### `guardrails.minConfidence`
`low` | `medium` | `high` — default **`medium`**

A finding below this threshold that Drift planned a commit for **blocks
automatic dispatch**. The plan is still filed in full for review, and one
`/drift apply` from someone with write access proceeds.

Confidence here is the calibrated value, which combines how sure Drift is that
the change happened upstream with how sure it is that this repository is
affected — a finding is only as trustworthy as its weaker half. See
[the confidence model](architecture.md#confidence-in-three-dimensions).

Findings below the threshold that Drift did *not* plan a commit for are listed
as warnings and do not block. Nothing is about to be edited on their account,
and blocking on them would train people to raise the threshold until it stopped
meaning anything.

> **This changed.** It used to warn only, which made the setting a lie: a
> repository configured for `high` would still dispatch an agent against a
> low-confidence guess, having noted its own doubt in a paragraph nobody had to
> read.

### `guardrails.experimentalDispatchBelowMinConfidence`
`boolean` — default **`false`**

Dispatch automatically even when findings are below `minConfidence`. Named for
what it is. This exists for teams deliberately exploring what an agent does with
weak evidence on a throwaway branch, and it is the only way to get the previous
behaviour back. Leaving it off is correct for every repository whose branches
matter.

### `guardrails.forbidTestWeakening`
`boolean` — default **`true`**

Adds an explicit instruction that tests must be updated to the new API, never
weakened or deleted to make them pass.

---

## Remediation

### `remediation.commitGranularity`
`per-breaking-change` | `per-dependency` | `single` — default
**`per-breaking-change`**

Per-breaking-change is recommended: it's what keeps `git revert` and `git bisect`
meaningful, and it lets a reviewer approve one fix without judging the rest.

### `remediation.branchPrefix`
`string` — default **`drift/`**

Branches are named `<prefix><package>-<version>-<sha7>`.

### `remediation.draftPr`
`boolean` — default **`true`**

### `remediation.model`
`string` — optional. Model hint passed to the Copilot agent API.

### `remediation.customInstructions`
`string` — default **`""`**

Appended verbatim to every agent task. Put your repository's conventions here —
this is the highest-leverage setting for output quality.

```yaml
remediation:
  customInstructions: |
    This repo uses Vitest, not Jest. Run `pnpm test` to verify.
    Prefer named exports. Do not add barrel files.
    All HTTP calls go through src/lib/http.ts — never call fetch directly.
```

### `remediation.communityRecipes`
`boolean` — default **`false`**

Every surface resolves a commit's fix the same way: Drift's own deterministic
codemod first, then — only when this is `true` — a matching, version-pinned
recipe discovered live from Codemod.com's registry or Maven Central (for
OpenRewrite, restricted to its own `org.openrewrite.recipe` group — see
`src/remediation/live-search.ts`), then an AI agent.

This is what gates the network query itself, on every surface, not just
whether a found recipe may run: with this `false` (the default), Drift never
queries either registry, so a plain `drift analyze` makes no third-party
network calls for this. Set it to `true` to let Drift ask Codemod.com and
Maven Central whether a recipe exists for a finding its own codemod engine
couldn't resolve — the result is still only ever a proposal, never applied
automatically.

On the **GitHub Action**, which cannot prompt, this is also what gates
whether a found recipe is actually used instead of falling straight to
Copilot:

```yaml
remediation:
  communityRecipes: true
```

On the **CLI** and in the **VS Code extension**, enabling this surfaces a
matching recipe as an explicit choice (a prompt, or `--community-recipes`
for non-interactive `drift fix` runs) — it is still never run without that
choice, in this run or on this exact pinned version. A
recipe is never executed silently on any surface, and Drift's own codemod
always takes priority over a recipe when both could resolve a commit.

---

## LLM (optional)

Off by default. Drift's rule engine is deterministic and needs no API key.

Enabling this improves *recall* on prose changelogs the rules can't parse.
Findings it produces are capped at `medium` confidence and can never clear the
dispatch gate on their own.

```yaml
llm:
  enabled: false
  provider: anthropic
  model: claude-opus-5
  effort: medium          # low | medium | high | xhigh | max
  apiKeyEnv: ANTHROPIC_API_KEY
```

`apiKeyEnv` names the environment variable — never put a key in this file.

Requires `@anthropic-ai/sdk` (an optional dependency). If `enabled: true` but the
key or package is missing, Drift warns and continues with rules only.

---

## Recipes

**Cautious — recommended starting point**

```yaml
mode: approve
```

That's it. Everything else defaults correctly.

**Autonomous for the safe cases only**

```yaml
mode: auto
maxAutoRisk: low
alwaysApprove: ["stripe", "next", "@aws-sdk/*"]
guardrails:
  minConfidence: high
```

**High-signal, low-noise**

```yaml
mode: auto
triggerOn:
  major: true
  minor: true
  patch: false
  transitive: false
ignore: ["@types/*", "eslint*", "prettier"]
```

**Consuming an upstream API**

```yaml
evidence:
  openapiSpecs: ["api/partner-openapi.yaml"]
guardrails:
  minConfidence: medium
```

---

## VS Code settings

The extension reads the same `.github/drift.yml`, then layers VS Code settings on
top. **The file is the team's policy; settings are the individual's preference**,
so a developer can widen what they see locally without changing what the
repository enforces for everyone.

### Set from the panel composer

These exist as settings so a team can commit a default in
`.vscode/settings.json`, but the expected way to change them is the control in
the composer, where the effect is visible. Each one opens a themed menu anchored
under its own button, listing the options with a line explaining what each does,
so the setting does not have to be looked up to be understood.

| Setting | Scope | Values | Meaning |
|---|---|---|---|
| `drift.session.mode` | workspace | `agent` (default), `ask` | `ask` analyses and explains but never edits |
| `drift.session.permission` | workspace | `ask`, `auto-edit` (default), `full-auto` | How much the agent may do unsupervised |
| `drift.agent.models` | global | `{ "<agent id>": "<model id>" }` | The model chosen inside each subscription |
| `drift.agent.efforts` | global | `{ "<agent id>": "low" \| "medium" \| "high" \| "xhigh" }` | How hard that subscription's model thinks |

The model and the effort are kept per subscription and globally, because both are
statements about a product rather than about a repository: "when I use Claude,
use Opus on Ultracode" should still hold in the next project.

**Effort is a reasoning budget, and only that.** It never changes which
dependencies are checked, how many impact sites are recorded, or which fixes are
attempted — every level does all of the work the evidence calls for. What scope a
scan has is decided by `drift.analysis.includeDev`, `includePatch` and
`ignore`, and it means the same thing at every effort level.

Each agent names its own stops, and Drift uses the vendor's word:

| Agent | Stops | How it is passed |
|---|---|---|
| Claude Code | Low, Medium, High, **Ultracode** | thinking depth in the prompt (`think` → `ultrathink`) |
| Codex | Low, Medium, High, **Extra High** | `-c model_reasoning_effort="…"` |
| Copilot (in-editor), Copilot cloud, Gemini CLI, Aider, OpenCode, Ollama | — | no reasoning control, so the dial is not drawn |

A model that cannot honour the top stop narrows the dial rather than offering a
position that would do nothing — Claude Haiku stops at High.

**Permission:**

| | Before editing | After editing |
|---|---|---|
| `ask` | Asks in the thread, per commit group | Waits for keep/undo |
| `auto-edit` | Edits | Waits for keep/undo; commits a group when it is fully kept |
| `full-auto` | Edits | Commits each group immediately |

On `ask` and `auto-edit`, **nothing reaches a commit without a human keeping it.**

### The one worth setting by hand

`drift.fix.customInstructions` — your repository's conventions, passed to every
agent on every run. The highest-leverage setting for output quality:

```text
This repo uses Vitest, not Jest. Prefer named exports.
All HTTP goes through src/lib/http.ts — never call fetch directly.
```

Anything you type into the panel that is not a command and not an answer to a
question is appended here, so the composer doubles as the way to add a convention
mid-session.

### The rest

| Setting | Default | Meaning |
|---|---|---|
| `drift.agent.preferred` | `auto` | Which agent, or best available |
| `drift.agent.copilotModelFamily` | — | Pin an in-editor Copilot model family |
| `drift.agent.ollamaHost` / `ollamaModel` | `localhost:11434`, `qwen2.5-coder` | Local model |
| `drift.agent.timeoutSeconds` | `600` | Per commit unit |
| `drift.analysis.runOnStartup` | `true` | Analyse on open, and scan when the panel first opens |
| `drift.analysis.includePatch` / `includeDev` / `includeTransitive` | `false` | Widen `/recent` analysis |
| `drift.analysis.ignore` | `[]` | Package patterns to skip, added to `ignore` in `drift.yml` |
| `drift.ui.showInlineDiagnostics` | `true` | Flag affected lines in the Problems panel |
| `drift.logLevel` | `info` | Output channel verbosity |

---

## Environment variables

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` | Repository reads, branch creation, issues |
| `DRIFT_COPILOT_TOKEN` | **User-scoped** token for the Copilot agent API |
| `DRIFT_TELEMETRY_DISABLED` | `1` or `true` disables telemetry even when opted in |
| `DO_NOT_TRACK` | `1` disables telemetry |
| `ANTHROPIC_API_KEY` | Only when `llm.enabled: true` |
| `GITHUB_WEBHOOK_SECRET` | Webhook runner only |
| `DRIFT_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
| `DRIFT_DRY_RUN` | `true` to analyse without writing |
