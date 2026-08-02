# Schema versions and migration

Drift serializes two things that outlive the run that produced them: the
**remediation plan** and the **approval-issue footer** that identifies it. Both
carry an explicit version so a consumer can tell whether it understands what it
is reading rather than misinterpreting a newer format as a corrupt older one.

```
RemediationPlan.schemaVersion   // the plan shape
<!-- drift-schema: N -->        // the same number, recorded on the approval issue
```

Both are `PLAN_SCHEMA_VERSION`, exported from `src/approval/digest.ts`.

---

## Why a version at all

The plan digest is a SHA-256 over a canonical serialization of the whole plan.
Approving an issue approves one specific plan, and Drift refuses to execute one
whose digest does not match what the issue recorded.

That check is only meaningful if both sides serialize the same way. Change what
goes into the canonical form and every outstanding approval starts failing —
with a message saying *the plan changed*, which would be false and actively
misleading. The version turns that into a truthful, actionable answer:

> This issue records plan schema v2, which this version of Drift cannot verify
> (it supports v3). Re-run Drift to generate a current plan.

---

## Version history

### v3 — true remediation DAG

Added by `feat(planner): replace linear commit chain with dependency DAG`.

| Field | Where | Meaning |
|---|---|---|
| `id` | `CommitUnit` | Stable unit identity used by graph edges |
| `allowedFiles` | `CommitUnit` | Authoritative edit scope; `files` remains a compatibility view |
| `allowedSymbols` | `CommitUnit` | Symbol-level scope when localization can name it |
| `dependsOn` | `CommitUnit` | Prerequisite commit unit ids, not display order numbers |
| `dependencyReasons` | `CommitUnit` | Incoming `PlanEdge` records for local consumers |
| `executionLayer` | `CommitUnit` | Deterministic topological layer |
| `expectedChecks` | `CommitUnit` | Verification expected before accepting the unit |
| `invalidationTriggers` | `CommitUnit` | File, symbol, and dependency changes that force replanning |
| `planEdges` | `RemediationPlan` | Full remediation DAG |
| `upgradeCohorts` | `RemediationPlan` | Dependency groups that should move together |

The digest includes the graph, layers, edit scopes, expected checks, and cohorts.
Approving a plan now approves the exact execution graph, not just a displayed
list of commits. `CommitUnit.order` is retained only as a deterministic display
order; consumers that enforce execution must use ids and edges.

### v2 — taxonomy and calibrated confidence

Added by `feat(evidence): classify breaking changes and calibrate confidence`.

| Field | Where | Meaning |
|---|---|---|
| `schemaVersion` | `RemediationPlan` | This number |
| `taxonomy` | `BreakingChange` | Nature, detectability, scope, visibility |
| `assessment` | `BreakingChange` | Upstream, local-impact, and verification confidence |
| `gaps` | `RemediationPlan` | Surfaces Drift could not establish |
| `checkedSurfaces` | `RemediationPlan` | Surfaces it did establish, and how |

`taxonomy` and `assessment` are part of the digest. Classification is part of
what a reviewer approved — the same removal reclassified from compile-time to
runtime-only is a materially different thing to accept — and so are the
confidence *scores*, though not the prose explaining them: rewording an
explanation must not invalidate an approval, but a changed score must.

`gaps` are digested too, by shape rather than wording. Approving a plan is
partly approving what it says it could not check, so a plan that quietly lost a
gap between filing and execution is not the plan that was read.

### v1 — initial

Plan identity, introduced by
`fix(security): bind approvals to authorized users and analyzed plans`.

---

## Migration

**There is no automatic upgrade of an older approval issue, by design.** An old issue
records a digest computed under old rules; recomputing it under v3 produces a
different value no matter what the plan contains, so accepting the issue and
comparing digests could only ever fail. Drift detects the version first and says
so plainly.

**What a user does:** re-run Drift. A fresh plan is filed with a v3 footer and
approving that works normally. Nothing is lost — the analysis is deterministic,
so a re-run on the same commit produces the same findings.

**What an operator does:** nothing. There is no stored state to migrate. Plans
live in GitHub issues, and stale ones are superseded rather than upgraded.

### Compatibility that *was* preserved

- `BreakingChange.confidence` still exists and still means what it meant:
  upstream confidence. It is now derived from `assessment.upstream` rather than
  computed separately, but no consumer had to change.
- `BreakingChange.taxonomy` is optional on the interface, so a finding
  constructed by hand — by a test, or an external consumer of the library —
  stays valid. Read it through `taxonomyOf()`, which derives one from `kind`
  when it is absent. `buildPlan` fills it in, so every finding on a plan has one.
- `RemediationPlan.gaps` and `.checkedSurfaces` are required, because every plan
  comes from `buildPlan`, which always populates them. Nothing persists plans
  across sessions, so there is no stored plan that could lack them.
- `CommitUnit.order` and `.files` remain present for display and older UI
  affordances. The authoritative execution identity is `id`, and the
  authoritative file scope is `allowedFiles`.

---

## Adding a version

1. Change the canonical form in `src/approval/digest.ts`.
2. Bump `PLAN_SCHEMA_VERSION`.
3. Leave `SUPPORTED_PLAN_SCHEMA_VERSIONS` as `[PLAN_SCHEMA_VERSION]` unless the
   older serialization is genuinely still computable — accepting a version whose
   digest you cannot reproduce is worse than refusing it.
4. Add a row to the history above, saying what entered the digest and why.
5. Add a test that an issue at the previous version is refused with a message
   naming the version, not a "plan changed" error.
