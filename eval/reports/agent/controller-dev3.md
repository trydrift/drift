# Controller-owned remediation: controller-dev3

Generated 2026-09-17T15:04:48.519Z.

- Development cases only (they informed the architecture). Nothing here is held-out evidence or a public claim.
- Tiny sample: 3 case(s). Bootstrap intervals are shown but are wide by construction.
- Tokens are provider-reported. For orchestrated conditions every session is summed (open, unit and repair sessions); controller verification is not model usage and is not in any token figure.
- Token changes are case-level medians: per case, treatment median / reference median - 1; then the median across cases. Negative is fewer tokens.
- Tokens before/after first edit: main-model usage up to and including the call that issued the first file edit across all sessions in order, and everything after it.
- Agent broad checks: whole-project build/typecheck/lint/test commands the agent issued (shell commands only), classified by the product classifier for every condition. In orchestrated conditions the verification guard refuses them; refused attempts are counted separately and did not run. The raw baseline has no guard.
- Dependency research: Read/Grep/Glob/shell accesses to node_modules/<dependency>, changelog/migration files, and registry queries.
- Agent wall: time inside agent sessions. Controller wall: pre-upgrade baseline measurement + controller verification. End-to-end: from the start of Drift analysis (or the first session) to the end of the controller.

- Run `controller-dev3-eslint-r1`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 1bb4379190fe, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev3-eslint-r2`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 1bb4379190fe, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev3-eslint-r3`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 1bb4379190fe, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev3-ethereum-r1`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 1bb4379190fe, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev3-ethereum-r2`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 1bb4379190fe, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev3-ethereum-r3`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 1bb4379190fe, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev3-winston-r1`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 1bb4379190fe, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev3-winston-r2`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 1bb4379190fe, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev3-winston-r3`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 1bb4379190fe, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Session environment fingerprint(s) across valid trials: 8d69d817761f3509.

## Accuracy

| Case | Raw | Generic orch. | Drift orch. |
| --- | ---: | ---: | ---: |
| aws-least-privilege-winston-3 | 3/3 | 3/3 | 2/3 |
| eth-ledger-bridge-keyring-ethereumjs-tx-5 | 3/3 | 3/3 | 2/3 |
| gh-aw-firewall-eslint-10 | 3/3 | 3/3 | 3/3 |
| **Total** | **9/9** | **9/9** | **7/9** |

Drift accuracy not below raw overall: **NO**; in every case: **NO**.

### Every failure

- `controller-dev3-winston-r3/aws-least-privilege-winston-3/drift-orchestrated/3` (Drift orch., rep 3): build_failure, hidden_regression_failure; controller ended no-progress
  - check failed: compile (tsc) — > tsc / node_modules/logform/index.d.ts(14,4): error TS1023: An index signature parameter type must be 'string' or 'number'.
  - hidden test failed: logger-behaviour — the project does not typecheck: / node_modules/logform/index.d.ts(14,4): error TS1023: An index signature parameter type must be 'string' or 'number'.
- `controller-dev3-ethereum-r2/eth-ledger-bridge-keyring-ethereumjs-tx-5/drift-orchestrated/2` (Drift orch., rep 2): prohibited_workaround; controller ended verified
  - workaround rule: Suppressing the type errors in the keyring with a directive is not a migration of it (the file's pre-existing ts-expect-error lines on the ethereumjs-tx v1 branch stay). Narrowed on 2026-09-16 from also forbidding any-typing, for the reason recorded on the winston case. (added in: src/ledger-keyring.ts)

## Tokens and activity by case (medians over valid trials)

### aws-least-privilege-winston-3

| | Raw | Generic orch. | Drift orch. |
| --- | ---: | ---: | ---: |
| Success | 3/3 | 3/3 | 2/3 |
| Gross input | 2,710,679 | 2,597,124 | 3,411,612 |
| Uncached input | 83,909 | 42,729 | 95,358 |
| Output | 14,986 | 19,775 | 34,911 |
| Model calls | 47 | 41 | 55 |
| Agent sessions | 1 | 1 | 3 |
| Agent tool calls | 46 | 40 | 56 |
| Agent broad checks | 11 | 2 | 2 |
| Agent narrow checks | 0 | 4 | 2 |
| Agent broad checks refused by the guard | 0 | 2 | 2 |
| Dependency research | 5 | 7 | 15 |
| Gross before first edit | 412,099 | 641,755 | 1,178,276 |
| Gross after first edit | 2,311,738 | 1,954,334 | 2,319,824 |
| Gross in repair sessions | 0 | 0 | 1,929,145 |
| Repair sessions | 0 | 0 | 2 |
| Files exposed per session | — | — | 1 |
| Files modified | 4 | 4 | 2 |
| Unique files read | 3 | 4 | 5 |
| Controller checks run | 0 | 4 | 10 |
| Agent wall | 451s | 449s | 673s |
| Controller wall | 0s | 70s | 134s |
| End-to-end wall | 451s | 518s | 872s |
| Drift analysis | 0s | 0s | 89s |
| Cost | $1.01 | $0.88 | $1.36 |
| Units (plan) | 0 | 0 | 2 |
| Units resolved deterministically | 0 | 0 | 0 |
| Units sent to agent | 0 | 0 | 1 |
| Units skipped (protected) | 0 | 0 | 0 |
| Units requiring repair | 0 | 0 | 0 |
| Out-of-scope rejections | 0 | 0 | 0 |

### eth-ledger-bridge-keyring-ethereumjs-tx-5

| | Raw | Generic orch. | Drift orch. |
| --- | ---: | ---: | ---: |
| Success | 3/3 | 3/3 | 2/3 |
| Gross input | 5,107,526 | 6,863,079 | 9,558,957 |
| Uncached input | 85,106 | 102,434 | 147,798 |
| Output | 26,244 | 32,309 | 39,804 |
| Model calls | 61 | 70 | 87 |
| Agent sessions | 1 | 1 | 2 |
| Agent tool calls | 63 | 69 | 87 |
| Agent broad checks | 12 | 1 | 2 |
| Agent narrow checks | 0 | 10 | 13 |
| Agent broad checks refused by the guard | 0 | 1 | 2 |
| Dependency research | 9 | 15 | 12 |
| Gross before first edit | 274,514 | 1,034,379 | 1,177,708 |
| Gross after first edit | 4,857,037 | 5,131,249 | 7,627,010 |
| Gross in repair sessions | 0 | 0 | 9,558,957 |
| Repair sessions | 0 | 0 | 2 |
| Files exposed per session | — | — | 15 |
| Files modified | 4 | 4 | 4 |
| Unique files read | 2 | 3 | 5 |
| Controller checks run | 0 | 6 | 12 |
| Agent wall | 699s | 665s | 1298s |
| Controller wall | 0s | 232s | 568s |
| End-to-end wall | 699s | 873s | 2060s |
| Drift analysis | 0s | 0s | 107s |
| Cost | $1.58 | $2.08 | $2.75 |
| Units (plan) | 0 | 0 | 1 |
| Units resolved deterministically | 0 | 0 | 0 |
| Units sent to agent | 0 | 0 | 0 |
| Units skipped (protected) | 0 | 0 | 1 |
| Units requiring repair | 0 | 0 | 0 |
| Out-of-scope rejections | 0 | 0 | 0 |

### gh-aw-firewall-eslint-10

| | Raw | Generic orch. | Drift orch. |
| --- | ---: | ---: | ---: |
| Success | 3/3 | 3/3 | 3/3 |
| Gross input | 9,150,040 | 8,480,972 | 8,231,940 |
| Uncached input | 90,068 | 108,670 | 150,367 |
| Output | 39,986 | 37,618 | 54,969 |
| Model calls | 107 | 91 | 117 |
| Agent sessions | 1 | 1 | 3 |
| Agent tool calls | 106 | 90 | 114 |
| Agent broad checks | 14 | 3 | 3 |
| Agent narrow checks | 3 | 14 | 11 |
| Agent broad checks refused by the guard | 0 | 3 | 3 |
| Dependency research | 11 | 10 | 19 |
| Gross before first edit | 809,315 | 1,215,430 | 1,734,875 |
| Gross after first edit | 8,339,756 | 6,877,498 | 6,226,475 |
| Gross in repair sessions | 0 | 0 | 7,888,165 |
| Repair sessions | 0 | 0 | 2 |
| Files exposed per session | — | 20 | 15 |
| Files modified | 12 | 12 | 11 |
| Unique files read | 9 | 11 | 11 |
| Controller checks run | 0 | 12 | 30 |
| Agent wall | 1553s | 1027s | 1118s |
| Controller wall | 0s | 248s | 306s |
| End-to-end wall | 1553s | 1191s | 1455s |
| Drift analysis | 0s | 0s | 13s |
| Cost | $2.57 | $2.48 | $2.72 |
| Units (plan) | 0 | 0 | 5 |
| Units resolved deterministically | 0 | 0 | 0 |
| Units sent to agent | 0 | 0 | 1 |
| Units skipped (protected) | 0 | 0 | 3 |
| Units requiring repair | 0 | 0 | 0 |
| Out-of-scope rejections | 0 | 0 | 0 |

## Case-level median changes

| Comparison | Paired cases | Gross input | 95% CI | Uncached input | Gross after first edit | Model calls | Per case (gross) | Successes (reference → treatment) |
| --- | ---: | ---: | --- | ---: | ---: | ---: | --- | --- |
| Generic vs Raw | 3 | -4.2% | [-39.9, 82.3] | +20.4% | -15.5% | -12.8% | winston-3 -4.2%; tx-5 +34.4%; eslint-10 -7.3% | 9 → 9 |
| Drift vs Raw | 3 | +25.9% | [-32.5, 89.2] | +66.9% | +0.3% | +17.0% | winston-3 +25.9%; tx-5 +87.2%; eslint-10 -10.0% | 9 → 7 |
| Drift vs Generic | 3 | +31.4% | [-29.0, 88.0] | +44.3% | +18.7% | +28.6% | winston-3 +31.4%; tx-5 +39.3%; eslint-10 -2.9% | 9 → 7 |

≥30% median gross reduction vs raw: **not met** (-25.9% reduction).

## Schedule and exclusions

- Raw: positions 3 / 3 / 3
- Generic orch.: positions 3 / 3 / 3
- Drift orch.: positions 3 / 3 / 3

Every slot holds a valid trial.
