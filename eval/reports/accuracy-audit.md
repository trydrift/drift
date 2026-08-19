# Drift Accuracy Audit Trail

Each entry records the benchmark metrics for one commit and fixture-set hash.
Generated deterministic reports remain reproducible; this file is the historical run log.

## 2026-08-19T03:58:54.398Z - cb1eeac3654b

- Commit: `cb1eeac3654b7d0fcc14776e62d2781264c560eb`
- Branch: `benchmark/accuracy-harness`
- Dirty worktree: `no`
- Fixture set hash: `ba1c1a1f2cce22b2f8e9ea0da0f420848d8a5820d84794f3d810957965a87ab5`
- Scoring version: `eval-score-v1`
- Command: `npm run eval:accuracy:audit`

| Adapter | Fixtures | Detection F1 | Impact F1 | Repair Oracle | Gold Patch | Repair Files F1 | False-safe | Score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| current-main-frozen | 3 | 1.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0.150 |
| drift-structured-fixture | 3 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 1.000 |
