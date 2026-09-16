# Environment exclusions — v3-dev-eslint

## v3-dev-eslint/gh-aw-firewall-eslint-10/drift/2

- Moved unmodified to `trials/gh-aw-firewall-eslint-10__drift__rep-02.attempt-2.*` on 2026-09-16 after all slots had a trial; aggregation never reads `attempt-N` files.
- Session started 2026-09-16T21:25:10.909Z. Environment fingerprint `b24568bfb9cc0f74`; every other valid trial of the v3 experiment (34 of 36) has `8d69d817761f3509`.
- The difference: the session's tool list contained two additional built-in Claude Code tools, `ArtifactComments` and `ArtifactData` (26 tools instead of 24). No local configuration changed; sessions before and after it did not have them, which is consistent with a server-side feature flag toggling for the account.
- Rule applied: sessions whose loaded environment differs from the experiment's are not pooled (`compare` refused), and the slot is rerun. The rule is independent of outcome; this trial was recorded as **success** with 30,068,523 gross input tokens.
