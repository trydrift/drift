# Environment exclusions — v3-dev-ethereum

## v3-dev-ethereum/eth-ledger-bridge-keyring-ethereumjs-tx-5/drift-agent-brief/3

- Moved unmodified to `trials/eth-ledger-bridge-keyring-ethereumjs-tx-5__drift-agent-brief__rep-03.attempt-2.*` on 2026-09-16 after all slots had a trial; aggregation never reads `attempt-N` files.
- Session started 2026-09-16T22:12:17.253Z. Environment fingerprint `b24568bfb9cc0f74`; every other valid trial of the v3 experiment (34 of 36) has `8d69d817761f3509`.
- The difference: the session's tool list contained two additional built-in Claude Code tools, `ArtifactComments` and `ArtifactData` (26 tools instead of 24). No local configuration changed; sessions before and after it did not have them, which is consistent with a server-side feature flag toggling for the account.
- Rule applied: sessions whose loaded environment differs from the experiment's are not pooled (`compare` refused), and the slot is rerun. The rule is independent of outcome; this trial was recorded as **success** with 4,986,312 gross input tokens.
