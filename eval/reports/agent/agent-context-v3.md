# Agent interface comparison: agent-context-v3

Generated 2026-09-16T23:44:14.231Z.

- Development cases only. These cases were used to select the agent interface and are not held-out evidence.
- Diagnostic, not publishable: the canonical publication gates (10+ cases, frozen suite, 30+ valid trials per condition) are not met.
- Every Drift condition is compared with the baseline trials of the same experiment. The runs in the current section passed the compatibility check (same agent, settings, Drift build, isolation, loaded environment, case content, start trees and tasks).
- Token changes are case-level medians: (condition median / baseline median - 1) per case, then the median across cases. Negative is fewer tokens.
- Drift context and tool sizes are estimated at 3 bytes per token (the production brief estimator), not provider counts. Every other token figure is provider-reported.
- Tokens before/after the first edit come from the per-message usage ledger of the main model and exclude the CLI auxiliary model.
- End-to-end wall = Drift analysis before the session + the agent session. For drift-mcp, Drift runs inside the session and is already in the session time; Drift tool time is shown as a part of it, not added.
- History section "the first result (#320: baseline vs full report, safe-mode sessions)" (v1-dev-1, v1-dev-2) is shown for context only and never pooled into the current estimates.
- History section "exploratory runs aborted during review" (v2-dev-1, v2-dev-2, v2-dev-3) is shown for context only and never pooled into the current estimates.

## Current runs

- Run `v3-dev-winston`: claude-sonnet-5 at effort high, 2.1.267 (Claude Code), Drift 474b12890cc5, 3 run(s) per condition (baseline, drift-full-report, drift-agent-brief, drift-mcp).
- Run `v3-dev-ethereum`: claude-sonnet-5 at effort high, 2.1.267 (Claude Code), Drift 474b12890cc5, 3 run(s) per condition (baseline, drift-full-report, drift-agent-brief, drift-mcp).
- Run `v3-dev-eslint`: claude-sonnet-5 at effort high, 2.1.267 (Claude Code), Drift 474b12890cc5, 3 run(s) per condition (baseline, drift-full-report, drift-agent-brief, drift-mcp).
- Session isolation: isolated.

### Schedule positions (trials per position, 1 = first in its block)

- baseline: 3 / 2 / 2 / 2
- drift-full-report: 2 / 3 / 2 / 2
- drift-agent-brief: 2 / 2 / 2 / 3
- drift-mcp: 2 / 2 / 3 / 2

### By condition

| Condition | Successes / valid | Median gross input | Median uncached input | Median model calls | Median cost | Median end-to-end wall | Median session wall | Median tool calls | Median unique files read | Median Drift context (est.) | Median Drift tool returns (est.) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 7/9 | 6,243,038 | 78,233 | 70 | $1.82 | 929s | 929s | 74 | 4 | 0 | 0 |
| drift-full-report | 8/9 | 9,417,198 | 142,590 | 75 | $2.70 | 884s | 874s | 75 | 6 | 48,582 | 0 |
| drift-agent-brief | 7/9 | 6,242,052 | 74,091 | 79 | $1.80 | 977s | 966s | 78 | 3 | 1,420 | 0 |
| drift-mcp | 7/9 | 7,304,882 | 91,653 | 82 | $2.16 | 922s | 922s | 83 | 5 | 18 | 3,327 |

### Wall-clock decomposition

End-to-end = Drift analysis before the session + session. Drift tool time is inside the session (MCP), not added to it.

| Condition | Median end-to-end | Median Drift before session | Median session | Median Drift tool time (in session) | Median case change in end-to-end vs baseline |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 929s | 0s | 929s | 0s | — |
| drift-full-report | 884s | 84s | 874s | 0s | -5.0% |
| drift-agent-brief | 977s | 69s | 966s | 0s | -14.1% |
| drift-mcp | 922s | 0s | 922s | 67s | -19.3% |

### Against the baseline (case-level medians)

| Condition | Paired cases | Median case change, gross | 95% CI | Median case change, uncached | Success difference | 95% CI | Cases better / tied / worse on success |
| --- | ---: | ---: | --- | ---: | ---: | --- | --- |
| drift-full-report | 3 | +50.8% | [-14.4, 226.5] | +100.2% | +11.1 pp | [-33.3, 55.6] | 1 / 2 / 0 |
| drift-agent-brief | 3 | -16.4% | [-35.3, 8.9] | -6.0% | 0.0 pp | [-55.6, 44.4] | 1 / 1 / 1 |
| drift-mcp | 3 | -9.9% | [-44.1, 47.0] | +10.5% | 0.0 pp | [-55.6, 44.4] | 1 / 1 / 1 |

### By case

| Case | Condition | Successes / valid | Median gross input | Change vs baseline | Median uncached | Change vs baseline | Median cost | Median end-to-end wall | Tool calls | Unique files read | Drift context (est.) | Drift tool returns (est.) | Failure reasons |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| aws-least-privilege-winston-3 | baseline | 3/3 | 4,342,225 | — | 66,360 | — | $1.34 | 802s | 58 | 2 | 0 | 0 | — |
| aws-least-privilege-winston-3 | drift-full-report | 3/3 | 3,870,337 | -10.9% | 132,851 | +100.2% | $1.33 | 519s | 34 | 2 | 48,582 | 0 | — |
| aws-least-privilege-winston-3 | drift-agent-brief | 3/3 | 3,309,675 | -23.8% | 58,684 | -11.6% | $1.09 | 538s | 47 | 3 | 1,420 | 0 | — |
| aws-least-privilege-winston-3 | drift-mcp | 3/3 | 3,169,159 | -27.0% | 50,181 | -24.4% | $1.03 | 626s | 48 | 4 | 18 | 4,522 | — |
| eth-ledger-bridge-keyring-ethereumjs-tx-5 | baseline | 2/3 | 6,243,038 | — | 78,233 | — | $1.82 | 929s | 74 | 4 | 0 | 0 | prohibited_workaround ×1 |
| eth-ledger-bridge-keyring-ethereumjs-tx-5 | drift-full-report | 2/3 | 9,417,198 | +50.8% | 142,590 | +82.3% | $2.70 | 1130s | 75 | 6 | 24,398 | 0 | prohibited_workaround ×1 |
| eth-ledger-bridge-keyring-ethereumjs-tx-5 | drift-agent-brief | 1/3 | 6,242,052 | -0.0% | 74,091 | -5.3% | $1.80 | 1143s | 78 | 3 | 1,331 | 0 | prohibited_workaround ×2 |
| eth-ledger-bridge-keyring-ethereumjs-tx-5 | drift-mcp | 1/3 | 7,965,045 | +27.6% | 102,937 | +31.6% | $2.30 | 1272s | 83 | 5 | 18 | 2,500 | prohibited_workaround ×1, hidden_regression_failure ×1 |
| gh-aw-firewall-eslint-10 | baseline | 2/3 | 8,419,485 | — | 87,248 | — | $2.38 | 1142s | 99 | 9 | 0 | 0 | existing_test_failure ×1, prohibited_workaround ×1 |
| gh-aw-firewall-eslint-10 | drift-full-report | 3/3 | 26,936,186 | +219.9% | 441,581 | +406.1% | $7.01 | 1085s | 99 | 11 | 168,968 | 0 | — |
| gh-aw-firewall-eslint-10 | drift-agent-brief | 3/3 | 7,041,923 | -16.4% | 81,980 | -6.0% | $2.00 | 981s | 86 | 10 | 1,482 | 0 | — |
| gh-aw-firewall-eslint-10 | drift-mcp | 3/3 | 7,588,012 | -9.9% | 96,371 | +10.5% | $2.22 | 922s | 85 | 9 | 18 | 3,327 | — |

### Where the tokens went

| Condition | Median model calls | Median gross before first edit | Median gross after first edit | Trials with no edit | Median output tokens | Drift analysis before session |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 70 | 923,830 | 5,065,112 | 0 | 29,565 | — |
| drift-full-report | 75 | 1,371,121 | 7,582,521 | 0 | 31,821 | 84s |
| drift-agent-brief | 79 | 547,435 | 5,218,043 | 0 | 29,402 | 69s |
| drift-mcp | 82 | 791,103 | 6,188,200 | 0 | 32,237 | — |

### Drift tools and independent research

| Condition | Median findings supplied up front | Median Drift tool calls | Calls by tool (all trials) | Median findings pulled on demand | Median dependency-source accesses | Median registry queries | Median changelog accesses |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| baseline | — | 0 | — | 0 | 7 | 2 | 0 |
| drift-full-report | — | 0 | — | 0 | 8 | 2 | 0 |
| drift-agent-brief | 4 | 0 | — | 0 | 6 | 1 | 0 |
| drift-mcp | — | 4 | get_finding ×19, plan_upgrade ×10, get_evidence ×7, verify_upgrade ×4 | 2 | 6 | 2 | 0 |

### Exclusions

Every slot in this section holds a valid trial.

Attempts set aside before their slot was run again (31; never counted):

- 29 × provider_error: api error status 429: You've hit your session limit
- 2 × environment mismatch
- v3-dev-ethereum/eth-ledger-bridge-keyring-ethereumjs-tx-5__drift-agent-brief__rep-03.attempt-2.json (drift-agent-brief): environment fingerprint b24568bfb9cc0f74 differed from the experiment's (see ENVIRONMENT-EXCLUSIONS.md); it had recorded success.
- v3-dev-eslint/gh-aw-firewall-eslint-10__drift__rep-02.attempt-2.json (drift-full-report): environment fingerprint b24568bfb9cc0f74 differed from the experiment's (see ENVIRONMENT-EXCLUSIONS.md); it had recorded success.

---

## History, not pooled: the first result (#320: baseline vs full report, safe-mode sessions)

- Run `v1-dev-1`: claude-sonnet-5 at effort high, 2.1.267 (Claude Code), Drift 627bfda24d1e, 3 run(s) per condition (baseline, drift-full-report).
- Run `v1-dev-2`: claude-sonnet-5 at effort high, 2.1.267 (Claude Code), Drift 627bfda24d1e, 3 run(s) per condition (baseline, drift-full-report).
- Session isolation: safe-mode.

### By condition

| Condition | Successes / valid | Median gross input | Median uncached input | Median model calls | Median cost | Median end-to-end wall | Median session wall | Median tool calls | Median unique files read | Median Drift context (est.) | Median Drift tool returns (est.) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 8/9 | 6,015,134 | 83,520 | 66 | $1.84 | — | 717s | 67 | 5 | — | — |
| drift-full-report | 7/9 | 8,742,874 | 148,944 | 76 | $2.65 | — | 761s | 75 | 4 | — | — |

### Wall-clock decomposition

End-to-end = Drift analysis before the session + session. Drift tool time is inside the session (MCP), not added to it.

| Condition | Median end-to-end | Median Drift before session | Median session | Median Drift tool time (in session) | Median case change in end-to-end vs baseline |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | — | — | — | — | — |
| drift-full-report | — | — | — | — | — |

### Against the baseline (case-level medians)

| Condition | Paired cases | Median case change, gross | 95% CI | Median case change, uncached | Success difference | 95% CI | Cases better / tied / worse on success |
| --- | ---: | ---: | --- | ---: | ---: | --- | --- |
| drift-full-report | 3 | +68.5% | [24.1, 326.5] | +173.1% | -11.1 pp | [-55.6, 33.3] | 0 / 2 / 1 |

### By case

| Case | Condition | Successes / valid | Median gross input | Change vs baseline | Median uncached | Change vs baseline | Median cost | Median end-to-end wall | Tool calls | Unique files read | Drift context (est.) | Drift tool returns (est.) | Failure reasons |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| aws-least-privilege-winston-3 | baseline | 3/3 | 2,216,178 | — | 48,194 | — | $0.79 | 409s | 41 | 3 | — | — | — |
| aws-least-privilege-winston-3 | drift-full-report | 3/3 | 3,734,828 | +68.5% | 131,617 | +173.1% | $1.29 | 325s | 33 | 2 | — | — | — |
| eth-ledger-bridge-keyring-ethereumjs-tx-5 | baseline | 2/3 | 6,015,134 | — | 94,990 | — | $1.93 | 717s | 67 | 5 | — | — | prohibited_workaround ×1 |
| eth-ledger-bridge-keyring-ethereumjs-tx-5 | drift-full-report | 1/3 | 8,742,874 | +45.3% | 142,923 | +50.5% | $2.65 | 761s | 75 | 6 | — | — | prohibited_workaround ×2 |
| gh-aw-firewall-eslint-10 | baseline | 3/3 | 7,199,445 | — | 84,099 | — | $2.07 | 762s | 89 | 11 | — | — | — |
| gh-aw-firewall-eslint-10 | drift-full-report | 3/3 | 28,862,221 | +300.9% | 452,276 | +437.8% | $7.51 | 927s | 98 | 4 | — | — | — |

### Where the tokens went

| Condition | Median model calls | Median gross before first edit | Median gross after first edit | Trials with no edit | Median output tokens | Drift analysis before session |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 66 | — | — | 0 | 28,765 | — |
| drift-full-report | 76 | — | — | 0 | 33,851 | 38s |

### Drift tools and independent research

| Condition | Median findings supplied up front | Median Drift tool calls | Calls by tool (all trials) | Median findings pulled on demand | Median dependency-source accesses | Median registry queries | Median changelog accesses |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| baseline | — | — | — | — | — | — | — |
| drift-full-report | — | — | — | — | — | — | — |

### Exclusions

Every slot in this section holds a valid trial.

Attempts set aside before their slot was run again (8; never counted):

- 8 × provider_error: api error status 429: You've hit your session limit

---

## History, not pooled: exploratory runs aborted during review

- Run `v2-dev-1`: claude-sonnet-5 at effort high, 2.1.267 (Claude Code), Drift 5115f99a5e63, 3 run(s) per condition (baseline, drift-full-report, drift-agent-brief, drift-mcp).
- Run `v2-dev-2`: claude-sonnet-5 at effort high, 2.1.267 (Claude Code), Drift 5115f99a5e63, 3 run(s) per condition (baseline, drift-full-report, drift-agent-brief, drift-mcp).
- Run `v2-dev-3`: claude-sonnet-5 at effort high, 2.1.267 (Claude Code), Drift 5115f99a5e63, 3 run(s) per condition (baseline, drift-full-report, drift-agent-brief, drift-mcp).
- Session isolation: isolated.

### By condition

| Condition | Successes / valid | Median gross input | Median uncached input | Median model calls | Median cost | Median end-to-end wall | Median session wall | Median tool calls | Median unique files read | Median Drift context (est.) | Median Drift tool returns (est.) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 3/3 | 6,695,560 | 82,240 | 67 | $2.02 | — | 699s | 68 | 3 | 0 | 0 |

### Wall-clock decomposition

End-to-end = Drift analysis before the session + session. Drift tool time is inside the session (MCP), not added to it.

| Condition | Median end-to-end | Median Drift before session | Median session | Median Drift tool time (in session) | Median case change in end-to-end vs baseline |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | — | — | — | — | — |

### Against the baseline (case-level medians)

| Condition | Paired cases | Median case change, gross | 95% CI | Median case change, uncached | Success difference | 95% CI | Cases better / tied / worse on success |
| --- | ---: | ---: | --- | ---: | ---: | --- | --- |

### By case

| Case | Condition | Successes / valid | Median gross input | Change vs baseline | Median uncached | Change vs baseline | Median cost | Median end-to-end wall | Tool calls | Unique files read | Drift context (est.) | Drift tool returns (est.) | Failure reasons |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| aws-least-privilege-winston-3 | baseline | 1/1 | 3,771,693 | — | 58,544 | — | $1.24 | 548s | 52 | 1 | 0 | 0 | — |
| eth-ledger-bridge-keyring-ethereumjs-tx-5 | baseline | 1/1 | 6,695,560 | — | 99,600 | — | $2.02 | 699s | 68 | 3 | 0 | 0 | — |
| gh-aw-firewall-eslint-10 | baseline | 1/1 | 7,776,509 | — | 82,240 | — | $2.17 | 843s | 93 | 9 | 0 | 0 | — |

### Where the tokens went

| Condition | Median model calls | Median gross before first edit | Median gross after first edit | Trials with no edit | Median output tokens | Drift analysis before session |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 67 | 1,612,681 | 5,081,906 | 0 | 30,172 | — |

### Drift tools and independent research

| Condition | Median findings supplied up front | Median Drift tool calls | Calls by tool (all trials) | Median findings pulled on demand | Median dependency-source accesses | Median registry queries | Median changelog accesses |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| baseline | — | 0 | — | 0 | 5 | 4 | 0 |

### Exclusions

Every slot in this section holds a valid trial.
