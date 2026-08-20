# Roseau accuracy dataset (replication kit) — run `roseau-accuracy`

**On hand-built Java library version pairs with exhaustively enumerated API breaking changes, does Drift produce the same set?**

What a good result here does *not* establish: Nothing about Drift on real-world Java projects: this dataset is constructed to enumerate API change kinds exhaustively, which is what makes precision meaningful and also what makes it unrepresentative of an actual upgrade.

## Provenance

| | |
| --- | --- |
| Dataset | Roseau accuracy dataset (replication kit) |
| Source | https://zenodo.org/records/15536418 |
| Dataset version | `10.5281/zenodo.15536418` |
| Licence | see the replication kit |
| Citation | Roseau replication kit, Zenodo, DOI 10.5281/zenodo.15536418; tool at https://github.com/alien-tools/roseau |
| Ecosystem | maven |
| Benchmark class | upstream-bc-detection |
| Drift commit | `d34ee396fc0f8bdd50f53a6326cc658b34b55fdb` (working tree dirty) |
| Run date | 2026-08-20T00:20:18.129Z |
| Re-scored | 2026-08-20T14:51:59.263Z at `20eccc0dc0` — metrics recomputed from the recorded per-case results; the observations above are unchanged |
| Command | `/Users/rudy/.nvm/versions/node/v22.22.0/bin/node /Users/rudy/Desktop/Developer/Drift/eval/src/external/cli.ts roseau --run-id roseau-accuracy` |
| Platform | darwin/x64, Node v22.22.0 |

## Case accounting

Read this before any rate below.

| | Cases |
| --- | --- |
| Available in the dataset | 267 |
| Selected for this run (all) | 267 |
| Scored | 267 |
| Excluded | 0 |
| Negative/control cases among the scored | 167 |

## Results

| Question | Result | 95% interval |
| --- | --- | --- |
| breaking-change detection recall | 81/100 (81.0%) | 73.0–88.0% |

Intervals are a case-level bootstrap, resampled over cases rather than trials, and are omitted below twenty
cases — an interval from four cases is arithmetically valid and rhetorically dishonest.

### Classification

Computed because this corpus supplies real negatives, so a false positive has a population to be measured over.

| | |
| --- | --- |
| True positives | 81 |
| False positives | 8 |
| True negatives | 159 |
| False negatives | 19 |
| Precision | 81/89 (91.0%) |
| Recall | 81/100 (81.0%) |
| F1 | 0.857 |

### Breakdown

Every rate again, split by the dataset's own label and by the strata the adapter recorded. A pooled figure
hides both directions of the interesting result, so it is never the only number available here.

| Slice | breaking-change detection recall |
| --- | --- |
| groundTruthSourceBreaking: false | 20/21 (95.2%) |
| groundTruthSourceBreaking: true | 61/79 (77.2%) |
| label: binary-breaking | 81/100 (81.0%) |

## Label mapping coverage

This corpus's vocabulary is not Drift's, so every label carries a mapping and a confidence. Only `exact` and
`compatible` mappings are scored for category correctness; `ambiguous` and `unsupported` ones are counted here
rather than forced into the nearest Drift kind, which would make the resulting accuracy partly a measurement of
how generously the mapping was written.

| Mapping status | Cases |
| --- | --- |
| `exact` | 267 |

## Ground truth

- Granularity: **api-symbol**
- Exhaustive at that granularity: **yes**
- Basis: Constructed library pairs with every API breaking change enumerated at symbol level, which is what supports precision and F1.
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
| `japicmp` | SYNOPSIS | Drift's Java API-surface diff, which its maven capability declares it requires |

## Reproduction

```sh
npm run eval:external -- roseau
```

Every per-case prediction, label and outcome is beside this file:

```sh
gunzip -c cases.jsonl.gz | jq .
```

How the cases were chosen is in `selection.json`. No number above was typed by hand; each is read out of
`metrics.json`, which this file is a rendering of.
