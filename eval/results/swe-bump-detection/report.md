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
| Drift commit | `b4a343b34605b92c8e99bdb236c0421cae615551` |
| Run date | 2026-09-02T12:00:33.174Z |
| Command | `/opt/hostedtoolcache/node/22.23.2/x64/bin/node /home/runner/work/drift/drift/eval/src/external/cli.ts swe-bump --run-id swe-bump-detection` |
| Platform | linux/x64, Node v22.23.2 |

## Case accounting

Read this before any rate below.

| | Cases |
| --- | --- |
| Available in the dataset | 63 |
| Selected for this run (all) | 63 |
| Scored | 63 |
| Excluded | 0 |
| Negative/control cases among the scored | 0 |

## Results

### Adjudication coverage

Unadjudicated cases remain in the corpus and artifacts, but do not enter the metric denominator.

| Question | Adjudicated | Not adjudicated |
| --- | ---: | ---: |
| affected-repository identification rate | 3 | 60 |
| consumer localization rate | 3 | 60 |
| dependency-update detection rate | 3 | 60 |
| false-safe verdicts | 3 | 60 |

Reasons:

- affected-repository identification rate: 60 — the corpus supplies a manifest range rather than an authoritative exact before/after version pair
- consumer localization rate: 60 — the corpus supplies a manifest range rather than an authoritative exact before/after version pair
- dependency-update detection rate: 60 — the corpus supplies a manifest range rather than an authoritative exact before/after version pair
- false-safe verdicts: 60 — the corpus supplies a manifest range rather than an authoritative exact before/after version pair

| Question | Result | 95% interval |
| --- | --- | --- |
| affected-repository identification rate | 3/3 (100.0%) | not reported (under 20 cases) |
| consumer localization rate | 3/3 (100.0%) | not reported (under 20 cases) |
| dependency-update detection rate | 3/3 (100.0%) | not reported (under 20 cases) |
| false-safe verdicts | 0/3 (0.0%) | not reported (under 20 cases) |

Intervals are a case-level bootstrap, resampled over cases rather than trials, and are omitted below twenty
cases — an interval from four cases is arithmetically valid and rhetorically dishonest.

### Breakdown

Every rate again, split by the dataset's own label and by the strata the adapter recorded. A pooled figure
hides both directions of the interesting result, so it is never the only number available here.

| Slice | affected-repository identification rate | consumer localization rate | dependency-update detection rate |
| --- | --- | --- | --- |
| exactVersionAdjudicated: true | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) |
| label: known-breaking-upgrade | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) |
| versionToIsRange: false | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) |

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
| `node` | v22.23.2 | every npm/TypeScript case, and Drift itself |
| `npm` | 10.9.8 | installing a TypeScript consumer before its build oracle can run |
| `git` | git version 2.55.0 | checking out an original repository at the exact evaluated commit |
| `java` | openjdk version "17.0.20.1" 2026-08-18 | any Java case |
| `mvn` | Apache Maven 3.9.16 (2bdd9fddda4b155ebf8000e807eb73fd829a51d5) | BUMP's Maven oracle, and building Roseau from its replication kit |
| `docker` | Docker version 28.0.4, build b8034c0 | BUMP's published pre/breaking images and TimeMachine's date-filtered PyPI infrastructure |
| `python3` | Python 3.12.3 | any Python case |
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
