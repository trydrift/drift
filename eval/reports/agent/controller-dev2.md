# Controller-owned remediation: controller-dev2

Generated 2026-09-17T09:01:47.964Z.

- Development cases only (they informed the architecture). Nothing here is held-out evidence or a public claim.
- Tiny sample: 3 case(s). Bootstrap intervals are shown but are wide by construction.
- Tokens are provider-reported. For orchestrated conditions every session is summed (open, unit and repair sessions); controller verification is not model usage and is not in any token figure.
- Token changes are case-level medians: per case, treatment median / reference median - 1; then the median across cases. Negative is fewer tokens.
- Tokens before/after first edit: main-model usage up to and including the call that issued the first file edit across all sessions in order, and everything after it.
- Agent broad checks: whole-project build/typecheck/lint/test commands the agent issued (shell commands only), classified by the product classifier for every condition. In orchestrated conditions the verification guard refuses them; refused attempts are counted separately and did not run. The raw baseline has no guard.
- Dependency research: Read/Grep/Glob/shell accesses to node_modules/<dependency>, changelog/migration files, and registry queries.
- Agent wall: time inside agent sessions. Controller wall: pre-upgrade baseline measurement + controller verification. End-to-end: from the start of Drift analysis (or the first session) to the end of the controller.

- Run `controller-dev2-eslint-r1`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 2daf69592ff4, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev2-eslint-r2`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 2daf69592ff4, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev2-eslint-r3`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 2daf69592ff4, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev2-ethereum-r1`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 2daf69592ff4, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev2-ethereum-r2`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 2daf69592ff4, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev2-ethereum-r3`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 2daf69592ff4, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev2-winston-r1`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 2daf69592ff4, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev2-winston-r2`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 2daf69592ff4, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Run `controller-dev2-winston-r3`: claude-sonnet-5, effort high, 2.1.267 (Claude Code), Drift 2daf69592ff4, isolated sessions, 3 repetition(s), conditions baseline, generic-orchestrated, drift-orchestrated.
- Session environment fingerprint(s) across valid trials: 8d69d817761f3509.

## Accuracy

| Case | Raw | Generic orch. | Drift orch. |
| --- | ---: | ---: | ---: |
| aws-least-privilege-winston-3 | 3/3 | 3/3 | 3/3 |
| eth-ledger-bridge-keyring-ethereumjs-tx-5 | 2/3 | 3/3 | 2/3 |
| gh-aw-firewall-eslint-10 | 3/3 | 3/3 | 1/3 |
| **Total** | **8/9** | **9/9** | **6/9** |

Drift accuracy not below raw overall: **NO**; in every case: **NO**.

### Every failure

- `controller-dev2-ethereum-r1/eth-ledger-bridge-keyring-ethereumjs-tx-5/baseline/1` (Raw, rep 1): prohibited_workaround
  - workaround rule: Coverage thresholds, the package-manager policy and compiler strictness are not part of this migration. (changed: jest.config.js)
- `controller-dev2-ethereum-r3/eth-ledger-bridge-keyring-ethereumjs-tx-5/drift-orchestrated/3` (Drift orch., rep 3): hidden_regression_failure; controller ended verified
  - hidden test failed: keyring-signing —       at LedgerKeyring._LedgerKeyring_signTransaction (src/ledger-keyring.ts:385:28) / … (275 more characters)
- `controller-dev2-eslint-r2/gh-aw-firewall-eslint-10/drift-orchestrated/2` (Drift orch., rep 2): hidden_regression_failure, lint_failure; controller ended verified
  - check failed: eslint on src —     https://eslint.org/docs/latest/use/configure/configuration-files#specify-files-with-arbitrary-extensions /   * If the file is ignored because it is located outside of the base path, change the location of your config file to be in a par
  - hidden test failed: lint-config-behaviour — - the project's own no-unsafe-execa rule did not fire on unsafe-execa.ts: [] / - expected 4 fixture files in the report, got 0 (the fixtures directory may be ignored by the configuration)
- `controller-dev2-eslint-r3/gh-aw-firewall-eslint-10/drift-orchestrated/3` (Drift orch., rep 3): hidden_regression_failure, lint_failure; controller ended no-progress
  - check failed: eslint on src — If you still have problems after following the migration guide, please stop by / https://eslint.org/chat/help to chat with the team.
  - hidden test failed: lint-config-behaviour — - the project's own no-unsafe-execa rule did not fire on unsafe-execa.ts: [] / - expected 4 fixture files in the report, got 0 (the fixtures directory may be ignored by the configuration)

## Tokens and activity by case (medians over valid trials)

### aws-least-privilege-winston-3

| | Raw | Generic orch. | Drift orch. |
| --- | ---: | ---: | ---: |
| Success | 3/3 | 3/3 | 3/3 |
| Gross input | 2,979,693 | 2,484,475 | 1,339,010 |
| Uncached input | 53,182 | 46,058 | 59,212 |
| Output | 18,513 | 19,338 | 16,514 |
| Model calls | 45 | 42 | 25 |
| Agent sessions | 1 | 1 | 3 |
| Agent tool calls | 45 | 41 | 24 |
| Agent broad checks | 9 | 2 | 3 |
| Agent narrow checks | 0 | 7 | 1 |
| Agent broad checks refused by the guard | 0 | 2 | 3 |
| Dependency research | 5 | 5 | 8 |
| Gross before first edit | 668,651 | 501,783 | 636,879 |
| Gross after first edit | 2,227,116 | 1,981,657 | 608,522 |
| Gross in repair sessions | 0 | 0 | 416,320 |
| Repair sessions | 0 | 0 | 2 |
| Files exposed per session | — | — | 1 |
| Files modified | 4 | 4 | 2 |
| Unique files read | 4 | 3 | 4 |
| Controller checks run | 0 | 2 | 8 |
| Agent wall | 403s | 426s | 254s |
| Controller wall | 0s | 40s | 60s |
| End-to-end wall | 403s | 482s | 355s |
| Drift analysis | 0s | 0s | 37s |
| Cost | $0.98 | $0.83 | $0.63 |
| Units (plan) | 0 | 0 | 2 |
| Units resolved deterministically | 0 | 0 | 0 |
| Units sent to agent | 0 | 0 | 1 |
| Units skipped (protected) | 0 | 0 | 0 |
| Units requiring repair | 0 | 0 | 0 |
| Out-of-scope rejections | 0 | 0 | 0 |

### eth-ledger-bridge-keyring-ethereumjs-tx-5

| | Raw | Generic orch. | Drift orch. |
| --- | ---: | ---: | ---: |
| Success | 2/3 | 3/3 | 2/3 |
| Gross input | 7,055,471 | 8,630,587 | 4,625,032 |
| Uncached input | 96,051 | 109,760 | 122,025 |
| Output | 32,455 | 43,959 | 38,935 |
| Model calls | 74 | 77 | 59 |
| Agent sessions | 1 | 1 | 2 |
| Agent tool calls | 74 | 79 | 57 |
| Agent broad checks | 12 | 1 | 2 |
| Agent narrow checks | 0 | 3 | 7 |
| Agent broad checks refused by the guard | 0 | 1 | 2 |
| Dependency research | 10 | 18 | 16 |
| Gross before first edit | 252,540 | 1,956,045 | 1,811,445 |
| Gross after first edit | 6,520,464 | 6,383,786 | 3,236,719 |
| Gross in repair sessions | 0 | 0 | 4,625,032 |
| Repair sessions | 0 | 0 | 2 |
| Files exposed per session | — | — | 5 |
| Files modified | 4 | 4 | 4 |
| Unique files read | 3 | 6 | 4 |
| Controller checks run | 0 | 3 | 9 |
| Agent wall | 810s | 897s | 689s |
| Controller wall | 0s | 133s | 181s |
| End-to-end wall | 810s | 1036s | 959s |
| Drift analysis | 0s | 0s | 56s |
| Cost | $2.13 | $2.58 | $1.74 |
| Units (plan) | 0 | 0 | 1 |
| Units resolved deterministically | 0 | 0 | 0 |
| Units sent to agent | 0 | 0 | 0 |
| Units skipped (protected) | 0 | 0 | 1 |
| Units requiring repair | 0 | 0 | 0 |
| Out-of-scope rejections | 0 | 0 | 0 |

### gh-aw-firewall-eslint-10

| | Raw | Generic orch. | Drift orch. |
| --- | ---: | ---: | ---: |
| Success | 3/3 | 3/3 | 1/3 |
| Gross input | 7,906,981 | 10,828,359 | 3,868,801 |
| Uncached input | 92,278 | 104,978 | 114,759 |
| Output | 34,992 | 48,918 | 36,517 |
| Model calls | 94 | 113 | 66 |
| Agent sessions | 1 | 1 | 4 |
| Agent tool calls | 94 | 113 | 62 |
| Agent broad checks | 17 | 4 | 2 |
| Agent narrow checks | 1 | 15 | 7 |
| Agent broad checks refused by the guard | 0 | 4 | 2 |
| Dependency research | 11 | 18 | 12 |
| Gross before first edit | 1,417,708 | 1,300,980 | 503,913 |
| Gross after first edit | 6,336,754 | 9,053,769 | 3,256,899 |
| Gross in repair sessions | 0 | 0 | 3,519,509 |
| Repair sessions | 0 | 0 | 3 |
| Files exposed per session | — | 9 | 5 |
| Files modified | 12 | 12 | 4 |
| Unique files read | 6 | 12 | 4 |
| Controller checks run | 0 | 6 | 30 |
| Agent wall | 806s | 953s | 688s |
| Controller wall | 0s | 87s | 197s |
| End-to-end wall | 806s | 1042s | 944s |
| Drift analysis | 0s | 0s | 10s |
| Cost | $2.25 | $3.05 | $1.44 |
| Units (plan) | 0 | 0 | 5 |
| Units resolved deterministically | 0 | 0 | 0 |
| Units sent to agent | 0 | 0 | 1 |
| Units skipped (protected) | 0 | 0 | 3 |
| Units requiring repair | 0 | 0 | 0 |
| Out-of-scope rejections | 0 | 0 | 0 |

## Case-level median changes

| Comparison | Paired cases | Gross input | 95% CI | Uncached input | Gross after first edit | Model calls | Per case (gross) | Successes (reference → treatment) |
| --- | ---: | ---: | --- | ---: | ---: | ---: | --- | --- |
| Generic vs Raw | 3 | +22.3% | [-18.5, 42.1] | +13.8% | -2.1% | +4.1% | winston-3 -16.6%; tx-5 +22.3%; eslint-10 +36.9% | 8 → 9 |
| Drift vs Raw | 3 | -51.1% | [-68.7, -2.2] | +24.4% | -50.4% | -29.8% | winston-3 -55.1%; tx-5 -34.4%; eslint-10 -51.1% | 8 → 6 |
| Drift vs Generic | 3 | -46.4% | [-68.1, -6.5] | +11.2% | -64.0% | -40.5% | winston-3 -46.1%; tx-5 -46.4%; eslint-10 -64.3% | 9 → 6 |

≥30% median gross reduction vs raw: **met** (51.1% reduction).

## Schedule and exclusions

- Raw: positions 3 / 3 / 3
- Generic orch.: positions 3 / 3 / 3
- Drift orch.: positions 3 / 3 / 3

Every slot holds a valid trial.
