# Held-out run 1: the 46.5% does not replicate

Ten frozen cases, three repetitions, two headline conditions and two ablations:
120 live sessions, 120 valid trials after a retry, no case excluded. This is the
run the publication gates were waiting for, and it answers the question that
was actually asked — can Drift save agent tokens without costing accuracy —
with **no**.

## Result

| | Valid trials | Successful | Median gross input | Median uncached input |
| --- | ---: | ---: | ---: | ---: |
| Baseline (agent as it ships) | 30 | **29** (96.7%) | 1,565k | 35.8k |
| Baseline + lean tools | 30 | **24** (80.0%) | **811k** | 27.7k |
| Drift (lean tools + Drift's report) | 30 | **28** (93.3%) | 1,580k | 79.8k |
| Drift's report + full tools | 30 | **25** (83.3%) | 2,763k | 83.3k |

Headline, Drift vs baseline: **+12.4% tokens** (median case-level change; 95%
CI −84% to +65%) and **−3.3pp accuracy** (95% CI −23pp to +10pp). Cost over the
run: $27.26 baseline, $45.68 Drift.

## What the ablation shows, which is the whole story

The development runs measured lean sessions and Drift's report as one thing.
Separating them on held-out cases shows they pull in opposite directions.

**The lean tool set does save tokens — 42.4% median across ten cases** (13, 35,
36, 42, 42, 42, 59, 65, 67, 68), which is the same effect the development set
showed. It is a real mechanism, not a sampling artifact.

**It is paid for in accuracy: 24/30 against the baseline's 29/30.** Removing
the tools the agent never used on three development cases removes tools it does
use on ten. Lean lost successes on four cases (axe-core 2/3, ethereumjs 1/3,
ESLint 1/3, lru-cache 2/3).

**Drift's report buys most of that accuracy back: 24/30 → 28/30**, with the
same restricted tool set. That is the clearest evidence so far that the
analysis is worth something — given an agent that cannot search the repository
freely, Drift's localization substitutes for the search. It recovers ESLint,
axe-core and lru-cache to 3/3.

**And it costs more than the tools saved.** The report is ~40k tokens of
uncached input per session (79.8k vs 35.8k), and uncached input is the
expensive kind. Net against a full-tooled baseline: more tokens, slightly worse
accuracy, 68% higher dollar cost.

## The fourth condition: the shipped default is the best Drift configuration

Held-out run 1 left one combination unmeasured — the report *with* the tools
the agent ships with — and it is the one that decides whether
`remediation.agent.leanSession` should stay on. It is worse on both axes:
**25/30 at +28.4% tokens**, against the lean configuration's 28/30 at +12.4%.

Ranked on this suite, then, from best accuracy: baseline 29/30 at its own cost,
Drift-as-shipped 28/30 at +12.4%, report-with-full-tools 25/30 at +28.4%, lean
alone 24/30 at −42.4%. The default stays as it is; turning the lean session off
would make the product worse and more expensive at once.

Why giving an agent both the report and every tool goes wrong is visible in the
failure reasons. With full tools it spends the report *and* searches anyway —
the ESLint case ran to 22.8M gross input tokens in one trial — and its failures
spread across every mode the harness distinguishes (3 hidden regressions, 2
timeouts, 2 prohibited workarounds, a lint failure, an existing test failure).
The lean configuration's two failures are both the same case, ethereumjs, which
no condition ever fixed more than once.

## Why the development set was wrong

Three cases, nine trials per condition, and every one of them a case the lean
tool set happened to suit. The 95% CI on that measurement was −59% to +35% and
was reported as such; the point estimate was still treated as the finding. Ten
held-out cases put the same measurement at +12.4%, inside that interval. The
development number was not a lie, it was an underpowered estimate that landed
on the favourable side, which is exactly what a ten-case gate exists to catch.

## What this does not say

It does not say lean sessions are useless: a 42% token reduction is large, and
a caller who wants it can have it by accepting a lower success rate. It does
not say Drift's analysis is worthless: the ablation is the first clean evidence
that it raises a restricted agent's success rate by 13pp. It says the two
together do not add up to "same work, fewer tokens", which is the claim that
was on the table.

It is also ten cases. The confidence intervals above are wide enough to contain
both a real 20% saving and a real 40% penalty; what they exclude is a reliable
46.5% win.

## Provenance

Runs `heldout-1-s1..s5` (baseline, drift), `heldout-1-lean-s1..s5`
(baseline-lean) and `heldout-1-fulltools-s1..s5` (drift-full-tools), suite `agent-upgrade-v1` frozen at ten cases, Drift
fcccc433, Claude Code 2.1.267, claude-sonnet-5 at effort high, three
repetitions per condition in a counterbalanced order. 25 ablation trials first
failed on an account session limit (HTTP 429) and were re-run to completion
after it reset; they are infrastructure failures, recorded and replaced, not
excluded outcomes. Every trial records the full argv it launched with, so the
tool difference between conditions is auditable per trial.
