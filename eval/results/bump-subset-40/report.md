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
| Drift commit | `3f60351d2b781f868ac6d380b267f5391d7e3af2` |
| Run date | 2026-09-11T19:51:41.625Z |
| Command | `/opt/hostedtoolcache/node/22.23.2/x64/bin/node /home/runner/work/drift/drift/eval/src/external/cli.ts bump --limit 40 --seed 20260819 --run-id bump-subset-40` |
| Platform | linux/x64, Node v22.23.2 |

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
| affected-repository identification rate | 28/39 (71.8%) | 56.4–84.6% |
| consumer localization rate | 12/39 (30.8%) | 15.4–46.2% |
| dependency-update detection rate | 36/39 (92.3%) | 82.1–100.0% |
| false-safe verdicts | 1/39 (2.6%) | 0.0–7.7% |

Intervals are a case-level bootstrap, resampled over cases rather than trials, and are omitted below twenty
cases — an interval from four cases is arithmetically valid and rhetorically dishonest.

### Affected-repository misses by stage

Every scored positive that did not end at `locally-affected`, charged to the one pipeline stage the answer
was lost at. This is where affected-repository recall is going — read it before proposing an engine change,
since it sizes what each stage can recover. Buckets sum to the total; see `impact-funnel.ts` for definitions.

| Stage | Cases |
| --- | ---: |
| `dependency-update-not-detected` | 3 |
| `consumer-usage-not-found` | 2 |
| `dependency-import-not-found` | 2 |
| `verification-inconclusive` | 2 |
| `no-breaking-change-derived` | 1 |
| `upstream-surface-unavailable` | 1 |
| **Total** | **11** |

### Failure classes that admit a static signal

BUMP labels each case with why the build broke. `ENFORCER_FAILURE` (Maven build-policy rules) and the
resolution/lock failures have no API-surface change for any static differ to find, so Drift answers
`insufficient-evidence` — the correct answer, indistinguishable from a miss once pooled.

| Stratum | affected-repository identification rate |
| --- | --- |
| Static signal possible (compilation, test, werror) | 22/28 (78.6%) |
| No API-surface delta (enforcer, lock, resolution) | 6/11 (54.5%) |
| Pooled — every case | 28/39 (71.8%) |

The first row is the one that answers "does Drift find the break when a break is findable". The second
measures a limit of static analysis, not of Drift, and only a build can settle those cases. Neither is
omitted, and no case is excluded from the pooled rate to produce them.

### Breakdown

Every rate again, split by the dataset's own label and by the strata the adapter recorded. A pooled figure
hides both directions of the interesting result, so it is never the only number available here.

| Slice | affected-repository identification rate | consumer localization rate | dependency-update detection rate |
| --- | --- | --- | --- |
| label: COMPILATION_FAILURE | 9/12 (75.0%) | 6/12 (50.0%) | 12/12 (100.0%) |
| label: DEPENDENCY_LOCK_FAILURE | 1/2 (50.0%) | 0/2 (0.0%) | 1/2 (50.0%) |
| label: ENFORCER_FAILURE | 5/9 (55.6%) | 0/9 (0.0%) | 7/9 (77.8%) |
| label: TEST_FAILURE | 13/16 (81.3%) | 6/16 (37.5%) | 16/16 (100.0%) |
| stratum: no-api-surface-delta | 6/11 (54.5%) | 0/11 (0.0%) | 8/11 (72.7%) |
| stratum: static-signal-possible | 22/28 (78.6%) | 12/28 (42.9%) | 28/28 (100.0%) |

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
| `node` | v22.23.2 | every npm/TypeScript case, and Drift itself |
| `npm` | 10.9.8 | installing a TypeScript consumer before its build oracle can run |
| `git` | git version 2.55.0 | checking out an original repository at the exact evaluated commit |
| `java` | openjdk version "21.0.12.1" 2026-08-18 LTS | any Java case |
| `mvn` | Apache Maven 3.9.16 (2bdd9fddda4b155ebf8000e807eb73fd829a51d5) | BUMP's Maven oracle, and building Roseau from its replication kit |
| `docker` | Docker version 28.0.4, build b8034c0 | BUMP's published pre/breaking images and TimeMachine's date-filtered PyPI infrastructure |
| `python3` | Python 3.12.3 | any Python case |
| `uv` | **not installed** | TimeMachine's documented environment setup |
| `japicmp` | installed (version unknown) | Drift's Java API-surface diff, which its maven capability declares it requires |

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
