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
| Drift commit | `12e8415bc9eed274bbcffeb14c5de31e92ac83e4` |
| Run date | 2026-09-03T04:46:09.548Z |
| Command | `/opt/hostedtoolcache/node/22.23.2/x64/bin/node /home/runner/work/drift/drift/eval/src/external/cli.ts roseau --run-id roseau-accuracy` |
| Platform | linux/x64, Node v22.23.2 |

## Case accounting

Read this before any rate below.

| | Cases |
| --- | --- |
| Available in the dataset | 267 |
| Selected for this run (all) | 267 |
| Scored | 255 |
| Excluded | 12 |
| Negative/control cases among the scored | 157 |

Every exclusion, with its reason:

| Reason | Cases |
| --- | --- |
| `ground-truth-contested` | 12 |

## Results

| Question | Result | 95% interval |
| --- | --- | --- |
| breaking-change detection recall | 98/98 (100.0%) | 100.0–100.0% |

Intervals are a case-level bootstrap, resampled over cases rather than trials, and are omitted below twenty
cases — an interval from four cases is arithmetically valid and rhetorically dishonest.

### Classification

Computed because this corpus supplies real negatives, so a false positive has a population to be measured over.

| | |
| --- | --- |
| True positives | 98 |
| False positives | 1 |
| True negatives | 156 |
| False negatives | 0 |
| Precision | 98/99 (99.0%) |
| Recall | 98/98 (100.0%) |
| F1 | 0.995 |

### Breakdown

Every rate again, split by the dataset's own label and by the strata the adapter recorded. A pooled figure
hides both directions of the interesting result, so it is never the only number available here.

| Slice | breaking-change detection recall |
| --- | --- |
| groundTruthSourceBreaking: false | 20/20 (100.0%) |
| groundTruthSourceBreaking: true | 78/78 (100.0%) |
| label: binary-breaking | 98/98 (100.0%) |

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
npm run eval:external -- roseau
```

Every per-case prediction, label and outcome is beside this file:

```sh
gunzip -c cases.jsonl.gz | jq .
```

How the cases were chosen is in `selection.json`. No number above was typed by hand; each is read out of
`metrics.json`, which this file is a rendering of.
