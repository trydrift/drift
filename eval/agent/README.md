# Dependency-upgrade agent benchmark

Does Drift let the **same coding agent** fix a **real dependency upgrade** with
**fewer input tokens** and **a higher probability of a correct fix**?

Two questions, one set of trials. Each trial is one agent session on one case
under one condition, and every trial reports both what the session consumed and
whether the repository it left behind actually works with the new version.

```text
real repository at a fixed commit
        ↓
dependency upgraded from old version to new version (manifest + lockfile)
        ↓
application code NOT yet migrated
        ↓
the agent is asked to make it work    ← baseline: the task alone
                                      ← drift:    the task + Drift's report
        ↓
validation, hidden tests staged only now
```

This directory holds the cases and the suites. The harness is
[`eval/src/agent/`](../src/agent/); results are under
[`eval/results/agent/`](../results/agent/) and the report under
[`eval/reports/agent/`](../reports/agent/). The benchmark is internal and
publishes nothing — no page, no README figure — and `benchmark:agent:verify`
fails the build if one appears. What it found is in
[`eval/reports/agent/final-verdict.md`](../reports/agent/final-verdict.md).

---

## The two conditions

**Baseline.** The agent receives this task and nothing else:

```text
The dependency <package> has been upgraded from <old> to <new>.

Update this repository so that it works correctly with the new version.

Find and fix all relevant incompatibilities.

Do not revert or downgrade the dependency.

Run the appropriate tests/build/typecheck and leave the repository in a working state.
```

It has its ordinary tools: file reads, search, shell, the package manager, the
installed package contents. Nothing is withheld from it and nothing is
pre-loaded into its context. The baseline is not handicapped; it investigates
the way a developer's agent would.

**Drift.** The identical task text, followed by Drift's report for that
upgrade. The report is produced by the production pipeline
(`runPipeline` over `LocalGitProvider`, `dryRun`, then
`renderPullRequestBody`) — the same code path and the same text as

```sh
drift analyze --before <base> --after <start> --markdown --verify
```

which is what the CLI prints and the GitHub Action posts: computed breaking
changes with their evidence and citations, the file and line of every impact
site the Meta-RAG index located, the project's own checks run against the
bumped tree, gaps Drift could not close. One benchmark-authored sentence
introduces it (`DRIFT_PREAMBLE_HEADER` in `eval/src/agent/task.ts`); the rest
is the product's own output. There is no benchmark-only prompt.

Everything else is identical and recorded per trial: model, effort, permission
mode, tool set, disallowed tools, network policy, time limit, budget, the start
tree hash, and the SHA-256 of the task text.

Two ablations exist for diagnostics — `drift-evidence-only` (the report with
impact sites removed) and `drift-localization-only` (the report with evidence
excerpts withheld). Both go through the production renderer and neither ever
enters a headline.

## What one trial produces

```text
Efficiency (from the provider's own usage record)
  grossInputTokens         input + cache-read + cache-creation, every model, every turn   ← headline
  uncachedInputTokens      input + cache-creation                                          ← secondary
  cacheReadTokens, cacheCreationTokens, outputTokens, modelCalls, byModel
  tool calls by tool, file reads, unique files read, searches, shell commands, edits
  agent wall clock, Drift analysis time (separately; never added to the agent's)

Effectiveness (binary)
  dependency integrity     manifest still selects the new version and not the old one;
                           a fresh install succeeds; the installed version equals the new version
  project checks           every declared build / typecheck / test / lint / runtime command passes
  hidden regression tests  every hidden test passes (staged after the agent exited)
  forbidden rules          no case-specific workaround rule fires
  success = all of the above, and the session neither timed out nor errored
```

Failure reasons are categorical and can co-occur: `dependency_reverted`,
`install_failure`, `build_failure`, `typecheck_failure`,
`existing_test_failure`, `lint_failure`, `runtime_failure`,
`hidden_regression_failure`, `prohibited_workaround`, `timeout`, `agent_error`,
`incomplete_fix` (the agent changed nothing). Nothing is inferred from prose.

### Input tokens, exactly

For Claude Code the session is started with `--output-format stream-json
--verbose`. Every model response arrives as an `assistant` event carrying the
API's `usage` block; the final `result` event carries the CLI's cumulative
per-model account (`modelUsage`). The harness:

- reads the headline from `modelUsage`, summing `inputTokens +
  cacheReadInputTokens + cacheCreationInputTokens` over every model the session
  used (the CLI calls a small auxiliary model for its own housekeeping; both
  conditions pay that identically and it is reported per model);
- re-sums the per-message ledger, **deduplicated by message id** (the CLI emits
  one event per content block, all with the same id and usage), and records
  whether it agrees with the provider's record;
- falls back to the ledger, and says so in `usage.source`, only for a session
  killed at the timeout before its `result` event.

Nothing is estimated from characters, prompt size, or a tokenizer. The stream
format was verified against the installed CLI (2.1.267) and the parser is
covered by fixture tests; a future CLI that renames a field fails those tests
rather than under-counting.

### Tool counting, exactly

Tool calls are `tool_use` blocks in the event stream, deduplicated by block id.
File reads are `Read` calls; unique files read are distinct `Read` paths;
searches are `Grep` and `Glob`; shell commands are `Bash` invocations, each
counted once however many programs the command line ran; edits are `Edit`,
`Write`, `MultiEdit`, `NotebookEdit`. A file read through `cat` in a shell
command is **not** a file read. These are diagnostics, and the report says so.

## Isolation

Each trial:

1. builds a fresh temporary git repository from the case's source — a cached
   `--mirror` clone for git sources, `fixture/` for synthetic ones — with
   exactly two commits (before and after the bump), no remote and no later
   history, so the maintainer's eventual fix is not reachable;
2. audits it: any path named like private material (`hidden`, `.drift-hidden`,
   `hidden.yml`, `reference.patch`) or any symlink leaving the workspace throws;
3. installs dependencies, so both conditions start from an installed tree;
4. runs Drift (Drift condition only) and then the agent, with browsing tools
   (`WebFetch`, `WebSearch`) disabled by default for both conditions, user
   settings, plugins, hooks and MCP servers excluded (`--safe-mode
   --strict-mcp-config`), no session persistence, and permissions bypassed so
   the session runs unattended;
5. captures the diff, then copies the hidden tests into `.drift-hidden/`, runs
   every validation layer, and deletes them again.

This is a **workspace audit, not an OS sandbox**: the case's private half is
readable elsewhere on the host by a process the agent starts. Every trial
records that. Package-manager caches (npm's, for instance) are shared across
trials and conditions; they affect both equally.

## Cases

```text
eval/agent/cases/<id>/
  case.yml              public: repository, base and start commits, dependency and versions,
                        install and check commands, integrity paths, objective metadata
  fixture/start|base/   synthetic cases only: the two trees
  admission.json        the last admission run's evidence
  hidden/hidden.yml     private: hidden tests, forbidden rules, expected symbols
  hidden/reference.patch  a known-correct fix (maintainer's or benchmark-authored); admission only
  hidden/*              the hidden tests' own files
```

A case is `historical` (a real repository, a real bump, a real later fix by a
maintainer), `mined` (a real repository at a real commit, a real published
upgrade applied by the benchmark — the construction swe-bump-bench and BUMP
use — and a benchmark-authored reference fix), or `synthetic` (a consumer this
project wrote against a real package). Synthetic cases develop the harness and
can never enter a public suite; the gates refuse them. The share of each is
printed in every result. A case's `role` is `development` or `held-out`; the share of held-out
cases is printed in every result.

Metadata is objective only: ecosystem, dependency category, semver class,
failure mode (compile-time / runtime / configuration / mixed), number of known
affected locations, whether a migration guide exists, whether the reference fix
spans several files. There is no `easy`/`medium`/`hard`.

### Admission

```sh
npm run benchmark:agent:validate -- --case <id>
npm run benchmark:agent:validate -- --suite agent-upgrade-v1 --write   # record passes in a draft suite
```

A case enters a suite only if every step passes:

1. **shape** — the case and its hidden half parse and are consistent;
2. **start-state** — it materializes and installs on this machine;
3. **broken-state-hidden-tests-fail** — at the start state at least one hidden
   test FAILS (a hidden test that already passes tells us nothing);
4. **broken-state-dependency-upgraded** — the start state really has the new
   version installed;
5. **fixed-state** — with the reference patch applied: install succeeds, the
   dependency is still at the new version, every project check passes, every
   hidden test passes, no forbidden rule fires;
6. **deterministic** — step 5 repeated (default twice) gives identical results.

Isolation is enforced by materialization itself. The evidence is written to
`admission.json`, and `--write` records the case's content hash in the suite.

### Hidden tests

Behaviour, not implementation. A removed or renamed API is tested through the
behaviour the consumer exposes; a changed return type through what downstream
code does with it; a config-schema change by launching the thing; a lifecycle
change by exercising the lifecycle. The agent's patch is never compared to the
reference patch for correctness — `referencePatchFileOverlap` is recorded as a
diagnostic and nothing more.

### Forbidden rules

Case-specific, never global: `path-unchanged`, `file-present`,
`pattern-absent`, `pattern-not-added`, `manifest-scripts-unchanged`,
`no-test-deletions`. A `@ts-ignore` is a legitimate edit in most files and an
illegitimate one on the line the upgrade broke; the case author says which.

### Adding a case

1. Find the bump and the fix. The best source is a merged Dependabot or Renovate
   pull request with human commits after the bot's: the bot's commit is the
   start state, its parent is the base, the human commits are the reference.
2. Write `case.yml` with exact versions, the install command, every check the
   project's CI runs, an `installedVersion` command, and the integrity paths.
3. Write hidden tests that fail at the start state and pass with the fix, and
   any forbidden rules the case needs.
4. Save the fix as `hidden/reference.patch` (a unified diff against the start
   tree) and describe its origin in `hidden.yml`.
5. Run admission. Fix the case until every step passes, then `--write` it into
   a draft suite.

## Suites

`eval/agent/suites/<suite>.json` lists admitted cases by content hash. A
`draft` suite may change; a `frozen` suite refuses to run or aggregate a case
whose hash moved, and a material change to any case or its validation means a
new suite (`agent-upgrade-v2`), never a silent edit. Every removed case is
listed with its reason and date. `smoke` is the development suite.

## Running

```sh
npm run benchmark:agent:validate -- --suite agent-upgrade-v1        # admission, free
npm run benchmark:agent:smoke                                       # 1 run per condition on the smoke suite (live)
npm run benchmark:agent -- --suite agent-upgrade-v1 --case <id> --runs 5
npm run benchmark:agent -- --suite agent-upgrade-v1 --runs 5        # full (live, costs money)
npm run benchmark:agent:aggregate -- --runs <run-id>[,<run-id>]     # canonical summary, free, offline
npm run benchmark:agent:report                                      # report, README block, public copy
npm run benchmark:agent:rescore -- --runs <run-id>                  # offline re-evaluation after a case's rules changed
npm run benchmark:agent:verify                                      # stale public claims fail here
```

Defaults: `--model claude-sonnet-5 --effort high`, provider `claude-code`,
5 runs per condition, browsing tools disabled, Drift's `--verify` on. Options:
`--conditions`, `--web-tools allow`, `--no-drift-verify`, `--max-budget-usd`,
`--max-turns`, `--run-id` (rerunning under the same id resumes; existing
trials are never overwritten), `--retry-infrastructure` (attempt again the
slots whose trial was excluded for an infrastructure failure such as a
provider rate limit; the excluded artifact is kept as `*.attempt-N.*` and a
valid trial is never retried, whatever its outcome), `--notes`.

Conditions alternate order on every repetition (baseline first on odd
repetitions, Drift first on even), so neither is systematically first.

**Requirements.** Node 22.6+, git, the `claude` CLI on `PATH` and signed in
(or `ANTHROPIC_API_KEY` set), network access for the package registry and the
provider, and whatever toolchain the suite's cases declare. Each trial is one
live agent session; a five-run, two-condition sweep over N cases is 10·N
sessions. Provider cost is recorded per trial where the CLI reports it.

## Aggregation

Per case: median gross input tokens of valid baseline trials, median of valid
Drift trials, `caseReduction = 1 - driftMedian / baselineMedian`. The headline
efficiency figure is the **median of case-level reductions** — never
`1 - totalDrift / totalBaseline`, which a single large repository would
dominate — with the mean, IQR and full distribution beside it, and the
uncached-token version as a secondary.

Per condition: `successful valid trials / valid trials`, the difference in
percentage points (the relative difference is secondary), and the case-level
view: cases improved, tied, baseline better, median and mean case difference.

Uncertainty: a two-level percentile bootstrap (2000 iterations, seed
20260916): cases are resampled with replacement, then each condition's trials
within each drawn case. 95% intervals for the median reduction, the mean
reduction, the success-rate difference and each condition's success rate. No
trial is rerun because of its result, and no case is dropped because of its
result.

Secondary, labelled as such: input tokens per successful fix and median input
tokens among successful runs. Conditioning on success is selection.

### Correcting a validation mistake after a run

A rule that turns out to be wrong — a live trial produced a legitimate
migration and a case-specific rule fired on it — is narrowed in the case,
logged in the suite manifest's `changes` with the date and the reason, and
recorded trials are re-scored **offline**:

```sh
npm run benchmark:agent:rescore -- --runs <run-id>[,<run-id>]
```

Only rules the recorded diff can decide (`pattern-not-added`,
`no-test-deletions`, `path-unchanged`) are re-evaluated; checks, hidden tests,
integrity and tree-dependent rules keep what was observed. The artifact keeps
its original verdict under `rescore`. Nothing is rerun, so no new sample is
drawn because of its result.

### What is excluded, and what is not

A trial is excluded, with its reason recorded, only for infrastructure:
`setup_failure` (the start state could not be materialized or installed),
`agent_launch_failure` (no model response ever arrived), `provider_error` (an
API error status), `validation_unavailable` (a check could not be started),
`runner_error`. An agent that timed out, errored mid-session, reverted the
dependency, or produced a wrong fix is a **failed trial**, counted. A Drift
analysis that failed or found nothing is a product outcome, recorded on the
trial (`context.driftStatus`), and the trial counts.

## Results and publication

```text
eval/results/agent/raw/<run-id>/manifest.json           what was run, with what
eval/results/agent/raw/<run-id>/trials/*.json           one artifact per trial (prompt, usage, tools, validation, diff, timing)
eval/results/agent/raw/<run-id>/trials/*.diff           the final diff
eval/results/agent/raw/<run-id>/trials/*.stream.jsonl.gz  raw agent event stream (gitignored; CI artifact)
eval/results/agent/latest.json                          the one canonical summary
eval/results/agent/history/<generatedAt>__<suite>__<model>.json   every summary ever generated
eval/reports/agent/latest.md                            the report
eval/reports/agent/public-copy.md                       launch copy, generated only when the gates pass
```

`latest.json` carries its own **publication gates**: minimum cases (10),
minimum paired cases (10), minimum runs per condition (3), minimum valid trials
per condition (30), a frozen suite, no synthetic cases, freshness (180
days), infrastructure exclusions under 20%, hidden validation complete for every
valid trial, one task hash per case, one confirmed model, both success rates
defined, a clean Drift tree, required metadata present. The website, the
README block and the public copy render figures only when every gate passes;
`npm run benchmark:agent:verify` (run in CI) fails if the README block differs
from what `latest.json` generates, if the site's copy differs from
`latest.json`, or if a guarded document quotes a figure while no publishable
result exists.

History is never overwritten. Two summaries are comparable only on the same
suite and the same model; a different model generation is a different
experiment, and the summary records the model so nobody pools them.

## What is not claimed

- "X% smaller context window" — context-window occupancy is not measured.
- "X% cheaper" — provider pricing is recorded where the CLI reports it, not
  modelled.
- "X% faster" — wall clock is reported as a secondary with its caveats.
- "X% more accurate" — the effectiveness metric is the remediation success
  rate, defined above.
- The research paper's ~79.9% token reduction: that is the paper's result on
  its own system and its own evaluation (see
  [`docs/research.md`](../../docs/research.md)), not Drift's.
- Any best-case figure as the headline.

## Limitations

- Coding agents are stochastic; repeated trials and intervals bound the
  variance, they do not remove it.
- Results depend on the model, agent CLI version and effort recorded, and can
  change when the provider updates any of them.
- The cases are dependency migrations — Drift's intended use — and say nothing
  about other coding tasks.
- Gross input tokens count cache reads at full size; provider cache behaviour
  therefore shapes the headline. The uncached figure is reported beside it.
- Wall clock includes provider latency and network conditions.
- Tool-activity counts are per invocation, and a shell command hides what it
  read.
- Isolation is a workspace audit, not an OS sandbox.
- An early suite has few held-out cases; the share is printed in every result.
- Passing every check cannot prove the absence of every regression.
- Hidden-test quality varies by case; each case's tests are in the repository
  for review.
- Only one provider (Claude Code) is implemented. The provider interface
  (`eval/src/agent/providers/types.ts`) is what a second one has to satisfy.

## Reproduce

```sh
git clone https://github.com/trydrift/drift && cd drift && npm ci && npm run build
claude --version                                   # the agent under test, signed in
npm run benchmark:agent:validate -- --suite agent-upgrade-v1
npm run benchmark:agent -- --suite agent-upgrade-v1 --runs 5 --model claude-sonnet-5 --effort high
npm run benchmark:agent:aggregate -- --runs <the run id printed above>
npm run benchmark:agent:report
npm run benchmark:agent:verify
```

Every published summary names its run ids; the raw trial artifacts for those
runs are committed under `eval/results/agent/raw/`.
