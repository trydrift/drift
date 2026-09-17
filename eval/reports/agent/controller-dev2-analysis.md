# Controller-owned remediation, development run — diagnosis

Companion to [`controller-dev2.md`](controller-dev2.md), which holds every number. **Development cases only** (winston 2 → 3, `@ethereumjs/tx` 4 → 5, ESLint 8 → 10). They shaped the controller — two pilots and a superseded run found and fixed ten product defects on them — so nothing here is held-out evidence, and no public claim will be made from it.

Experiment: `controller-dev2-{winston,ethereum,eslint}-r{1,2,3}` — `claude-sonnet-5`, effort high, Claude Code 2.1.267, isolated sessions (one environment fingerprint), web tools disabled, no budget or turn cap, Drift `2daf6959`, 3 conditions × 3 cases × 3 repetitions in a Williams schedule (every condition 3/3/3 across positions). 27 of 27 slots valid; no exclusions, no retries.

## Verdict

**The architecture failed the acceptance gate.** It met the token target (−51.1% median case-level gross input vs raw, 95% CI −68.7 to −2.2) and **reduced accuracy**: Drift-orchestrated 6/9 against raw 8/9 and generic-orchestrated 9/9. By the experiment's own rule, lower tokens with lower success is not a win.

| | Raw | Generic orch. | Drift orch. |
| --- | ---: | ---: | ---: |
| winston | 3/3 | 3/3 | 3/3 |
| @ethereumjs/tx | 2/3 | 3/3 | 2/3 |
| ESLint | 3/3 | 3/3 | **1/3** |
| **Total** | **8/9** | **9/9** | **6/9** |

## Answers

1. **Material reduction in total agent input vs raw?** Yes on the headline (−51.1% median case-level gross; winston −55.1%, ethereumjs −34.4%, ESLint −51.1%; model calls −29.8%). But part of it is failure being cheap: both failed ESLint Drift trials stopped early (3.45M, 3.87M). The one successful ESLint Drift trial used 6.06M against raw's 7.91M median (≈ −23%); on ethereumjs the successful Drift trials used 7.04M and 4.63M against raw's successful 6.77M and 7.20M. Only winston, where every trial succeeded, shows a clean large saving.
2. **Accuracy preserved?** No: 6/9 vs 8/9, and worse on ESLint in every sense.
3. **How much comes from generic orchestration?** None of the saving. Generic orchestration was **+22.3%** gross vs raw (winston −16.6%, ethereumjs +22.3%, ESLint +36.9%) with the best accuracy (9/9). Moving verification out of the agent and blocking broad checks did not make an open, full-scope session cheaper: agents replaced refused broad checks with narrow ones (15 on ESLint) and kept reading the dependency (18 research accesses on ethereumjs and ESLint).
4. **Attributable to Drift?** Drift vs generic: −46.4% gross (−64.0% after the first edit, −40.5% model calls). But Drift did not contribute *intelligence* in the sense the plan meant: no unit was resolved deterministically, no finding carried a replacement symbol or signature, and Drift's units were mostly skipped (ethereumjs: its only unit was a protected CI workflow; ESLint: 3 of 5 protected, the rest a RuleTester no-op). The saving comes from **scoping**: repair sessions exposed 1–5 files instead of the whole repository, which is also what caused the ESLint failures.
5. **Deterministic repairs avoiding LLM calls?** Zero units, in every trial. The analysis produced no codemod or fix plan for these upgrades.
6. **Did external verification shorten the post-edit loop?** Only in combination with scoping. Gross after first edit: Drift 0.61M / 3.24M / 3.26M vs raw 2.23M / 6.52M / 6.34M. Generic, with the same external verification and guard but full scope, was 1.98M / 6.38M / 9.05M — no shorter than raw.
7. **Agents still researching dependency source?** Yes, in every condition. Median dependency-research accesses: raw 5 / 10 / 11, generic 5 / 18 / 18, Drift 8 / 16 / 12. The prompt's "don't re-derive" rule changes nothing when Drift has no replacement API to give.
8. **What dominates token usage?** Fixed per-call context (≈40–50k gross tokens per Claude Code model call) × model calls. Every condition's cost tracks its model-call count; fresh sessions help only when they cut calls, and repeated file and package reading in each fresh session limits that.
9. **Strong enough to replace the existing fixing flow?** No. It should stay opt-in (`remediation.loop: verified`, default `single-pass`).

## The new systematic failure mode

**Scoped sessions under-migrate configuration migrations.** ESLint 8 → 10 needs a flat config plus companion packages (typescript-eslint 8, `@eslint/js`, `globals`). Drift's residual repair sessions were scoped to the files the failures named; the agent was told that out-of-scope edits discard its work, and that it may *request* a file. In rep 2 it wrote an `eslint.config.js` carrying `TODO(drift): … porting them needs … editing package.json, which is out of scope`, dropped `eslint:recommended` and typescript-eslint's recommended rules, and downgraded the project's own `no-unsafe-execa` rule from error to warning. `npm run lint` passed, so the controller reported **verified**; the hidden lint-behaviour test (project rules must still fire) failed. Rep 3 stalled on the same lint failure and ended no-progress. Generic's open session, with the whole repository in scope, migrated properly in 3/3.

Two gaps combine: (a) scope pressure makes a narrower, weaker fix the agent's easiest path, even with scope requests available; (b) controller verification cannot see that a lint configuration was weakened (rules removed or downgraded) — a check that passes because it checks less.

The ethereumjs Drift failure (rep 3) is a semantic bug the project's mocked tests cannot catch (`v`/`r`/`s` passed as non-`0x` strings to `TransactionFactory.fromTxData`); the same bug appeared in raw and generic trials in the superseded run, so it is not attributed to the architecture.

## What was not changed after seeing these results

No product fix was made in response to this run. The candidate fixes — detecting lint-rule weakening as a workaround, and granting manifest scope by default when the failing check is the upgraded tool — are plausible but were found on these three development cases, and making them and rerunning here would tune the product to the cases that measure it.

## Next experiment

Before any held-out run: fix the two gaps above in the product (lint/tooling-config weakening detection; a scope policy for tooling migrations), then measure on **held-out** cases, including configuration-heavy tooling upgrades, with ≥ 10 cases. Separately, the plan's premise — Drift supplying replacement APIs and deterministic fixes — did not hold on any development case; improving that analysis (replacement symbols, localisation of compiler-measured breaks into units) is what would test Drift intelligence rather than scoping.
