# swe-bump-bench — run `p0-baseline-swe-bump`

**Given a real TypeScript project at a real commit and a dependency upgrade known to break its build, does Drift detect the update, decide the repository is affected, localize the code, and avoid telling the developer it is safe?**

What a good result here does *not* establish: No precision and no false-positive rate. Every task in this corpus is a known-breaking upgrade, so there is no negative population to compute one over; a tool that answered "affected" unconditionally would score identically on the questions this corpus can answer.

## Provenance

| | |
| --- | --- |
| Dataset | swe-bump-bench |
| Source | https://github.com/xeol-io/swe-bump-bench |
| Dataset version | `d4504129fd9b536ad5aca2e74f35f5d51e3362e4` |
| Licence | see the repository |
| Citation | xeol-io, swe-bump-bench, https://github.com/xeol-io/swe-bump-bench |
| Ecosystem | npm |
| Benchmark class | consumer-impact |
| Drift commit | `a8757c68985ab23e5d8125b54463eaf8decd1052` (working tree dirty) |
| Run date | 2026-09-04T08:35:25.547Z |
| Command | `/Users/rudy/.nvm/versions/node/v24.20.0/bin/node /Users/rudy/Desktop/Developer/Drift/eval/src/external/cli.ts swe-bump --run-id p0-baseline-swe-bump` |
| Platform | darwin/x64, Node v24.20.0 |

## Case accounting

Read this before any rate below.

| | Cases |
| --- | --- |
| Available in the dataset | 63 |
| Selected for this run (all) | 63 |
| Scored | 49 |
| Excluded | 14 |
| Negative/control cases among the scored | 0 |

Every exclusion, with its reason:

| Reason | Cases |
| --- | --- |
| `reproduction-failed` | 12 |
| `source-unavailable` | 2 |

## Results

### Adjudication coverage

Unadjudicated cases remain in the corpus and artifacts, but do not enter the metric denominator.

| Question | Adjudicated | Not adjudicated |
| --- | ---: | ---: |
| affected-repository identification rate | 45 | 4 |
| consumer localization rate | 45 | 4 |
| dependency-update detection rate | 45 | 4 |
| false-safe verdicts | 45 | 4 |

Reasons:

- affected-repository identification rate: 4 — the corpus supplies a manifest range and Drift could not resolve it to a concrete before/after version pair
- consumer localization rate: 4 — the corpus supplies a manifest range and Drift could not resolve it to a concrete before/after version pair
- dependency-update detection rate: 4 — the corpus supplies a manifest range and Drift could not resolve it to a concrete before/after version pair
- false-safe verdicts: 4 — the corpus supplies a manifest range and Drift could not resolve it to a concrete before/after version pair

| Question | Result | 95% interval |
| --- | --- | --- |
| affected-repository identification rate | 30/45 (66.7%) | 51.1–80.0% |
| consumer localization rate | 30/45 (66.7%) | 53.3–80.0% |
| dependency-update detection rate | 45/45 (100.0%) | 100.0–100.0% |
| false-safe verdicts | 0/45 (0.0%) | 0.0–0.0% |

Intervals are a case-level bootstrap, resampled over cases rather than trials, and are omitted below twenty
cases — an interval from four cases is arithmetically valid and rhetorically dishonest.

### Affected-repository misses by stage

Every scored positive that did not end at `locally-affected`, charged to the one pipeline stage the answer
was lost at. This is where affected-repository recall is going — read it before proposing an engine change,
since it sizes what each stage can recover. Buckets sum to the total; see `impact-funnel.ts` for definitions.

| Stage | Cases |
| --- | ---: |
| `consumer-usage-not-found` | 6 |
| `verification-inconclusive` | 5 |
| `upstream-surface-unavailable` | 4 |
| `dependency-update-not-detected` | 4 |
| **Total** | **19** |

### Breakdown

Every rate again, split by the dataset's own label and by the strata the adapter recorded. A pooled figure
hides both directions of the interesting result, so it is never the only number available here.

| Slice | affected-repository identification rate | consumer localization rate | dependency-update detection rate |
| --- | --- | --- | --- |
| exactVersionAdjudicated: true | 30/45 (66.7%) | 30/45 (66.7%) | 45/45 (100.0%) |
| label: known-breaking-upgrade | 30/45 (66.7%) | 30/45 (66.7%) | 45/45 (100.0%) |
| versionToIsRange: false | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) |
| versionToIsRange: true | 27/42 (64.3%) | 27/42 (64.3%) | 42/42 (100.0%) |

## What is deliberately not reported

These metrics are not omitted for space. The data cannot support them, and computing them anyway would
produce a number that describes the arithmetic rather than the tool.

| Metric | Why not |
| --- | --- |
| precision | swe-bump-bench's annotation is not exhaustive at the granularity Drift predicts at (project-build): Each task is a known-breaking dependency bump whose build oracle fails. Positives only: there are no non-breaking control upgrades, and no symbol-level annotation of what changed. |
| F1 | F1 is a harmonic mean of precision and recall, and precision is not defined here. |
| false-positive rate | swe-bump-bench's annotation is not exhaustive at the granularity Drift predicts at (project-build): Each task is a known-breaking dependency bump whose build oracle fails. Positives only: there are no non-breaking control upgrades, and no symbol-level annotation of what changed. |

## Label mapping coverage

This corpus's vocabulary is not Drift's, so every label carries a mapping and a confidence. Only `exact` and
`compatible` mappings are scored for category correctness; `ambiguous` and `unsupported` ones are counted here
rather than forced into the nearest Drift kind, which would make the resulting accuracy partly a measurement of
how generously the mapping was written.

| Mapping status | Cases |
| --- | --- |
| `exact` | 63 |

## Ground truth

- Granularity: **project-build**
- Exhaustive at that granularity: **no**
- Basis: Each task is a known-breaking dependency bump whose build oracle fails. Positives only: there are no non-breaking control upgrades, and no symbol-level annotation of what changed.
- Metrics this annotation can support: recall, repair-success, false-safe-count

## Environment

| Tool | Version | Needed for |
| --- | --- | --- |
| `node` | v24.20.0 | every npm/TypeScript case, and Drift itself |
| `npm` | 11.12.1 | installing a TypeScript consumer before its build oracle can run |
| `git` | git version 2.50.1 (Apple Git-155) | checking out an original repository at the exact evaluated commit |
| `java` | openjdk version "19" 2022-09-20 | any Java case |
| `mvn` | Apache Maven 3.9.9 (8e8579a9e76f7d015ee5ec7bfcdc97d260186937) | BUMP's Maven oracle, and building Roseau from its replication kit |
| `docker` | Docker version 29.7.2, build a7dcaa6 | BUMP's published pre/breaking images and TimeMachine's date-filtered PyPI infrastructure |
| `python3` | Python 3.14.3 | any Python case |
| `uv` | uv 0.12.9 (9f9286029 2026-09-01 x86_64-apple-darwin) | TimeMachine's documented environment setup |
| `japicmp` | installed (version unknown) | Drift's Java API-surface diff, which its maven capability declares it requires |

## Reproduction

```sh
npm run eval:external -- swe-bump
```

Every per-case prediction, label and outcome is beside this file:

```sh
gunzip -c cases.jsonl.gz | jq .
```

How the cases were chosen is in `selection.json`. No number above was typed by hand; each is read out of
`metrics.json`, which this file is a rendering of.
