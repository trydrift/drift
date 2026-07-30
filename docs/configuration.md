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
  for a `/drift apply` comment.
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

---

## Selection

### `ecosystems`
default **all six** — `npm`, `pypi`, `go`, `cargo`, `maven`, `rubygems`

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

Findings below this are reported but not acted on unattended.

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

These three exist as settings so a team can commit a default in
`.vscode/settings.json`, but the expected way to change them is the picker in the
composer, where the effect is visible.

| Setting | Values | Meaning |
|---|---|---|
| `drift.session.mode` | `agent` (default), `ask` | `ask` analyses and explains but never edits |
| `drift.session.effort` | `quick`, `balanced` (default), `thorough` | How widely to look — see below |
| `drift.session.permission` | `ask`, `auto-edit` (default), `full-auto` | How much the agent may do unsupervised |

**Effort changes what is analysed, not just how long it takes:**

| | Dependencies | Bumps | Impact sites per change | Packages |
|---|---|---|---|---|
| `quick` | runtime only | major, minor | 12 | first 25 |
| `balanced` | runtime only | major, minor | 40 | all |
| `thorough` | runtime, dev, optional, peer | major, minor, patch | 120 | all |

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
| `ANTHROPIC_API_KEY` | Only when `llm.enabled: true` |
| `GITHUB_WEBHOOK_SECRET` | Webhook runner only |
| `DRIFT_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
| `DRIFT_DRY_RUN` | `true` to analyse without writing |
