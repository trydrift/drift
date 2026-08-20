# BUMP — reproducible breaking dependency updates in Java — run `bump-subset-40`

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
| Drift commit | `f887b6fee92e04f2714d5f009f95cf3267e15036` (working tree dirty) |
| Run date | 2026-08-20T05:19:55.347Z |
| Re-scored | 2026-08-20T14:16:26.734Z at `42be074db9` — metrics recomputed from the recorded per-case results; the observations above are unchanged |
| Command | `/Users/rudy/.nvm/versions/node/v22.22.0/bin/node /Users/rudy/Desktop/Developer/Drift/eval/src/external/cli.ts bump --limit 40 --seed 20260819 --run-id bump-subset-40` |
| Platform | darwin/x64, Node v22.22.0 |

## Case accounting

Read this before any rate below.

| | Cases |
| --- | --- |
| Available in the dataset | 571 |
| Selected for this run (stratified-sample, limit 40, seed 20260819) | 40 |
| Scored | 39 |
| Excluded | 1 |
| Negative/control cases among the scored | 0 |

Every exclusion, with its reason:

| Reason | Cases |
| --- | --- |
| `source-unavailable` | 1 |

## Results

| Question | Result | 95% interval |
| --- | --- | --- |
| affected-repository identification rate | 7/39 (17.9%) | 5.1–30.8% |
| consumer localization rate | 7/39 (17.9%) | 5.1–30.8% |
| dependency-update detection rate | 34/39 (87.2%) | 76.9–97.4% |
| false-safe verdicts | 16/39 (41.0%) | 25.6–56.4% |

Intervals are a case-level bootstrap, resampled over cases rather than trials, and are omitted below twenty
cases — an interval from four cases is arithmetically valid and rhetorically dishonest.

### Breakdown

Every rate again, split by the dataset's own label and by the strata the adapter recorded. A pooled figure
hides both directions of the interesting result, so it is never the only number available here.

| Slice | affected-repository identification rate | consumer localization rate | dependency-update detection rate |
| --- | --- | --- | --- |
| label: COMPILATION_FAILURE | 4/12 (33.3%) | 4/12 (33.3%) | 11/12 (91.7%) |
| label: DEPENDENCY_LOCK_FAILURE | 0/2 (0.0%) | 0/2 (0.0%) | 1/2 (50.0%) |
| label: ENFORCER_FAILURE | 0/9 (0.0%) | 0/9 (0.0%) | 7/9 (77.8%) |
| label: TEST_FAILURE | 3/16 (18.8%) | 3/16 (18.8%) | 15/16 (93.8%) |

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
| `compatible` | 40 |

## Ground truth

- Granularity: **project-build**
- Exhaustive at that granularity: **no**
- Basis: Each record is one reproduced breaking dependency update with a recorded failure category. Positives only, and no annotation of which consumer source lines the break lands on.
- Metrics this annotation can support: recall, repair-success, false-safe-count

## Environment

| Tool | Version | Needed for |
| --- | --- | --- |
| `node` | v22.22.0 | every npm/TypeScript case, and Drift itself |
| `npm` | 10.9.4 | installing a TypeScript consumer before its build oracle can run |
| `git` | git version 2.39.5 (Apple Git-154) | checking out an original repository at the exact evaluated commit |
| `java` | openjdk version "19" 2022-09-20 | any Java case |
| `mvn` | **not installed** | BUMP's Maven oracle, and building Roseau from its replication kit |
| `docker` | **not installed** | BUMP's published pre/breaking images and TimeMachine's date-filtered PyPI infrastructure |
| `python3` | Python 3.9.6 | any Python case |
| `uv` | **not installed** | TimeMachine's documented environment setup |
| `japicmp` | SYNOPSIS | Drift's Java API-surface diff, which its maven capability declares it requires |

## Reproduction

```sh
npm run eval:external -- bump --limit 40 --seed 20260819
```

Every per-case prediction, label and outcome is beside this file:

```sh
gunzip -c cases.jsonl.gz | jq .
```

How the cases were chosen is in `selection.json`. No number above was typed by hand; each is read out of
`metrics.json`, which this file is a rendering of.
