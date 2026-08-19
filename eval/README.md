# Drift benchmark

This measures whether Drift detects a real dependency breakage, localizes it to
the right consumer code, decides honestly whether it can safely repair it, and —
when it repairs — whether the repair actually works.

**Read "Composition and limitations" before citing any number from here.** The
corpus is currently five synthetic npm cases. That is enough to validate the
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
  truth.yml           developer patch, hidden-check declarations, recorded trigger signature
  adjudication.yml    the accepted ground truth
  hidden/             executable behavioural assertions (see below)
  reviews/*.yml       every independent review, append-only
```

`evidence/` is genuinely read. Drift reaches upstream prose through a chain —
npm registry metadata names a GitHub repository, and the changelog and migration
guide are probed on `raw.githubusercontent.com` — so the fetch stub serves both
ends of that chain from the case's own frozen files. An offline run therefore
reads the same evidence a networked one would, through the same production code
path. A case that froze no prose gets none, exactly as a package without a
discoverable repository does.

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
decides success by comparing a *count*, and a count credits a patch that swaps
one real error for a different real error.

A failure already present in baseline is pre-existing consumer breakage and can
never be credited to a repair. A bump that broke nothing reproducibly is
`no-trigger` and can never credit a repair for fixing nothing.

### What failure signatures do not establish

**Signatures prevent one failure being substituted for another. They do not
prevent deletion, and nothing about set algebra could.** Removing the code that
called the changed API removes the diagnostic: the trigger set empties, the
project's own check exits 0, and the three stages read exactly like a
successful migration. That is true of a count and equally true of identities.

What separates the two is an observation, not a diff — something has to call
the behaviour and find it still there. That is what hidden behavioural checks
below are for, and the README says which mechanism does which job because
claiming signatures alone prove behaviour preservation would be claiming more
than the code does. `eval/src/oracle/destructive-repair.test.ts` pins both
halves: destructive edits are not credited, and *with hidden checks removed*
the same deletion is credited.

---

## Hidden behavioural checks

A case may carry executable assertions about the consumer's own application
semantics, authored in the fixture tree and moved into
`eval/cases/private/<id>/hidden/`.

```yaml
- id: preserves-shout
  description: The consumer still exports shout(name) and it still returns the upper-cased name.
  command: node hidden/behaviour.mjs
  expect: pass
  files: [behaviour.mjs]
```

- They are **never** in a prediction workspace. `materializeCase` copies only
  named public directories, `auditWorkspaceIsolation` rejects a `hidden/`
  directory outright, and the check's files are written into the *throwaway*
  consumer copy an oracle stage makes — after the repair already exists.
- Their diagnostics join the stage's signature under a `hidden:` prefix, so the
  existing fail-to-pass algebra needs no new concepts. A deleted behaviour
  leaves a hidden trigger unresolved (`partially-repaired`) or replaces it with
  a new failure (`introduced-regression`), and can never reach `repaired`.
- The **reproducibility gate runs them in every stage**, and that is what
  entitles them to disqualify anything. A check that does not pass on the
  baseline is asserting something that was never true, and the gate reports the
  case `invalid-baseline` rather than letting the check quietly fail every
  repair.
- They are ground truth, so the review revision hash covers them: changing what
  a correct repair must preserve stales the accepted review.
- A semantically valid alternative repair still passes. The assertion is about
  behaviour, never about text, and a rewrite that reads nothing like the gold
  patch is credited — that case is in the test.

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
Drift's user-facing verdict is safe-equivalent.

A verdict is safe-equivalent when it tells the user their repository is
unaffected: `no-incompatible-change-in-checked-surfaces`, `clean`, and
`detected-not-locally-reachable`. The third is included deliberately.
Production only emits it once localization has actually run — it is
distinguished from `verification-incomplete` on exactly that — so it means "we
searched this repository and the changed symbol is not used here", which is a
conclusion about the user's code and the sentence they act on. Excluding it
under-counted false-safes and made a genuine control case structurally
incapable of ever scoring `correctSafe`.

Every remaining verdict (`insufficient-evidence`, `verification-incomplete`,
`unchecked`, `verification-failed`, `upstream-only`) describes a check that did
not complete and is never read as a safety claim in either direction. Widening
that set further is the easiest way to improve a false-safe rate without
changing the product, which is why it is a named constant with its reasoning
attached.

An **absence of findings is never by itself safe.** A bump with no breaking
change reduces to `no-incompatible-change-in-checked-surfaces` only when the
API surface was genuinely computed and the repository was genuinely searched;
otherwise it reduces to `insufficient-evidence`.

`unsupportedSafe` (truth uncertain, Drift said safe) and `safeButInconclusive`
(truth safe, Drift claimed nothing) are reported separately and never merged
in.

### Repair — one track per production mechanism

Never pooled. They fail for different reasons and need different fixes.

| Track | Mode | What it exercises | Corpus input today |
| --- | --- | --- | --- |
| `repair-codemod` | conditional | tier 1: deterministic, model-free rename codemod | every case |
| `repair-fixplan-cache` | conditional | a cached plan, through the normal revalidation gate | none seeded — needs `--fixplan-cache DIR` |
| `repair-fixplan-recipe` | conditional | a community recipe re-derived in a disposable sandbox | none seeded — needs a recipe candidate |
| `repair-fixplan-model` | conditional | a model authors a *rule*; `validateFixPlan` decides; Drift applies it | cases whose evidence attests the replacement |
| `repair-agent` | conditional | a coding agent through Drift's real `FixAgent` + worktree runner | every case; needs the agent CLI |
| `repair-full-remediation` | **end-to-end** | the complete hierarchy, Drift choosing — **the headline** | every case |

All six are implemented against production paths and all six are covered by
tests. Two of them have no corpus input yet, and that is stated in the table
rather than hidden behind a zero: a cache entry is a plan an *earlier* run
authored and the gate accepted, and a recipe is a third-party package, so
seeding either from nothing would be inventing benchmark evidence. Run without
an input they report `cache-unavailable` / `recipe-unavailable`, which is an
operational non-outcome excluded from every rate — a tier that was never asked
did not decline. The cache track is populated the honest way: point a
`repair-fixplan-model` run at `--fixplan-cache DIR` and the accepted plan is
written there through production's own cache.

A note on what `repair-fixplan-model` can reach. Drift's gate refuses any
replacement name the cited evidence does not state — correctly — so on a case
with no retrievable prose no model-authored plan can ever be accepted, however
right it is. `npm-documented-rename` exists to separate "the mechanism cannot
author a plan" from "the evidence did not support one".

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
not apply, model not configured, no plan cache supplied, no recipe supplied)
leaves both the numerator and the denominator. It is still counted in the
outcome table, so nothing disappears.

### What ground truth says Drift may do

`expectedAction` has four values, not three, because `repair | abstain |
no-repair-needed` could not express the most common honest answer to a real
migration:

| Value | Meaning | A deterministic tier that declines | …that acts |
| --- | --- | --- | --- |
| `deterministic-repair` | the evidence attests the replacement; a rule is derivable | `missed-opportunity` | judged on the oracle |
| `agent-delegation` | no rule is derivable; an agent under approval is right | `correct-abstention` | `unsafe-attempt` |
| `abstain` | nothing automated should touch this | `correct-abstention` | `unsafe-attempt` |
| `no-repair-needed` | nothing is broken | `no-repair-needed` | `unsafe-attempt` |

Under the old enum, a case where no rule was derivable but an agent fix under
review was correct had to be recorded `abstain`, which charged the codemod tier
a missed opportunity for not guessing *and* the full hierarchy an unsafe attempt
for doing exactly what the product is designed to do. Nothing was relaxed by
adding the value: a deterministic mechanism that acts on `agent-delegation`
truth is still an `unsafe-attempt`.

Gold-patch exactness is a **diagnostic** and never a gate — a semantically
correct migration that reads differently is still correct.

### Conditional vs end-to-end

Every artifact carries an `experimentMode`, derived from its track and
exhaustive over the track enum, and anything that pools results filters on that
field rather than on a track name.

- `end-to-end` — `detect-end-to-end` and `repair-full-remediation`. The chain a
  user actually gets. Only these may enter a headline number.
- `conditional` — every standalone mechanism track. A capability ceiling:
  *given* Drift routed the work here, could the mechanism do it? Pooling one
  into an end-to-end figure would report a ceiling as an outcome.
- `ablation` — `detect-known-bump`, which is handed the dependency update
  rather than discovering it. A diagnostic, never a product claim.

---

## Live AI trials

- **Every attempt is retained.** Keeping only the successful trial of three is
  best-of-k with extra steps. The store refuses to overwrite an artifact; a
  repeat must take the next trial index.
- **First-attempt success is the headline.** Reliability across trials is
  reported beside it, never instead of it: "succeeded once in three" and
  "succeeded three times in three" are different products that pass@3 scores
  identically. No best-of-k number is computed at all.
- **Requested and confirmed are different fields.** `model`, `effort`,
  `provider` and `fastMode` are filled only from what the agent itself
  reported; `requestedModel`, `requestedEffort`, `requestedFastMode`,
  `requestedTimeoutSeconds` and `requestedAgentId` record what the run asked
  for. A CLI agent resolves its own model from its own config when the flags
  are absent, so a request written into `model` would attribute a result to a
  model that may never have run it. `unavailable` in a confirmed column means
  the provider did not report it — never that the request was used. Both
  columns are printed side by side.
- **The config the runner receives is built by one helper for both agent
  tracks**, so provenance and execution cannot disagree, and the tests assert
  on the config the production runner was handed rather than on what provenance
  claims.
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
- A review applies only to the exact revision it inspected. Content hashes cover
  the fixture metadata, oracles, consumer, both upstream trees, the gold patch,
  the frozen evidence and the hidden behavioural checks; a stale review's case
  is excluded rather than re-scored.

### Two kinds of staleness, kept apart

- **Prediction evidence.** Every artifact records a content hash of the *whole*
  public capsule — consumer source, `before/`, both upstream trees, frozen
  evidence, lockfiles, `case.yml`. The evaluator recomputes it and refuses to
  re-score a mismatch. An artifact predating the capsule hash records
  `unavailable`, which is treated as stale: not knowing what a trial saw is
  exactly the state this exists to refuse.
- **Truth revision.** Adjudications live outside the capsule, so correcting one
  does **not** stale a prediction — it re-scores it, which is the entire point
  of adjudications being append-only and the evaluator being re-runnable. Each
  result records the adjudication revision it was scored against, and the
  report prints it per case, so a number can always be traced to a truth.

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

npm run eval:cases:reproduce -- --write   # the only command that may promote a case

npm run eval:bench -- run              # deterministic tracks: detect-end-to-end, repair-codemod
npm run eval:bench -- run --tracks repair-agent --trials 3 --agent codex   # live, costs money
npm run eval:bench -- run --tracks repair-fixplan-model --fixplan-cache .cache/fixplans
npm run eval:bench -- run --tracks repair-fixplan-cache --fixplan-cache .cache/fixplans
npm run eval:bench -- evaluate <run-id> [--out FILE]                       # always free, always offline
npm run eval:bench -- runs
```

The two `--fixplan-cache` lines are the intended order and not a convenience:
a cache entry is a plan an earlier run authored and the gate accepted, so the
model run populates the directory through production's own cache and the cache
run then restores from it.

`run` produces artifacts and may cost money. `evaluate` scores artifacts and
never calls anything. Anyone can re-score a paid run after an evaluator fix, and
CI validates the evaluator with zero model calls.

`evaluate` fails only on an **integrity** break — a false-safe, a production
scope escape, an unaudited workspace, or a stale artifact. A missed detection or
a failed repair is a product result; failing CI on one is how a benchmark starts
being tuned away from measuring the product.

---

## Composition and limitations

Current corpus: **5 cases, all synthetic, all npm, one repository, one
dependency, 1 negative/control.** Every report prints this before any number.
No accuracy figure from this corpus is representative of anything, and none is
presented as such.

What the five cover, chosen to exercise the benchmark's own failure modes
rather than only Drift's:

| Case | Shape | Why it is here |
| --- | --- | --- |
| `npm-renamed-export` | direct rename, named import | the mechanical case; a deterministic rule is derivable from the failing binding |
| `npm-member-rename` | rename through a namespace member | the same fact with *no* attesting evidence, so the fix-plan gate must refuse it |
| `npm-documented-rename` | rename with a frozen changelog | the same fact *with* attesting evidence, so the gate may accept it. The only case with adjudicated D0 and D1 |
| `npm-return-value` | runtime behavioural failure, two call sites | typechecks, still breaks; one call site the project's own check never runs |
| `npm-unused-break` | real upstream break, unused locally | the safety control: `correctSafe` has to be reachable, not only `falseSafe` avoidable |

Adversarial coverage that has no case of its own, because it is a property of
the evaluator rather than of a corpus, lives in tests instead: destructive
repair, wrong replacement, semantically valid alternative repair, a case with
no trigger, and an oracle-insufficient exclusion.

- **No historical cases yet.** The miner (`src/corpus/mine-npm.ts`) builds them
  causally from real migration PRs and the reproducibility gate rules on them,
  but the corpus has not been populated. This is the single largest gap, and it
  is why nothing here is a general accuracy claim.
- **One ecosystem.** The schema is ecosystem-neutral; only npm is populated.
- **D0 and D1 are adjudicated on one case of five.** The other reviews predate
  those levels, and only `npm-documented-rename` has a retrievable prose source
  a reviewer could state a D1 expectation from without inventing it. The rest
  report `not-adjudicated`, which contributes to nothing.
- **The fix-plan cache and recipe tracks have no corpus input.** Both are
  implemented against production paths and tested; neither has a seeded input,
  and both report that rather than a zero. See the track table above.
- **Network isolation is configuration, not a sandbox.** Drift's own `fetch` is
  intercepted and the package manager runs with its offline flags set. A
  subprocess — including a coding agent — is not prevented from reaching the
  network by either. No stronger claim is made anywhere in this harness.
- **A live agent must reach its own provider**, so `agent-service-only` is the
  strongest honest policy for an agent trial. An agent that searches for the
  historical PR is not currently prevented, only recorded.
- **Only one AI reviewer so far, and zero human reviewers.** The
  multi-reviewer/disagreement machinery exists and is exercised by several
  cases' supersession history, but not yet by two different reviewers
  disagreeing.
- **Repair tracks run Drift in `mode: auto` with `fixPlans.autoApply: proven`.**
  Both are real production settings and both are stated in the runner. They are
  the weakest settings under which a deterministic tier acts at all: under the
  defaults every plan is proposed for a human and nothing is applied, so no
  repair could be measured. A plan that changes expression structure still
  needs the project's own checks to have passed, which this configuration does
  not enable — so these results understate what a `verified` configuration
  would apply, never overstate it.
- **`repair-fixplan-model` has no partial-coverage case.** Production's
  `minCoverage` gate rejects a plan explaining too little of a finding, and
  `residualImpactSites` counts what a plan left behind, but no case in this
  corpus has enough call sites for a genuinely partial plan to arise.
