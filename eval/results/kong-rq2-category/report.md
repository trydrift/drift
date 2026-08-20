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
| Drift commit | `80aa8209d62bf19bcdab50dcd7232377528f4de7` |
| Run date | 2026-08-20T17:40:43.012Z |
| Re-scored | 2026-08-20T21:08:51.097Z at `bfcc036fff` — metrics recomputed from the recorded per-case results; the observations above are unchanged |
| Command | `/Users/rudy/.nvm/versions/node/v24.19.0/bin/node /Users/rudy/Desktop/Developer/Drift/eval/src/external/cli.ts kong --experiment rq2-category --run-id kong-rq2-category` |
| Platform | darwin/x64, Node v24.19.0 |

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
| breaking-change detection recall | 189/1511 (12.5%) | 10.9–14.2% |
| category classification accuracy | 2/134 (1.5%) | 0.0–3.7% |

Intervals are a case-level bootstrap, resampled over cases rather than trials, and are omitted below twenty
cases — an interval from four cases is arithmetically valid and rhetorically dishonest.

**category classification accuracy** is scored on 134 of 1511 cases — the rest have a label this corpus does not record precisely enough to check (1375 ambiguous, 2 unsupported), not cases that were skipped. See "Label mapping coverage" below.

### Breakdown

Every rate again, split by the dataset's own label and by the strata the adapter recorded. A pooled figure
hides both directions of the interesting result, so it is never the only number available here.

| Slice | breaking-change detection recall | category classification accuracy |
| --- | --- | --- |
| label: change_behavior | 83/1026 (8.1%) | — |
| label: change_signature | 27/134 (20.1%) | 2/134 (1.5%) |
| label: inline | 0/2 (0.0%) | — |
| label: move class | 1/7 (14.3%) | — |
| label: move field | 0/1 (0.0%) | — |
| label: move method | 1/12 (8.3%) | — |
| label: move module | 0/5 (0.0%) | — |
| label: move | 0/2 (0.0%) | — |
| label: remove class | 8/26 (30.8%) | — |
| label: remove constant | 4/10 (40.0%) | — |
| label: remove field | 8/27 (29.6%) | — |
| label: remove interface | 1/2 (50.0%) | — |
| label: remove method | 36/126 (28.6%) | — |
| label: remove module | 8/17 (47.1%) | — |
| label: remove type | 1/1 (100.0%) | — |
| label: remove | 0/2 (0.0%) | — |
| label: rename class | 1/22 (4.5%) | — |
| label: rename constant | 0/1 (0.0%) | — |
| label: rename field | 5/29 (17.2%) | — |
| label: rename interface | 0/4 (0.0%) | — |
| label: rename method | 5/50 (10.0%) | — |
| label: rename module | 0/3 (0.0%) | — |
| label: rename package | 0/1 (0.0%) | — |
| label: rename | 0/1 (0.0%) | — |
| markerBaselinePredictsBreaking: false | 0/47 (0.0%) | 0/5 (0.0%) |
| markerBaselinePredictsBreaking: true | 189/1464 (12.9%) | 2/129 (1.6%) |
| messageStatesDetail: false | 20/391 (5.1%) | 1/37 (2.7%) |
| messageStatesDetail: true | 169/1120 (15.1%) | 1/97 (1.0%) |

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
npm run eval:external -- kong
```

Every per-case prediction, label and outcome is beside this file:

```sh
gunzip -c cases.jsonl.gz | jq .
```

How the cases were chosen is in `selection.json`. No number above was typed by hand; each is read out of
`metrics.json`, which this file is a rendering of.
