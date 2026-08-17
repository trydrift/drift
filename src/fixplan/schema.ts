import type { BreakingChangeKind } from '../types.js';

/**
 * Fix plans: a deterministic, auditable migration document for one breaking
 * change, applied to every call site at once.
 *
 * The tier this introduces sits between Drift's own built-in codemod
 * (`src/codemod/index.ts`) and handing the finding to an AI agent. The
 * difference from both is where the *judgement* happens:
 *
 *   - A built-in codemod is derived by Drift from structured evidence. It
 *     needs no model, and its scope is therefore whatever Drift can derive
 *     unaided — today, a clean rename and nothing else.
 *   - An AI agent is handed the finding and edits each call site itself. Its
 *     reasoning is spent once per site, and what it did is legible only as a
 *     diff after the fact.
 *   - A fix plan asks a model for *the rule*, once, and then never asks it
 *     anything again. Drift validates the rule, applies it itself, and the
 *     rule is the artefact: a reviewer reads what will happen to every site
 *     before any of it happens, an auditor reads it a year later instead of
 *     guessing at a diff, and the same plan can be cached, shared, or
 *     replayed against another repository.
 *
 * That last point is the reason the ops below are a closed vocabulary rather
 * than "a script the model wrote". A plan Drift cannot re-derive the effect
 * of is a plan Drift cannot prove anything about, and an unprovable
 * deterministic fix is just an AI fix with extra steps. Every op here can be
 * applied by `execute.ts` from its parameters alone, checked against the
 * exact line it is about to touch, and run twice to prove it converges.
 */

/**
 * Version of the serialized fix plan shape.
 *
 * Present for the same reason `RemediationPlan.schemaVersion` is: a plan is
 * designed to outlive the run that produced it — in a cache, in a PR body,
 * in an audit — so a consumer reading a stored one has to be able to tell
 * whether it understands the format rather than misreading a newer one.
 *
 * Version 2 replaced line-level anchors with exact occurrence anchors.
 *
 * The bump is deliberately incompatible rather than additive. A version 1
 * anchor recorded only a file, a line's text, and its number, and application
 * re-ran the plan across that whole line — which meant an operation could
 * rewrite a *second* occurrence of the same name that Drift never localized:
 *
 *   primary.oldMethod(); backup.oldMethod();
 *
 * There is no way to read a version 1 anchor as a version 2 one, because the
 * missing information — which occurrence — is exactly the information that
 * made the old form unsafe. Reading them optimistically would silently
 * reintroduce the bug on every stored plan, so a version 1 plan is rejected
 * outright by `validateFixPlan` and treated as a miss by the cache.
 */
export const FIX_PLAN_SCHEMA_VERSION = 2;

/** The closed set of transforms Drift can execute deterministically. */
export type FixOpKind =
  | 'rename-identifier'
  | 'rename-member'
  | 'replace-import-path'
  | 'insert-argument'
  | 'wrap-call';

/**
 * A bare identifier is renamed to another bare identifier.
 *
 * The same transform the built-in codemod engine performs, expressible here
 * so a model can propose one for a finding Drift could not derive it from —
 * a prose changelog that names both symbols, say, where no computed surface
 * diff produced a `renamed-export`.
 */
export interface RenameIdentifierOp {
  kind: 'rename-identifier';
  from: string;
  to: string;
}

/**
 * A member access is renamed: `client.oldName` becomes `client.newName`.
 *
 * Deliberately distinct from `rename-identifier`, which specifically refuses
 * to touch anything preceded by a dot. The two are opposite rules about the
 * same syntax and collapsing them would make each one unsafe: a bare rename
 * that also rewrote members would hit unrelated objects that happen to share
 * a method name, and a member rename that also rewrote bare identifiers
 * would hit locals.
 */
export interface RenameMemberOp {
  kind: 'rename-member';
  from: string;
  to: string;
}

/**
 * A module specifier changes: the symbol still exists, somewhere else.
 *
 * The one op that works *inside* a string literal rather than outside one,
 * which is why `quotedSpans` exists alongside `maskQuotedSpans`. Applied
 * only to lines that actually read as an import, so a path that appears in a
 * log message or a config value is not rewritten.
 */
export interface ReplaceImportPathOp {
  kind: 'replace-import-path';
  from: string;
  to: string;
}

/**
 * A required argument was added to a call: `connect(url)` becomes
 * `connect(url, { retries: 3 })`.
 *
 * `index` is the position in the argument list to insert at, so this covers
 * both a new trailing options object and a new leading parameter. `text` is
 * inserted verbatim and is validated as a literal — see `ARGUMENT_LITERAL`
 * in `validate.ts`. It is never allowed to be an arbitrary expression,
 * because an expression can call something, and a transform that can call
 * something is not a transform Drift can reason about.
 */
export interface InsertArgumentOp {
  kind: 'insert-argument';
  callee: string;
  index: number;
  text: string;
}

/**
 * A call needs a prefix it did not need before: it became asynchronous, or a
 * factory function became a class.
 *
 * The narrowest useful form of "the shape of the call changed" — prefixing
 * is the only structural edit that can be made to a call expression without
 * knowing anything about the surrounding grammar.
 */
export interface WrapCallOp {
  kind: 'wrap-call';
  callee: string;
  wrapper: 'await' | 'new';
}

export type FixOp =
  | RenameIdentifierOp
  | RenameMemberOp
  | ReplaceImportPathOp
  | InsertArgumentOp
  | WrapCallOp;

/**
 * How strong a guarantee Drift can make about an op without running the
 * project's own checks.
 *
 * `proven` — applying this op cannot change whether the file parses. It
 * swaps one token or one string for another of the same syntactic class.
 * The edit may still be semantically wrong if the plan itself is wrong, but
 * the plan's correctness is separately attested by cited evidence.
 *
 * `proven` is a claim about **one occurrence**, and only holds because
 * anchors are exact (see `FixPlanAnchor`). Under version 1's line-level
 * anchors the label was too strong: a "proven" rename re-ran across the
 * whole anchored line and could rewrite a second, same-named occurrence
 * Drift never localized — syntactically valid, and wrong. The guarantee now
 * has two halves, and both are enforced rather than asserted: the operation
 * is shape-preserving, *and* it can only reach the exact occurrence
 * localization established.
 *
 * `checked` — applying this op changes the structure of an expression, and
 * whether the result is valid depends on context this line-based engine
 * cannot see. `await` outside an async function is a syntax error; an
 * inserted argument may be the wrong arity for an overload. These ops are
 * still deterministic and still auditable — Drift knows exactly what it will
 * do — but Drift cannot promise the result compiles, so a plan containing
 * one is never applied automatically without the project's own checks
 * actually passing. See `assurance` on `FixPlanAssessment`.
 *
 * This distinction is what keeps the tier honest. The alternative — treating
 * every op as equally safe because all of them are deterministic — would
 * conflate "Drift can predict this edit" with "Drift can vouch for this
 * edit", which are different claims and only the first is free.
 */
export type OpAssurance = 'proven' | 'checked';

/**
 * One exact occurrence a plan is permitted to edit.
 *
 * Not a line. The distinction is the whole safety property of this tier: an
 * anchor names the single occurrence localization established, so an
 * operation physically cannot reach a same-named identifier elsewhere on the
 * same line, in the same file, or anywhere else.
 *
 * Four fields, each load-bearing:
 *
 * - `lineNumber` and `column` are where the occurrence *was*. Fast path.
 * - `line` is the whole line's text as it read then, which is what lets an
 *   anchor survive earlier commits in the same run shifting the file — a
 *   line number goes stale, its text usually does not.
 * - `matchedText` is what the matcher actually consumed at `column`
 *   (`connect(`, `new Foo(`, a bare name). It is the fingerprint: an anchor
 *   is only usable where this text is still present at this offset, so a
 *   file edited underneath a plan fails closed instead of splicing at a
 *   position that now means something else.
 */
export interface FixPlanAnchor {
  file: string;
  /** The full line as it read when the occurrence was localized. */
  line: string;
  /** 1-indexed line number at localization time. */
  lineNumber: number;
  /** 0-based offset of the occurrence within `line`. */
  column: number;
  /** Exact text the matcher consumed at `column`. */
  matchedText: string;
}

export function opAssurance(op: FixOp): OpAssurance {
  switch (op.kind) {
    case 'rename-identifier':
    case 'rename-member':
    case 'replace-import-path':
      return 'proven';
    case 'insert-argument':
    case 'wrap-call':
      return 'checked';
  }
}

/** The weakest assurance among a plan's ops — a plan is only as safe as its riskiest rule. */
export function planAssurance(ops: readonly FixOp[]): OpAssurance {
  return ops.some((op) => opAssurance(op) === 'checked') ? 'checked' : 'proven';
}

/**
 * Where a fix plan was *proposed* from.
 *
 * Note the word. A proposal source is not an authority: every value here
 * goes through the identical gate in `validate.ts`, and none of them can
 * skip it. This is the whole shape of the design — many ways to arrive at a
 * candidate rule, exactly one way to have it accepted, exactly one engine
 * that executes it.
 *
 * `model` — authored by an LLM from evidence, once per finding.
 * `builtin` — lifted from Drift's own codemod engine, no model involved.
 * `recipe` — inferred from what a community recipe actually did to a
 *   throwaway worktree (see `infer.ts`). The recipe is third-party code, so
 *   its *output* is treated as a suggestion to be re-derived and re-proved,
 *   never as an edit to be trusted and committed. This is a deliberate
 *   change from the tier it replaces, where a matching recipe's diff was
 *   scope-checked and taken. Scope-checking answers "did it stay in its
 *   lane"; it does not answer "is this the right edit", and the same gate
 *   that asks that of a model has no reason to ask less of a recipe.
 * `cache` — restored from a previously validated plan for the same
 *   migration; `sourceId` names the plan it came from.
 * `user` — supplied or edited by a human. Bypasses authoring, never
 *   bypasses validation.
 */
export interface FixPlanProvenance {
  author: 'model' | 'builtin' | 'recipe' | 'cache' | 'user';
  /** Exact model id, when `author` is `model`. Never a family name. */
  model?: string;
  /** `name@version` and publisher, when `author` is `recipe`. */
  recipe?: { name: string; version: string; publisher: string; source: string };
  authoredAt: string;
  sourceId?: string;
}

/**
 * The document itself.
 *
 * Everything needed to re-derive the edit is in here, and nothing that ties
 * it to one repository is: the ops are about the dependency's API, not about
 * any particular call site. That is what makes a plan cacheable across runs
 * and shareable across repositories — the sites it applies to are computed
 * fresh each time by matching it against that repository's own localized
 * impact sites, never stored in the plan.
 */
export interface FixPlan {
  schemaVersion: number;
  /**
   * Content-derived id, computed over the migration this plan describes —
   * dependency, version range, change kind, symbols, ops — and deliberately
   * not over anything repository-specific. Two repositories hitting the same
   * upstream break compute the same id, which is what makes the cache in
   * `cache.ts` a shared artefact rather than a per-repo memo.
   */
  id: string;
  breakingChangeId: string;
  dependency: string;
  fromVersion: string | null;
  toVersion: string | null;
  changeKind: BreakingChangeKind;
  /** One sentence a human reads to decide whether this plan is right. */
  migration: string;
  /** Why this is the correct fix, in the model's own words, for the document. */
  rationale: string;
  ops: FixOp[];
  /**
   * Evidence ids attesting the replacement this plan introduces.
   *
   * Never empty for a model-authored plan. A plan whose `to` symbol appears
   * in no cited evidence is rejected outright rather than downgraded — an
   * invented replacement API is precisely the failure mode that would make
   * this tier untrustworthy, and it is cheap to check.
   */
  citations: string[];
  provenance: FixPlanProvenance;
}

/** What happened to one localized impact site under a plan. */
export interface FixPlanSiteOutcome {
  file: string;
  line: number;
  /** The line as it read when the site was localized. */
  before: string;
  /** The line after the plan's ops, when `status` is `covered`. */
  after?: string;
  /**
   * `covered` — an op matched this line and changed it. The deterministic
   * transform handles it and no agent is asked about it.
   * `residual` — no op's preconditions held here. The site falls through to
   * whatever the next tier is, per site rather than per finding.
   */
  status: 'covered' | 'residual';
  op?: FixOpKind;
  /** Why a residual site was not covered, in a sentence a reviewer can act on. */
  reason?: string;
}

/**
 * Drift's verdict on a proposed plan, and the per-site split that follows
 * from it.
 *
 * `partial` is the outcome that makes this tier worth having. The built-in
 * codemod engine is all-or-nothing per commit (`resolveCodemod` in
 * `plan/commits.ts`) — a rule covering nine of ten sites resolves none of
 * them. Here the nine are resolved deterministically and the tenth is handed
 * on, which is both cheaper and more legible than sending all ten to an
 * agent because one was unusual.
 */
export interface FixPlanAssessment {
  plan: FixPlan;
  verdict: 'accepted' | 'partial' | 'rejected';
  /** The weakest assurance among the ops that actually covered a site. */
  assurance: OpAssurance;
  sites: FixPlanSiteOutcome[];
  covered: number;
  residual: number;
  /**
   * Hard failures that rejected the plan as a whole, each phrased as a
   * statement of what Drift could not establish. Empty unless `verdict` is
   * `rejected`.
   */
  rejections: string[];
  /** The exact occurrences the accepted ops are permitted to touch. */
  anchors: FixPlanAnchor[];
}

/**
 * A validated plan attached to a commit unit, in the shape that survives
 * serialization into a stored `RemediationPlan`.
 *
 * Mirrors how `CommitUnit.codemod` carries a rule plus its anchors rather
 * than precomputed file contents: a consumer re-applies this against
 * whatever each file actually holds when it runs.
 */
export interface AttachedFixPlan {
  plan: FixPlan;
  assurance: OpAssurance;
  files: string[];
  anchors: FixPlanAnchor[];
  covered: number;
  residual: number;
  /** Residual sites, kept so the next tier knows exactly what is left. */
  residualSites: { file: string; line: number; reason: string }[];
}
