import { createHash } from 'node:crypto';
import type { Evidence, RemediationPlan } from '../types.js';

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
export const PLAN_SCHEMA_VERSION = 1;

/** Schema versions this build can verify. */
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
    branchName: plan.branchName,
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
      order: c.order,
      message: c.message,
      body: c.body,
      breakingChangeIds: [...c.breakingChangeIds].sort(),
      files: [...c.files].sort(),
      instructions: c.instructions,
      dependsOn: [...c.dependsOn].sort(),
    })),
    evidence: plan.evidence.map(canonicalEvidence),
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
