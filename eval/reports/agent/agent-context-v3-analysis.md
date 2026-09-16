# Agent interface comparison v3 — diagnosis

Companion to [`agent-context-v3.md`](agent-context-v3.md), which holds every number. This file explains them. **Development cases only** (winston 2 → 3, `@ethereumjs/tx` 4 → 5, ESLint 8 → 10): these three cases shaped the agent interface, so nothing here is held-out evidence and nothing here may be quoted publicly.

Experiment: `v3-dev-winston`, `v3-dev-ethereum`, `v3-dev-eslint` — `claude-sonnet-5`, effort high, Claude Code 2.1.267, isolated sessions (one environment fingerprint across all 36 counted trials), web tools disabled, no budget or turn cap, Drift commit `474b1289`, 4 conditions × 3 cases × 3 repetitions in a Williams schedule. 36 of 36 slots hold a valid trial. 31 earlier attempts were set aside before their slots were run again: 29 provider session-limit errors, and 2 sessions that exposed two extra built-in tools (`ArtifactComments`, `ArtifactData`; both had recorded successes, and one of the two reruns failed).

## Answers

**1. Does Drift now reduce gross agent input tokens?** The agent brief does, in the same direction on every case: median case-level change −16.4% (winston −23.8%, `@ethereumjs/tx` −0.0%, ESLint −16.4%; bootstrap 95% interval −35.3% to +8.9%, which includes no change). MCP: −9.9% median, but mixed (winston −27.0%, `@ethereumjs/tx` +27.6%, ESLint −9.9%; interval −44.1% to +47.0%). The full report is still worse: +50.8% (ESLint +219.9%).

**2. Uncached tokens?** Brief −6.0% (−11.6%, −5.3%, −6.0%). MCP +10.5% (−24.4%, +31.6%, +10.5%). Full report +100.2%.

**3. Is remediation success comparable?** Yes, and indistinguishable at this size: baseline 7/9, full report 8/9, brief 7/9, MCP 7/9. Five of the eight failures are one behaviour on one case — the agent lowered the jest coverage thresholds in `jest.config.js` on `@ethereumjs/tx` (baseline 1, full report 1, brief 2, MCP 1). One MCP trial failed the hidden signing test; one baseline ESLint trial deleted the custom rule's test. No failure traces to a wrong Drift recommendation: the coverage workaround appears in the baseline as well, and neither the brief nor the MCP plan mentions coverage.

**4. AgentBrief or MCP?** The brief. It is never worse than the baseline on gross tokens in any case, cheapest in median cost ($1.80 vs baseline $1.82, MCP $2.16), and it needs no tool round-trips. MCP wins winston and loses `@ethereumjs/tx`.

**5. Why.** The brief costs about 1,400 estimated tokens up front and cuts the research phase roughly in half: median gross tokens *before the first edit* fall from 866k to 493k (winston), 1.52M to 596k (`@ethereumjs/tx`) and 884k to 439k (ESLint). MCP reaches the same information more expensively: every MCP session called `plan_upgrade` (9/9, one twice) and then `get_finding` 1–3 times and `get_evidence` once, adding model calls (median 82 vs 70 baseline) whose results then stay in context. `plan_upgrade` verifies by default, so Drift tool time inside the session was 16–148 s (median 67 s). On `@ethereumjs/tx` the MCP sessions were the longest and most expensive of any condition.

**6. The remaining bottleneck.** Work after the first edit. In every condition 80–90% of gross input tokens are spent after the agent starts editing — the build, test and fix loop, re-reading an ever-longer cached context over 70–90 model calls — and no Drift interface shortens it: median gross after the first edit is 5.07M baseline, 5.22M brief, 6.19M MCP. Two contributing signals:

- Agents still read the upgraded package's own source in every condition (`@ethereumjs/tx`: 10–16 accesses per trial with or without Drift). The brief says `TxData.v` was removed and the compiler errors where; it does not say what replaces it (`TypedTxData`, `getMessageToSign`), because the plan's evidence has no replacement symbol. The agent looks it up.
- Registry and package-metadata commands are unchanged or higher with the brief on ESLint (6–8 per trial vs 5 baseline).

**7. Ready to freeze the architecture and run held-out cases?** No. By the decision rules the brief qualifies as "reduces tokens and success is not visibly worse", but its −16.4% sits in the "improvement, probably not launch-worthy" band, its interval includes zero, one case shows no change, and three development cases cannot distinguish that from noise. MCP does not beat the brief. The honest next step is a general product change aimed at the bottleneck above — for example replacement-API detail in findings where evidence supports it, and not re-running verification inside `plan_upgrade` when the change is already verified — measured in a new development run, before freezing and adding held-out cases.

## What did not change

- The full-report condition still inflates ESLint (+219.9% gross, 169k estimated tokens of context re-read each turn), as in #320.
- Hidden validation, workaround rules, cases and success definitions are identical to #320; no case, rule or threshold was edited for this experiment.
