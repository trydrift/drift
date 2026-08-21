# Corpus (Layer A)

Mined candidates and the record of what was rejected. **Nothing here is a
benchmark case.** A candidate becomes one only after the reproducibility gate
(`npm run eval:cases:reproduce`) and independent review have both ruled on it.

```
candidates/   one JSON record per surviving candidate
rejected/     every rejected candidate, with its reason
```

## Why the rejections are kept

A miner that emits only its successes hides its own selection bias. The
rejection histogram is the most informative thing this stage produces, and it
is what tells you whether the corpus that results is representative or an
artifact of the filter.

## Pilot run, 2026-08-19

`eval:corpus:mine sindresorhus/execa TanStack/query --max 3 --since 2023-01-01`
over 200 merged pull requests:

| Outcome | Count |
| --- | --- |
| candidate | 1 |
| `no-manifest-change` | 171 |
| `bump-only-no-adaptation` | 13 |
| `no-version-moved` | 8 |
| `multiple-dependencies-moved` | 7 |

Three things this says, all of which shape what the corpus can become:

1. **The yield is very low.** One candidate per two hundred merged PRs. A
   corpus of a useful size needs mining across many repositories, not deeper
   mining of a few.
2. **`bump-only-no-adaptation` is the second-largest bucket, and those are not
   waste.** Thirteen PRs bumped a dependency and changed no consumer source.
   Each is a candidate *negative/control* case — a real upgrade that genuinely
   broke nothing here — which is exactly what a detection benchmark needs to
   punish false positives, and exactly what synthetic fixtures are worst at
   supplying. They are rejected as *repair* candidates and should be mined
   separately as controls.
3. **The one surviving candidate is not obviously usable.** `execa#1257` bumps
   `xo` (a linter, a devDependency) from `^3.0.2` to `^4.0.0` and touches 34
   source files. A lint-rule migration is a real breaking update and a poor
   test of dependency-breakage *detection*, since nothing about the consumer's
   runtime behaviour changed. It has not been promoted, and would fail the
   causality expectation that the update breaks the consumer's own checks for
   reasons a type or runtime surface can express.

The version ranges (`^3.0.2`) also show why `validateCase` demands exact
resolved versions: what the manifest records is not what was installed, so
promoting a candidate requires resolving the lockfile to the version that
actually ran.
