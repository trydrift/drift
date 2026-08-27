# Towards Better Comprehension of Breaking Changes in the NPM Ecosystem — run `kong-rq2-category`

**Given the real prose an upstream JavaScript maintainer wrote about a commit, does Drift read a breaking change out of it, and does it read the right kind of breaking change?**

What a good result here does *not* establish: Nothing about whether Drift finds these changes in a consumer repository, nothing about repair, and nothing about the published-artefact API diff — this corpus supplies prose, so only the prose interpreter is under test.

## Provenance

| | |
| --- | --- |
| Dataset | Towards Better Comprehension of Breaking Changes in the NPM Ecosystem |
| Source | https://zenodo.org/records/13857646 |
| Dataset version | `10.5281/zenodo.13857646` |
| Licence | CC-BY-4.0 |
| Citation | Dezhen Kong et al., "Towards Better Comprehension of Breaking Changes in the NPM Ecosystem", replication package, Zenodo, DOI 10.5281/zenodo.13857646. |
| Ecosystem | npm |
| Benchmark class | upstream-bc-detection |
| Drift commit | `3d7939b671b05db95b4014ca55d1155b0f307d5e` |
| Run date | 2026-08-27T21:50:17.664Z |
| Command | `/opt/hostedtoolcache/node/22.23.2/x64/bin/node /home/runner/work/drift/drift/eval/src/external/cli.ts kong --experiment rq2-category --run-id kong-rq2-category` |
| Platform | linux/x64, Node v22.23.2 |

## Case accounting

Read this before any rate below.

| | Cases |
| --- | --- |
| Available in the dataset | 1511 |
| Selected for this run (all) | 1511 |
| Scored | 1511 |
| Excluded | 0 |
| Negative/control cases among the scored | 0 |

## Results

| Question | Result | 95% interval |
| --- | --- | --- |
| breaking-change detection recall | 1144/1511 (75.7%) | 73.5–77.8% |
| category classification accuracy | 2/134 (1.5%) | 0.0–3.7% |

Intervals are a case-level bootstrap, resampled over cases rather than trials, and are omitted below twenty
cases — an interval from four cases is arithmetically valid and rhetorically dishonest.

**category classification accuracy** is scored on 134 of 1511 cases — the rest have a label this corpus does not record precisely enough to check (1375 ambiguous, 2 unsupported), not cases that were skipped. See "Label mapping coverage" below.

### Breakdown

Every rate again, split by the dataset's own label and by the strata the adapter recorded. A pooled figure
hides both directions of the interesting result, so it is never the only number available here.

| Slice | breaking-change detection recall | category classification accuracy |
| --- | --- | --- |
| label: change_behavior | 770/1026 (75.0%) | — |
| label: change_signature | 100/134 (74.6%) | 2/134 (1.5%) |
| label: inline | 2/2 (100.0%) | — |
| label: move class | 5/7 (71.4%) | — |
| label: move field | 1/1 (100.0%) | — |
| label: move method | 11/12 (91.7%) | — |
| label: move module | 5/5 (100.0%) | — |
| label: move | 1/2 (50.0%) | — |
| label: remove class | 20/26 (76.9%) | — |
| label: remove constant | 7/10 (70.0%) | — |
| label: remove field | 23/27 (85.2%) | — |
| label: remove interface | 2/2 (100.0%) | — |
| label: remove method | 97/126 (77.0%) | — |
| label: remove module | 12/17 (70.6%) | — |
| label: remove type | 1/1 (100.0%) | — |
| label: remove | 1/2 (50.0%) | — |
| label: rename class | 15/22 (68.2%) | — |
| label: rename constant | 0/1 (0.0%) | — |
| label: rename field | 23/29 (79.3%) | — |
| label: rename interface | 3/4 (75.0%) | — |
| label: rename method | 41/50 (82.0%) | — |
| label: rename module | 2/3 (66.7%) | — |
| label: rename package | 1/1 (100.0%) | — |
| label: rename | 1/1 (100.0%) | — |
| markerBaselinePredictsBreaking: false | 0/47 (0.0%) | 0/5 (0.0%) |
| markerBaselinePredictsBreaking: true | 1144/1464 (78.1%) | 2/129 (1.6%) |
| messageStatesDetail: false | 60/391 (15.3%) | 1/37 (2.7%) |
| messageStatesDetail: true | 1084/1120 (96.8%) | 1/97 (1.0%) |

## What is deliberately not reported

These metrics are not omitted for space. The data cannot support them, and computing them anyway would
produce a number that describes the arithmetic rather than the tool.

| Metric | Why not |
| --- | --- |
| precision | Towards Better Comprehension of Breaking Changes in the NPM Ecosystem contributed no negative/control cases to this run, so there is no population a false positive could be measured against. |
| F1 | F1 is a harmonic mean of precision and recall, and precision is not defined here. |
| false-positive rate | Towards Better Comprehension of Breaking Changes in the NPM Ecosystem contributed no negative/control cases to this run, so there is no population a false positive could be measured against. |

## Label mapping coverage

This corpus's vocabulary is not Drift's, so every label carries a mapping and a confidence. Only `exact` and
`compatible` mappings are scored for category correctness; `ambiguous` and `unsupported` ones are counted here
rather than forced into the nearest Drift kind, which would make the resulting accuracy partly a measurement of
how generously the mapping was written.

| Mapping status | Cases |
| --- | --- |
| `ambiguous` | 1375 |
| `exact` | 134 |
| `unsupported` | 2 |

## Ground truth

- Granularity: **commit**
- Exhaustive at that granularity: **yes**
- Basis: RQ1's detected_bc_are_documented.csv labels every sampled commit yes/no for whether developers documented a breaking change, so the negatives are real and precision is defined. RQ2's analyzed_breaking_changes.csv annotates a category per breaking change on commits already known to be breaking, which supports category accuracy and nothing else.
- Metrics this annotation can support: recall, precision, f1, category-accuracy

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
npm run eval:external -- kong
```

Every per-case prediction, label and outcome is beside this file:

```sh
gunzip -c cases.jsonl.gz | jq .
```

How the cases were chosen is in `selection.json`. No number above was typed by hand; each is read out of
`metrics.json`, which this file is a rendering of.
