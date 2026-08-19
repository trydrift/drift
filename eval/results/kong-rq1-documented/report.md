# Towards Better Comprehension of Breaking Changes in the NPM Ecosystem — run `kong-rq1-documented`

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
| Drift commit | `a2c0b8a8b83fadcafd3f8b02f13d540abbeb26ce` (working tree dirty) |
| Run date | 2026-08-19T23:21:48.448Z |
| Command | `/Users/rudy/.nvm/versions/node/v22.22.0/bin/node /Users/rudy/Desktop/Developer/Drift/eval/src/external/cli.ts kong --experiment rq1-documented --run-id kong-rq1-documented` |
| Platform | darwin/x64, Node v22.22.0 |

## Case accounting

Read this before any rate below.

| | Cases |
| --- | --- |
| Available in the dataset | 16333 |
| Selected for this run (all) | 16333 |
| Scored | 16333 |
| Excluded | 0 |
| Negative/control cases among the scored | 16168 |

## Results

| Question | Result |
| --- | --- |
| breaking-change detection recall | 23/165 (13.9%) |

### Classification

Computed because this corpus supplies real negatives, so a false positive has a population to be measured over.

| | |
| --- | --- |
| True positives | 23 |
| False positives | 11 |
| True negatives | 16157 |
| False negatives | 142 |
| Precision | 23/34 (67.6%) |
| Recall | 23/165 (13.9%) |
| F1 | 0.231 |

### Trivial baseline on the same cases

Predicts "breaking" whenever the commit message contains a literal BREAKING CHANGE annotation. Not Drift, and not presented as Drift — it is here so a reader can see how much of this task is reachable without reading the text.

| | Precision | Recall |
| --- | --- | --- |
| conventional-commits marker | 164/193 (85.0%) | 164/165 (99.4%) |

Read this next to the result above. Where the baseline scores close to Drift, the task is not measuring much.

### Breakdown

Every rate again, split by the dataset's own label and by the strata the adapter recorded. A pooled figure
hides both directions of the interesting result, so it is never the only number available here.

| Slice | breaking-change detection recall |
| --- | --- |
| label: documents-breaking-change | 23/165 (13.9%) |
| markerBaselinePredictsBreaking: false | 0/1 (0.0%) |
| markerBaselinePredictsBreaking: true | 23/164 (14.0%) |
| messageStatesDetail: false | 6/48 (12.5%) |
| messageStatesDetail: true | 17/117 (14.5%) |

## Label mapping coverage

This corpus's vocabulary is not Drift's, so every label carries a mapping and a confidence. Only `exact` and
`compatible` mappings are scored for category correctness; `ambiguous` and `unsupported` ones are counted here
rather than forced into the nearest Drift kind, which would make the resulting accuracy partly a measurement of
how generously the mapping was written.

| Mapping status | Cases |
| --- | --- |
| `exact` | 16333 |

## Ground truth

- Granularity: **commit**
- Exhaustive at that granularity: **yes**
- Basis: RQ1's detected_bc_are_documented.csv labels every sampled commit yes/no for whether developers documented a breaking change, so the negatives are real and precision is defined. RQ2's analyzed_breaking_changes.csv annotates a category per breaking change on commits already known to be breaking, which supports category accuracy and nothing else.
- Metrics this annotation can support: recall, precision, f1, category-accuracy

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
