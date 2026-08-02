# Positioning

Primary positioning:

> Drift is the evidence, impact, planning, and verification layer for dependency
> change.

Drift complements Dependabot, Renovate, Snyk, and coding agents.

- Dependabot and Renovate find candidate upgrades and open version-change PRs.
- Snyk and SCA tools prioritize known vulnerabilities and licence risk.
- Coding agents can edit code once a task is clear.
- Drift explains what changed, whether it reaches this repository, what is
  unchecked, how remediation work should be split, and which verification ran.

Drift is not an SCA replacement. It should consume SCA signals when available,
but its core job is dependency change intelligence: upstream evidence, local
impact, plan structure, execution boundaries, and verification.

Drift never auto-merges by default. Agent output always requires configured
verification. Behavioural testing is bounded and cannot prove universal
equivalence.

Preferred language:

- "No incompatible change detected in checked surfaces."
- "Incompatible change detected but not locally reachable."
- "Locally affected."
- "Insufficient evidence."
- "Verification incomplete."

Avoid "safe" unless naming a configured policy state that explicitly defines
what was checked.
