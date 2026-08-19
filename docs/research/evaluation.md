# Evaluation

The executable benchmark harness lives in `eval/`. Deterministic fixtures run
with:

```sh
npm run eval:deterministic
```

Commit-tied audit entries are appended with:

```sh
npm run eval:accuracy:audit
```

Each fixture records ecosystem, dependency, from/to version, source repository
and licence, breaking-change taxonomy, direct/transitive exposure, expected
upstream findings, expected impact sites, expected gaps, gold patch or validated
outcome, negative and positive oracle commands, complexity, network policy,
provenance, and review status.

Reported metrics include upstream precision/recall/F1, impact-site
precision/recall/F1, taxonomy accuracy, gap recall, plan-node recall, edge
precision where ground truth exists, repair attempt rate, repair oracle pass
rate, gold-patch exact match rate, changed-file precision/recall/F1, regression
rate, out-of-scope edit rate, abstention quality, cost, latency, false-safe
count, and a cost-sensitive score with severe penalties for false-safe outcomes
and broken repairs. Individual metrics stay visible.

Model-backed adapters are separate from normal unit tests and must cache outputs
with provenance. Normal CI should not spend real model API money.

Recent papers such as DepRepair and SemaDiff are useful context. Where they are
preprints, published numbers are not Drift claims. Drift claims require the
fixture revision, adapter version, command, cached run provenance, and scoring
version.
