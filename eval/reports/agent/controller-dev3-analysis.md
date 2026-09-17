# Controller-owned remediation, development regression rerun (dev3) — diagnosis

Companion to [`controller-dev3.md`](controller-dev3.md). **Development cases only**; a regression rerun after the accuracy fixes that followed [`controller-dev2`](controller-dev2-analysis.md), not a validation benchmark.

Experiment: `controller-dev3-{winston,ethereum,eslint}-r{1,2,3}`, Drift `1bb43791` (coverage probes, clean-install confirmation, adaptive scope, worktrees outside `.git/`), same model, effort, isolation and schedule as dev2. 27/27 valid, no exclusions or retries.

## Gate: not met on either criterion

| | Raw | Generic orch. | Drift orch. |
| --- | ---: | ---: | ---: |
| winston | 3/3 | 3/3 | 2/3 |
| @ethereumjs/tx | 3/3 | 3/3 | 2/3 |
| ESLint | 3/3 | 3/3 | **3/3** (dev2: 1/3) |
| **Total** | **9/9** | **9/9** | **7/9** |
| Median case gross input vs Raw | — | −4.2% | **+25.9%** (dev2: −51.1%) |

## What the accuracy fixes did

- **ESLint recovered (1/3 → 3/3).** No session under-migrated the flat config; adaptive scope gave repairs `package.json` and the config files, and the coverage probes would have caught a weakened config.
- **Two Drift failures remain, both from controller defects fixed in #323 after this run and not yet measured:**
  - ethereumjs r2: a repair session reworded an existing `@ts-expect-error` in `src/ledger-keyring.ts`; the checks passed. New or changed type-check suppressions in source are now rejected (checked offline against the references and all 49 dev2/dev3 trial diffs: flags only this trial).
  - winston r3: the correct `tsconfig.json` fix was rejected because a tool wrote into `node_modules/typescript` during the session (a rule added after the first pilot). Dependency writes no longer reject a session; the clean reinstall and the clean-install confirmation cover the risk.

## Why the token reduction disappeared

**The dev2 saving and the dev2 accuracy loss had the same cause: narrow scope.** Median files exposed per Drift session went from 5 to 15 on ethereumjs and ESLint once adaptive scope widened repairs that fail at the tool level (a coverage threshold, a lint configuration). A session that can do the whole migration does the whole migration, at the same cost as the raw agent plus the overhead of fresh sessions:

- Gross after first edit — Drift vs raw: winston 2.32M vs 2.31M, ethereumjs 7.63M vs 4.86M, ESLint 6.23M vs 8.34M.
- Every fresh session re-researches the dependency: median dependency-research accesses Drift 15 / 12 / 19 vs raw 5 / 9 / 11.
- Model calls Drift 55 / 87 / 117 vs raw 47 / 61 / 107; at roughly 40–50k gross tokens of fixed context per call, calls are the cost.

Nothing Drift supplies shortens the work on these cases: in every trial, no unit was resolved deterministically and no finding carried a replacement symbol or signature. With complete migrations required, controller orchestration on its own is not a token saving — generic orchestration is −4.2% with the same accuracy as raw.

## Implication

Fixing the two remaining defects should close the accuracy gap, but nothing in those fixes reduces tokens, so a further rerun is expected to show accuracy near raw and no material saving. The architecture's token claim now depends on Drift supplying migration knowledge that removes agent work (replacement APIs, localisation of the compiler-measured breaks into units, deterministic fixes) — which did not exist for any development case.
