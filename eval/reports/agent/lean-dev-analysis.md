# Lean agent sessions, development run — diagnosis

Companion to [`lean-dev.md`](lean-dev.md). **Development cases only** (winston 2 → 3, `@ethereumjs/tx` 4 → 5, ESLint 8 → 10): not held-out evidence and not a public claim.

Experiment: `lean-dev-{winston,ethereum,eslint}-r{1,2,3}` — `claude-sonnet-5`, effort high, Claude Code 2.1.267, isolated sessions, web tools disabled, no budget or turn cap, Drift `3cb16e3c`, Williams schedule. 27/27 slots valid; no exclusions, no retries. Every lean session was audited to have loaded exactly the lean tool set and no skills or slash commands; the rest of every session's environment matched the baseline's (one base fingerprint).

## Why this experiment

Token-weighted attribution over the 18 raw trials of `controller-dev2`/`dev3` (script and method in the PR): **49% of all gross input tokens was the fixed context every model call starts with** — Claude Code's system prompt plus 24 tool definitions, 19 skills and 53 slash commands, 41,550 tokens per call. Everything the agent read or ran (test and compiler output 6.3%, repository reads 4.8%, dependency browsing 3.7%, …) was about 20%. Every earlier intervention (reports, briefs, MCP, a controller) addressed the 20%.

Across 90 earlier benchmark sessions agents called only Bash, Edit, Read and Write (plus ToolSearch in MCP sessions and TaskOutput/TaskStop four times). `remediation.agent.leanSession` (#323) starts Claude Code with `--tools Bash Read Edit Write TaskOutput TaskStop --disable-slash-commands`: 12,557 tokens of fixed context per call.

## Result

| | Raw | Drift lean | Drift lean + brief |
| --- | ---: | ---: | ---: |
| winston | 3/3 | 3/3 | 3/3 |
| @ethereumjs/tx | 2/3 | 2/3 | 1/3 |
| ESLint | 3/3 | 3/3 | 3/3 |
| **Total** | **8/9** | **8/9** | **7/9** |
| Median case gross input vs Raw | — | **−46.5%** (95% CI −59.1 to +34.7) | −10.3% |
| Per case | — | winston +10.0%, ethereumjs −46.5%, ESLint −47.7% | winston −10.3%, ethereumjs +6.1%, ESLint −43.1% |

**Drift lean meets the development gate:** accuracy equal to raw overall and in every case, and a −46.5% median case-level reduction in gross input.

### The mechanism holds per call, in every case

| Case | Raw gross per call | Lean gross per call | Raw cost | Lean cost |
| --- | --- | --- | --- | --- |
| ESLint | 83–86k | 44–53k | $2.00–2.43 | $1.20–1.55 |
| @ethereumjs/tx | 86–101k | 52–60k | $1.78–2.01 | $0.99–1.30 |
| winston | 54–70k | 26–59k | $0.52–1.21 | $0.38–1.96 |

Removing ~29k tokens of fixed context from every call lowers per-call cost in every case; the total then depends on how many calls a session makes, which is the agent's stochastic part. Winston's median is +10% because one lean trial took 96 calls (raw: 25–54); on ESLint and ethereumjs every lean trial cost less than every raw trial.

### Failures

- Raw, ethereumjs r1: lowered the Jest coverage thresholds (prohibited workaround).
- Drift lean, ethereumjs r3: hidden signing test fails at runtime (`TransactionFactory.fromTxData` given non-`0x` strings); the project's own tests mock that path. The same bug appeared in raw and generic trials in earlier runs.
- Drift lean + brief, ethereumjs r1 and r2: lowered the Jest coverage thresholds (r1 also added a type suppression). The brief condition hit the same workaround twice on this case in v3 as well.

## Interpretation

1. **The saving is real and mechanical.** It comes from what the agent session loads, not from the agent doing less work: model calls −10%, gross after first edit −35.5%, and the per-call reduction appears in every trial pair.
2. **Accuracy is unchanged.** The lean session has every tool agents used; workflow, scope and autonomy are the raw agent's.
3. **The agent brief does not add value on top.** It adds per-call context and calls, and on ethereumjs it coincided with the coverage-threshold workaround again (0/2 → 1/3). Not recommended with the lean profile.
4. **Attribution, stated plainly:** this saving is Drift's agent launch configuration, not Drift's dependency analysis. Any tool that starts Claude Code for a fix could configure the same; Drift's value here is that its fix flow does it by default and measures it.
5. **What this does not show:** held-out generality, other agents (Codex, Gemini CLI), other models or CLI versions. The fixed-context size is specific to Claude Code 2.1.267's tool roster.

## Next step

Freeze the lean profile, make the benchmarked path the product path (one autonomous fix session for the upgrade, started lean by `drift fix`), and run the ≥ 10-case held-out experiment: raw vs Drift lean.
