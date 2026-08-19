# Drift Dependency Upgrade Evaluation

This harness runs small, deterministic dependency-upgrade fixtures and reports
the metrics Drift needs before claiming progress. It does not spend model API
money during normal tests. Model-backed adapters must be invoked separately and
their outputs cached with provenance.

Run the deterministic subset:

```sh
npm run eval:deterministic
```

Record an audit entry for the current commit:

```sh
npm run eval:accuracy:audit
```

Each fixture records its ecosystem, dependency move, taxonomy, exposure, expected
findings, expected impact sites, expected gaps, plan graph obligations, repair
expectations, oracle commands, provenance, and review status. Reports keep
individual detection and repair metrics visible; the cost-sensitive score is
only a release-gate aid and heavily penalizes false-safe outcomes and broken
repairs.

Recent systems papers such as DepRepair and SemaDiff are useful context, but
where they are preprints their numbers are not Drift claims. Drift benchmark
claims must cite the fixture revision, adapter, cached run provenance, command,
and scoring version used here.
