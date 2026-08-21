# swe-bump-bench — run `swe-bump-detection`

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
| Drift commit | `49c081ee5712d59ed3e006b0586145450b1a5ef6` |
| Run date | 2026-08-20T19:09:44.578Z |
| Command | `/Users/rudy/.nvm/versions/node/v24.19.0/bin/node /Users/rudy/Desktop/Developer/Drift/eval/src/external/cli.ts swe-bump --run-id swe-bump-detection` |
| Platform | darwin/x64, Node v24.19.0 |

## Case accounting

Read this before any rate below.

| | Cases |
| --- | --- |
| Available in the dataset | 63 |
| Selected for this run (all) | 63 |
| Scored | 58 |
| Excluded | 5 |
| Negative/control cases among the scored | 0 |

Every exclusion, with its reason:

| Reason | Cases |
| --- | --- |
| `reproduction-failed` | 3 |
| `source-unavailable` | 2 |

## Results

| Question | Result | 95% interval |
| --- | --- | --- |
| affected-repository identification rate | 38/58 (65.5%) | 53.4–77.6% |
| consumer localization rate | 38/58 (65.5%) | 53.4–77.6% |
| dependency-update detection rate | 58/58 (100.0%) | 100.0–100.0% |
| false-safe verdicts | 17/58 (29.3%) | 19.0–41.4% |

Intervals are a case-level bootstrap, resampled over cases rather than trials, and are omitted below twenty
cases — an interval from four cases is arithmetically valid and rhetorically dishonest.

### Breakdown

Every rate again, split by the dataset's own label and by the strata the adapter recorded. A pooled figure
hides both directions of the interesting result, so it is never the only number available here.

| Slice | affected-repository identification rate | consumer localization rate | dependency-update detection rate |
| --- | --- | --- | --- |
| label: known-breaking-upgrade | 38/58 (65.5%) | 38/58 (65.5%) | 58/58 (100.0%) |
| versionToIsRange: false | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) |
| versionToIsRange: true | 35/55 (63.6%) | 35/55 (63.6%) | 55/55 (100.0%) |

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
| `node` | v24.19.0 | every npm/TypeScript case, and Drift itself |
| `npm` | 11.12.1 | installing a TypeScript consumer before its build oracle can run |
| `git` | git version 2.39.5 (Apple Git-154) | checking out an original repository at the exact evaluated commit |
| `java` | openjdk version "19" 2022-09-20 | any Java case |
| `mvn` | Apache Maven 3.9.9 (8e8579a9e76f7d015ee5ec7bfcdc97d260186937) | BUMP's Maven oracle, and building Roseau from its replication kit |
| `docker` | **not installed** | BUMP's published pre/breaking images and TimeMachine's date-filtered PyPI infrastructure |
| `python3` | Python 3.14.3 | any Python case |
| `uv` | **not installed** | TimeMachine's documented environment setup |
| `japicmp` | **not installed** | Drift's Java API-surface diff, which its maven capability declares it requires |

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
