# ADR: Behavioural Differential Testing

## Status

Accepted as experimental.

## Context

Compile-time and static evidence cannot prove every behavioural compatibility
question. Some dependency upgrades preserve types while changing return values,
defaults, exceptions, async behavior, serialization, mutation, or side effects.

## Decision

Drift adds a bounded npm/TypeScript differential framework behind conservative
configuration defaults. It selects locally reachable changed APIs, runs old and
new package environments separately, disables network by default, bounds CPU,
memory, process, output, and wall-clock time, and records observations as
evidence.

No observed difference is not proof of compatibility. It can only raise
verification confidence for the specific contract and generated input domain
that was exercised.

## Consequences

Behavioural probes improve evidence for a narrow class of changes while keeping
dependency code treated as untrusted. Wider ecosystem support and stronger
isolation backends should be added incrementally and benchmarked before being
marketed as production-ready.
