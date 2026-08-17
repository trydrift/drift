# Configuration reference

Drift reads `.github/drift.yml`. Every option has a default, so the file is
optional — without one, Drift runs in `approve` mode and asks before doing
anything.

Searched in order: `.github/drift.yml`, `.github/drift.yaml`, `drift.yml`,
`drift.yaml`.

**A malformed config never fails a run.** Drift reports the problem in the run
output and falls back to defaults — which are the safe, approval-required
settings.

A copy-paste starting point: [`examples/drift.yml`](../examples/drift.yml). Or pick
your options on the site's `/configure` page (built from [`site/src/app/configure`](../site/src/app/configure))
and download a ready-to-commit `drift.yml` and workflow file.

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

default **all sixteen** — `npm`, `pypi`, `go`, `cargo`, `maven`, `rubygems`,
`nuget`, `packagist`, `hex`, `pub`, `swift`, `cocoapods`, `opam`, `conan`,
`vcpkg`, `arduino` (see [support.md](support.md) for what each can do).

Note `packagist`, not `composer`: the identifier names the registry, and
Composer is the tool that reads it. This page said `composer` for a while,
which is not a value the schema accepts — and because a malformed config falls
back to the defaults, following it produced a file that looked configured and
behaved as if it were not.

Listing a subset switches the rest **off**. There is no need to list them to
turn them on; all sixteen are already on.

### `triggerOn`

| Key | Default | Notes |
| --- | --- | --- |
| `major` | `true` | |
| `minor` | `true` | |
| `patch` | `false` | Breakage here is usually accidental, but real |
| `transitive` | `false` | Lockfile-only churn is constant and rarely actionable |
| `dev` | `true` | Dev, optional, and peer dependencies still run in CI and in some consumers' hands |

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

Patterns work too, in every `*Specs` and `*Schemas` list. `*` matches within one
path segment, `**/` matches any number of segments including none, and `?`
matches a single character:

```yaml
evidence:
  openapiSpecs:
    - "spec/**/*.yaml"
```

Patterns are expanded against the files present at the *after* revision. If
Drift cannot list the repository — a GitHub tree too large to return in full,
for instance — the pattern is reported as a gap naming itself, never expanded
to nothing and reported as clean.

### `evidence.protobuf` · `evidence.protobufSpecs`

`boolean` / `string[]` — default **`true`** / **`[]`**

The same idea for `.proto` files. Drift hands the two revisions to `buf
breaking`, which checks them against protobuf's own compatibility rules —
field numbers, wire types, deleted RPCs — rather than against a guess at them.

Drift compiles every configured `.proto` together, so imports between them
resolve. Because a `.proto` almost always imports its siblings, name the
directory rather than the single file you care about:

```yaml
evidence:
  protobufSpecs:
    - "proto/**/*.proto"
```

Each document is still compared on its own terms — a field removed from a
shared file is reported once, against that file, not again against everything
importing it.

Needs the [Buf CLI](https://buf.build/docs/installation) on `PATH`. When it is
missing, the run says so and names the remedy; it never reports a comparison
that did not happen as a clean one. An import of a file Drift was *not* told
about still cannot resolve, and that is reported as a toolchain failure naming
the import — never as "no breaking changes".

### `evidence.graphql` · `evidence.graphqlSchemas`

`boolean` / `string[]` — default **`true`** / **`[]`**

GraphQL SDL, diffed with `graphql-inspector`. No toolchain to install — it is a
library Drift ships with.

```yaml
evidence:
  graphqlSchemas:
    - "schema/api.graphql"
```

Both *breaking* and *dangerous* changes are reported, using
graphql-inspector's own classification. A removed field is breaking: the whole
operation stops validating, not just that selection. A new enum value is
dangerous: the query still runs, and an exhaustive switch over the enum has
quietly stopped being exhaustive. Purely additive changes are not reported.

Schema documents only. An operation document (`{ user(id: 1) { id } }`) that
happens to share the extension is skipped rather than diffed.

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

**Where it runs.** The worker process this spawns is a separate `node` process,
not an import, so it has to exist as a real file next to whatever is running.
All three surfaces now ship it: the CLI's `dist/` build keeps ES modules and
resolves it through `import.meta.url`, while `scripts/build-action.mjs` and
`extension/esbuild.mjs` each place a `behavioural-worker.js` beside their
bundle, which `behavioural.ts` finds via `__dirname` in CJS output.

An earlier version of this page said the feature was broken outside the CLI
because esbuild's CJS output leaves `import.meta.url` empty. That was true, and
is not any more — the resolution handles both module systems and both bundles
carry the worker.

**The real limitation** is what the result means, not where it runs: it needs
both versions of the package to be installable and executable on the machine,
which is a much stronger requirement than the rest of the pipeline, and it is
off by default for that reason.

## Telemetry

Telemetry is disabled unless you explicitly configure your own collector
endpoint; this repository does not include a hosted telemetry backend. See
[telemetry.md](telemetry.md) for the allow-list, kill switches, retention
target, and the `drift telemetry print` command that shows the exact event
shape before wiring a collector.

---

## Code scanning

Every plan Drift produces can also be rendered as
[SARIF](https://sarif.readthedocs.io) and uploaded to the repository's code
scanning dashboard, so Drift's findings sit next to CodeQL's and Scorecard's
rather than only in a pull request or an approval issue. The unit of an
alert is one *locally actionable* finding, not one package: a breaking
change becomes an alert only when it has at least one impact site — code in
this repository that actually calls the affected symbol. An upstream change
that touches nothing here never reaches the Security tab at all (an early
version of this alerted on every upstream change regardless of local impact;
zod 3 -> 4 alone found 347 individually-true breaking changes against this
project, and reachable code here used exactly one of them). The full
upstream count is still visible — in the job summary for a scheduled scan,
and in the pull request body for a push — it just isn't a Security alert.

Each alert is anchored to the highest-confidence call site as its primary
location, with every other site the same change reaches listed as a related
location. It carries what the extension's inline diagnostics carry — the
evidence (with citations), where the finding was found (including which
workspace member, in a monorepo), and a fix: the exact command for a safe
upgrade, the deterministic commit Drift will make once approved, or a note to
comment `/drift apply` on the approval issue Drift filed. Severity reflects
both dimensions of confidence: a proven upstream change (Drift computed the
diff itself) with only a loosely-matched local call site is a warning, not
an error — `error` is reserved for when both agree.

`ruleId` names the *kind* of finding (`drift/removed-export`,
`drift/vulnerability`, `drift/outdated`, ...) rather than the package it was
found in, matching how GitHub's rule descriptors are meant to be used — a
category that changes rarely, not one minted per dependency. Each result
also carries a content-based fingerprint, so the same finding reconciles
across runs even when unrelated edits shift its line number. Push-triggered
and scheduled scans upload to separate categories, so one mode's result set
never overwrites the other's: each uploads its complete current finding set
for its own category, and GitHub's own code scanning reconciliation does the
rest from there — a finding updates in place to the newest commit when it
reappears, and closes on its own (marked "fixed") the first run it doesn't.
Drift never needs to dismiss or delete an alert itself.

Requires the workflow job to grant `security-events: write` —
[`examples/workflows/drift.yml`](../examples/workflows/drift.yml) already
has it. Without that permission, Drift logs a warning naming the missing
permission and continues; nothing else about the run is affected.

### `codeScanning.enabled`

`boolean` — default **`true`**

Upload findings to code scanning after every analysed push.

### `codeScanning.includeInformational`

`boolean` — default **`false`**

Also alert on a dependency move with no breaking change and no security
signal — a plain "update available" with nothing to triage. Off by default:
that belongs in the job summary, not the Security tab. `true` adds one
low-severity alert per otherwise-quiet outdated dependency, for a team that
wants full dependency visibility in code scanning rather than just the
summary.

### `codeScanning.granularity`

`'package' | 'breakingChange' | 'affectedSite'` — default **`'package'`**

How findings are grouped into alerts.

- `'package'` folds every breaking change and security signal for one
  dependency into a single alert. No single call site is representative of
  the whole alert, so no code snippet is shown — just text and a list of
  links.
- `'breakingChange'` opens one alert per breaking change instead, covering
  every call site it reaches. The alert now covers one issue, so its
  primary location's snippet is shown as a representative example.
- `'affectedSite'` opens one alert per individual call site. There's
  exactly one location per alert, so its snippet is a direct view of that
  line, not a stand-in for anything else. This is the noisiest mode — one
  breaking change reaching fifty call sites becomes fifty alerts — hence
  not the default.

### `codeScanning.createIssuesPerAlert`

`boolean` — default **`false`**

Also open a GitHub issue for every alert, in addition to the code scanning
upload. Off by default, since code scanning already surfaces every alert on
the Security tab. Useful for teams that don't watch that tab, or that want
alerts triaged and assigned like any other issue. Each issue embeds the
alert's `ruleId` as a hidden marker, so a rescan finds the existing issue
instead of filing a duplicate — the body itself is not updated on a rescan.

## Issue creation

The one-click "file this" action offered wherever Drift shows a breaking
change — the CLI's interactive `analyze` prompt and the VS Code extension's
report view both read this block for their default, so the two surfaces
behave identically. Every action fails soft: no git repo, no `gh`/GitHub
token, or a request that errors out is logged (CLI) or shown as a
dismissable notification (extension), never a thrown error or a crashed
session.

### `issueCreation.default`

`'issue' | 'branch' | 'both'` — default **`'issue'`**

What the primary action does.

- `'issue'` files a GitHub issue with the finding's evidence and a
  rescan-safe hidden marker, mirroring `codeScanning.createIssuesPerAlert`'s
  dedup behaviour — re-triggering it finds the existing issue rather than
  filing a duplicate.
- `'branch'` creates (or checks out, if it already exists) a local branch
  named for the finding, with no issue filed.
- `'both'` does both and links them: the branch name is included in the
  issue body.

The extension's report view always offers the other two choices one click
away, in the button's dropdown, regardless of this setting.

### `issueCreation.granularity`

`'package' | 'change'` — default **`'package'`**

What one issue/branch covers.

- `'package'` bundles every breaking change for one dependency into a single
  issue/branch — the option offered at each package's group header.
- `'change'` scopes the action to one breaking change at a time — useful
  when different call sites of the same upgrade need to be triaged or
  landed separately. This is also always offered on each individual finding,
  regardless of this setting.

### `issueCreation.assignees`

`string[]` — default **`[]`**

GitHub usernames to assign automatically to every issue Drift files —
approval issues, and per-alert issues opened via
`codeScanning.createIssuesPerAlert`. Empty by default; nobody is assigned
unless a team opts in.

### `outdated.enabled`

`boolean` — default **`false`**

Proactive scanning of every *installed* dependency against its registry,
independent of any push — the same check `drift outdated` runs locally.
Off by default because, unlike the rest of this config, it has no push to
react to and needs a `schedule` trigger of its own; see
[`examples/workflows/drift-outdated.yml`](../examples/workflows/drift-outdated.yml).

Each dependency it finds becomes a code scanning alert exactly like the ones
above. It does not open a branch or a pull request: a `RemediationPlan` from
this scan describes what fixing the code *would* look like if the upgrade
were taken, and dispatching that as a real commit would mean editing code for
an upgrade nobody applied yet. The alert's fix instead names the exact
command — `drift outdated --upgrade <name>`, or the underlying package manager command —
that applies it; once that lands and is pushed, the ordinary push-triggered
pipeline above takes over exactly as it would for a human's own bump.

### `tools.autoInstall`

`boolean` — default **`true`**

Install a missing Drift-owned helper analyzer (`cargo-public-api`, `japicmp`)
the moment a scan needs it, instead of reporting the gap and waiting for a
second, manual pass. On by default — these are known, named commands Drift
runs on its own behalf, not arbitrary code. Set to `false` if you don't want
a scan installing global toolchain binaries via `cargo`/`brew` as a side
effect.

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

**Deprecated — use [`pullRequest.draft`](#pullrequestdraft).**

`boolean` — no default. Honoured only when `pullRequest.draft` is unset, so an
existing config keeps working unchanged.

Both fields used to be read and OR'd together, and this one defaulted to
`true`. That made the replacement unusable: setting `pullRequest.draft: false`
produced a draft anyway, because the deprecated field it was combined with was
still `true`. Precedence is now explicit — `pullRequest.draft` wins outright
when set, this is consulted only in its absence, and the effective default is
`true` either way.

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

Whether Drift may query Codemod.com's registry and Maven Central (for
OpenRewrite, restricted to its own `org.openrewrite.recipe` group — see
`src/remediation/live-search.ts`) for a recipe matching a finding its own
codemod engine could not resolve.

This gates the network query itself, on every surface: with this `false` (the
default), Drift never contacts either registry, so a plain `drift analyze`
makes no third-party network calls for this.

**What a recipe is allowed to do changed with fix plans.** A recipe used to
be an execution tier — a match was scope-checked and its diff committed.
Scope checking answers "did it stay in its lane" and never answers "is this
the right edit", so a recipe is now a *proposal source* instead. It runs in a
throwaway worktree purely to be observed; Drift reads the edits it made,
infers which of its own operations would explain them, and puts the result
through the same gate a model-authored plan goes through. What reaches your
repository is Drift's operations, applied by Drift's executor. The recipe's
output is discarded along with the worktree, and a recipe whose edits Drift
cannot re-derive is declined rather than trusted — the finding goes to an
agent and the report says the recipe was *consulted*.

See [fix-plans.md](fix-plans.md#community-recipes-are-an-input-not-an-override).

```yaml
remediation:
  communityRecipes: true
```

### `remediation.fixPlans`

A migration described once, as a rule, and applied by Drift to every call
site at once. The tier between Drift's own codemod engine and handing a
finding to an AI agent — see [fix-plans.md](fix-plans.md) for the full
treatment.

```yaml
remediation:
  fixPlans:
    enabled: false
    minCoverage: 0.5
    autoApply: review
    cache: true
```

#### `remediation.fixPlans.enabled`

`boolean` — default **`false`**

Ask a model to author a plan for findings nothing cheaper resolved. Off by
default because authoring needs [`llm.enabled`](#llm) and an API key.

With it off, **cached and recipe-derived plans are still used** — neither
costs a model call — so a repository can benefit from plans validated
elsewhere without configuring a model at all.

#### `remediation.fixPlans.minCoverage`

`number` between `0` and `1` — default **`0.5`**

The fraction of a finding's call sites a plan must cover to be used at all.

Coverage is decided per call site rather than per finding: a rule explaining
nine of ten call sites resolves nine, and the tenth is handed to an agent
individually with a reason attached. But a rule explaining *one* site out of
forty is not a migration — it is a coincidence, and acting on it splits one
finding across two mechanisms for no benefit. This is the floor. Set it to
`0` to take any coverage at all, or `1` to accept only plans that resolve a
finding completely.

Enforced once, centrally, so all three surfaces agree about which findings
even have a deterministic fix.

#### `remediation.fixPlans.autoApply`

`'review' | 'proven' | 'verified'` — default **`'review'`**

Whether a plan may be applied without a human seeing it first.

| Value | Behaviour |
| --- | --- |
| `review` | Always write the plan document and ask, on every surface that can ask. |
| `proven` | Apply plans whose every operation is structurally incapable of changing whether the file parses (a token or string swap). Ask about the rest. |
| `verified` | Also apply structural plans, once the project's own checks have actually passed against them. |

There is deliberately no `always`. **A plan Drift cannot promise still parses
is never applied unattended without the project's own checks passing**,
regardless of this setting — that combination is precisely where a
deterministic engine would propagate a mistake faster than any per-site agent
could. Verification being *switched off* is not verification that *passed*,
and the two are distinguished.

`mode: approve` reviews everything regardless of this setting: a repository
that asks before an agent edits it is not asking to be edited
deterministically instead.

#### `remediation.fixPlans.cache`

`boolean` — default **`true`**

Reuse plans previously validated for the same migration.

The cache is keyed on the migration — dependency, version range, change kind,
symbols — and never on the repository, so a plan validated for one codebase
is a candidate for any other hitting the same upstream break. Restored plans
are re-validated against the local call sites exactly as fresh ones are: the
cache saves the authoring call, never the checking.

Plans live in `~/.drift/cache/fixplans/` as plain JSON. `DRIFT_CACHE_DIR`
moves the whole cache; `DRIFT_NO_CACHE=1` disables it.

---

## Pull request

How the pull request gets opened. Drift never merges it.

### `pullRequest.enabled`

`boolean` — default **`true`**

Open a pull request once the branch is pushed. With this off, Drift stops at
the pushed branch.

How it opens depends on what the machine has. The CLI and the VS Code extension
both prefer the GitHub CLI (`gh`) when it is installed and signed in, since it
carries its own credential and needs nothing from you; the extension then falls
back to your VS Code GitHub sign-in, and finally to opening GitHub's own pull
request page for the pushed branch. `gh` is a shortcut, never a requirement.

### `pullRequest.confirm`

`ask` | `never` — default **`ask`**

Confirm the branch name and title first, in the CLI and the VS Code panel. The
GitHub Action ignores this and always proceeds: there is nobody there to
answer, and a workflow that stops to prompt is a workflow that hangs.

### `pullRequest.base`

`branched-from` | `default-branch` — default **`branched-from`**

Which branch to merge into. `branched-from` targets whatever the work started
from, which is the right answer on any team that does not develop directly on
its default branch — targeting `main` from a `develop`-based branch proposes
merging into the wrong place and shows a diff full of other people's commits.

### `pullRequest.draft`

`boolean` — effective default **`true`**

Open as a draft for a human to promote. This is the single source of truth;
the deprecated [`remediation.draftPr`](#remediationdraftpr) is consulted only
when this is unset.

### `pullRequest.labels`, `pullRequest.reviewers`

`string[]` — default **`[]`**

Labels applied and reviews requested, when the credential can set them. Read by
the Action, the CLI and the VS Code extension alike — there is deliberately no
editor setting for either, because a label set and a reviewer list are
properties of the repository everyone shares, not of one developer's editor.

### `pullRequest.branchTemplate`, `pullRequest.titleTemplate`

`string` — default **`{prefix}upgrade-{summary}-{date}`** and
**`chore(deps): upgrade {summary}`**

Placeholders: `{prefix}`, `{summary}`, `{name}`, `{from}`, `{to}`, `{count}`,
`{date}`. An unrecognised placeholder is left verbatim, so a typo produces an
obviously wrong name rather than a plausible one that silently collides with
the next run.

### `pullRequest.coAuthor`

`boolean` — default **`true`**

Credit Drift as a co-author on the commits it makes. You stay the author — you
chose the upgrade and reviewed the diff. Turn it off if your repository lints
commit trailers.

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
| --- | --- | --- | --- |
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
| --- | --- | --- |
| Claude Code | Low, Medium, High, **Ultracode** | thinking depth in the prompt (`think` → `ultrathink`) |
| Codex | Low, Medium, High, **Extra High** | `-c model_reasoning_effort="…"` |
| Copilot (in-editor), Copilot cloud, Gemini CLI, Aider, OpenCode, Ollama | — | no reasoning control, so the dial is not drawn |

A model that cannot honour the top stop narrows the dial rather than offering a
position that would do nothing — Claude Haiku stops at High.

**Permission:**

| | Before editing | After editing |
| --- | --- | --- |
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
| --- | --- | --- |
| `drift.agent.preferred` | `auto` | Which agent, or best available |
| `drift.agent.copilotModelFamily` | — | Pin an in-editor Copilot model family |
| `drift.agent.ollamaHost` / `ollamaModel` | `localhost:11434`, `qwen2.5-coder` | Local model |
| `drift.agent.timeoutSeconds` | `600` | Per commit unit |
| `drift.analysis.runOnStartup` | `true` | Analyse on open, and scan when the panel first opens |
| `drift.analysis.includePatch` / `includeTransitive` | `false` | Widen `/recent` analysis |
| `drift.analysis.includeDev` | `true` | Also analyse dev, optional, and peer dependencies |
| `drift.analysis.ignore` | `[]` | Package patterns to skip, added to `ignore` in `drift.yml` |
| `drift.ui.showInlineDiagnostics` | `true` | Flag affected lines in the Problems panel |
| `drift.logLevel` | `info` | Output channel verbosity |

---

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | Repository reads, branch creation, issues |
| `DRIFT_COPILOT_TOKEN` | **User-scoped** token for the Copilot agent API |
| `DRIFT_TELEMETRY_DISABLED` | `1` or `true` disables telemetry even when opted in |
| `DO_NOT_TRACK` | `1` disables telemetry |
| `ANTHROPIC_API_KEY` | Only when `llm.enabled: true` |
| `GITHUB_WEBHOOK_SECRET` | Webhook runner only |
| `DRIFT_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
| `DRIFT_DRY_RUN` | `true` to analyse without writing |
