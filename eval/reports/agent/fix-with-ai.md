# Fix with AI against a raw agent

Internal record. Nothing here is published, and `benchmark:agent:verify`
keeps it that way.

## What was measured

The product's own Fix with AI path (`runAgentUpgradeFix`, the `drift-fix`
condition in `eval/src/agent/drift-fix.ts`) against a raw Claude Code session
given only the benchmark task (`baseline`). Suite `agent-upgrade-v2`: ten real
upgrades with hidden behavioural validators, 3 repetitions each. Same model,
effort, isolation and token accounting in both conditions.

Earlier reports in this directory (`final-verdict.md`, `brief-runs-analysis.md`)
measured something else: Drift's report or brief pasted in front of the raw
task. Their conclusions apply to that, not to this pipeline.

## Results

| Condition | Prompt | Correct | Gross input tokens |
|---|---|---|---|
| raw agent (`fwa2`) | benchmark task | 25/30 | 77.8M |
| Fix with AI, findings as a head start (`fixwithai`, 51 of 60 trials before the run was lost) | task + Drift's findings | 19/24 | — |
| Fix with AI, raw task + "not what was broken before" (`fwa2`) | | 24/30 | 80.5M |
| **Fix with AI, shipping prompt (`fwa3`)** | raw task word for word + enforced rules | **29/30** | 85.7M |

Per case, shipping prompt against the raw agent (correct of 3):

| Case | Raw | Fix with AI |
|---|---|---|
| winston 3 | 3 | 3 |
| axe-core 4 | 3 | 3 |
| fetch-retry 6 | 3 | 3 |
| vue 3 | 2 | 3 |
| @ethereumjs/tx 5 | 1 | 2 |
| ajv 8 | 3 | 3 |
| eslint 10 | 2 | 3 |
| lru-cache 10 | 3 | 3 |
| telnet-client 2 | 2 | 3 |
| tar 7 | 3 | 3 |

Drift reverted no file in any of the 60 Fix with AI trials of `fwa2` and `fwa3`.

## How to read it

- **Accuracy: at least as good as a raw agent.** The shipping prompt is the raw
  task plus the rules Drift enforces afterwards, so the two sessions are asked
  nearly the same thing; 29 against 25 is within what three repetitions can
  move and was not interleaved (the `fwa3` trials ran after the `fwa2`
  baselines). Claim parity, not superiority.
- **Tokens: no saving.** 10% more in total, cheaper by median on 7 of 10
  cases; the difference is mostly eslint, where the raw agent's one failure
  was also its cheapest run.
- **What moved accuracy was taking things out of the prompt.** Drift's
  findings anchored the agent on the listed items (lru-cache's `maxSize`, a
  behaviour change under an unchanged name). A single scope sentence —
  "failures that were there before this upgrade are not this task" — made two
  of three sessions confirm lru-cache's `maxSize` crash on the old version and
  leave it. Any sentence added to this prompt needs measuring first.

Trials: `eval/results/agent/raw/fwa2-s*`, `fwa3-s*` on
`experimental/agent-remediation-research`.
