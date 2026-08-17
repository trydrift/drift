import type { BreakingChange, Evidence, ImpactSite } from '../types.js';
import { isCommentOnly } from '../codemod/line.js';
import { editAtOccurrence, opEditAt } from './execute.js';
import {
  FIX_PLAN_SCHEMA_VERSION,
  opAssurance,
  type FixOp,
  type FixPlan,
  type FixPlanAssessment,
  type FixPlanAnchor,
  type FixPlanSiteOutcome,
  type OpAssurance,
} from './schema.js';

/**
 * The gate. Nothing a model proposes reaches a repository without passing
 * every check in this file.
 *
 * The checks divide into three kinds, and the order matters:
 *
 *   1. **Shape.** Is each op's parameter the syntactic class it claims to
 *      be? An "identifier" containing a parenthesis is not an identifier,
 *      and rejecting it here is what stops a transform vocabulary from
 *      quietly becoming an arbitrary-code vocabulary.
 *   2. **Grounding.** Does this plan address the finding it claims to
 *      address? A rule about a symbol the breaking change never mentions is
 *      not a fix for it, however plausible it reads.
 *   3. **Attestation.** Is the replacement this plan introduces stated
 *      anywhere in the evidence Drift actually retrieved? This is the
 *      anti-hallucination check, and it is the single most important one
 *      here. A model asked to migrate an API it does not know will invent a
 *      confident, well-named, entirely fictional replacement, and a
 *      deterministic engine will then apply that fiction to every call site
 *      in the repository — faster and more thoroughly than any per-site
 *      agent would have. Determinism multiplies whatever it is given. This
 *      check is what makes sure it is given a fact.
 *
 * Then two properties are proved by execution rather than argued for:
 * applying the plan twice must equal applying it once, and no op may change
 * the number of lines in a file. Both are cheap, and both would otherwise be
 * assumptions.
 *
 * Everything that survives is still not trusted blindly: an accepted plan
 * goes through the same scope validation and the same verification an
 * agent's output does. What it skips is the *generation* step, not the
 * safety bar — the same bargain `codemod/index.ts` already makes.
 */

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const DOTTED_CALLEE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
/** Module specifiers, across every import syntax Drift indexes. No quotes, no whitespace. */
const MODULE_PATH = /^[\w@.][\w@.:/+-]*$/;

/**
 * What may be inserted as an argument.
 *
 * Literals only, and deliberately so. An expression can call something, and
 * a transform that can call something is a transform whose effect Drift
 * cannot state in advance — which would forfeit the entire reason this tier
 * exists. Covers a string, a number, a boolean, each ecosystem's spelling of
 * null, a flat object/dict/keyword literal of those, and a named argument.
 * Anything else is refused, and the site goes to an agent instead.
 */
const ARGUMENT_LITERAL =
  /^(?!.*=>)(?!.*\blambda\b)(?!.*\bfunction\b)[\w$]*\s*[:=]?\s*(?:"[^"\\]*"|'[^'\\]*'|-?\d+(?:\.\d+)?|true|false|True|False|null|None|nil|nullptr|undefined|\{[^{}()`]*\}|\[[^\[\]()`]*\])$/;

const MAX_OPS = 8;

export interface ValidateOptions {
  plan: FixPlan;
  change: BreakingChange;
  sites: readonly ImpactSite[];
  /** Contents of every file named by `sites`, as localization read them. */
  fileContents: ReadonlyMap<string, string>;
  /** Evidence available for attestation. Only the plan's own citations are read. */
  evidence: readonly Evidence[];
}

export function validateFixPlan(options: ValidateOptions): FixPlanAssessment {
  const { plan, change, sites, fileContents, evidence } = options;
  const rejections: string[] = [];

  if (plan.schemaVersion !== FIX_PLAN_SCHEMA_VERSION) {
    rejections.push(
      `The plan declares schema version ${plan.schemaVersion}; this build of Drift reads version ${FIX_PLAN_SCHEMA_VERSION}.`,
    );
    return rejected(plan, rejections);
  }

  if (plan.ops.length === 0) {
    rejections.push('The plan contains no operations, so there is nothing it could deterministically change.');
    return rejected(plan, rejections);
  }

  if (plan.ops.length > MAX_OPS) {
    rejections.push(
      `The plan contains ${plan.ops.length} operations; ${MAX_OPS} is the most Drift will apply as a single migration. A migration needing more than that is not one rule, and should be split into separate findings.`,
    );
    return rejected(plan, rejections);
  }

  /* 1 — shape */
  for (const op of plan.ops) {
    const problem = shapeProblem(op);
    if (problem) rejections.push(problem);
  }

  /* 2 — grounding */
  for (const op of plan.ops) {
    const problem = groundingProblem(op, change);
    if (problem) rejections.push(problem);
  }

  /* 3 — attestation */
  const cited = evidence.filter((record) => plan.citations.includes(record.id));
  const unknown = plan.citations.filter((id) => !evidence.some((record) => record.id === id));
  if (unknown.length > 0) {
    rejections.push(
      `The plan cites evidence Drift did not gather (${unknown.join(', ')}), so its provenance cannot be checked.`,
    );
  }

  // A community recipe is its own citation: it is published, version-pinned,
  // and a human can open `provenance.recipe.source` and read what it claims
  // to migrate. That is a weaker attestation than a computed API diff and a
  // stronger one than nothing, and it is exactly as much as the recipe tier
  // ever actually had — the difference now is that it buys the recipe a
  // hearing at this gate rather than a bypass around it.
  if (plan.provenance.author === 'recipe' && !plan.provenance.recipe) {
    rejections.push(
      'The plan claims to come from a community recipe but names none, so there is nothing to audit it against.',
    );
  }

  if (plan.provenance.author === 'model' && cited.length === 0) {
    rejections.push(
      'The plan cites no retrievable evidence. A migration Drift cannot trace back to something it actually read is not one it will apply to every call site.',
    );
  }

  const attested = attestationCorpus(change, cited, plan);
  for (const op of plan.ops) {
    for (const introduced of introducedTokens(op)) {
      if (!attests(attested, introduced)) {
        rejections.push(
          `Nothing in the cited evidence mentions \`${introduced}\`, which this plan would introduce at every call site. Drift will not apply a replacement it cannot find stated upstream.`,
        );
      }
    }
  }

  if (rejections.length > 0) return rejected(plan, rejections);

  /* 4 — proved by execution, not asserted */
  const evaluated = evaluateSites(plan.ops, change, sites, fileContents);
  const outcomes = evaluated.map((entry) => entry.outcome);

  for (const { outcome, anchor } of evaluated) {
    if (outcome.status !== 'covered' || outcome.after === undefined || !anchor) continue;

    if (outcome.after.includes('\n')) {
      rejections.push(
        `Applying this plan to ${outcome.file}:${outcome.line} would split one line into several. Every operation Drift executes is line-preserving, so this plan cannot be one of Drift's.`,
      );
      continue;
    }

    // Idempotence, proved by re-running against the rewritten line at the
    // same occurrence. Under exact anchoring the usual reason a second pass
    // finds nothing is that `matchedText` is no longer at `column` — which is
    // itself the property being checked, so it is checked rather than assumed.
    const second = editAtOccurrence(outcome.after, plan.ops, {
      column: anchor.column,
      matchedText: anchor.matchedText,
    });
    if (second) {
      rejections.push(
        `Applying this plan twice to ${outcome.file}:${outcome.line} does not give the same result as applying it once. A rule that keeps changing its own output cannot be safely re-applied, and Drift re-applies every rule against live file contents rather than a snapshot.`,
      );
    }
  }

  if (rejections.length > 0) return rejected(plan, rejections);

  const covered = evaluated.filter((entry) => entry.outcome.status === 'covered');
  if (covered.length === 0) {
    rejections.push(
      'No operation in the plan matched any of the call sites Drift localized for this finding. The plan may be correct about the upstream change and wrong about how this repository uses it.',
    );
    return rejected(plan, rejections);
  }

  const usedKinds = new Set(covered.map((entry) => entry.outcome.op));
  const assurance: OpAssurance = plan.ops.some((op) => usedKinds.has(op.kind) && opAssurance(op) === 'checked')
    ? 'checked'
    : 'proven';

  return {
    plan,
    verdict: covered.length === outcomes.length ? 'accepted' : 'partial',
    assurance,
    sites: outcomes,
    covered: covered.length,
    residual: outcomes.length - covered.length,
    rejections: [],
    // Exact occurrences, taken from the impact sites localization established
    // — never re-derived by searching the line, which is what allowed a rule
    // to reach a second, same-named occurrence Drift never localized.
    anchors: covered.map((entry) => entry.anchor!),
  };
}

/**
 * Run the plan against every localized site and record what happened.
 *
 * This is the per-site partition that makes the tier worth having. Drift's
 * built-in codemod engine is all-or-nothing per commit — a rule covering
 * nine of ten sites resolves none of them — which is defensible when the
 * rule was cheap to derive and pointless when it cost a model call. Here the
 * nine are taken and the tenth is handed on with a reason attached.
 *
 * Each covered site yields an **exact anchor**, built from the column
 * localization recorded rather than by searching the line. A site that has no
 * column is residual by definition: Drift never established which occurrence
 * it meant, so there is nothing a plan may safely edit there.
 */
function evaluateSites(
  ops: readonly FixOp[],
  change: BreakingChange,
  sites: readonly ImpactSite[],
  fileContents: ReadonlyMap<string, string>,
): { outcome: FixPlanSiteOutcome; anchor?: FixPlanAnchor }[] {
  const evaluated: { outcome: FixPlanSiteOutcome; anchor?: FixPlanAnchor }[] = [];
  const seen = new Set<string>();

  for (const site of sites) {
    if (site.breakingChangeId !== change.id) continue;

    // Keyed by occurrence, not by line: two distinct occurrences on one line
    // are two sites, and collapsing them would silently drop one.
    const key = `${site.file}\0${site.line}\0${site.column ?? 'line'}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const residual = (before: string, reason: string) =>
      evaluated.push({ outcome: { file: site.file, line: site.line, before, status: 'residual', reason } });

    const content = fileContents.get(site.file);
    if (content === undefined) {
      residual(site.excerpt, 'Drift no longer has this file’s contents, so it could not check the rule against the real line.');
      continue;
    }

    const line = content.split('\n')[site.line - 1];
    if (line === undefined) {
      residual(site.excerpt, 'The file no longer has a line here.');
      continue;
    }

    if (isCommentOnly(line)) {
      residual(line, 'This line is a comment. Drift does not rewrite prose, even prose that names the changed symbol.');
      continue;
    }

    // No column means localization matched the line without establishing an
    // occurrence on it — the call-opens-on-next-line fallback, or a
    // manifest/runtime finding. A plan must not invent a position Drift never
    // established, so this is residual rather than a guess at the first match.
    if (site.column === undefined || site.matchedText === undefined) {
      residual(
        line,
        'Drift matched this line but not a specific occurrence on it, so there is no exact position a deterministic rule could edit. An agent can read the surrounding code; a line-based rule cannot.',
      );
      continue;
    }

    const occurrence = { column: site.column, matchedText: site.matchedText };
    if (line.slice(occurrence.column, occurrence.column + occurrence.matchedText.length) !== occurrence.matchedText) {
      residual(
        line,
        'The line no longer reads the way it did when this occurrence was localized, so Drift cannot confirm it would edit the right one.',
      );
      continue;
    }

    const applied = editAtOccurrence(line, ops, occurrence);
    if (!applied) {
      residual(
        line,
        'No operation in the plan applies at the exact occurrence Drift localized, so this call site is shaped differently from the ones the plan describes.',
      );
      continue;
    }

    const after = line.slice(0, applied.edit.start) + applied.edit.text + line.slice(applied.edit.end);

    evaluated.push({
      outcome: { file: site.file, line: site.line, before: line, after, status: 'covered', op: applied.op },
      anchor: {
        file: site.file,
        line,
        lineNumber: site.line,
        column: occurrence.column,
        matchedText: occurrence.matchedText,
      },
    });
  }

  return evaluated;
}

/** Is every parameter the syntactic class its op claims? */
function shapeProblem(op: FixOp): string | null {
  switch (op.kind) {
    case 'rename-identifier':
    case 'rename-member': {
      if (!IDENTIFIER.test(op.from)) return `\`${op.from}\` is not a plain identifier, so \`${op.kind}\` cannot act on it.`;
      if (!IDENTIFIER.test(op.to)) return `\`${op.to}\` is not a plain identifier, so \`${op.kind}\` cannot produce it.`;
      if (op.from === op.to) return `\`${op.kind}\` was given the same name on both sides, which would change nothing.`;
      return null;
    }
    case 'replace-import-path': {
      if (!MODULE_PATH.test(op.from)) return `\`${op.from}\` is not a module path Drift can match on.`;
      if (!MODULE_PATH.test(op.to)) return `\`${op.to}\` is not a module path Drift can write.`;
      if (op.from === op.to) return 'The import path rule was given the same path on both sides, which would change nothing.';
      return null;
    }
    case 'insert-argument': {
      if (!DOTTED_CALLEE.test(op.callee)) return `\`${op.callee}\` is not a callable name Drift can locate.`;
      if (!Number.isInteger(op.index) || op.index < 0 || op.index > MAX_OPS) {
        return `Argument position ${op.index} is out of range.`;
      }
      if (!ARGUMENT_LITERAL.test(op.text.trim())) {
        return `\`${op.text}\` is not a literal. Drift only inserts literal arguments, because an expression could call something and a rule whose effect depends on running code is not a rule Drift can state in advance.`;
      }
      return null;
    }
    case 'wrap-call': {
      if (!DOTTED_CALLEE.test(op.callee)) return `\`${op.callee}\` is not a callable name Drift can locate.`;
      return null;
    }
  }
}

/**
 * Does this op concern the finding it is attached to?
 *
 * A plan is authored for one breaking change and applied to that change's
 * own localized sites. An op naming a symbol the finding never mentions is
 * either a misunderstanding or a second, unreported migration riding along
 * inside the first — and the second is worse, because it would land under a
 * commit message describing something else.
 */
function groundingProblem(op: FixOp, change: BreakingChange): string | null {
  const known = new Set<string>();
  for (const symbol of change.symbols) {
    known.add(symbol);
    for (const segment of symbol.split(/[./]/)) if (segment) known.add(segment);
  }

  const subject =
    op.kind === 'insert-argument' || op.kind === 'wrap-call'
      ? op.callee
      : op.kind === 'replace-import-path'
        ? op.from
        : op.from;

  if (op.kind === 'replace-import-path') {
    // An import path is grounded by naming the dependency that moved, not by
    // matching a symbol — the symbol is what is being imported, the path is
    // where from.
    if (subject === change.dependency || subject.startsWith(`${change.dependency}/`) || known.has(subject)) return null;
    return `The plan rewrites imports of \`${subject}\`, which is neither \`${change.dependency}\` nor a symbol this finding names.`;
  }

  const segments = subject.split('.');
  if (known.has(subject) || segments.some((segment) => known.has(segment))) return null;

  return `The plan acts on \`${subject}\`, which this finding never mentions. Drift will not apply a rule about one symbol to sites localized for another.`;
}

/** The tokens an op would introduce into the repository that were not there before. */
function introducedTokens(op: FixOp): string[] {
  switch (op.kind) {
    case 'rename-identifier':
    case 'rename-member':
    case 'replace-import-path':
      return [op.to];
    case 'insert-argument': {
      // The literal's *value* is the migration's choice and needs attesting;
      // punctuation and quoting do not.
      const words = op.text.match(/[A-Za-z_$][\w$]*/g) ?? [];
      return words.filter((word) => !LITERAL_KEYWORDS.has(word));
    }
    case 'wrap-call':
      // `await` and `new` are language keywords, not upstream API names.
      return [];
  }
}

const LITERAL_KEYWORDS = new Set([
  'true',
  'false',
  'True',
  'False',
  'null',
  'None',
  'nil',
  'nullptr',
  'undefined',
]);

/**
 * Everything Drift actually read that could attest to a replacement.
 *
 * The finding's own computed fields come first — `replacementSymbols` and a
 * before/after signature pair are machine-derived from the published
 * artefact, which is stronger than any prose — followed by the verbatim text
 * of the evidence the plan cites.
 */
function attestationCorpus(change: BreakingChange, cited: readonly Evidence[], plan: FixPlan): string {
  return [
    ...(change.replacementSymbols ?? []),
    change.before ?? '',
    change.after ?? '',
    change.summary,
    change.remediation,
    ...cited.map((record) => `${record.title}\n${record.content}`),
    ...cited.flatMap((record) =>
      (record.findings ?? []).map((finding) => `${finding.symbol} ${finding.detail} ${finding.before ?? ''} ${finding.after ?? ''}`),
    ),
    // What the recipe says it migrates, when one proposed this plan.
    plan.provenance.recipe ? `${plan.provenance.recipe.name}\n${plan.migration}` : '',
  ].join('\n');
}

/**
 * Whether a token appears in the corpus as a token, not as a substring.
 *
 * The word-boundary requirement matters: `connect` appearing inside
 * `disconnect` is not evidence that `connect` is the new API, and a
 * substring check would accept exactly the plausible-looking invention this
 * gate exists to catch.
 */
function attests(corpus: string, token: string): boolean {
  return new RegExp(`(^|[^\\w$])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w$]|$)`).test(corpus);
}

function rejected(plan: FixPlan, rejections: string[]): FixPlanAssessment {
  return {
    plan,
    verdict: 'rejected',
    assurance: 'checked',
    sites: [],
    covered: 0,
    residual: 0,
    rejections,
    anchors: [],
  };
}
