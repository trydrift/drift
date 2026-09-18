# Can Drift save agent tokens without costing accuracy?

Yes — one lever works, and it is not the one the plan was built around. This
note states what is established, what is not, and what should not be merged.

## The short version

| Intervention | Accuracy vs raw | Gross input | Verdict |
| --- | --- | ---: | --- |
| **Lean sessions** (`remediation.agent.leanSession`) | 8/9 = 8/9, equal in every case | **−46.5%** median per case | **Merge** (PR #325) |
| Lean + Drift brief | 7/9 (worse) | −10.3% | Do not enable |
| Controller-owned remediation, dev2 | 6/9 (worse) | −51% | **Experimental** (PR #323/#324) |
| Controller-owned remediation, dev3 | 7/9 (worse) | +26% | **Experimental** |
| Deterministic codemod tier | — | ~0 on real cases | Keep, but claims nothing |

## What is established

**49% of an agent's gross input tokens is fixed context.** Token-weighted
attribution over the 18 raw trials of the controller runs: Claude Code's system
prompt plus 24 tool definitions, 19 skills and 53 slash commands re-read on
every model call — 41,550 tokens per call. Everything the agent actually read
or ran (test and compiler output 6.3%, repository reads 4.8%, dependency
browsing 3.7%) is about 20%. Every earlier intervention — richer reports,
briefs, MCP, the controller — was aimed at that 20%.

**Starting the session lean cuts that in half, and costs no accuracy.** Across
90 earlier sessions agents called only Bash, Edit, Read and Write. Launching
with `--tools Bash Read Edit Write TaskOutput TaskStop
--disable-slash-commands` gives 12,557 tokens of fixed context per call.
Result over 3 cases × 3 trials × 3 conditions: 8/9 for both raw and lean, equal
in every case, median **−46.5%** gross input. The mechanism is visible per call
in every case (ESLint 83–86k → 44–53k; ethereumjs 86–101k → 52–60k; winston
54–70k → 26–59k), so the direction is not a sampling accident.

## What is not established

- **n is 3 cases, 9 trials per condition.** The 95% CI on the median case-level
  reduction is −59.1% to +34.7%. The per-call mechanism is solid; the
  *session-level total* is not, because it also depends on how many calls a
  session makes, which is the stochastic part. One winston lean trial took 96
  calls (raw: 25–54) and came out +10%.
- **Nothing here supports a public claim.** No marketing copy, README
  performance claim, landing-page number or benchmark claim should cite this.
  That needs the ≥10-case held-out run, which has not been spent.

## The uncomfortable part: the saving is configuration, not analysis

The −46.5% comes from *not loading tools the agent never calls*. Any harness
could set those flags. Drift's contribution is that it is the thing configuring
and launching the session — a real "agent vs. through Drift" saving, and an
honest one to state that way. It is not evidence that Drift's analysis makes
agents cheaper.

Three attempts to convert the analysis itself into savings all failed:

- **A richer brief costs accuracy** (7/9 vs 8/9) and saves little (−10.3%).
- **The controller loop** — Drift owning verification, bounding agent units,
  repairing residuals — scored 6/9 then 7/9, never matching raw. The dev2
  −51% was an artifact: narrow scope caused under-migration, so the agent did
  less work and failed more hidden tests. Cheaper because worse.
- **The deterministic tier does not fire on real cases.** Over 52 scored
  swe-bump cases it produced **0 codemod units and 0 fully deterministic
  cases**. Before the successor inference was tightened it had exactly one —
  vue 2.7 -> 3.5 — and that one was *wrong*: it read `Vue` as replaced by
  `CompatVue` and would have committed `new CompatVue({...})` where the
  migration is `createApp(App).mount()`.

### What the analysis does get right

The tier produces no automated fix, but what it *says* is accurate. Re-deriving
every successor it proposes across the 57 cases, against the final build: nine
proposals on five cases, and all nine are correct — `glob.sync` -> `globSync`
(three cases), `winston.Logger` -> `winston.createLogger`, and all five mkdirp
flat exports (`sync` -> `mkdirpSync`, `manual` -> `mkdirpManual`, `manualSync`,
`native`, `nativeSync`). Zero false positives, where before the tightening this
same corpus produced the `CompatVue` fix.

That is worth something to whoever reads the report — it is simply not worth
tokens, because naming the successor does not shorten the session that applies
it.

**On "generate one fix, replay it at every site":** mostly no, but not never.
The median case has **2** impact sites and 28 of 52 have two or fewer — there
is nothing to replay to, and dedupe cannot save what those cases never spend.
There is a tail, though: seven cases have nine or more sites (9, 15, 17, 18,
24, 25, and one with **211**). If the idea is worth testing, it is worth
testing only there, and the open question is not the saving but whether one
authored fix is actually valid at 211 sites — which is the same correctness
question the `CompatVue` case just answered badly.

## Merge / do not merge

**Merge — PR #325.** Lean sessions, off by default and measured; the successor
inference tightened to shape-equality plus the package-name merge; the
namespace-member codemod; and the hardening found along the way (protected-path
glob depth, `.git/`-hosted worktrees invisible to Jest, scope validation,
anti-weakening checks). These are correct independent of any token claim. The
suite is green (2,671 pass, 1 skipped) and typecheck is clean.

**Do not merge as default — PR #323/#324.** The controller loop is a coherent
architecture that did not beat a raw agent on either accuracy or tokens in two
development runs. It stays behind its flag, labelled experimental.

## If the ≥10-case run is worth spending

Spend it on lean vs raw only. That is the one comparison with a mechanism, a
direction, and a passing accuracy gate. Do not re-test the controller until
there is a reason to believe the accuracy gap has closed.
