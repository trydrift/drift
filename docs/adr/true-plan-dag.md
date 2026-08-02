# ADR: True Plan DAG

## Status

Accepted.

## Context

The old remediation plan behaved like a linear chain: each commit depended on
the previous one. That was easy to render but false. Independent files could not
run in parallel, while real prerequisites such as import moves, generated code,
runtime changes, and package cohorts were not represented explicitly.

## Decision

`CommitUnit` now has a stable id, `dependsOn` ids, dependency reasons,
execution layer, expected checks, allowed files/symbols, and invalidation
triggers. `PlanEdge` records why one unit precedes another. Layers are derived
topologically and can execute in parallel only when file scopes are disjoint and
there is no dependency relationship.

Cycles are blockers unless nodes can be safely collapsed into one atomic unit.
Adaptive replanning must rerun localization and expected checks after completed
layers and must stop with a blocker if convergence fails.

## Consequences

The plan is more accurate, more parallel, and easier to audit. It also means
serialized plans need schema-versioned readers and deterministic digests.
