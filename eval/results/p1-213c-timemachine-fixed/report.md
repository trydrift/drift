# TimeMachine-bench (human-verified subset) — run `p1-213c-timemachine-fixed`

**Given a real Python repository whose historical dependency state no longer resolves or runs, does Drift detect the dependency change and identify the repository as affected?**

What a good result here does *not* establish: No precision and no false-positive rate, for the same reason as swe-bump-bench: the corpus is migration failures, so every case is a positive.

## Provenance

| | |
| --- | --- |
| Dataset | TimeMachine-bench (human-verified subset) |
| Source | https://github.com/tohoku-nlp/timemachine-bench |
| Dataset version | `9928dbf1af1405433d2c2e40227f39fd831d3863` |
| Licence | see the repository |
| Citation | Tohoku NLP, TimeMachine-bench, https://github.com/tohoku-nlp/timemachine-bench |
| Ecosystem | pypi |
| Benchmark class | consumer-impact |
| Drift commit | `a8757c68985ab23e5d8125b54463eaf8decd1052` (working tree dirty) |
| Run date | 2026-09-04T21:05:44.279Z |
| Command | `/Users/rudy/.nvm/versions/node/v24.20.0/bin/node /Users/rudy/Desktop/Developer/Drift/eval/src/external/cli.ts timemachine --run-id p1-213c-timemachine-fixed` |
| Platform | darwin/x64, Node v24.20.0 |

## Case accounting

Read this before any rate below.

| | Cases |
| --- | --- |
| Available in the dataset | 100 |
| Selected for this run (all) | 100 |
| Scored | 69 |
| Excluded | 31 |
| Negative/control cases among the scored | 0 |

Every exclusion, with its reason:

| Reason | Cases |
| --- | --- |
| `reproduction-failed` | 31 |

## Results

| Question | Result | 95% interval |
| --- | --- | --- |
| affected-repository identification rate | 41/69 (59.4%) | 47.8–71.0% |
| consumer localization rate | 41/69 (59.4%) | 47.8–71.0% |
| dependency-update detection rate | 67/69 (97.1%) | 92.8–100.0% |
| false-safe verdicts | 0/69 (0.0%) | 0.0–0.0% |

Intervals are a case-level bootstrap, resampled over cases rather than trials, and are omitted below twenty
cases — an interval from four cases is arithmetically valid and rhetorically dishonest.

### Affected-repository misses by stage

Every scored positive that did not end at `locally-affected`, charged to the one pipeline stage the answer
was lost at. This is where affected-repository recall is going — read it before proposing an engine change,
since it sizes what each stage can recover. Buckets sum to the total; see `impact-funnel.ts` for definitions.

| Stage | Cases |
| --- | ---: |
| `consumer-usage-not-found` | 10 |
| `upstream-surface-unavailable` | 6 |
| `dependency-import-not-found` | 4 |
| `consumer-match-insufficient-confidence` | 3 |
| `breaking-change-low-confidence` | 3 |
| `dependency-update-not-detected` | 2 |
| **Total** | **28** |

### Breakdown

Every rate again, split by the dataset's own label and by the strata the adapter recorded. A pooled figure
hides both directions of the interesting result, so it is never the only number available here.

| Slice | affected-repository identification rate | consumer localization rate | dependency-update detection rate |
| --- | --- | --- | --- |
| label: migration-failure-easy | 22/44 (50.0%) | 22/44 (50.0%) | 42/44 (95.5%) |
| label: migration-failure-hard | 2/2 (100.0%) | 2/2 (100.0%) | 2/2 (100.0%) |
| label: migration-failure-medium | 17/23 (73.9%) | 17/23 (73.9%) | 23/23 (100.0%) |

## What is deliberately not reported

These metrics are not omitted for space. The data cannot support them, and computing them anyway would
produce a number that describes the arithmetic rather than the tool.

| Metric | Why not |
| --- | --- |
| precision | TimeMachine-bench (human-verified subset)'s annotation is not exhaustive at the granularity Drift predicts at (project-build): Human-verified migration failures. Positives only; no non-failing control migrations. |
| F1 | F1 is a harmonic mean of precision and recall, and precision is not defined here. |
| false-positive rate | TimeMachine-bench (human-verified subset)'s annotation is not exhaustive at the granularity Drift predicts at (project-build): Human-verified migration failures. Positives only; no non-failing control migrations. |

## Label mapping coverage

This corpus's vocabulary is not Drift's, so every label carries a mapping and a confidence. Only `exact` and
`compatible` mappings are scored for category correctness; `ambiguous` and `unsupported` ones are counted here
rather than forced into the nearest Drift kind, which would make the resulting accuracy partly a measurement of
how generously the mapping was written.

| Mapping status | Cases |
| --- | --- |
| `compatible` | 100 |

## Ground truth

- Granularity: **project-build**
- Exhaustive at that granularity: **no**
- Basis: Human-verified migration failures. Positives only; no non-failing control migrations.
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
npm run eval:external -- timemachine
```

Every per-case prediction, label and outcome is beside this file:

```sh
gunzip -c cases.jsonl.gz | jq .
```

How the cases were chosen is in `selection.json`. No number above was typed by hand; each is read out of
`metrics.json`, which this file is a rendering of.
