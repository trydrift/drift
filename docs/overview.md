# Why Drift

Drift exists to answer the question dependency bots usually leave to a human: **a dependency changed, but did it actually break this repository?**

Dependabot and Renovate are good at telling you that a version moved. That is not the same as telling you whether the code you own still works. Drift fills that gap by gathering evidence about what changed upstream, finding where those changes intersect with this repository, explaining whether the upgrade is worth taking, and preparing a reviewable fix when needed.

The intended flow is:

```text
dependency bump → what changed upstream? → where does it bite here? → is it worth it? → fix it
     detect             evidence                  localize              rationale       dispatch
```

Drift does not merge changes for you.

## What Drift optimizes for

Drift is designed around a few principles:

- **Evidence over model recall.** Findings should be backed by release notes, changelogs, computed API diffs, or other inspectable sources.
- **Repository-specific impact.** A breaking change is only relevant if this repository actually uses the changed surface.
- **Deterministic work first.** Mechanical changes should be handled by Drift itself or a validated fix plan before an AI agent is involved.
- **Reviewable output.** Fixes are separated into meaningful commits and surfaced for human review.
- **Uncertainty stays visible.** Missing evidence or unavailable toolchains are reported as gaps rather than silently treated as safe.
- **Approval by default.** The GitHub Action starts in approval mode; autonomy is opt-in.

The failure mode Drift aims for is asking a human too often, not editing code it cannot justify.

## Why computed evidence matters

Version numbers and prose changelogs are incomplete descriptions of public API changes. Drift therefore computes package surfaces where the ecosystem makes that practical and compares what was actually shipped.

Depending on the ecosystem, that can include TypeScript declarations, Go exports, rustdoc output, JVM or .NET metadata, public C/C++ headers, Dart libraries, or Hex exports. Where a strong computed surface is unavailable, Drift falls back to other evidence and says so explicitly.

See [Supported ecosystems](support.md) for the exact capabilities by ecosystem and [Architecture](architecture.md) for implementation details.

## Why localization matters

A dependency can have many breaking changes without affecting a given repository. Drift narrows findings to code that imports or otherwise depends on the changed package, then reports the relevant files and call sites.

This is the distinction the product is built around: **breaking upstream** is not the same as **breaking here**.

## Why remediation is staged

For each affected change, Drift prefers the lowest-risk remediation path available:

1. a deterministic transform;
2. a validated [fix plan](fix-plans.md);
3. an external AI agent for what remains.

That ordering keeps straightforward migrations reproducible and limits agent work to cases that genuinely require interpretation.

## Trust and safety

Drift's analysis can be evaluated without granting repository write access. `drift analyze` and the default form of `drift outdated` are read-only against the checkout.

When Drift does prepare changes, it uses isolated worktrees, explicit branch/PR flows, and guardrails that downgrade automation to human review rather than silently skipping the result.

For the threat model, credential handling, verification model, protected paths, and agent boundaries, see [Trust & safety](trust-and-safety.md) and [Agent security boundaries](security/agent-boundaries.md).

## Research foundation

Drift's localization design is informed by the Meta-RAG approach described in *LLM Agents for Automated Dependency Upgrades*. Drift differs from that work in several deliberate ways, including computed breaking-change evidence, structural summaries, and reviewable commit/PR output.

See [Research mapping](research.md) for the detailed comparison and [Benchmarks](../eval/README.md) for evaluation results and limitations.

## Validation

Drift is tested against captured real-repository upgrade scenarios as regression coverage in addition to its unit and integration tests. The project also publishes live replays of representative runs so the evidence and decisions can be inspected rather than treated as a marketing mock-up.

See [Testing on a real repo](testing-on-a-real-repo.md) and the [live demos](https://trydrift.github.io/drift/).

## Status

Drift is currently an MVP. Known limitations are documented rather than hidden; see [Architecture — known limitations](architecture.md#known-limitations).

## License

Drift is free and source-available under the PolyForm Shield 1.0.0 license. You may read it, run it, modify it, and use it at work; the license restricts using Drift to build a competing product.

See [LICENSE](../LICENSE) for the license text.
