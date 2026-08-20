# TimeMachine-bench (human-verified subset) — run `timemachine-verified`

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
| Drift commit | `b89642f42b0daf43fb52ba666653a64157c4124a` (working tree dirty) |
| Run date | 2026-08-20T00:44:31.375Z |
| Re-scored | 2026-08-20T14:51:50.408Z at `20eccc0dc0` — metrics recomputed from the recorded per-case results; the observations above are unchanged |
| Command | `/Users/rudy/.nvm/versions/node/v22.22.0/bin/node /Users/rudy/Desktop/Developer/Drift/eval/src/external/cli.ts timemachine --experiment verified --run-id timemachine-verified` |
| Platform | darwin/x64, Node v22.22.0 |

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
| affected-repository identification rate | 39/69 (56.5%) | 44.9–68.1% |
| consumer localization rate | 39/69 (56.5%) | 44.9–68.1% |
| dependency-update detection rate | 49/69 (71.0%) | 59.4–81.2% |
| false-safe verdicts | 4/69 (5.8%) | 1.4–11.6% |

Intervals are a case-level bootstrap, resampled over cases rather than trials, and are omitted below twenty
cases — an interval from four cases is arithmetically valid and rhetorically dishonest.

### Breakdown

Every rate again, split by the dataset's own label and by the strata the adapter recorded. A pooled figure
hides both directions of the interesting result, so it is never the only number available here.

| Slice | affected-repository identification rate | consumer localization rate | dependency-update detection rate |
| --- | --- | --- | --- |
| label: migration-failure-easy | 24/44 (54.5%) | 24/44 (54.5%) | 32/44 (72.7%) |
| label: migration-failure-hard | 2/2 (100.0%) | 2/2 (100.0%) | 2/2 (100.0%) |
| label: migration-failure-medium | 13/23 (56.5%) | 13/23 (56.5%) | 15/23 (65.2%) |

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
| `node` | v22.22.0 | every npm/TypeScript case, and Drift itself |
| `npm` | 10.9.4 | installing a TypeScript consumer before its build oracle can run |
| `git` | git version 2.39.5 (Apple Git-154) | checking out an original repository at the exact evaluated commit |
| `java` | openjdk version "19" 2022-09-20 | any Java case |
| `mvn` | **not installed** | BUMP's Maven oracle, and building Roseau from its replication kit |
| `docker` | **not installed** | BUMP's published pre/breaking images and TimeMachine's date-filtered PyPI infrastructure |
| `python3` | Python 3.9.6 | any Python case |
| `uv` | **not installed** | TimeMachine's documented environment setup |
| `japicmp` | **not installed** | Drift's Java API-surface diff, which its maven capability declares it requires |

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
