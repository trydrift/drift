# BUMP — reproducible breaking dependency updates in Java — run `p9-bump`

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
| Drift commit | `65686d9a777678e2c43e6049b7024f2230e399cc` (working tree dirty) |
| Run date | 2026-09-07T11:20:24.156Z |
| Re-scored | 2026-09-11T16:42:20.022Z at `c9644ed9ba` — metrics recomputed from the recorded per-case results; the observations above are unchanged |
| Command | `/Users/rudy/.nvm/versions/node/v24.20.0/bin/node /private/tmp/claude-501/-Users-rudy-Desktop-Developer-Drift/430aba2d-72ba-44fc-9d6a-07ffdc20243f/scratchpad/wt-bump/eval/src/external/cli.ts bump --run-id p9-bump --concurrency 3 --benchmarks /Users/rudy/Desktop/Developer/Drift/benchmarks` |
| Platform | darwin/x64, Node v24.20.0 |

## Case accounting

Read this before any rate below.

| | Cases |
| --- | --- |
| Available in the dataset | 571 |
| Selected for this run (all) | 571 |
| Scored | 551 |
| Excluded | 20 |
| Negative/control cases among the scored | 0 |

Every exclusion, with its reason:

| Reason | Cases |
| --- | --- |
| `source-unavailable` | 20 |

## Results

| Question | Result | 95% interval |
| --- | --- | --- |
| affected-repository identification rate | 386/551 (70.1%) | 66.2–73.9% |
| consumer localization rate | 282/551 (51.2%) | 47.0–55.2% |
| dependency-update detection rate | 495/551 (89.8%) | 87.3–92.4% |
| false-safe verdicts | 17/551 (3.1%) | 1.8–4.7% |

Intervals are a case-level bootstrap, resampled over cases rather than trials, and are omitted below twenty
cases — an interval from four cases is arithmetically valid and rhetorically dishonest.

### Affected-repository misses by stage

Every scored positive that did not end at `locally-affected`, charged to the one pipeline stage the answer
was lost at. This is where affected-repository recall is going — read it before proposing an engine change,
since it sizes what each stage can recover. Buckets sum to the total; see `impact-funnel.ts` for definitions.

| Stage | Cases |
| --- | ---: |
| `dependency-update-not-detected` | 56 |
| `dependency-import-not-found` | 28 |
| `verification-inconclusive` | 24 |
| `consumer-usage-not-found` | 24 |
| `upstream-surface-unavailable` | 15 |
| `no-breaking-change-derived` | 14 |
| `breaking-change-low-confidence` | 4 |
| **Total** | **165** |

### Failure classes that admit a static signal

BUMP labels each case with why the build broke. `ENFORCER_FAILURE` (Maven build-policy rules) and the
resolution/lock failures have no API-surface change for any static differ to find, so Drift answers
`insufficient-evidence` — the correct answer, indistinguishable from a miss once pooled.

| Stratum | affected-repository identification rate |
| --- | --- |
| Static signal possible (compilation, test, werror) | 315/411 (76.6%) |
| No API-surface delta (enforcer, lock, resolution) | 71/140 (50.7%) |
| Pooled — every case | 386/551 (70.1%) |

The first row is the one that answers "does Drift find the break when a break is findable". The second
measures a limit of static analysis, not of Drift, and only a build can settle those cases. Neither is
omitted, and no case is excluded from the pooled rate to produce them.

### Breakdown

Every rate again, split by the dataset's own label and by the strata the adapter recorded. A pooled figure
hides both directions of the interesting result, so it is never the only number available here.

| Slice | affected-repository identification rate | consumer localization rate | dependency-update detection rate |
| --- | --- | --- | --- |
| label: COMPILATION_FAILURE | 181/220 (82.3%) | 178/220 (80.9%) | 214/220 (97.3%) |
| label: DEPENDENCY_LOCK_FAILURE | 4/14 (28.6%) | 0/14 (0.0%) | 4/14 (28.6%) |
| label: DEPENDENCY_RESOLUTION_FAILURE | 0/5 (0.0%) | 0/5 (0.0%) | 2/5 (40.0%) |
| label: ENFORCER_FAILURE | 67/121 (55.4%) | 8/121 (6.6%) | 104/121 (86.0%) |
| label: TEST_FAILURE | 133/187 (71.1%) | 96/187 (51.3%) | 168/187 (89.8%) |
| label: WERROR_FAILURE | 1/4 (25.0%) | 0/4 (0.0%) | 3/4 (75.0%) |
| stratum: no-api-surface-delta | 71/140 (50.7%) | 8/140 (5.7%) | 110/140 (78.6%) |
| stratum: static-signal-possible | 315/411 (76.6%) | 274/411 (66.7%) | 385/411 (93.7%) |

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
| `python3` | Python 3.12.14 | any Python case |
| `uv` | **not installed** | TimeMachine's documented environment setup |
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
