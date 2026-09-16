# Dependency Upgrade Agent Benchmark

```
Suite:              smoke (draft)
Cases:              1
Runs per condition: 1
Model:              claude-sonnet-5 (confirmed: claude-sonnet-5)
Effort:             high
Agent:              claude-code 2.1.267 (Claude Code)
Drift commit:       d1101f875d9abc2f69e2956eb73f62dfdab8d08b (dirty tree) (v0.1.11)
Generated:          2026-09-16T10:09:46.260Z

EFFECTIVENESS

Successful dependency remediations

Without Drift     100.0%   (1/1 valid trials)
With Drift        100.0%   (1/1 valid trials)
Difference        +0.0 pp

EFFICIENCY

Median agent input tokens (gross, all turns, cache reads included)

Without Drift     375,832
With Drift        565,893

Median case-level reduction: -50.6%  (1 paired cases)

QUALITY CONTROLS

Same model                    yes
Same task                     yes
Same starting commits         yes (start tree hash recorded per trial)
Hidden compatibility tests    yes (staged after the agent exits)
Known-good validation         yes (reference fix must pass every layer at admission)
Dependency must remain new    yes (manifest, fresh install, installed version)
Publication gates             NOT MET
```

## Confidence intervals (95%, bootstrap)

- Median input-token reduction: -50.6% to -50.6%
- Mean input-token reduction: -50.6% to -50.6%
- Success-rate difference: 0.0 pp to 0.0 pp
- Baseline success rate: 100.0% to 100.0%
- Drift success rate: 100.0% to 100.0%
- Method: two-level percentile bootstrap: cases resampled with replacement, then each condition's trials within each drawn case resampled with replacement; seed 20260916, 2000 iterations.
- With 1 case(s) these intervals are wide by construction; read them as such.

## Secondary metrics

| Metric | Without Drift | With Drift |
| --- | ---: | ---: |
| Median uncached input tokens | 45,104 | 35,954 |
| Median case-level uncached reduction | | 20.3% |
| Mean case-level gross reduction | | -50.6% |
| Reduction IQR (case level) | | -50.6% to -50.6% |
| Median wall-clock change (agent session) | | -1.2% |
| Median unique-files-read change | | n/a |
| Median tool-call change | | 25.0% |
| Median Drift analysis time (not agent time) | | 5s |
| Relative success difference | | 0.0% |
| Input tokens per successful fix | 375,832 | 565,893 |
| Median input tokens among successes | 375,832 | 565,893 |

_Secondary. Conditioning on success selects for the runs that went well and is not a substitute for the two primary metrics._

### Condition: baseline

- Trials: 1 (1 valid, 0 excluded as infrastructure failures)
- Successful: 1/1 (100.0%)
- Median gross input tokens: 375,832; median output tokens: 2,120
- Median wall clock: 55s; median tool calls: 8; median unique files read: 0; median shell commands: 7; median files changed: 1
- Agent session outcomes: completed ×1
- Failure reasons (a trial can carry several): none
- Total provider-reported cost: $0.26

### Condition: drift

- Trials: 1 (1 valid, 0 excluded as infrastructure failures)
- Successful: 1/1 (100.0%)
- Median gross input tokens: 565,893; median output tokens: 2,734
- Median wall clock: 54s; median tool calls: 10; median unique files read: 2; median shell commands: 7; median files changed: 1
- Agent session outcomes: completed ×1
- Failure reasons (a trial can carry several): none
- Total provider-reported cost: $0.25

## Per-case results

| Case | Baseline success | Drift success | Δ success | Baseline median tokens | Drift median tokens | Token Δ | Drift found change | Drift found code |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| smoke-glob-sync | 1/1 (100.0%) | 1/1 (100.0%) | +0.0 pp | 375,832 | 565,893 | +50.6% | 100.0% | 100.0% |

Case level: Drift improved 0, tied 1, baseline better 0; median difference +0.0 pp, mean +0.0 pp.

## Failure categories

| Reason | Baseline | Drift |
| --- | ---: | ---: |
| (none) | 0 | 0 |

## Pipeline diagnostics (Drift condition)

- Drift analysis outcomes: completed ×1
- Drift named the relevant breaking change: 100.0% of trials with expected symbols declared
- Drift located a file the reference fix touches: 100.0%

## Excluded trials

None.

## Publication gates

Eligible for public claims: **no**

- ❌ minimum-cases: 1 case(s), minimum 10
- ❌ minimum-paired-cases: 1 paired case(s), minimum 10
- ❌ minimum-runs-per-condition: 1 run(s) per condition, minimum 3
- ❌ minimum-valid-trials: 1 valid trial(s) in the smaller condition, minimum 30
- ❌ frozen-suite: suite status draft
- ❌ historical-cases-only: 1 synthetic case(s) in the result
- ✅ freshness: 0 day(s) old, maximum 180
- ✅ infrastructure-exclusions: 0/2 trial(s) excluded as infrastructure failures
- ✅ hidden-validation-complete: every valid trial ran hidden validation
- ✅ same-task: one task hash per case across conditions
- ✅ one-model: confirmed models: claude-sonnet-5
- ✅ success-rate-integrity: both success rates are defined
- ❌ clean-drift-tree: Drift source tree had uncommitted changes
- ✅ required-metadata: commit, agent version and model recorded

## Methodology

- Conditions: identical task text (hashes 8d602a7fe7), identical model, effort, permissions, tools, network policy and time limit; the Drift condition appends Drift's production report (`drift analyze --markdown --verify`) to the same task.
- Input tokens: Gross agent input tokens: for one agent session, the sum over every model the session used of the provider-reported input_tokens + cache_read_input_tokens + cache_creation_input_tokens, read from the coding agent CLI's own cumulative per-model usage record at the end of the session (Claude Code: the `modelUsage` block of the `result` event in `--output-format stream-json`). Every model turn in the session is included, not only the first prompt. Cache reads are counted at their full token size. "Uncached input tokens" (input_tokens + cache_creation_input_tokens) is reported as a secondary metric.
- Success: A trial succeeds only if, after the agent exits: the dependency is still declared at the upgraded version and a fresh install resolves and installs it at that version; every one of the project's own declared checks passes; every hidden regression test — staged into the workspace only after the agent exited — passes; and no case-specific prohibited-workaround rule fires. A session that timed out or errored fails. No partial credit.
- Isolation: Each trial runs in a fresh temporary git repository built from the case source with exactly two commits (before and after the bump), no remote and no later history, audited to contain no hidden material. Hidden tests, the reference patch and case metadata live outside that directory and are copied in only after the agent process has exited. This is a workspace audit, not an OS sandbox: the private files remain readable elsewhere on the host by a process the agent starts. Package manager caches are shared across trials and conditions.
- Tool counting: Counts are `tool_use` blocks in the session event stream, deduplicated by block id. "File reads" are Read calls; "unique files read" are distinct Read paths; "searches" are Grep and Glob calls; "shell commands" are Bash tool invocations, each counted once regardless of how many programs the command line ran; "edits" are Edit, Write, MultiEdit and NotebookEdit calls. Files read through a shell command (cat, sed, head) are not counted as file reads.
- Agent configuration: permission modes bypassPermissions; clean environment safe-mode; disallowed tools WebFetch, WebSearch; network registry-and-provider; web tools disabled; timeouts 900s.
- Case provenance: synthetic ×1; roles: development ×1; ecosystems: npm ×1.

## Limitations

- Coding agents are stochastic; repeated trials and bootstrap intervals bound but do not remove that variance.
- Results are specific to the model, agent CLI version and effort setting recorded here, and can change when the provider updates any of them.
- The cases are dependency migrations, which is what Drift is for; they say nothing about other coding tasks.
- Gross input tokens count cache reads at full size; the provider's cache behaviour therefore affects the headline, and the uncached figure is reported beside it.
- Wall-clock figures include provider latency and network conditions on the machine that ran the trials.
- Tool-activity counts are per tool invocation; a single shell command can read many files and is counted once.
- Ground-truth isolation is a workspace audit, not an OS sandbox; hidden material was not mounted but was readable elsewhere on the host.
- The held-out share of the suite is recorded per result; a suite with few or no held-out cases supports a weaker generalisation claim.
- Passing every check, including the hidden tests, cannot prove the absence of every regression.
- Hidden-test quality varies by case; each case's tests and rules are in its private directory for review.
- The Drift condition appends a production report to the task; a reader should check the report is the product's own output (it is rendered by the same code as `drift analyze --markdown`) and not a benchmark-tuned prompt.

## Reproduction

```sh
npm run benchmark:agent:validate -- --suite smoke
npm run benchmark:agent -- --suite smoke --runs 1 --model claude-sonnet-5 --effort high
npm run benchmark:agent:aggregate -- --runs smoke-dev-1
npm run benchmark:agent:report
npm run benchmark:agent:verify
```

Raw trial artifacts: `eval/results/agent/raw/<run-id>/trials/` for `smoke-dev-1`.
