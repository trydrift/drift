import { createHash } from 'node:crypto';
import type { Evidence, RemediationPlan } from '../types.js';
import { taxonomyOf, type ChangeTaxonomy } from '../confidence/taxonomy.js';

/**
 * Plan identity: what exactly was approved.
 *
 * The approval flow stores no plans. A human reads an issue, comments
 * `/drift apply`, and Drift re-analyses to reproduce what they read. That only
 * works if "the plan I reviewed" and "the plan you are about to execute" are
 * the same object — and until now nothing checked that. The plan *id* is
 * derived from `owner/repo/sha` alone, so it is stable across completely
 * different analyses of the same commit: a plan that grew three new commit
 * units between filing and approval keeps its id and sails through.
 *
 * The digest closes that gap. It is a SHA-256 over a canonical serialization of
 * everything that makes the plan what it is, so approving an issue approves one
 * specific proposal rather than a commit number.
 *
 * ## Why re-analysis may legitimately not match
 *
 * The digest covers upstream evidence, which is retrieved from the network and
 * can change under us — a new release is published, a changelog is edited, a
 * CVE is disclosed. When that happens the recomputed digest differs and the
 * approval is refused as stale. That is the intended outcome and not a bug:
 * the plan a human read is no longer the plan that would run, so they should
 * read the new one. Failing closed here is the entire point of the mechanism.
 */

/**
 * Bump when the canonical form changes in a way that alters digests.
 *
 * Approval issues record the schema version they were written under, and a
 * runner refuses versions it does not implement rather than comparing digests
 * across incompatible serializations — which would silently reject every
 * outstanding approval at deploy time with a misleading "plan changed" message.
 */
export const PLAN_SCHEMA_VERSION = 3;

/**
 * Schema versions this build can verify.
 *
 * Only the current one. An older approval issue records a digest computed under
 * different serialization rules, so comparing against it would fail anyway —
 * and would fail with a misleading "the plan changed" rather than the truthful
 * "this issue predates a schema change". v1 issues are refused explicitly and
 * told to re-run. See `docs/schema-migration.md`.
 */
export const SUPPORTED_PLAN_SCHEMA_VERSIONS: readonly number[] = [PLAN_SCHEMA_VERSION];

/**
 * A JSON value with object keys in sorted order, rendered without incidental
 * whitespace.
 *
 * `JSON.stringify` preserves insertion order, which makes digests depend on the
 * order fields happen to be assigned in — a refactor that reorders an object
 * literal would invalidate every outstanding approval. Sorting removes that
 * coupling.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` and absent must serialize identically: `exactOptionalPropertyTypes`
    // is off in this project, so the two are genuinely interchangeable upstream.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Evidence content is verbatim upstream text and can run to many kilobytes per
 * record. Hashing it keeps the canonical form small while still making any edit
 * to the quoted material change the digest.
 */
function canonicalEvidence(evidence: Evidence): Record<string, unknown> {
  return {
    id: evidence.id,
    source: evidence.source,
    dependency: evidence.dependency,
    url: evidence.url ?? null,
    locator: evidence.locator ?? null,
    title: evidence.title,
    contentHash: createHash('sha256').update(evidence.content).digest('hex'),
    weight: evidence.weight,
    findings: (evidence.findings ?? []).map((f) => ({
      code: f.code,
      symbol: f.symbol,
      detail: f.detail,
      before: f.before ?? null,
      after: f.after ?? null,
    })),
  };
}

function canonicalTaxonomy(taxonomy: ChangeTaxonomy): Record<string, unknown> {
  return {
    nature: taxonomy.nature,
    detectability: [...taxonomy.detectability].sort(),
    scope: taxonomy.scope,
    visibility: [...taxonomy.visibility].sort(),
    origin: taxonomy.origin,
  };
}

/**
 * The plan reduced to exactly the fields that define it.
 *
 * Volatile fields are excluded by construction rather than by deletion, so a
 * field added to `RemediationPlan` later does not silently enter the digest.
 * `createdAt` is the obvious exclusion — it changes on every run and would make
 * every digest unique, which would break the mechanism completely rather than
 * subtly.
 */
export function canonicalPlan(plan: RemediationPlan): Record<string, unknown> {
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    id: plan.id,
    // Excluded like `createdAt`: the default branch template includes
    // `{date}`, resolved from wall-clock time at plan-build time, so it is
    // volatile across a UTC-midnight boundary even when nothing about the
    // plan itself changed. It carries no decision-bearing content beyond
    // `changes`, which is already digested below — a reviewer approves the
    // upgrade, not the branch name it happens to land on.
    baseBranch: plan.baseBranch,
    headSha: plan.headSha,
    risk: plan.risk,
    blockers: [...plan.blockers],
    warnings: [...plan.warnings],
    changes: plan.changes.map((c) => ({
      name: c.name,
      ecosystem: c.ecosystem,
      from: c.from,
      to: c.to,
      kind: c.kind,
      bump: c.bump,
      manifestPath: c.manifestPath,
      workspace: c.workspace ?? null,
    })),
    breakingChanges: plan.breakingChanges.map((b) => ({
      id: b.id,
      dependency: b.dependency,
      kind: b.kind,
      summary: b.summary,
      remediation: b.remediation,
      symbols: [...b.symbols].sort(),
      replacementSymbols: [...(b.replacementSymbols ?? [])].sort(),
      confidence: b.confidence,
      // Classification is part of what a reviewer approved: the same removal
      // reclassified from compile-time to runtime-only is a materially
      // different thing to accept.
      taxonomy: canonicalTaxonomy(taxonomyOf(b)),
      // Scores and bands, not the prose that explains them — wording changes
      // must not invalidate an approval, but a changed score must.
      assessment: b.assessment
        ? {
            upstream: b.assessment.upstream.score,
            localImpact: b.assessment.localImpact.score,
            verification: b.assessment.verification.score,
            automaticExecutionEligible: b.assessment.automaticExecutionEligible,
            calibration: b.assessment.upstream.calibration,
          }
        : null,
      citations: [...b.citations].sort(),
    })),
    impactSites: plan.impactSites.map((s) => ({
      breakingChangeId: s.breakingChangeId,
      file: s.file,
      line: s.line,
      matchedSymbol: s.matchedSymbol,
      enclosingSymbol: s.enclosingSymbol ?? null,
      confidence: s.confidence,
    })),
    commits: plan.commits.map((c) => ({
      id: c.id,
      order: c.order,
      message: c.message,
      body: c.body,
      breakingChangeIds: [...c.breakingChangeIds].sort(),
      files: [...c.files].sort(),
      allowedFiles: [...c.allowedFiles].sort(),
      allowedSymbols: [...(c.allowedSymbols ?? [])].sort(),
      instructions: c.instructions,
      dependsOn: [...c.dependsOn].sort(),
      dependencyReasons: [...c.dependencyReasons]
        .map((edge) => ({
          from: edge.from,
          to: edge.to,
          reason: edge.reason,
          evidence: [...edge.evidence].sort(),
        }))
        .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
      executionLayer: c.executionLayer,
      expectedChecks: [...c.expectedChecks]
        .map((check) => ({
          id: check.id,
          kind: check.kind,
          command: check.command ?? null,
          reason: check.reason,
        }))
        .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
      invalidationTriggers: [...c.invalidationTriggers].sort(),
    })),
    planEdges: [...plan.planEdges]
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        reason: edge.reason,
        evidence: [...edge.evidence].sort(),
      }))
      .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    upgradeCohorts: [...plan.upgradeCohorts]
      .map((cohort) => ({
        id: cohort.id,
        ecosystem: cohort.ecosystem,
        dependencies: [...cohort.dependencies].sort(),
        constraints: [...cohort.constraints]
          .map((constraint) => ({
            dependency: constraint.dependency,
            ecosystem: constraint.ecosystem,
            range: constraint.range,
            source: constraint.source,
          }))
          .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
        candidatePaths: [...cohort.candidatePaths].sort(),
        reason: cohort.reason,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    evidence: plan.evidence.map(canonicalEvidence),
    // Gaps are load-bearing: approving a plan is partly approving what it says
    // it could not check, so a plan that quietly lost a gap between filing and
    // execution is not the plan that was read.
    gaps: [...plan.gaps]
      .map((gap) => ({
        stage: gap.stage,
        dependency: gap.dependency ?? null,
        ecosystem: gap.ecosystem ?? null,
        surface: gap.surface,
        severity: gap.severity,
        automaticExecution: gap.automaticExecution,
      }))
      .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
  };
}

/**
 * SHA-256 of the canonical plan, hex encoded.
 *
 * Full length rather than truncated: this is an integrity check on something
 * that authorizes code execution, and the ten characters `stableId` uses are
 * fine for a human-readable handle but not for that.
 */
export function planDigest(plan: RemediationPlan): string {
  return createHash('sha256').update(canonicalJson(canonicalPlan(plan))).digest('hex');
}
