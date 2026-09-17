# Agent interface comparison: smoke-v3-1

Generated 2026-09-16T17:54:42.049Z.

- Development cases only. These cases were used to select the agent interface and are not held-out evidence.
- Diagnostic, not publishable: the canonical publication gates (10+ cases, frozen suite, 30+ valid trials per condition) are not met.
- Every Drift condition is compared with the baseline trials of the same experiment. The runs in the current section passed the compatibility check (same agent, settings, Drift build, isolation, loaded environment, case content, start trees and tasks).
- Token changes are case-level medians: (condition median / baseline median - 1) per case, then the median across cases. Negative is fewer tokens.
- Drift context and tool sizes are estimated at 3 bytes per token (the production brief estimator), not provider counts. Every other token figure is provider-reported.
- Tokens before/after the first edit come from the per-message usage ledger of the main model and exclude the CLI auxiliary model.
- End-to-end wall = Drift analysis before the session + the agent session. For drift-mcp, Drift runs inside the session and is already in the session time; Drift tool time is shown as a part of it, not added.
- History section "exploratory runs aborted during review" (smoke-v2-1) is shown for context only and never pooled into the current estimates.

## Current runs

- Run `smoke-v3-1`: claude-sonnet-5 at effort high, 2.1.267 (Claude Code), Drift 0a37d7280a0f, 1 run(s) per condition (baseline, drift-full-report, drift-agent-brief, drift-mcp).
- Session isolation: isolated.

### Schedule positions (trials per position, 1 = first in its block)

- baseline: 1 / 0 / 0 / 0
- drift-full-report: 0 / 1 / 0 / 0
- drift-agent-brief: 0 / 0 / 0 / 1
- drift-mcp: 0 / 0 / 1 / 0

### By condition

| Condition | Successes / valid | Median gross input | Median uncached input | Median model calls | Median cost | Median end-to-end wall | Median session wall | Median tool calls | Median unique files read | Median Drift context (est.) | Median Drift tool returns (est.) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 1/1 | 441,794 | 10,388 | 10 | $0.15 | 53s | 53s | 11 | 3 | 0 | 0 |
| drift-full-report | 1/1 | 655,655 | 35,725 | 11 | $0.26 | 58s | 52s | 10 | 3 | 11,091 | 0 |
| drift-agent-brief | 1/1 | 513,708 | 14,559 | 11 | $0.18 | 65s | 61s | 10 | 1 | 1,168 | 0 |
| drift-mcp | 1/1 | 559,852 | 13,697 | 12 | $0.19 | 50s | 50s | 12 | 1 | 18 | 1,588 |

### Wall-clock decomposition

End-to-end = Drift analysis before the session + session. Drift tool time is inside the session (MCP), not added to it.

| Condition | Median end-to-end | Median Drift before session | Median session | Median Drift tool time (in session) | Median case change in end-to-end vs baseline |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 53s | 0s | 53s | 0s | — |
| drift-full-report | 58s | 5s | 52s | 0s | +9.8% |
| drift-agent-brief | 65s | 4s | 61s | 0s | +23.6% |
| drift-mcp | 50s | 0s | 50s | 5s | -3.9% |

### Against the baseline (case-level medians)

| Condition | Paired cases | Median case change, gross | 95% CI | Median case change, uncached | Success difference | 95% CI | Cases better / tied / worse on success |
| --- | ---: | ---: | --- | ---: | ---: | --- | --- |
| drift-full-report | 1 | +48.4% | [48.4, 48.4] | +243.9% | 0.0 pp | [0.0, 0.0] | 0 / 1 / 0 |
| drift-agent-brief | 1 | +16.3% | [16.3, 16.3] | +40.2% | 0.0 pp | [0.0, 0.0] | 0 / 1 / 0 |
| drift-mcp | 1 | +26.7% | [26.7, 26.7] | +31.9% | 0.0 pp | [0.0, 0.0] | 0 / 1 / 0 |

### By case

| Case | Condition | Successes / valid | Median gross input | Change vs baseline | Median uncached | Change vs baseline | Median cost | Median end-to-end wall | Tool calls | Unique files read | Drift context (est.) | Drift tool returns (est.) | Failure reasons |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| smoke-glob-sync | baseline | 1/1 | 441,794 | — | 10,388 | — | $0.15 | 53s | 11 | 3 | 0 | 0 | — |
| smoke-glob-sync | drift-full-report | 1/1 | 655,655 | +48.4% | 35,725 | +243.9% | $0.26 | 58s | 10 | 3 | 11,091 | 0 | — |
| smoke-glob-sync | drift-agent-brief | 1/1 | 513,708 | +16.3% | 14,559 | +40.2% | $0.18 | 65s | 10 | 1 | 1,168 | 0 | — |
| smoke-glob-sync | drift-mcp | 1/1 | 559,852 | +26.7% | 13,697 | +31.9% | $0.19 | 50s | 12 | 1 | 18 | 1,588 | — |

### Where the tokens went

| Condition | Median model calls | Median gross before first edit | Median gross after first edit | Trials with no edit | Median output tokens | Drift analysis before session |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 10 | 302,973 | 137,853 | 0 | 2,351 | — |
| drift-full-report | 11 | 339,464 | 305,889 | 0 | 2,841 | 5s |
| drift-agent-brief | 11 | 222,825 | 289,026 | 0 | 2,813 | 4s |
| drift-mcp | 12 | 362,850 | 196,019 | 0 | 2,479 | — |

### Drift tools and independent research

| Condition | Median findings supplied up front | Median Drift tool calls | Calls by tool (all trials) | Median findings pulled on demand | Median dependency-source accesses | Median registry queries | Median changelog accesses |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| baseline | — | 0 | — | 0 | 1 | 0 | 0 |
| drift-full-report | — | 0 | — | 0 | 3 | 0 | 0 |
| drift-agent-brief | 3 | 0 | — | 0 | 3 | 0 | 0 |
| drift-mcp | — | 4 | plan_upgrade ×1, get_finding ×1, get_evidence ×1, verify_upgrade ×1 | 1 | 1 | 0 | 0 |

### Exclusions

No trial was excluded.

---

## History, not pooled: exploratory runs aborted during review

- Run `smoke-v2-1`: claude-sonnet-5 at effort high, 2.1.267 (Claude Code), Drift 98a0be7e3816, 1 run(s) per condition (baseline, drift-full-report, drift-agent-brief, drift-mcp).
- Session isolation: isolated.

### By condition

| Condition | Successes / valid | Median gross input | Median uncached input | Median model calls | Median cost | Median end-to-end wall | Median session wall | Median tool calls | Median unique files read | Median Drift context (est.) | Median Drift tool returns (est.) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 1/1 | 605,482 | 53,054 | 13 | $0.36 | — | 124s | 16 | 3 | 0 | 0 |
| drift-full-report | 1/1 | 593,854 | 35,498 | 10 | $0.25 | — | 69s | 9 | 1 | 11,104 | 0 |
| drift-agent-brief | 1/1 | 370,980 | 13,404 | 8 | $0.14 | — | 48s | 7 | 0 | 1,167 | 0 |
| drift-mcp | 1/1 | 614,791 | 15,247 | 13 | $0.20 | — | 66s | 13 | 2 | 18 | 1,587 |

### Wall-clock decomposition

End-to-end = Drift analysis before the session + session. Drift tool time is inside the session (MCP), not added to it.

| Condition | Median end-to-end | Median Drift before session | Median session | Median Drift tool time (in session) | Median case change in end-to-end vs baseline |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | — | — | — | — | — |
| drift-full-report | — | — | — | — | — |
| drift-agent-brief | — | — | — | — | — |
| drift-mcp | — | — | — | — | — |

### Against the baseline (case-level medians)

| Condition | Paired cases | Median case change, gross | 95% CI | Median case change, uncached | Success difference | 95% CI | Cases better / tied / worse on success |
| --- | ---: | ---: | --- | ---: | ---: | --- | --- |
| drift-full-report | 1 | -1.9% | [-1.9, -1.9] | -33.1% | 0.0 pp | [0.0, 0.0] | 0 / 1 / 0 |
| drift-agent-brief | 1 | -38.7% | [-38.7, -38.7] | -74.7% | 0.0 pp | [0.0, 0.0] | 0 / 1 / 0 |
| drift-mcp | 1 | +1.5% | [1.5, 1.5] | -71.3% | 0.0 pp | [0.0, 0.0] | 0 / 1 / 0 |

### By case

| Case | Condition | Successes / valid | Median gross input | Change vs baseline | Median uncached | Change vs baseline | Median cost | Median end-to-end wall | Tool calls | Unique files read | Drift context (est.) | Drift tool returns (est.) | Failure reasons |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| smoke-glob-sync | baseline | 1/1 | 605,482 | — | 53,054 | — | $0.36 | 124s | 16 | 3 | 0 | 0 | — |
| smoke-glob-sync | drift-full-report | 1/1 | 593,854 | -1.9% | 35,498 | -33.1% | $0.25 | 69s | 9 | 1 | 11,104 | 0 | — |
| smoke-glob-sync | drift-agent-brief | 1/1 | 370,980 | -38.7% | 13,404 | -74.7% | $0.14 | 48s | 7 | 0 | 1,167 | 0 | — |
| smoke-glob-sync | drift-mcp | 1/1 | 614,791 | +1.5% | 15,247 | -71.3% | $0.20 | 66s | 13 | 2 | 18 | 1,587 | — |

### Where the tokens went

| Condition | Median model calls | Median gross before first edit | Median gross after first edit | Trials with no edit | Median output tokens | Drift analysis before session |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 13 | 403,350 | 201,164 | 0 | 4,521 | — |
| drift-full-report | 10 | 398,929 | 184,622 | 0 | 2,501 | 7s |
| drift-agent-brief | 8 | 177,982 | 191,148 | 0 | 2,150 | 5s |
| drift-mcp | 13 | 361,902 | 251,906 | 0 | 2,179 | — |

### Drift tools and independent research

| Condition | Median findings supplied up front | Median Drift tool calls | Calls by tool (all trials) | Median findings pulled on demand | Median dependency-source accesses | Median registry queries | Median changelog accesses |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| baseline | — | 0 | — | 0 | 3 | 0 | 0 |
| drift-full-report | — | 0 | — | 0 | 4 | 0 | 0 |
| drift-agent-brief | 3 | 0 | — | 0 | 2 | 0 | 0 |
| drift-mcp | — | 4 | plan_upgrade ×1, get_finding ×1, get_evidence ×1, verify_upgrade ×1 | 1 | 1 | 0 | 0 |

### Exclusions

No trial was excluded.
