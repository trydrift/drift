# ADR: Evidence Confidence Model

## Status

Accepted.

## Context

A single `high`/`medium`/`low` confidence field conflated different questions:
whether an upstream change happened, whether it reaches local code, and whether
anything verified the proposed repair.

## Decision

Confidence is split into upstream, local-impact, and verification assessments.
Each score carries a 0-1 value, display band, contributing evidence, penalties,
and calibration version. Gaps are first-class records and unchecked surfaces are
not clean results.

Taxonomy is recorded separately from remediation strategy: nature,
detectability, scope, and visibility explain what changed, while
`BreakingChangeKind` continues to guide repair.

## Consequences

Reports can say "incompatible change detected but not locally reachable" or
"verification incomplete" without implying safety. Automatic execution blocks on
low-confidence actionable findings unless an explicitly experimental opt-in is
configured.
