# Drift benchmark

This measures whether Drift detects a real dependency breakage, localizes it to
the right consumer code, decides honestly whether it can safely repair it, and —
when it repairs — whether the repair actually works.

**Read "Composition and limitations" before citing any number from here.** The
corpus is currently four synthetic npm cases. That is enough to validate the
harness and nothing like enough to support a general accuracy claim.

The methodology, and where it departs from BUMP, Defects4J, SWE-bench,
swe-bump-bench, bumpgen, DepBench and UPGRADVISOR, is in
[`docs/research/evaluation.md`](../docs/research/evaluation.md).

---

## Layers

Five, with enforced boundaries. The boundary that matters most is between C and
D.

| Layer | Responsibility | May read ground truth? |
| --- | --- | --- |
| **A** corpus construction (`src/corpus/`) | mine and freeze candidate cases | no |
| **B** QA and ground truth (`src/oracle/`, `src/judge/`, `src/review.ts`) | reproducibility, independent review, adjudication | writes it; never sees a prediction while reviewing |
| **C** prediction (`src/adapters/`, `src/tiers/`) | run real Drift production paths | **no** |
| **D** evaluation (`src/evaluate.ts`, `src/evaluator/`) | oracles, scoring, metrics | yes — only here |
| **E** reporting (`src/report/`, `src/runs/`) | aggregation, provenance, audit | derived only |

### Why C cannot reach D

A prediction adapter receives a `PublicCase` and a materialized workspace.
`PrivateTruth` — adjudication references, the developer's migration patch,
hidden oracles, the recorded trigger signature — lives in a sibling directory
that is never mounted. Three redundant enforcements, each catching a different
mistake:

1. `PredictionInput` has no field that could carry truth, so an adapter cannot
   be handed the answer. (The previous harness passed `adjudication` directly.)
2. `PrivateTruth` is branded at its loader, so it cannot be structurally widened
   into anything Layer C accepts.
3. `auditWorkspaceIsolation` walks the workspace and rejects private artifacts,
   overlap with the private root, and symlinks whose *target* leaves the
   workspace — on **every** materialization, not only in a test.

The third is the only one that still holds once a coding agent with shell access
is running in that directory, which is exactly what the agent repair track does.
A static test also asserts nothing under `src/adapters/` or `src/tiers/` imports
the private loader.

---

## Case layout

```
eval/cases/public/<id>/
  case.yml            immutable, reproducible description (schema: src/case/schema.ts)
  consumer/           the BUMP-ONLY state: base commit + only the manifest/lockfile bump
  before/             manifest and lockfile as they read pre-bump, and nothing else
  upstream/old|new/   frozen package trees for the two exact versions
  evidence/           frozen upstream prose (changelog, release notes), optional

eval/cases/private/<id>/
  truth.yml           developer patch, hidden oracles, recorded trigger signature
  adjudication.yml    the accepted ground truth
  reviews/*.yml       every independent review, append-only
```

`consumer/` being the bump-only state is the causal construction BUMP and
DepBench both use: it is the state a developer lands in when a Dependabot PR
turns red. Diffing `before/` against `consumer/` is the same operation
production performs between two git refs, which is what makes manifest detection
measurable rather than assumed.

A case declares **exact resolved versions**, never a range — a range stops being
reproducible the day the registry moves, and `validateCase` rejects one. It also
records the resolved dependency-*graph* delta, not only the direct bump, because
a one-line manifest change is routinely not a one-package change.

### Case status

Every value except `benchmark-ready` requires a reason and appears in the
report's exclusion table. Nothing is ever silently dropped.

`candidate` · `reproducibility-check` · `benchmark-ready` · `disputed` ·
`flaky` · `invalid-baseline` · `non-causal` · `oracle-insufficient` ·
`environment-unavailable` · `excluded-stale`

---

## The reproducibility gate

A case is not a case because it failed once.
`checkReproducibility` runs baseline, bump-only and (where a gold patch exists)
gold-repaired **three times each**, and rules in this order — the order is
load-bearing:

1. **`environment-unavailable`** — a machine that could not install cannot say
   anything about a case.
2. **`invalid-baseline`** — a consumer already failing its own check before the
   upgrade makes every later observation uninterpretable. (swe-bump-bench's
   collector warns about exactly this and keeps the task anyway.)
3. **`flaky`** — an unstable signature cannot support a causal claim.
4. **`non-causal`** — the bump-only state did not behave as declared.
5. **`oracle-insufficient`** — the bump-only state failed, but with no failure
   the baseline did not already produce, so the update cannot be shown to be the
   cause; or the gold patch does not actually repair it.
6. **`benchmark-ready`.**

Three repetitions is the minimum because BUMP discarded 57 of 628 candidates at
this stage: roughly one in eleven looked like a breaking update and was not.

The gate records the platform it verified and claims nothing beyond it.

---

## Failure signatures, not error counts

Every stage's output is parsed into a set of stable diagnostic **identities** —
diagnostic code, repo-relative file, normalized message; never line numbers,
absolute paths, or per-run temp prefixes. Repair is then judged with set algebra:

```
trigger set   = broken \ baseline          what the upgrade actually broke
resolved      = trigger \ repaired         what the repair actually fixed
new failures  = repaired \ (baseline ∪ broken)   what the repair broke
```

This is Defects4J's trigger tests and SWE-bench's FAIL_TO_PASS / PASS_TO_PASS,
applied to upgrades. It exists because every prior benchmark in this space
decides success by comparing a *count*, and a count cannot distinguish a
migration from deleting the code that called the changed API — nor catch a patch
that swaps one real error for a different real error.

A failure already present in baseline is pre-existing consumer breakage and can
never be credited to a repair. A bump that broke nothing reproducibly is
`no-trigger` and can never credit a repair for fixing nothing.

---

## What is measured

### Detection — five independent levels

Pooling them makes a miss undiagnosable: "never fetched the evidence",
"classified a removal as a rename", "classified correctly and missed the wrapper
that calls it", and "found everything and still called it safe" are four defects
in four modules.

| Level | Question |
| --- | --- |
| **D0** | Did the manifest diff find the dependency update? |
| **D1** | Did evidence state what changed upstream? |
| **D2** | Was that turned into the right `BreakingChange`? |
| **D3** | Did it land on the right consumer code? (symbol view *and* line view) |
| **D4** | Was the user told something honest? |

A level the accepted adjudication does not rule on is `not-adjudicated` and
contributes to nothing. It is never zero-filled — scoring an unstated
expectation as an empty set turns "reviewers did not rule on this" into "Drift
correctly predicted nothing".

D3 is reported at two anchors on purpose. The **symbol** view survives harmless
reformatting; the **line** view still catches a tool naming the right file and
the wrong line.

**D4 / false-safe** requires two things: adjudicated truth is `unsafe`, *and*
Drift's user-facing verdict is safe-equivalent. Only
`no-incompatible-change-in-checked-surfaces` and `clean` are safe-equivalent —
every inconclusive verdict (`insufficient-evidence`, `verification-incomplete`,
`detected-not-locally-reachable`, `unchecked`, `verification-failed`,
`upstream-only`) is not a safety claim. Widening that set is the easiest way to
improve a false-safe rate without changing the product, which is why it is a
named constant with a comment saying so. `unsupportedSafe` (truth uncertain,
Drift said safe) is reported separately and never merged in.

### Repair — one track per production mechanism

Never pooled. They fail for different reasons and need different fixes.

| Track | What it exercises |
| --- | --- |
| `repair-codemod` | tier 1: deterministic, model-free rename codemod |
| `repair-fixplan-cache` | a cached plan, through the normal revalidation gate |
| `repair-fixplan-recipe` | a community recipe re-derived in the sandbox |
| `repair-fixplan-model` | a model authors a *rule*; `validateFixPlan` decides; Drift applies it |
| `repair-agent` | a coding agent through Drift's real `FixAgent` + worktree runner |
| `repair-full-remediation` | the complete hierarchy, Drift choosing — **the headline** |

`repair-fixplan-model` is architecturally unlike agent repair and is never
reported as the same thing: the model proposes one rule per finding and never
edited code, Drift's gate decides whether it is grounded and derivable, and
Drift's executor applies it. The two halves are recorded separately — "the model
declined" is a correct abstention, "the model proposed something the validator
rejected" is the gate earning its keep.

`repair-agent` benchmarks **Drift plus its Codex handoff, not Codex.** Nothing in
the harness writes a prompt. The agent comes from Drift's own
`CLI_AGENT_SPECS`, receives a `CommitUnit` the production planner built, and runs
through `runAgentCommitsInWorktree`, which supplies Drift's `buildFixPrompt`,
snapshots allowed files, isolates in a disposable worktree, and validates changed
paths against the plan's declared scope before accepting anything.

#### Outcomes

`repaired` · `partially-repaired` · `failed-to-fix` · `introduced-regression` ·
`correct-abstention` · `missed-opportunity` · `unsafe-attempt` ·
`no-repair-needed` · `operational-failure` · `no-trigger`

Only `repaired` counts as a repair. `correctDecision` — repaired, correctly
abstained, or nothing needed — is reported beside it, because a benchmark that
scores only repairs pushes a tool toward guessing, and a wrong migration applied
to every call site is worse than no migration.

Attempting where truth says abstain is `unsafe-attempt` **even when the oracle
goes green**. A repair that edits outside its own plan's declared scope is
disqualified however green the build.

`operational-failure` (agent timeout, agent error, install failure, patch would
not apply, model not configured) leaves both the numerator and the denominator.
It is still counted in the outcome table, so nothing disappears.

Gold-patch exactness is a **diagnostic** and never a gate — a semantically
correct migration that reads differently is still correct.

### Conditional vs end-to-end

A `conditional` experiment hands a mechanism adjudicated findings to measure its
ceiling ("could the codemod fix this *if* detection were correct?"). Useful, and
not the product. It is marked at the artifact level and the evaluator refuses to
fold it into end-to-end metrics.

---

## Live AI trials

- **Every attempt is retained.** Keeping only the successful trial of three is
  best-of-k with extra steps. The store refuses to overwrite an artifact; a
  repeat must take the next trial index.
- **First-attempt success is the headline.** Reliability across trials is
  reported beside it, never instead of it: "succeeded once in three" and
  "succeeded three times in three" are different products that pass@3 scores
  identically. No best-of-k number is computed at all.
- **Provenance is exhaustive**, and anything the environment does not expose is
  the literal string `unavailable`. Model and effort are read from what the
  agent itself reported, not from what Drift requested — Codex resolves its own
  model from config when flags are absent, and recording the request would
  attribute a result to a model that never ran it.
- **A live trial records `costUsd: null`, not `0`.** A provider that does not
  expose cost has not told us it was free.

---

## Statistics

Rates are reported at instance-micro, case-macro, repository-macro and
dependency-macro. A historical corpus is never balanced, and one active monorepo
contributing a dozen cases would otherwise have its characteristics reported as
the tool's; a large gap between the four is itself the finding.

- A rate over an empty denominator is `n/a (0/0)`, never `0%`.
- Empty-expected/empty-actual cases are excluded from macro means and harmless
  in micro. A false positive on a control case is **never** excluded.
- Bootstrap intervals resample over cases, not trials, and return nothing below
  20 cases. An interval from four cases is arithmetically valid and
  rhetorically dishonest.
- McNemar's exact test is available for comparing two tracks on identical cases,
  and returns nothing when too few pairs disagree.

---

## Ground truth

**Fixture → review → adjudication → prediction**, and only adjudication counts.

- A **review** is one reviewer's independently derived conclusion. Append-only:
  never edited, only superseded.
- An **adjudication** is the accepted truth, referencing the review(s) it
  accepts. Scoring reads only this — never a review directly, never case
  metadata. Where it differs from an accepted review, it must say so in
  machine-checked `override`/`synthesis` metadata naming exactly the fields that
  differ.
- A review applies only to the exact revision it inspected. Content hashes
  detect staleness, and a stale review's case is excluded rather than re-scored.

### AI review

Reviewers run through the same agent registry Drift's repair agents come from,
each in a fresh empty sandbox. The packet carries the public case, both upstream
trees, the consumer source and observed oracle output — and **excludes** any
Drift prediction (a reviewer who has seen the tool's answer is grading it, not
deriving truth), any other reviewer's conclusion, and the developer's patch (a
reviewer shown it records it as *the* expected change).

The instruction forbids answering from prior knowledge of the package and makes
`uncertain` an expected answer. The failure mode of an AI reviewer is not
refusing to answer — it is answering confidently from recollection, and a
benchmark whose ground truth is a model's memory of a package measures recall
rather than correctness. Reviewers are never told which tool is being evaluated.

Disagreement is preserved, not resolved by fiat. A disputed field is excluded
from headline metrics.

---

## Commands

```sh
npm run eval:typecheck                 # the harness typechecks
npm run eval:test                      # harness unit tests, zero model calls
npm run eval:cases:import              # legacy fixture -> public/private case layout

npm run eval:bench -- run              # deterministic tracks: detect-end-to-end, repair-codemod
npm run eval:bench -- run --tracks repair-agent --trials 3 --agent codex   # live, costs money
npm run eval:bench -- evaluate <run-id> [--out FILE]                       # always free, always offline
npm run eval:bench -- runs
```

`run` produces artifacts and may cost money. `evaluate` scores artifacts and
never calls anything. Anyone can re-score a paid run after an evaluator fix, and
CI validates the evaluator with zero model calls.

`evaluate` fails only on an **integrity** break — a false-safe, a production
scope escape, an unaudited workspace, or a stale artifact. A missed detection or
a failed repair is a product result; failing CI on one is how a benchmark starts
being tuned away from measuring the product.

---

## Composition and limitations

Current corpus: **4 cases, all synthetic, all npm, one repository, one
dependency, 1 negative/control.** Every report prints this before any number.

- **No historical cases yet.** The miner (`src/corpus/mine-npm.ts`) builds them
  causally from real migration PRs and the reproducibility gate rules on them,
  but the corpus has not been populated. This is the single largest gap.
- **One ecosystem.** The schema is ecosystem-neutral; only npm is populated.
- **D0 and D1 are unadjudicated on every current case.** The existing reviews
  predate those levels, and inventing an expectation for them is exactly what
  this harness must not do.
- **Network isolation is configuration, not a sandbox.** Drift's own `fetch` is
  intercepted and the package manager runs offline, but a subprocess — including
  a coding agent — is not prevented from reaching the network by either.
- **A live agent must reach its own provider**, so `agent-service-only` is the
  strongest honest policy for an agent trial. An agent that searches for the
  historical PR is not currently prevented, only recorded.
- **Only one AI reviewer so far, and zero human reviewers.** The
  multi-reviewer/disagreement machinery exists and is exercised by one case's
  supersession history, but not yet by two different reviewers disagreeing.
- **The `repair-fixplan-cache` and `repair-fixplan-recipe` tracks are declared
  but not yet implemented.** They are in the track enum and are not runnable;
  they report nothing rather than reporting zero.
