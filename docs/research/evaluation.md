# Evaluation

The executable benchmark harness lives in `eval/`. This page is a concise
research-methodology summary; see [`eval/README.md`](../../eval/README.md)
for full operational detail (adding a fixture, CLI commands, every metric
definition).

## Ground truth: review + adjudication, not the fixture

A **fixture** (`eval/fixtures/<id>/fixture.yml` plus its `upstream/old`,
`upstream/new`, and `consumer/` trees) is evidence only — a scenario to
inspect, never a claim about the right answer. It has no expected findings,
no repair expectation, and no review-status field; the fixture schema is
`.strict()`, so ground truth cannot silently re-enter it.

Ground truth instead lives in two append-only, provenance-tracked record
types:

- A **review** (`reviews/<review-id>.yml`) is one reviewer's independently
  derived conclusion about a fixture's evidence — human or AI, recorded
  honestly (an AI review names its provider/model, or the literal string
  `"unavailable"`, never a guess). Reviews are never edited or deleted, only
  superseded by a new review that reconsiders one.
- An **adjudication** (`adjudication.yml`) is the currently accepted truth,
  referencing the review(s) it accepts. Scoring reads only the adjudication,
  never a review or the fixture's own metadata directly.

An adjudication cannot silently contradict the review(s) it claims to accept:
when its decision differs from a single accepted review, or from any of
several accepted reviews, that difference must be named in explicit
`override`/`synthesis` metadata, machine-checked by `eval:review:validate`.
A review only applies to the exact fixture revision it inspected — stale
reviews (fixture evidence changed since review time) are detected by content
hash and excluded from scoring.

## What gets measured

- **`drift-full-pipeline`**: the headline detection/repair benchmark. Runs
  Drift's real production analysis path (`gatherEvidence` → `analyze` →
  `localize` → `attemptCodemod` → `buildPlan` → `verdictFor`) against a
  fixture's local trees, substituting only network transport. This is the
  only adapter whose numbers are ever called "detection accuracy."
- **Component adapters** (e.g. `drift-component-localize-repair`): given a
  *known* finding, do localization and repair application work? Never
  detection, never combined with the full-pipeline number.

Every fixture is scored with baseline/broken/repaired oracle stages — a
disposable copy of the consumer run against the old dependency (expected to
pass), the new dependency unmodified (expected to fail, proving the break is
real), and the new dependency with Drift's repair applied. A repair is never
credited as successful merely because the repaired stage passes; baseline and
broken must also have matched their own expectations.

## Metrics reported

Raw TP/FP/FN always precede any derived ratio, both micro (summed across all
fixtures) and macro (averaged per fixture, excluding a fixture where both
expected and actual were empty — never where only actual is empty). No
opaque, single headline score is reported.

- **`falseSafe`**: accepted ground truth is `unsafe` and Drift's real
  user-facing verdict was safe-equivalent. CI-blocking, unconditionally.
- **`unsupportedSafe`**: accepted ground truth is `uncertain` and Drift
  claimed safe-equivalent — a bad outcome, reported separately, never merged
  into `falseSafe`.
- **Repair funnel**: expected repair → attempted → succeeded/failed; expected
  abstain → correctly abstained / incorrectly attempted. Regressions are
  classified (`repair-failed-to-fix`, `repair-introduced-regression`,
  `oracle-unavailable`), not lumped into one boolean.
- **Production scope escape vs. unexpected changed file** — two distinct
  signals, never conflated. A *production scope escape* is a file Drift's
  repair changed outside its own plan's declared `allowedFiles`: a hard
  safety failure, CI-blocking. An *unexpected changed file* is a file changed
  within that allowed scope but not expected by adjudicated
  `expectedChangedFiles`: a benchmark-quality signal, reported but not
  CI-blocking. Changed-file precision/recall/F1 is always scored against
  adjudicated `expectedChangedFiles`, never against `allowedFiles`.
- **Gold-patch exactness** is a secondary diagnostic, tri-state
  (`true | false | 'not-applicable'`) rather than boolean — `'not-applicable'`
  when no repair was attempted or no gold patch exists, never `false` for "we
  did not compare." A semantically correct, non-exact repair still counts as
  a successful repair.

## Deterministic CI, and where model-backed runs would live

`npm run eval:deterministic` and `npm run eval:test` make no paid model API
calls — `drift-full-pipeline` only exercises deterministic, model-free
repair. CI fails only on harness-integrity problems: `eval:review:validate`
failing, `falseSafe === true` on a benchmark-ready fixture, or a production
scope escape. It does not fail merely because Drift missed a detection or a
repair on a hard fixture — those are reportable accuracy results, not
integrity breaks. `npm run eval:accuracy:audit -- --record` writes one
provenance-carrying record per run under `eval/reports/audits/` (commit,
fixture hashes, accepted review ids, scoring version, full metrics); a plain
`eval:deterministic` run writes nothing git-tracked. A future model-backed or
coding-agent adapter would cache its output with the same provenance fields
and replay from that cache in ordinary CI, keeping live paid calls out of it
entirely.

## Scope and limitations

The current suite is small (four synthetic npm fixtures, all AI-reviewed) and
exists to validate the harness architecture itself, not to support a general
accuracy claim. It is not evidence about Drift's real-world accuracy across
ecosystems, change types, or codebase sizes. Recent related work (e.g.
DepRepair, SemaDiff) is useful context where cited, but any preprint numbers
are not Drift's own claims; a Drift claim requires the fixture revision,
adapter version, command, cached run provenance, and scoring version behind
it.
