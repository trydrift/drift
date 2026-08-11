# Vision

## The goal

Dependencies change. Your codebase should adapt.

Drift is building the layer between an upstream dependency change and the
codebase that consumes it: understand what changed, determine whether the
repository is affected, and prepare the smallest reviewable fix.

## Why this layer is missing

Version-update tools know that a version moved. Coding agents know how to edit
code. The missing piece is deciding what the upstream change actually means
for *this* repository, with enough evidence and precision that an automated
edit is worth reviewing.

That is what the pipeline in [docs/architecture.md](architecture.md) does:
evidence, then impact, then a plan, before anything is ever edited.

## Self-maintaining software

The long-term goal is not autonomous merging. It is removing the manual glue
between "this dependency changed" and "here is the exact patch this repository
needs."

Drift keeps the final decision inside the review process a team already has: a
developer, a pull request, and the repository's own checks. See
[docs/trust-and-safety.md](trust-and-safety.md) for how that boundary is
enforced.

## Inspiration

This direction is closely aligned with Y Combinator's Fall 2026 Request for
Startups, ["Self-Maintaining APIs"](https://www.ycombinator.com/rfs), which
describes an application layer that connects upstream API changes to consumer
codebases and prepares the corresponding fixes. Drift generalizes that idea
across package ecosystems, not just APIs.
