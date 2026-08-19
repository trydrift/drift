# Drift accuracy benchmark

This is a harness-validation / initial benchmark, not yet a general accuracy
claim. It exists to answer, with independently reviewed and adjudicated
evidence, whether Drift correctly detects an upstream breaking change,
correctly identifies which consumer code is affected, doesn't call anything
safe that isn't, correctly decides whether it can safely repair an issue, and
if it repairs, whether the repair actually works. Read the "Limitations"
section before citing any number from here.

## Purpose and what's measured

Every score in this harness answers one of two questions:

1. **Detection/localization** (`drift-full-pipeline`): given only a fixture's
   local `upstream/old` and `upstream/new` trees and its `consumer/` code, did
   Drift's real production pipeline — the same `gatherEvidence` → `analyze` →
   `localize` → `attemptCodemod` → `buildPlan` → `verdictFor` path a `drift
   analyze` run takes — discover the break, find the right (and only the
   right) affected code, and say something honest about safety?
2. **Repair mechanics** (`drift-component-localize-repair`,
   `drift-component-fixplan-application`, described below): given a *known*
   finding, does Drift's repair machinery apply correctly?

These are different questions and are never combined into one number. See
"Full-pipeline vs. component adapters."

## Fixture vs. review vs. adjudication vs. prediction

- **FIXTURE** (`fixture.yml` + `upstream/`/`consumer/` trees): evidence only.
  No expected findings, no repair expectation, no review status live here —
  the Zod schema in `eval/src/load.ts` is `.strict()`, so an `expected:` block
  or similar cannot silently re-enter a fixture file.
- **REVIEW** (`reviews/<review-id>.yml`): one reviewer's independently derived
  opinion of a fixture's ground truth. Append-only — a review file is never
  overwritten once saved (`saveReview` throws if the id already exists).
  Reviewers can be human or AI; an AI review records `reviewer.type: ai`,
  `reviewer.name`, `provider`, `model` honestly, using the literal string
  `"unavailable"` for anything the environment doesn't expose — never a
  guess.
- **ADJUDICATION** (`adjudication.yml`): the currently accepted ground truth,
  referencing the review id(s) it accepts. Scoring reads *only*
  `adjudication.yml`, never a review directly and never fixture metadata.
- **PREDICTION**: what an adapter (`drift-full-pipeline` or a component
  adapter) actually produced for a fixture, in-memory for one run. Never
  written back into ground truth.

A Drift prediction can inform a reviewer's thinking, but it can never become
accepted truth by itself — a review or adjudication is required, and
`eval:review:validate` fails a `readiness: benchmark-ready` fixture that has
no accepted adjudication.

## AI reviewers, human reviewers, multiple reviews, second opinions

This repository's reviews so far are authored by Claude (Sonnet 5, Anthropic)
— recorded honestly as such, not as any other tool's name. Human review,
additional AI reviewers, and multiple independent reviews of the same fixture
are all first-class: `reviews/` is a directory, not a single file, and
`npm run eval:reviews -- <fixture-id>` shows every review's reviewer identity,
status, staleness, and where reviews disagree (upstream findings, impact
sites, taxonomy, gaps, expected repair action, expected changed files).
Nothing about the newest review is automatically authoritative — only
`adjudication.yml`'s `acceptedReviewIds` decides what counts, and changing
that requires an explicit adjudication update, not deleting the review it
used to point at.

To get a second opinion, export a fixture's full context (fixture metadata,
upstream/consumer evidence, hashes, every review, the adjudication, and a
disagreement summary — no hidden chain-of-thought, only persisted evidence
and rationale) with:

```sh
npm run eval:review:export -- <fixture-id>
```

## Stale review detection

A review only applies to the exact fixture revision it inspected.
`eval/src/hash.ts` computes stable SHA-256 hashes (sorted paths, no
timestamps) over six components: fixture metadata (`fixture.yml` minus the
`readiness` field, which is a workflow marker, not evidence), `upstream/old`,
`upstream/new`, `consumer`, the `oracles` section, and `expected/gold.patch`.
A review's `reviewedRevision` snapshots these at review time.
`eval:review:validate` fails a `benchmark-ready` fixture whose accepted
review's hashes don't match the fixture's current hashes — the fixture must
be re-reviewed, and the stale review stays on disk, inspectable, superseded
rather than deleted.

## Changing accepted ground truth

Write a **new** review file (never edit an existing one), set its `reviewOf`
to the review(s) it reconsiders, and update `adjudication.yml`'s
`acceptedReviewIds` and `decision` to match. The superseded review remains on
disk with its original `status`. If a fixture's own evidence changed, its old
review becomes stale automatically (see above) and needs a fresh review
regardless of whether the reviewer's opinion actually changed.

## Adjudication cannot silently contradict its accepted review(s)

`adjudication.yml`'s `decision` must equal its single accepted review's
`conclusion`, after canonical (order-insensitive on set-shaped fields;
`repair.expectedAction`/`repair.goldPatch` compared exactly) normalization —
see `diffConclusions`/`sameTaxonomy` in `eval/src/review.ts`. When it
legitimately differs, the adjudication must say so explicitly:

- **One accepted review**: an `override` block (`enabled: true`, `reason`,
  `changedFields`) is required, and `changedFields` must name exactly the
  fields that actually differ — no missing field (an unexplained delta) and
  no extra field (a stale or inaccurate justification).
- **Multiple accepted reviews**: adjudication may synthesize between
  genuinely disagreeing reviews, but a `synthesis` block (`reason`,
  `changedFields`) is required whenever `decision` differs from *any* one of
  them, naming the union of every field that differs from at least one.

`eval:review:validate` enforces this (`validateAdjudicationConsistency`) and
fails a `benchmark-ready` fixture that violates it.
`npm run eval:reviews -- <fixture-id>` shows whether the current adjudication
exactly matches its accepted review(s) and, if not, the changed fields and
override/synthesis reason (`--json` includes a structured
`adjudicationDelta`). `npm run eval:review:export -- <fixture-id>` includes
the same delta in its packet, plus per-review stale/current status, so it can
be handed to another AI or human and asked "does this adjudication fairly
reflect the accepted review evidence?"

## Full-pipeline vs. component adapters

- **`drift-full-pipeline`** (`eval/src/adapters/full-pipeline.ts`) is the
  headline, authoritative adapter. It never reads `fixture.yml`'s
  `scenarioLabel` or any review/adjudication content. It substitutes only
  *transport*: `installNpmFetchStub` serves the fixture's own
  `upstream/old`/`upstream/new` trees as jsDelivr responses (the same pattern
  `test/scan-rows.test.ts` already uses in production tests), so
  `fetchTypeSurface`/`extractExports`/`diffSurfaces` genuinely parse and diff
  real `.d.ts` files; `localPackageEnvironment` points behavioural
  verification at local package directories instead of a registry install.
  Any host other than the two jsDelivr hosts throws rather than silently
  reaching the real network, enforcing `network: disabled`.
  It only credits deterministic, model-free repair (`attemptCodemod`, tier
  1). Model-authored fix-plan generation (tier 2c) and coding-agent repair
  (tier 3) are never invoked here, so no paid model call happens in
  deterministic CI.
- **`drift-component-localize-repair`** (formerly `drift-structured-fixture`)
  reads `scenarioLabel` directly to construct a *known* `BreakingChange` (and,
  where the built-in codemod can't handle it, a *known*, hand-authored
  `FixPlan`), then tests only localization and repair application. It never
  contributes to headline detection metrics, and its abstention/repair-action
  scoring is intentionally skipped (see `score.ts`'s `policyScoped` flag) —
  it always attempts repair by design, because its entire purpose is testing
  whether repair *application* succeeds given a known finding, not whether
  Drift should have acted automatically. It only supports rename-shaped
  fixtures (`renamed-export`, `member-rename`); it is skipped for any other
  `scenarioLabel`.
- A distinct `drift-component-fixplan-application` adapter — narrower still,
  application only, given an already-*validated* recorded fix plan — was
  scoped in the original plan but not split into its own file in this pass;
  `npm-member-rename`'s repair today already exercises exactly that path
  (a hand-authored, non-generated `FixPlan` applied via `applyCommitFixPlan`)
  inside `drift-component-localize-repair`. Splitting it out is a clean,
  low-risk follow-up, not a methodology gap.

**Detection F1 in the public headline is `drift-full-pipeline`'s only.**
Component-adapter numbers are reported in a clearly separate section and must
never be quoted as detection accuracy.

## Baseline / broken / repaired oracles

Every repair-bearing fixture declares three oracle stages in `fixture.yml`,
each with a `command` and an `expect: pass | fail`:

- **baseline** — old dependency + original consumer. Normally `pass`.
- **broken** — new dependency + original consumer, unmodified. Normally
  `fail`; a "safe upgrade" fixture (e.g. `npm-unused-break`) may legitimately
  set `expect: pass` here, because the point of that fixture is that the
  upgrade genuinely doesn't break that particular consumer.
- **repaired** — new dependency + Drift's repaired consumer. Normally `pass`,
  and only run when a repair was actually attempted.

Each stage's observed result is `pass | fail | unable-to-run` —
`unable-to-run` (e.g. `npm install` itself failed) is an infrastructure
failure, never scored as a product success or failure. A fixture whose
*broken* stage already passes untouched can never be credited with a
successful repair merely because *repaired* also passes — `successfulRepair`
in `eval/src/score.ts` requires baseline and broken to have matched their own
expectations too.

## Detection metrics: micro and macro, raw counts

Every report shows raw TP/FP/FN before any derived ratio. **Micro** sums
confusion counts across every scored fixture for an adapter, then computes one
precision/recall/F1 — the standard corpus-level aggregate, and immune to
empty-set inflation because a fixture with nothing expected and nothing
predicted contributes 0/0/0, changing neither the numerator nor the
denominator. **Macro** averages each fixture's own precision/recall/F1, but
excludes a fixture where *both* expected and actual were empty from that
mean — including it would silently score "made no claim" as a perfect
positive detection, which is exactly the empty-set-precision trap this
harness must not fall into (see `aggregateDetection` in `eval/src/score.ts`
and its accompanying tests). A fixture with an empty expected set and a
*non-empty* actual set — a false positive on a negative/control fixture —
is never excluded; it correctly drags macro precision down.

All scoring is per-fixture first (`scoreFixture`), then aggregated
(`aggregateAdapter`) — finding and impact-site ids are internally namespaced
by fixture id before comparison, so identical ids in two different fixtures
can never satisfy each other.

## False-safe, precisely

`falseSafe` requires two things: the accepted adjudication's
`groundTruthSafety` is **`unsafe`** (a reviewed, evidence-backed claim, not a
default), and Drift's real user-facing verdict
(`verdictFor`'s `FindingVerdict`, captured directly by `drift-full-pipeline`)
is safe-equivalent — only `no-incompatible-change-in-checked-surfaces` and
`clean` count as safe-equivalent. Every other real verdict string
(`insufficient-evidence`, `verification-incomplete`,
`detected-not-locally-reachable`, `unchecked`, `verification-failed`,
`upstream-only`) is deliberately never treated as "Drift said safe" — an
unverified or inconclusive result is not a safe claim.

A second, distinct signal, `unsupportedSafe`, fires when `groundTruthSafety`
is `uncertain` (the benchmark itself couldn't resolve the question) and Drift
still claimed a safe-equivalent verdict. This is a bad product outcome and is
reported separately — it is never merged into the `falseSafe` count, because
calling it a factual false-safe would overstate what the benchmark actually
established. CI fails unconditionally on any `falseSafe === true` on a
`benchmark-ready` fixture; it does not fail on `unsupportedSafe` alone.

## Repair metrics

`correctAbstention`, `incorrectRepairAttempt`, `missedRepairOpportunity`, and
`successfulRepair` are computed from the adjudicated `expectedAction`
(`repair | abstain | no-repair-needed`) crossed with what was actually
attempted and observed — never conflated with plain oracle pass/fail (an
expected abstention is not "the repair oracle passed", it is "nothing was
attempted and nothing should have been"). Regression failures are classified
into `repair-failed-to-fix`, `repair-introduced-regression`, or
`oracle-unavailable`, not lumped into one boolean. Gold-patch exact match is
reported but is explicitly **secondary**: a semantically correct repair that
passes the repaired oracle, introduces no regression, and only touches
in-scope files must not fail merely because its diff text differs from the
checked-in `expected/gold.patch`.

### Production scope escape vs. ground-truth unexpected changed file

Every deterministic repair adapter (`eval/src/adapters/repair-capture.ts`)
captures the real before/after content of every file it touches — never a
hard-coded empty list — and reports two distinct things, never conflated:

- **`repairScopeEscapeFiles`** (aggregated as `productionScopeEscapeCount`) —
  a file the repair changed that falls *outside* the union of the repairable
  commits' own `allowedFiles`. This is Drift's own plan disobeying its own
  declared scope: a hard production-safety failure, and CI-blocking whenever
  it is non-zero (`eval/src/run.ts`).
- **`changedFiles`**'s FP count (aggregated as `unexpectedChangedFileCount`)
  — a file the repair changed that *was* within its own allowed scope, but
  that the adjudicated `repair.expectedChangedFiles` did not expect. This is
  a benchmark-quality signal (ground truth may be incomplete, or the repair
  may be doing something the benchmark didn't anticipate), reported clearly
  but never CI-blocking on its own.

A file can be both, if it lies outside both `allowedFiles` and
`expectedChangedFiles` — the two counts are not mutually exclusive. Changed-
file precision/recall/F1 is always scored against adjudicated
`expectedChangedFiles`, never against `allowedFiles` — `allowedFiles` is
Drift's own production safety boundary, not benchmark ground truth.

Gold-patch exactness is tri-state, not boolean: `repairGoldPatchExact` is
`'not-applicable'` (never `false`) when no repair was attempted or the
accepted adjudication names no gold patch, and only `true`/`false` when an
actual comparison ran — the real captured patch, normalized (blob-hash
`index` lines and hunk line-number ranges stripped, `+`/`-` content
untouched), against the checked-in gold patch, normalized the same way.

## Abstention

See "Repair metrics" above — abstention correctness is scored only for
`drift-full-pipeline`; see "Full-pipeline vs. component adapters" for why a
component adapter's designed-in repair attempt is not scored against the same
policy.

## Deterministic CI, and where model/agent runs would live

`npm run eval:deterministic` and `npm test`/`npm run eval:test` make no paid
model API calls — `drift-full-pipeline` only exercises tier-1 deterministic
repair. `ci.yml` fails on harness-integrity problems only: an
`eval:review:validate` failure, any `falseSafe === true` on a benchmark-ready
fixture, or a real production scope escape (see "Production scope escape vs.
ground-truth unexpected changed file" above) — never merely an unexpected-
changed-file benchmark-quality signal. It does **not** fail merely because
Drift missed a detection or a
repair on a hard fixture, or produced an `unsupportedSafe` outcome — those are
reportable product-accuracy metrics, not integrity breaks, and hiding a
genuine miss behind a CI failure would defeat the point of a benchmark.

A future model-authored fix-plan or coding-agent benchmark should record
provenance per run — fixture id, fixture hash, repository commit, provider,
model/tool, exact version where available, prompt version, prompt hash, run
timestamp, patch/result, cost, latency, review status — and replay from those
cached, reviewed artifacts in normal CI; live paid calls stay outside
`eval:deterministic`.

## Audit records

`npm run eval:accuracy:audit -- --record` writes one file per run under
`eval/reports/audits/<commit>-<fixtureSetHash>-<scoringVersion>.json` (+
`.md`), including commit, branch, dirty status, per-fixture hashes, accepted
review ids, adjudication hashes, scoring version, adapter versions, command,
timestamp, environment, and the full metrics. It refuses to silently
overwrite an existing record for the same key if its metrics materially
differ. Plain `npm run eval:deterministic` (no `--record`) writes nothing
git-tracked, so an ordinary CI run never dirties the tree — the previous
append-only `accuracy-audit.md` did, on every single run.

## Current benchmark composition

Every report's "Benchmark composition" section states this at run time, but
as of this PR: **4 fixtures, all synthetic, all npm, all AI-reviewed (Claude),
zero human-reviewed, one multi-reviewed** (`npm-return-value` has two
superseding reviews from a genuine self-correction — see its `reviews/`
directory), **zero historical fixtures, zero disputed fixtures**. This is a
small, honest, still-mostly-synthetic suite. Do not read any F1 number here
as a general accuracy claim about Drift.

### Fixtures

- `npm-renamed-export` — a straightforward export rename; consumer is broken
  against the new version.
- `npm-member-rename` — the same rename pattern, reached through a namespace
  import; ground truth's `expectedAction` is `abstain` (not `repair`) because
  nothing in the evidence available to an automated tool, absent a
  changelog/migration guide this synthetic package cannot legitimately
  provide under `network: disabled`, actually links the old name to the new
  one — see its `reviews/` rationale for the full argument.
- `npm-return-value` — a genuine return-shape breaking change, corroborated by
  both a real `.d.ts` diff and a real behavioural probe; ground truth expects
  abstention (no deterministic tier can safely guess what the caller wants
  from the new shape).
- `npm-unused-break` — **negative/control fixture**: a real upstream breaking
  change (`removedFn` removed) that the consumer never references. Ground
  truth is `groundTruthSafety: safe`, zero impact sites, `expectedAction:
  no-repair-needed`, and `broken.expect: pass` (a "safe upgrade" variant).

### Why the two rename fixtures show as detection misses today

`drift-full-pipeline`'s real evidence-gathering for a synthetic local npm
package has no source of prose (migration guide/changelog) linking an old
name to a new one — a real GitHub repository would supply that; a fixture
under `network: disabled` cannot without fabricating a fake fetchable GitHub
repo, which would just relocate the leaked answer rather than remove it. So
the real `analyze()` classifies the surface diff conservatively as
`removed-export`, not `renamed-export`, and the built-in codemod (which only
fires on `kind === 'renamed-export'`) correctly declines to guess. Ground
truth records the true fact (`renamed-export`, confirmed by identical
function bodies across old/new) — so this shows up as a genuine, honest
detection-granularity gap, not a bug in the harness or the review. This is
exactly the kind of finding the benchmark is designed to surface rather than
hide, and it argues for adding a fixture with real changelog/migration-guide
evidence (fixture-local, e.g. a `CHANGELOG.md` the consumer repo itself ships)
as a clean next step.

## Limitations

- Four fixtures, one ecosystem (npm), all synthetic. No historical
  real-world migration cases yet.
- Only one negative/control fixture exists; `npm-optional-parameter-added`,
  a local-symbol-shadowing case, and an ambiguous-migration abstention case
  (beyond `npm-member-rename`, which already covers one abstention shape)
  are the natural next additions.
- Only one AI reviewer (Claude) and zero human reviewers so far — the
  multi-reviewer/disagreement tooling (`eval:reviews`) is exercised by
  `npm-return-value`'s two-review history, but not yet by an actual
  disagreement between two different reviewers.
- `drift-component-fixplan-application` is not yet split into its own
  adapter file (see "Full-pipeline vs. component adapters").
- Network policy enforcement is best-effort: `installNpmFetchStub` throws on
  any unexpected host, but this is application-level interception of
  `globalThis.fetch`, not OS-level sandboxing — a determined subprocess could
  still reach the network. No claim of stronger isolation is made.

## Plan for historical fixtures

`fixture.yml`'s `provenance.kind: historical` is already a supported value.
A historical fixture's `source.repository` should point at the real upstream
repository, and its provenance/review evidence should reference the old/new
tags or commits, the consumer repository and its before/after commits, and
the real migration PR or release notes where available — captured once,
locally, so re-running the benchmark stays deterministic and offline. None
are added in this PR; adding a first real historical case (e.g. a well-known
npm major-version migration with a public migration guide) is the natural
next step once this architecture has been used for a second review cycle.

## Adding a fixture

1. Create `eval/fixtures/<id>/` with `fixture.yml`, `upstream/old/`,
   `upstream/new/`, `consumer/`, and (if a repair is expected)
   `expected/gold.patch`.
2. Set `readiness: draft` until it has an accepted adjudication.
3. Follow `eval/review-prompts/ground-truth-v1.md` to write an independent
   review — do not inspect any adapter's prediction first.
4. `npm run eval:review:validate` to confirm the review/adjudication are
   consistent, then flip `readiness` to `benchmark-ready`.

## Reproduce

```sh
npm run build
npm test
npm run eval:test
npm run eval:review:validate
npm run eval:deterministic
npm run eval:accuracy:audit -- --record
```
