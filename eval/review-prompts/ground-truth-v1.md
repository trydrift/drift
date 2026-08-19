# Ground-truth review prompt — v1

You are reviewing one benchmark fixture to produce a persisted `Review` record
(`eval/src/review.ts`). This is independent ground-truth derivation, not a
check on Drift's output.

## Rule zero

**Do not read `detect-end-to-end`'s or any adapter's prediction before
forming your own conclusion.** If you already know what Drift predicted for
this fixture, note that explicitly in `rationale.uncertainty` — it does not
disqualify the review, but it must be stated, not hidden.

## Steps

1. Read `upstream/old/` in full — every source and manifest file.
2. Read `upstream/new/` in full and diff it against `upstream/old/` by hand.
3. Read the package manifests (`package.json` or equivalent) in both trees —
   note the declared public entry points, `types`/`typings`, `exports`.
4. Read `consumer/` in full.
5. Identify the actual public-API/type/behavioural surface that changed.
   Be exact: a removed export is not automatically a "rename" unless there is
   real evidence (in the fixture's own trees, not your assumption) linking
   the old name to a specific replacement.
6. Determine which files/lines in `consumer/` actually reference the changed
   surface. Distinguish a real, bound usage from a same-name symbol that
   belongs to something else entirely (local shadowing, a different
   dependency, a coincidental match).
7. Explicitly determine what is **not** affected — a symbol that changed but
   is never imported, a consumer file that imports the dependency but never
   touches the changed symbol.
8. Run `fixture.yml`'s `oracles.baseline` and `oracles.broken` commands by
   hand (in a disposable copy — do not edit the checked-in fixture) to
   confirm your understanding is empirically correct, not merely textual.
9. Classify: `nature`, `detectability`, `scope`, `visibility` (see
   `src/confidence/taxonomy.ts` for the vocabulary).
10. State every evidence gap: what you could not establish and why.
11. Decide `groundTruthSafety`: `safe` only if there is truly no relevant
    impact; `unsafe` only if you can point to a specific supporting
    impact/gap/reason; `uncertain` if the evidence itself does not resolve
    the question. A bare assertion of `unsafe` or `safe` with nothing to
    back it will fail `eval:review:validate`'s consistency check.
12. Decide `repair.expectedAction`: `repair` only if a safe, mechanical fix is
    actually determinable from the evidence (not merely plausible-looking).
    `abstain` if the correct action is not determinable without more
    evidence than the fixture provides (e.g., a rename with no linkage
    evidence). `no-repair-needed` if nothing needs to change.
13. If `repair.expectedAction` is `repair`, state `expectedChangedFiles` and,
    if useful, validate/create `expected/gold.patch` — but remember gold-patch
    exactness is a secondary metric (see `eval/README.md`).
14. Write `rationale.summary` (what you concluded and why, in prose a second
    reviewer can check against the evidence), `rationale.findingNotes` (one
    line per finding), and `rationale.uncertainty` (explicit, not omitted —
    "none" is a valid value if genuinely true).
15. Persist the review with `reviewer` fields filled in honestly. Any field
    you cannot determine (e.g. a tool version the environment doesn't expose)
    is written as the literal string `"unavailable"`, never guessed and never
    omitted.

## What this prompt is not

It is not a request to reproduce a specific adapter's output. Two reviewers
using this prompt on the same fixture may legitimately disagree — that is
what `eval/src/cli/reviews.ts` (`npm run eval:reviews`) is for.
