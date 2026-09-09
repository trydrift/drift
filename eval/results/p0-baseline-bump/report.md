# BUMP — reproducible breaking dependency updates in Java — run `p0-baseline-bump`

**Given a real Java project at the commit where a dependency update broke its Maven build, does Drift detect the update and identify the project as affected?**

What a good result here does *not* establish: No precision and no false-positive rate. Every record is a reproduced breaking update; there are no non-breaking control updates in the corpus.

## Provenance

| | |
| --- | --- |
| Dataset | BUMP — reproducible breaking dependency updates in Java |
| Source | https://github.com/chains-project/bump |
| Dataset version | `324d5513aa5ca40b5cb32de5b816a58fa60bd7bb` |
| Licence | see the repository |
| Citation | Frank Reyes et al., "BUMP: A Benchmark of Reproducible Breaking Dependency Updates", arXiv:2401.09906; data at https://github.com/chains-project/bump, archive at DOI 10.5281/zenodo.10041883. |
| Ecosystem | maven |
| Benchmark class | consumer-impact |
| Drift commit | `a8757c68985ab23e5d8125b54463eaf8decd1052` (working tree dirty) |
| Run date | 2026-09-04T23:29:16.287Z |
| Re-scored | 2026-09-04T23:30:16.053Z at `a8757c6898` — metrics recomputed from the recorded per-case results; the observations above are unchanged |
| Command | `/Users/rudy/.nvm/versions/node/v24.20.0/bin/node /Users/rudy/Desktop/Developer/Drift/eval/src/external/cli.ts bump --run-id p0-baseline-bump --resume` |
| Platform | darwin/x64, Node v24.20.0 |

## Case accounting

Read this before any rate below.

| | Cases |
| --- | --- |
| Available in the dataset | 571 |
| Selected for this run (all) | 571 |
| Scored | 414 |
| Excluded | 157 |
| Negative/control cases among the scored | 0 |

Every exclusion, with its reason:

| Reason | Cases |
| --- | --- |
| `reproduction-failed` | 64 |
| `source-unavailable` | 93 |

## Results

| Question | Result | 95% interval |
| --- | --- | --- |
| affected-repository identification rate | 191/414 (46.1%) | 41.5–51.2% |
| consumer localization rate | 135/414 (32.6%) | 28.5–37.4% |
| dependency-update detection rate | 344/414 (83.1%) | 79.5–86.7% |
| false-safe verdicts | 32/414 (7.7%) | 5.1–10.4% |

Intervals are a case-level bootstrap, resampled over cases rather than trials, and are omitted below twenty
cases — an interval from four cases is arithmetically valid and rhetorically dishonest.

### Affected-repository misses by stage

Every scored positive that did not end at `locally-affected`, charged to the one pipeline stage the answer
was lost at. This is where affected-repository recall is going — read it before proposing an engine change,
since it sizes what each stage can recover. Buckets sum to the total; see `impact-funnel.ts` for definitions.

| Stage | Cases |
| --- | ---: |
| `dependency-update-not-detected` | 70 |
| `upstream-surface-unavailable` | 53 |
| `consumer-usage-not-found` | 33 |
| `dependency-import-not-found` | 26 |
| `no-breaking-change-derived` | 22 |
| `breaking-change-low-confidence` | 10 |
| `verification-inconclusive` | 9 |
| **Total** | **223** |

### Breakdown

Every rate again, split by the dataset's own label and by the strata the adapter recorded. A pooled figure
hides both directions of the interesting result, so it is never the only number available here.

| Slice | affected-repository identification rate | consumer localization rate | dependency-update detection rate |
| --- | --- | --- | --- |
| label: COMPILATION_FAILURE | 97/170 (57.1%) | 93/170 (54.7%) | 155/170 (91.2%) |
| label: DEPENDENCY_LOCK_FAILURE | 1/7 (14.3%) | 0/7 (0.0%) | 1/7 (14.3%) |
| label: DEPENDENCY_RESOLUTION_FAILURE | 0/4 (0.0%) | 0/4 (0.0%) | 1/4 (25.0%) |
| label: ENFORCER_FAILURE | 21/85 (24.7%) | 4/85 (4.7%) | 68/85 (80.0%) |
| label: TEST_FAILURE | 71/144 (49.3%) | 38/144 (26.4%) | 116/144 (80.6%) |
| label: WERROR_FAILURE | 1/4 (25.0%) | 0/4 (0.0%) | 3/4 (75.0%) |

## What is deliberately not reported

These metrics are not omitted for space. The data cannot support them, and computing them anyway would
produce a number that describes the arithmetic rather than the tool.

| Metric | Why not |
| --- | --- |
| precision | BUMP — reproducible breaking dependency updates in Java's annotation is not exhaustive at the granularity Drift predicts at (project-build): Each record is one reproduced breaking dependency update with a recorded failure category. Positives only, and no annotation of which consumer source lines the break lands on. |
| F1 | F1 is a harmonic mean of precision and recall, and precision is not defined here. |
| false-positive rate | BUMP — reproducible breaking dependency updates in Java's annotation is not exhaustive at the granularity Drift predicts at (project-build): Each record is one reproduced breaking dependency update with a recorded failure category. Positives only, and no annotation of which consumer source lines the break lands on. |

## Label mapping coverage

This corpus's vocabulary is not Drift's, so every label carries a mapping and a confidence. Only `exact` and
`compatible` mappings are scored for category correctness; `ambiguous` and `unsupported` ones are counted here
rather than forced into the nearest Drift kind, which would make the resulting accuracy partly a measurement of
how generously the mapping was written.

| Mapping status | Cases |
| --- | --- |
| `compatible` | 571 |

## Ground truth

- Granularity: **project-build**
- Exhaustive at that granularity: **no**
- Basis: Each record is one reproduced breaking dependency update with a recorded failure category. Positives only, and no annotation of which consumer source lines the break lands on.
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
npm run eval:external -- bump
```

Every per-case prediction, label and outcome is beside this file:

```sh
gunzip -c cases.jsonl.gz | jq .
```

How the cases were chosen is in `selection.json`. No number above was typed by hand; each is read out of
`metrics.json`, which this file is a rendering of.
