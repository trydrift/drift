# Controller-owned remediation: controller-dev-superseded

Generated 2026-09-17T07:23:04.710Z.

- Development cases only (they informed the architecture). Nothing here is held-out evidence or a public claim.
- Tiny sample: 3 case(s). Bootstrap intervals are shown but are wide by construction.
- Tokens are provider-reported. For orchestrated conditions every session is summed (open, unit and repair sessions); controller verification is not model usage and is not in any token figure.
- Token changes are case-level medians: per case, treatment median / reference median - 1; then the median across cases. Negative is fewer tokens.
- Tokens before/after first edit: main-model usage up to and including the call that issued the first file edit across all sessions in order, and everything after it.
- Agent broad checks: whole-project build/typecheck/lint/test commands the agent issued (shell commands only), classified by the product classifier for every condition. In orchestrated conditions the verification guard refuses them; refused attempts are counted separately and did not run. The raw baseline has no guard.
- Dependency research: Read/Grep/Glob/shell accesses to node_modules/<dependency>, changelog/migration files, and registry queries.
- Agent wall: time inside agent sessions. Controller wall: pre-upgrade baseline measurement + controller verification. End-to-end: from the start of Drift analysis (or the first session) to the end of the controller.

- Run `controller-dev-eslint-r1`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 8a1b536db17e, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev-eslint-r2`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 8a1b536db17e, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev-ethereum-r1`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 8a1b536db17e, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev-ethereum-r2`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 8a1b536db17e, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev-ethereum-r3`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 8a1b536db17e, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev-winston-r1`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 8a1b536db17e, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev-winston-r2`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 8a1b536db17e, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev-winston-r3`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 8a1b536db17e, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Session environment fingerprint(s) across valid trials: 8d69d817761f3509.

## Accuracy

| Case | Raw | Generic orch. | Drift orch. |
| --- | ---: | ---: | ---: |
| aws-least-privilege-winston-3 | 2/3 | 2/3 | 3/3 |
| eth-ledger-bridge-keyring-ethereumjs-tx-5 | 1/3 | 1/3 | 2/3 |
| gh-aw-firewall-eslint-10 | 1/2 | 2/2 | 1/2 |
| **Total** | **4/8** | **5/8** | **6/8** |

Drift accuracy not below raw overall: **yes**; in every case: **yes**.

### Every failure

- `controller-dev-winston-r2/aws-least-privilege-winston-3/baseline/2` (Raw, rep 2): build_failure, existing_test_failure, hidden_regression_failure, install_failure
  - install failed (lockfile invalid or out of sync): npm error code EUSAGE
npm error
npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.
npm error
npm error Invalid: lock file's @types/node@6.0.117 does not satisfy @types/node@18.19.130
npm error Invalid: lock file's typescript@3.0.3 does not satisfy typescript@5.9.3
npm error Missing: undici-types@5.26.5 from lock file
npm error
npm error Clean install a project
npm error
npm error Usage:
npm error npm ci
npm error
npm error Options:
npm error [--install-s
  - check failed: compile (tsc) — not run: install failed
  - check failed: unit tests (offline subset) — not run: install failed
  - hidden test failed: logger-behaviour — not run: install failed
- `controller-dev-winston-r3/aws-least-privilege-winston-3/generic-orchestrated/3` (Generic orch., rep 3): build_failure, hidden_regression_failure; controller ended unrepairable
  - check failed: compile (tsc) — > tsc / node_modules/logform/index.d.ts(14,4): error TS1023: An index signature parameter type must be 'string' or 'number'.
  - hidden test failed: logger-behaviour — the project does not typecheck: / node_modules/logform/index.d.ts(14,4): error TS1023: An index signature parameter type must be 'string' or 'number'.
- `controller-dev-ethereum-r1/eth-ledger-bridge-keyring-ethereumjs-tx-5/baseline/1` (Raw, rep 1): hidden_regression_failure
  - hidden test failed: keyring-signing —       a / … (193 more characters)
- `controller-dev-ethereum-r3/eth-ledger-bridge-keyring-ethereumjs-tx-5/baseline/3` (Raw, rep 3): prohibited_workaround
  - workaround rule: Coverage thresholds, the package-manager policy and compiler strictness are not part of this migration. (changed: jest.config.js)
- `controller-dev-ethereum-r3/eth-ledger-bridge-keyring-ethereumjs-tx-5/drift-orchestrated/3` (Drift orch., rep 3): existing_test_failure; controller ended no-progress
  - check failed: jest (with the project's coverage thresholds) — Time:        5.875 s / Ran all test suites.
- `controller-dev-ethereum-r1/eth-ledger-bridge-keyring-ethereumjs-tx-5/generic-orchestrated/1` (Generic orch., rep 1): existing_test_failure; controller ended unrepairable
  - check failed: jest (with the project's coverage thresholds) — Time:        9.8 s / Ran all test suites.
- `controller-dev-ethereum-r2/eth-ledger-bridge-keyring-ethereumjs-tx-5/generic-orchestrated/2` (Generic orch., rep 2): hidden_regression_failure; controller ended verified
  - hidden test failed: keyring-signing —       at  / … (191 more characters)
- `controller-dev-eslint-r1/gh-aw-firewall-eslint-10/baseline/1` (Raw, rep 1): existing_test_failure, prohibited_workaround
  - check failed: custom rule RuleTester test — } / Node.js v24.20.0
  - workaround rule: The custom rule and its RuleTester test must still exist. (missing: eslint-rules/no-unsafe-execa.test.js)
- `controller-dev-eslint-r1/gh-aw-firewall-eslint-10/drift-orchestrated/1` (Drift orch., rep 1): lint_failure; controller ended no-progress
  - check failed: eslint on src —     14:23  warning  Unexpected any. Specify a different type                                    @typescr / … (28778 more characters)

## Tokens and activity by case (medians over valid trials)

### aws-least-privilege-winston-3

| | Raw | Generic orch. | Drift orch. |
| --- | ---: | ---: | ---: |
| Success | 2/3 | 2/3 | 3/3 |
| Gross input | 3,162,112 | 1,642,959 | 1,469,909 |
| Uncached input | 52,520 | 32,964 | 57,284 |
| Output | 21,993 | 12,752 | 16,901 |
| Model calls | 49 | 29 | 27 |
| Agent sessions | 1 | 1 | 3 |
| Agent tool calls | 48 | 28 | 25 |
| Agent broad checks | 13 | 1 | 2 |
| Agent narrow checks | 0 | 3 | 2 |
| Agent broad checks refused by the guard | 0 | 1 | 2 |
| Dependency research | 6 | 6 | 7 |
| Gross before first edit | 615,639 | 576,335 | 461,270 |
| Gross after first edit | 2,572,603 | 882,609 | 820,497 |
| Gross in repair sessions | 0 | 0 | 321,834 |
| Repair sessions | 0 | 0 | 2 |
| Files exposed per session | — | — | 1 |
| Files modified | 4 | 2 | 2 |
| Unique files read | 3 | 3 | 5 |
| Controller checks run | 0 | 2 | 8 |
| Agent wall | 479s | 253s | 252s |
| Controller wall | 0s | 30s | 58s |
| End-to-end wall | 479s | 282s | 358s |
| Drift analysis | 0s | 0s | 44s |
| Cost | $1.06 | $0.58 | $0.65 |
| Units (plan) | 0 | 0 | 2 |
| Units resolved deterministically | 0 | 0 | 0 |
| Units sent to agent | 0 | 0 | 1 |
| Units skipped (protected) | 0 | 0 | 0 |
| Units requiring repair | 0 | 0 | 0 |
| Out-of-scope rejections | 0 | 0 | 0 |

### eth-ledger-bridge-keyring-ethereumjs-tx-5

| | Raw | Generic orch. | Drift orch. |
| --- | ---: | ---: | ---: |
| Success | 1/3 | 1/3 | 2/3 |
| Gross input | 5,988,046 | 8,491,824 | 6,830,953 |
| Uncached input | 84,742 | 98,417 | 139,815 |
| Output | 26,276 | 35,872 | 53,742 |
| Model calls | 68 | 86 | 77 |
| Agent sessions | 1 | 1 | 2 |
| Agent tool calls | 67 | 89 | 75 |
| Agent broad checks | 12 | 1 | 2 |
| Agent narrow checks | 0 | 11 | 7 |
| Agent broad checks refused by the guard | 0 | 1 | 2 |
| Dependency research | 8 | 18 | 18 |
| Gross before first edit | 918,132 | 1,681,623 | 2,166,269 |
| Gross after first edit | 5,464,420 | 5,768,988 | 4,652,959 |
| Gross in repair sessions | 0 | 0 | 6,830,953 |
| Repair sessions | 0 | 0 | 2 |
| Files exposed per session | — | — | 5 |
| Files modified | 4 | 4 | 4 |
| Unique files read | 4 | 5 | 6 |
| Controller checks run | 0 | 3 | 9 |
| Agent wall | 591s | 798s | 817s |
| Controller wall | 0s | 120s | 186s |
| End-to-end wall | 591s | 912s | 1085s |
| Drift analysis | 0s | 0s | 55s |
| Cost | $1.78 | $2.45 | $2.40 |
| Units (plan) | 0 | 0 | 1 |
| Units resolved deterministically | 0 | 0 | 0 |
| Units sent to agent | 0 | 0 | 0 |
| Units skipped (protected) | 0 | 0 | 1 |
| Units requiring repair | 0 | 0 | 0 |
| Out-of-scope rejections | 0 | 0 | 0 |

### gh-aw-firewall-eslint-10

| | Raw | Generic orch. | Drift orch. |
| --- | ---: | ---: | ---: |
| Success | 1/2 | 2/2 | 1/2 |
| Gross input | 7,141,795 | 9,143,155 | 9,797,529 |
| Uncached input | 80,818 | 88,151 | 331,150 |
| Output | 31,161 | 40,963 | 76,642 |
| Model calls | 87 | 107 | 167 |
| Agent sessions | 1 | 1 | 13 |
| Agent tool calls | 87 | 106 | 156 |
| Agent broad checks | 17 | 4 | 9 |
| Agent narrow checks | 2 | 19 | 30 |
| Agent broad checks refused by the guard | 0 | 4 | 9 |
| Dependency research | 12 | 13 | 27 |
| Gross before first edit | 1,525,091 | 1,263,049 | 531,381 |
| Gross after first edit | 5,615,735 | 7,879,070 | 9,205,319 |
| Gross in repair sessions | 0 | 0 | 9,479,739 |
| Repair sessions | 0 | 0 | 12 |
| Files exposed per session | — | — | 6 |
| Files modified | 12 | 12 | 10 |
| Unique files read | 10 | 10 | 11 |
| Controller checks run | 0 | 6 | 63 |
| Agent wall | 661s | 851s | 1482s |
| Controller wall | 0s | 80s | 365s |
| End-to-end wall | 661s | 931s | 1897s |
| Drift analysis | 0s | 0s | 11s |
| Cost | $2.04 | $2.57 | $3.80 |
| Units (plan) | 0 | 0 | 5 |
| Units resolved deterministically | 0 | 0 | 0 |
| Units sent to agent | 0 | 0 | 1 |
| Units skipped (protected) | 0 | 0 | 3 |
| Units requiring repair | 0 | 0 | 1 |
| Out-of-scope rejections | 0 | 0 | 0 |

## Case-level median changes

| Comparison | Paired cases | Gross input | 95% CI | Uncached input | Gross after first edit | Model calls | Per case (gross) | Successes (reference → treatment) |
| --- | ---: | ---: | --- | ---: | ---: | ---: | --- | --- |
| Generic vs Raw | 3 | +28.0% | [-53.3, 43.7] | +9.1% | +5.6% | +23.0% | winston-3 -48.0%; tx-5 +41.8%; eslint-10 +28.0% | 4 → 5 |
| Drift vs Raw | 3 | +14.1% | [-58.2, 53.1] | +65.0% | -14.8% | +13.2% | winston-3 -53.5%; tx-5 +14.1%; eslint-10 +37.2% | 4 → 6 |
| Drift vs Generic | 3 | -10.5% | [-21.4, 30.6] | +73.8% | -7.0% | -6.9% | winston-3 -10.5%; tx-5 -19.6%; eslint-10 +7.2% | 5 → 6 |

≥30% median gross reduction vs raw: **not met** (-14.1% reduction).

## Schedule and exclusions

- Raw: positions 3 / 2 / 3
- Generic orch.: positions 3 / 3 / 2
- Drift orch.: positions 2 / 3 / 3

Every slot holds a valid trial.
