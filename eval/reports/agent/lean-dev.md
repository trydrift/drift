# Agent benchmark comparison: lean-dev

Generated 2026-09-17T17:21:38.030Z. Conditions: Raw, Drift lean, Drift lean + brief.

- Development cases only (they informed the architecture). Nothing here is held-out evidence or a public claim.
- Tiny sample: 3 case(s). Bootstrap intervals are shown but are wide by construction.
- Tokens are provider-reported. For orchestrated conditions every session is summed (open, unit and repair sessions); controller verification is not model usage and is not in any token figure.
- Token changes are case-level medians: per case, treatment median / reference median - 1; then the median across cases. Negative is fewer tokens.
- Tokens before/after first edit: main-model usage up to and including the call that issued the first file edit across all sessions in order, and everything after it.
- Agent broad checks: whole-project build/typecheck/lint/test commands the agent issued (shell commands only), classified by the product classifier for every condition. In orchestrated conditions the verification guard refuses them; refused attempts are counted separately and did not run. The raw baseline has no guard.
- Dependency research: Read/Grep/Glob/shell accesses to node_modules/<dependency>, changelog/migration files, and registry queries.
- Agent wall: time inside agent sessions. Controller wall: pre-upgrade baseline measurement + controller verification. End-to-end: from the start of Drift analysis (or the first session) to the end of the controller.

- Run `lean-dev-eslint-r1`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 3cb16e3c46e8, isolated sessions, 3 repetition(s), conditions baseline, drift-lean, drift-lean-brief.
- Run `lean-dev-eslint-r2`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 3cb16e3c46e8, isolated sessions, 3 repetition(s), conditions baseline, drift-lean, drift-lean-brief.
- Run `lean-dev-eslint-r3`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 3cb16e3c46e8, isolated sessions, 3 repetition(s), conditions baseline, drift-lean, drift-lean-brief.
- Run `lean-dev-ethereum-r1`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 3cb16e3c46e8, isolated sessions, 3 repetition(s), conditions baseline, drift-lean, drift-lean-brief.
- Run `lean-dev-ethereum-r2`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 3cb16e3c46e8, isolated sessions, 3 repetition(s), conditions baseline, drift-lean, drift-lean-brief.
- Run `lean-dev-ethereum-r3`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 3cb16e3c46e8, isolated sessions, 3 repetition(s), conditions baseline, drift-lean, drift-lean-brief.
- Run `lean-dev-winston-r1`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 3cb16e3c46e8, isolated sessions, 3 repetition(s), conditions baseline, drift-lean, drift-lean-brief.
- Run `lean-dev-winston-r2`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 3cb16e3c46e8, isolated sessions, 3 repetition(s), conditions baseline, drift-lean, drift-lean-brief.
- Run `lean-dev-winston-r3`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 3cb16e3c46e8, isolated sessions, 3 repetition(s), conditions baseline, drift-lean, drift-lean-brief.
- Session environment fingerprint(s) across valid trials: 8d69d817761f3509, 98ee509151811e6b.

## Accuracy

| Case | Raw | Drift lean | Drift lean + brief |
| --- | ---: | ---: | ---: |
| aws-least-privilege-winston-3 | 3/3 | 3/3 | 3/3 |
| eth-ledger-bridge-keyring-ethereumjs-tx-5 | 2/3 | 2/3 | 1/3 |
| gh-aw-firewall-eslint-10 | 3/3 | 3/3 | 3/3 |
| **Total** | **8/9** | **8/9** | **7/9** |

Drift lean: accuracy not below Raw overall **yes**, in every case **yes**; median case gross reduction 46.5%.
Drift lean + brief: accuracy not below Raw overall **NO**, in every case **NO**; median case gross reduction 10.3%.

### Every failure

- `lean-dev-ethereum-r1/eth-ledger-bridge-keyring-ethereumjs-tx-5/baseline/1` (Raw, rep 1): prohibited_workaround
  - workaround rule: Coverage thresholds, the package-manager policy and compiler strictness are not part of this migration. (changed: jest.config.js)
- `lean-dev-ethereum-r3/eth-ledger-bridge-keyring-ethereumjs-tx-5/drift-lean/3` (Drift lean, rep 3): hidden_regression_failure
  - hidden test failed: keyring-signing —       at LedgerKeyring._LedgerKeyring_s / … (319 more characters)
- `lean-dev-ethereum-r1/eth-ledger-bridge-keyring-ethereumjs-tx-5/drift-lean-brief/1` (Drift lean + brief, rep 1): prohibited_workaround
  - workaround rule: Coverage thresholds, the package-manager policy and compiler strictness are not part of this migration. (changed: jest.config.js)
  - workaround rule: Suppressing the type errors in the keyring with a directive is not a migration of it (the file's pre-existing ts-expect-error lines on the ethereumjs-tx v1 branch stay). Narrowed on 2026-09-16 from also forbidding any-typing, for the reason recorded on the winston case. (added in: src/ledger-keyring.ts)
- `lean-dev-ethereum-r2/eth-ledger-bridge-keyring-ethereumjs-tx-5/drift-lean-brief/2` (Drift lean + brief, rep 2): prohibited_workaround
  - workaround rule: Coverage thresholds, the package-manager policy and compiler strictness are not part of this migration. (changed: jest.config.js)

## Tokens and activity by case (medians over valid trials)

### aws-least-privilege-winston-3

| | Raw | Drift lean | Drift lean + brief |
| --- | ---: | ---: | ---: |
| Success | 3/3 | 3/3 | 3/3 |
| Gross input | 1,743,253 | 1,917,312 | 1,563,482 |
| Uncached input | 33,690 | 48,551 | 43,700 |
| Output | 13,271 | 16,792 | 17,168 |
| Model calls | 32 | 50 | 46 |
| Agent sessions | 1 | 1 | 1 |
| Agent tool calls | 31 | 53 | 45 |
| Agent broad checks | 7 | 10 | 9 |
| Agent narrow checks | 0 | 0 | 0 |
| Agent broad checks refused by the guard | 0 | 0 | 0 |
| Dependency research | 6 | 4 | 6 |
| Gross before first edit | 539,867 | 227,602 | 183,958 |
| Gross after first edit | 1,036,026 | 1,720,757 | 1,400,014 |
| Gross in repair sessions | 0 | 0 | 0 |
| Repair sessions | 0 | 0 | 0 |
| Files exposed per session | — | — | — |
| Files modified | 3 | 3 | 4 |
| Unique files read | 3 | 5 | 2 |
| Controller checks run | 0 | 0 | 0 |
| Agent wall | 361s | 691s | 598s |
| Controller wall | 0s | 0s | 0s |
| End-to-end wall | 361s | 691s | 699s |
| Drift analysis | 0s | 0s | 0s |
| Cost | $0.60 | $0.73 | $0.64 |
| Units (plan) | 0 | 0 | 0 |
| Units resolved deterministically | 0 | 0 | 0 |
| Units sent to agent | 0 | 0 | 0 |
| Units skipped (protected) | 0 | 0 | 0 |
| Units requiring repair | 0 | 0 | 0 |
| Out-of-scope rejections | 0 | 0 | 0 |

### eth-ledger-bridge-keyring-ethereumjs-tx-5

| | Raw | Drift lean | Drift lean + brief |
| --- | ---: | ---: | ---: |
| Success | 2/3 | 2/3 | 1/3 |
| Gross input | 6,642,599 | 3,551,267 | 7,047,473 |
| Uncached input | 85,993 | 76,503 | 112,793 |
| Output | 29,379 | 28,587 | 37,081 |
| Model calls | 66 | 59 | 94 |
| Agent sessions | 1 | 1 | 1 |
| Agent tool calls | 70 | 58 | 94 |
| Agent broad checks | 15 | 10 | 14 |
| Agent narrow checks | 0 | 0 | 0 |
| Agent broad checks refused by the guard | 0 | 0 | 0 |
| Dependency research | 11 | 15 | 17 |
| Gross before first edit | 1,202,152 | 546,327 | 837,795 |
| Gross after first edit | 4,654,585 | 3,003,967 | 5,453,555 |
| Gross in repair sessions | 0 | 0 | 0 |
| Repair sessions | 0 | 0 | 0 |
| Files exposed per session | — | — | — |
| Files modified | 4 | 4 | 5 |
| Unique files read | 3 | 4 | 3 |
| Controller checks run | 0 | 0 | 0 |
| Agent wall | 1061s | 832s | 1376s |
| Controller wall | 0s | 0s | 0s |
| End-to-end wall | 1061s | 832s | 1565s |
| Drift analysis | 0s | 0s | 0s |
| Cost | $1.95 | $1.30 | $2.25 |
| Units (plan) | 0 | 0 | 0 |
| Units resolved deterministically | 0 | 0 | 0 |
| Units sent to agent | 0 | 0 | 0 |
| Units skipped (protected) | 0 | 0 | 0 |
| Units requiring repair | 0 | 0 | 0 |
| Out-of-scope rejections | 0 | 0 | 0 |

### gh-aw-firewall-eslint-10

| | Raw | Drift lean | Drift lean + brief |
| --- | ---: | ---: | ---: |
| Success | 3/3 | 3/3 | 3/3 |
| Gross input | 8,106,317 | 4,239,201 | 4,609,655 |
| Uncached input | 82,399 | 70,995 | 73,304 |
| Output | 31,303 | 31,506 | 25,664 |
| Model calls | 98 | 88 | 91 |
| Agent sessions | 1 | 1 | 1 |
| Agent tool calls | 98 | 87 | 90 |
| Agent broad checks | 17 | 13 | 15 |
| Agent narrow checks | 1 | 1 | 3 |
| Agent broad checks refused by the guard | 0 | 0 | 0 |
| Dependency research | 9 | 11 | 10 |
| Gross before first edit | 940,412 | 333,986 | 121,971 |
| Gross after first edit | 7,374,947 | 3,834,367 | 4,520,907 |
| Gross in repair sessions | 0 | 0 | 0 |
| Repair sessions | 0 | 0 | 0 |
| Files exposed per session | — | — | — |
| Files modified | 12 | 12 | 12 |
| Unique files read | 11 | 4 | 6 |
| Controller checks run | 0 | 0 | 0 |
| Agent wall | 1097s | 977s | 992s |
| Controller wall | 0s | 0s | 0s |
| End-to-end wall | 1097s | 977s | 1012s |
| Drift analysis | 0s | 0s | 0s |
| Cost | $2.24 | $1.43 | $1.44 |
| Units (plan) | 0 | 0 | 0 |
| Units resolved deterministically | 0 | 0 | 0 |
| Units sent to agent | 0 | 0 | 0 |
| Units skipped (protected) | 0 | 0 | 0 |
| Units requiring repair | 0 | 0 | 0 |
| Out-of-scope rejections | 0 | 0 | 0 |

## Case-level median changes

| Comparison | Paired cases | Gross input | 95% CI | Uncached input | Gross after first edit | Model calls | Per case (gross) | Successes (reference → treatment) |
| --- | ---: | ---: | --- | ---: | ---: | ---: | --- | --- |
| Drift lean vs Raw | 3 | -46.5% | [-59.1, 34.7] | -11.0% | -35.5% | -10.2% | winston-3 +10.0%; tx-5 -46.5%; eslint-10 -47.7% | 8 → 8 |
| Drift lean + brief vs Raw | 3 | -10.3% | [-48.9, 22.4] | +29.7% | +17.2% | +42.4% | winston-3 -10.3%; tx-5 +6.1%; eslint-10 -43.1% | 8 → 7 |
| Drift lean + brief vs Drift lean | 3 | +8.7% | [-57.7, 137.3] | +3.3% | +17.9% | +3.4% | winston-3 -18.5%; tx-5 +98.4%; eslint-10 +8.7% | 8 → 7 |

≥30% median gross reduction vs raw: **not met** (10.3% reduction).

## Schedule and exclusions

- Raw: positions 3 / 3 / 3
- Drift lean: positions 3 / 3 / 3
- Drift lean + brief: positions 3 / 3 / 3

Every slot holds a valid trial.
