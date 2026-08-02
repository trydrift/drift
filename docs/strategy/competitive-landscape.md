# Competitive Landscape

Drift sits between dependency update tools, security scanners, and coding
agents.

## Dependabot and Renovate

They are excellent candidate generators. Drift should consume their PRs where
possible instead of replacing their version selection and scheduling machinery.
The gap Drift fills is evidence-backed interpretation: what changed upstream,
which local call sites are reachable, what confidence and gaps exist, and how a
repair should be planned and verified.

## Snyk and SCA Platforms

SCA tools answer vulnerability, licence, and inventory questions. Drift is not
an SCA replacement. Security rationale is one input into upgrade priority, while
breaking-change evidence and local impact remain separate dimensions.

## Coding Agents

Agents are powerful executors but weak change-intelligence systems by default.
Drift should give agents narrow, cited, plan-bound tasks, isolated worktrees,
allowed-file constraints, and configured checks. Agent output is never accepted
because it "looks right"; it is accepted only after boundary validation and
verification.

## Hosted Code-Modernization Services

These compete most directly in enterprise budgets. Drift's differentiation is a
defensible evidence model, transparent gaps, deterministic local mode, open-core
benchmarks, and plan DAGs that can drive any agent rather than one proprietary
executor.
