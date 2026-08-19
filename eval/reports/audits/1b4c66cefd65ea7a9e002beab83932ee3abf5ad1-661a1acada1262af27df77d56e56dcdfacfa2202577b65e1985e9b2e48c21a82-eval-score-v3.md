# Accuracy audit — 1b4c66cefd65

- Commit: `1b4c66cefd65ea7a9e002beab83932ee3abf5ad1`
- Branch: `benchmark/accuracy-harness`
- Dirty worktree at record time: `true`
- Fixture set hash: `661a1acada1262af27df77d56e56dcdfacfa2202577b65e1985e9b2e48c21a82`
- Scoring version: `eval-score-v3`
- Command: `npm run eval:accuracy:audit -- --record`
- Timestamp: 2026-08-19T13:24:59.618Z
- Environment: node v24.19.0 on darwin

```json
[
  {
    "adapter": "drift-component-localize-repair",
    "fixtures": 2,
    "upstream": {
      "micro": {
        "precision": 1,
        "recall": 1,
        "f1": 1
      },
      "macro": {
        "precision": 1,
        "recall": 1,
        "f1": 1
      },
      "counts": {
        "tp": 2,
        "fp": 0,
        "fn": 0
      },
      "excludedFromMacro": 0
    },
    "impact": {
      "micro": {
        "precision": 1,
        "recall": 1,
        "f1": 1
      },
      "macro": {
        "precision": 1,
        "recall": 1,
        "f1": 1
      },
      "counts": {
        "tp": 2,
        "fp": 0,
        "fn": 0
      },
      "excludedFromMacro": 0
    },
    "changedFiles": {
      "micro": {
        "precision": 0.5,
        "recall": 1,
        "f1": 0.667
      },
      "macro": {
        "precision": 0.5,
        "recall": 1,
        "f1": 0.5
      },
      "counts": {
        "tp": 1,
        "fp": 1,
        "fn": 0
      },
      "excludedFromMacro": 0
    },
    "taxonomyAccuracy": 0,
    "gapRecall": "not-applicable",
    "falseSafeCount": 0,
    "unsupportedSafeCount": 0,
    "repairOpportunities": 2,
    "repairAttempts": 2,
    "expectedAbstentions": 0,
    "correctAbstentions": 0,
    "incorrectAbstentions": 0,
    "missedRepairOpportunities": 0,
    "successfulRepairs": 2,
    "failedRepairs": 0,
    "repairedOraclePassRate": 1,
    "regressionCounts": {
      "repair-failed-to-fix": 0,
      "repair-introduced-regression": 0,
      "oracle-unavailable": 0
    },
    "productionScopeEscapeCount": 0,
    "productionScopeEscapeRate": 0,
    "unexpectedChangedFileCount": 1,
    "changedFilePrecision": 0.5,
    "changedFileRecall": 1,
    "changedFileF1": 0.667,
    "goldPatchExactRate": "not-applicable"
  },
  {
    "adapter": "drift-full-pipeline",
    "fixtures": 4,
    "upstream": {
      "micro": {
        "precision": 0.6,
        "recall": 0.6,
        "f1": 0.6
      },
      "macro": {
        "precision": 0.5,
        "recall": 0.5,
        "f1": 0.5
      },
      "counts": {
        "tp": 3,
        "fp": 2,
        "fn": 2
      },
      "excludedFromMacro": 0
    },
    "impact": {
      "micro": {
        "precision": 1,
        "recall": 1,
        "f1": 1
      },
      "macro": {
        "precision": 1,
        "recall": 1,
        "f1": 1
      },
      "counts": {
        "tp": 4,
        "fp": 0,
        "fn": 0
      },
      "excludedFromMacro": 1
    },
    "changedFiles": {
      "micro": {
        "precision": 0,
        "recall": 0,
        "f1": 0
      },
      "macro": {
        "precision": 0.75,
        "recall": 0.75,
        "f1": 0.75
      },
      "counts": {
        "tp": 0,
        "fp": 0,
        "fn": 1
      },
      "excludedFromMacro": 0
    },
    "taxonomyAccuracy": 0.75,
    "gapRecall": "not-applicable",
    "falseSafeCount": 0,
    "unsupportedSafeCount": 0,
    "repairOpportunities": 1,
    "repairAttempts": 0,
    "expectedAbstentions": 2,
    "correctAbstentions": 2,
    "incorrectAbstentions": 0,
    "missedRepairOpportunities": 1,
    "successfulRepairs": 0,
    "failedRepairs": 0,
    "repairedOraclePassRate": "not-applicable",
    "regressionCounts": {
      "repair-failed-to-fix": 0,
      "repair-introduced-regression": 0,
      "oracle-unavailable": 0
    },
    "productionScopeEscapeCount": 0,
    "productionScopeEscapeRate": 0,
    "unexpectedChangedFileCount": 0,
    "changedFilePrecision": 0,
    "changedFileRecall": 0,
    "changedFileF1": 0,
    "goldPatchExactRate": "not-applicable"
  }
]
```
