# Evaluation methodology

The executable benchmark lives in [`eval/`](../../eval/). This page records
where its methodology comes from, and — more usefully — where it deliberately
departs from prior work. [`eval/README.md`](../../eval/README.md) has the
operational detail: layout, commands, and every metric definition.

Nothing on this page quotes another system's reported accuracy as evidence
about Drift. Numbers from other benchmarks appear only where they justify a
*methodological* choice.

---

## What the benchmark has to answer

Four questions, answered separately, because pooling them makes every result
undiagnosable:

1. Does Drift notice the right dependency change?
2. Does it correctly understand and localize the breakage?
3. Given correct information, can each repair mechanism fix it?
4. Does the complete production system — repository diff through selected
   repair tier — actually deliver a valid migration?

Questions 1, 2 and 4 are product results. Question 3 is a capability ceiling,
and its results never enter an end-to-end figure.

---

## Prior work

### BUMP — *Reproducible Breaking Dependency Updates* (arXiv:2401.09906, chains-project/bump)

The reference for what "reproducible" has to mean. BUMP mines Java/Maven
projects for pull requests that change only `pom.xml`, move exactly one
dependency version, and fail CI; reproduces each locally; and freezes the pre-
and post-update states so they run without a network connection.

**Adopted.**

- **The causal definition of a breaking update.** Pre-update state builds; a
  one-dependency update makes it fail; the failure reproduces locally. This is
  the definition `eval/src/oracle/reproducibility.ts` enforces, and it is
  stricter than simply observing a red build.
- **Repetition as a gate, not a formality.** BUMP ran each candidate three
  times, on two platforms, with the network disconnected, and discarded 57 of
  628 for flaky tests or system-configuration dependence. Roughly one
  candidate in eleven looked like a breaking update and was not. A benchmark
  that skips this reports that noise as product accuracy. Three repetitions is
  the minimum here for the same reason.
- **Failure categorisation.** BUMP's compilation / test / dependency-resolution
  / lock categories, minus the Maven-specific enforcer category.
- **Recording the resolved dependency graph, not only the direct bump.** BUMP
  found a median of two *effective* dependency changes per breaking update, and
  transitive ripple in 316 of 571 cases. A case record that names only the
  direct bump cannot later distinguish "Drift missed the direct break" from
  "Drift was defeated by a transitive change it never saw", so `graph.before`,
  `graph.after` and `graph.effectiveChanges` are part of the case schema.

**Adapted.**

- **Docker image pairs → content-pinned Node capsules.** BUMP freezes a pair of
  images per update, at a median 733 MB. That is the right idea and the wrong
  artifact for a Node corpus, where the equivalent frozen state is
  {consumer commit, lockfile, resolved graph, package tarball digests,
  toolchain versions} — orders of magnitude smaller and diffable in review.
  The case schema keeps a `containerDigest` field for ecosystems where an image
  genuinely is the reproducible unit.

**Rejected.**

- **Requiring cross-platform reproduction of every case.** Many real Node
  projects are platform-specific by design. The gate records the platform it
  verified rather than claiming portability it did not test.

### Defects4J (rjust/defects4j)

The origin of the discipline that makes a fault-localization benchmark
meaningful, and it transfers almost directly.

**Adopted.**

- **Trigger tests, generalized.** A Defects4J bug is only a bug if a named test
  fails before the fix and passes after. `analyzeFailToPass` computes the
  equivalent for an upgrade: `broken \ baseline` is the trigger set, and a
  failure already present in baseline is pre-existing consumer breakage that
  can never be credited to a repair.
- **Isolation of the fix from unrelated churn.** Defects4J minimizes patches by
  hand. The miner does the machine-checkable half — separating manifest,
  lockfile, source-migration and unrelated changes — and rejects a candidate
  whose unrelated edits make causal attribution impossible.
- **Explicit environment metadata.** Runtime version, package-manager version,
  platform, architecture, timezone and locale are pinned per case. Timezone and
  locale in particular change test outcomes and are never obvious when they do.
- **Excluding flaky and broken tests rather than scoring them.**

**Rejected.**

- **A single canonical fixed version as the definition of correctness.** A
  developer's migration is *one* valid repair. Gold-patch exactness is recorded
  as a diagnostic and never gates a verdict.

### SWE-bench evaluation methodology

**Adopted.**

- **FAIL_TO_PASS and PASS_TO_PASS as joint requirements.** A repair must clear
  the dependency-induced failures *and* preserve everything that already
  passed. Both are required; neither alone is sufficient.
- **Decoupling generation from evaluation.** Predictions are immutable
  artifacts; the evaluator reads them. This is what lets a paid run be
  re-scored after an evaluator fix, and what makes it structurally impossible
  for an oracle result to influence which attempt is kept.
- **Treating benchmark QA as an ongoing system.** Task-quality problems and
  weak graders distort apparent ability, so case status is an enum with an
  exclusion table rather than a one-time manual cleanup.

### swe-bump-bench (xeol-io/swe-bump-bench)

The closest prior work — real TypeScript repositories, real major bumps — and
the most useful precisely because its evaluator is where this benchmark most
deliberately differs.

**Adopted.**

- **Node-native mining shape.** Select repositories, install, bump one package,
  observe new diagnostics. The prediction/evaluation split, and the per-instance
  prediction artifact, are its design.

**Rejected, explicitly.**

- **`errsAfter.length > errsBefore.length` as the success criterion.** A count
  cannot distinguish a migration from deleting the code that called the changed
  API, and it credits a patch that swaps one real error for a different real
  error. `eval/src/oracle/signature.ts` compares diagnostic *identities*
  instead; its final test pins exactly this case.
- **Keeping a task whose baseline already fails.** Its collector warns about
  pre-existing errors and keeps the task anyway. Here an invalid baseline makes
  every later observation uninterpretable, and the case is recorded
  `invalid-baseline` rather than scored.
- **Resolving versions with `latest` at collection time.** A case pinned to a
  range stops being reproducible the day the registry moves; `validateCase`
  rejects a non-exact version.
- **`tsc` as the only oracle.** See the taxonomy note below.

### bumpgen (xeol-io/bumpgen)

**Adopted as a source of required case content, not as an evaluator design.**
Its plan-graph handles second-order effects, where one migration edit exposes
the next. Its documented limitations — dependence on build errors, blindness to
behavioural change, difficulty with multi-package and structural migrations —
are the categories a corpus must deliberately contain, and its `residualImpactSites`
counterpart here exists so a patch that fixes the first visible error and leaves
the repository broken cannot be scored as a repair.

### DepBench / DepRepair (arXiv:2607.17957)

The closest task to Drift's. Historical migration instances across Maven, npm,
Cargo and PyPI, filtered for causally related source adaptations, with Docker
oracles requiring both a failing unrepaired snapshot and a passing developer
patch.

**Adopted.**

- **Executable pass rate as the primary metric.**
- **Requiring the developer patch to actually pass before the case is usable.**
  A gold patch that does not repair the bump-only state cannot serve as
  evidence of a valid repair; the reproducibility gate checks it.
- **Migration-category stratification** — direct rename, import migration,
  compound, paradigm shift — as a benchmark-only dimension orthogonal to
  Drift's production taxonomy. "Drift repairs mechanical renames well and
  paradigm shifts not at all" is a far more useful sentence than one pooled
  percentage.

**Noted as a warning, not a result.** DepRepair's ablation reports that raw
upstream evidence *reduced* pass rates while structured evidence improved them.
The lesson taken is that "more context" is not automatically better and must be
measured — hence the ablation slot in the artifact schema — not that Drift's
structuring is thereby validated. Drift has not run that ablation.

### UPGRADVISOR (OSDI '22)

**Adopted as a framing.** Its separation of "an upstream change" from "a change
relevant to this application" is exactly Drift's `upstream-only` versus
`affected` distinction, and it is why negative and control cases — a real
upstream break the consumer never calls — are mandatory here rather than
optional. Its hybrid static/dynamic tracing approach is not adopted; Drift's
architecture is different.

### *More Effective JavaScript Breaking Change Detection* (ISSTA 2025) and *Towards Better Comprehension of Breaking Changes in the NPM Ecosystem* (arXiv:2408.14431)

The npm taxonomy work that decides what a Node corpus must cover. Across 1,519
manually curated breaking changes from 131 npm projects, **behavioural changes
account for 68.1%** — changed option handling, changed defaults, changed return
specifications, changed error handling.

This is the single most important number for this benchmark's scope, and it
follows from it that a `tsc`-only oracle measures roughly the *minority* of real
npm breakage. Both swe-bump-bench and bumpgen are type-error-driven by
construction. Drift's behavioural verification exists for the other two thirds,
so the corpus must contain cases that typecheck cleanly and still break, and the
oracle must run the project's own tests rather than only a compiler.

### CI-Repair-Bench

**Adopted as an optional stronger oracle.** Verifying a repair by re-running the
repository's original workflow, rather than a selected command, is strictly
better evidence where the workflow can be reconstructed. The case schema carries
an optional `fullCi` oracle for this; it is opt-in per run because it is slow.

---

## Where this benchmark goes further than its sources

Three properties that none of the systems above enforce.

**Ground truth is physically unreachable from a prediction.** Cases split into
`eval/cases/public/` and `eval/cases/private/`. A prediction adapter receives a
`PublicCase` and a workspace that has been walked and audited — private
artifacts, private-root overlap, and symlinks whose target leaves the workspace
all fail it — and the audit runs on every materialization, not only in a test.
Once a coding agent with shell access runs inside that directory, "the adapter
did not read the answer" has to be a property of the filesystem rather than of a
model's behaviour.

**Every repair mechanism is measured separately, and the mechanism that did the
work is recorded.** Drift's hierarchy is codemod → validated fix plan (cache,
recipe, or model-authored) → coding agent. One pooled repair number cannot
distinguish poor detection, a correct abstention, a bad generated rule, a
correct rule the policy declined, and an agent that timed out — five defects
needing five different fixes. `resolvedByTier` is the difference between "Drift
repaired 8 of 10" and "Drift repaired 8 of 10, six of them deterministically and
free".

**Correct abstention is a first-class good outcome.** A benchmark that scores
only repairs pushes a tool toward guessing, and a wrong automated migration
applied to every call site is worse than no migration at all. `correctDecision`
is reported beside `repairSuccess`, and attempting a repair where adjudicated
truth says abstain is an error *even when the oracle happens to go green*.

---

## Deliberate limitations

Stated here rather than discovered later.

- **Network isolation is configuration, not a sandbox.** `installNpmFetchStub`
  intercepts Drift's own `fetch`, and the package manager runs with its offline
  flags set. A subprocess — including a coding agent — is not prevented from
  reaching the network by either. No stronger claim is made.
- **A live agent must reach its own provider.** The strongest honest network
  policy for an agent trial is `agent-service-only`. Solution retrieval by an
  agent that searches for the historical PR is not currently prevented, only
  recorded.
- **AI reviewers are not a substitute for domain expertise.** They are
  independent, prompted against answering from prior knowledge, and permitted to
  answer `uncertain`. They are not infallible, disagreement is preserved rather
  than resolved by fiat, and a disputed field is excluded from headline metrics.
- **Statistics are refused below the sample size that supports them.** Bootstrap
  intervals return `null` under 20 cases; McNemar returns `null` when too few
  pairs disagree. An interval computed from four cases is arithmetically valid
  and rhetorically dishonest.
