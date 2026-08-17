import { escapeRegExp, maskQuotedSpans, quotedSpans } from '../codemod/line.js';
import type { FixOp, FixOpKind, FixPlanAnchor } from './schema.js';

/**
 * The deterministic half of the fix plan engine: given a rule and the exact
 * occurrence Drift localized, produce the edit. No model, no network, no
 * filesystem — a pure function.
 *
 * **Every operation resolves to a single splice inside one occurrence.** That
 * is the safety property this module exists to enforce, and it is structural
 * rather than conventional: `opEditAt` returns one `{start, end, text}` or
 * nothing, so there is no code path by which an operation can reach a second
 * occurrence of the same name. The previous design re-ran each op across the
 * whole anchored line, which meant a rename could rewrite a name Drift never
 * localized —
 *
 *     primary.oldMethod(); backup.oldMethod();
 *
 * — where only `primary` was bound from the dependency that moved. Both got
 * rewritten, and the plan called itself `proven` while doing it.
 *
 * Every op declines rather than guesses. Returning `null` for "my
 * preconditions do not hold at this occurrence" is the whole reason a plan
 * can cover nine call sites and leave the tenth to an agent: the tenth is not
 * a failure, it is this module refusing to pretend it understood something it
 * did not.
 *
 * Structure is read off the *masked* line — `maskQuotedSpans` blanks string
 * contents while preserving length — so a parenthesis inside a string literal
 * can never be mistaken for a real one, and indices into the masked line
 * still address the original. The one exception is `replace-import-path`,
 * whose whole job is inside a string; it uses `quotedSpans` instead, which is
 * the same idea turned around.
 */

/** A single, bounded replacement within one line. `[start, end)` is replaced by `text`. */
export interface LineEdit {
  start: number;
  end: number;
  text: string;
}

/** Where on a line the localized occurrence sits. */
export interface Occurrence {
  /** 0-based offset into the line. */
  column: number;
  /** Exact text the matcher consumed there. */
  matchedText: string;
}

/**
 * The edit an op would make at one localized occurrence, or `null`.
 *
 * The returned span is always inside, or immediately adjacent to, the
 * occurrence — never elsewhere on the line. `replace-import-path` is the one
 * op whose target can sit apart from the occurrence (the symbol is what was
 * localized; the module specifier is what moves), and it requires that
 * specifier to be *unique on the line* rather than searching for every match.
 */
export function opEditAt(line: string, op: FixOp, occurrence: Occurrence): LineEdit | null {
  const start = occurrence.column;
  const end = start + occurrence.matchedText.length;

  // The occurrence must still be where it was said to be. Anything else means
  // this line is not the line the anchor was taken from, and splicing at a
  // stale offset is precisely the failure this check exists to prevent.
  if (start < 0 || end > line.length) return null;
  if (line.slice(start, end) !== occurrence.matchedText) return null;

  switch (op.kind) {
    case 'rename-identifier':
      return renameAt(line, op.from, op.to, start, end, 'bare');
    case 'rename-member':
      return renameAt(line, op.from, op.to, start, end, 'member');
    case 'replace-import-path':
      return replaceImportPathAt(line, op.from, op.to, start, end);
    case 'insert-argument':
      return insertArgumentAt(line, op.callee, op.index, op.text, start, end);
    case 'wrap-call':
      return wrapCallAt(line, op.callee, op.wrapper, start, end);
  }
}

/**
 * Rename the one occurrence of `from` inside `[start, end)`.
 *
 * The matched text can be wider than the symbol — `connect(`, `new Foo(`,
 * `<Slot` — so the token is located *within* the occurrence rather than
 * assumed to begin at it. More than one candidate inside a single occurrence
 * means Drift cannot say which one it localized, and declining is the only
 * honest answer.
 *
 * `mode` is what keeps the two rename ops from becoming one unsafe op:
 * `bare` refuses anything preceded by a dot (it would be a member of some
 * other object), `member` requires one (a bare identifier would be a local).
 */
function renameAt(
  line: string,
  from: string,
  to: string,
  start: number,
  end: number,
  mode: 'bare' | 'member',
): LineEdit | null {
  const masked = maskQuotedSpans(line);
  const matcher = new RegExp(`(?<![\\w$])${escapeRegExp(from)}(?![\\w$])`, 'g');

  const hits: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(masked))) {
    if (match.index < start || match.index + from.length > end) continue;
    if (isMember(masked, match.index) !== (mode === 'member')) continue;
    hits.push(match.index);
  }

  if (hits.length !== 1) return null;
  return { start: hits[0]!, end: hits[0]! + from.length, text: to };
}

/** Is the token at `at` preceded by a `.` (ignoring whitespace)? */
function isMember(masked: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /\s/.test(masked[i]!)) i -= 1;
  return i >= 0 && masked[i] === '.';
}

/**
 * Rewrite the module specifier this occurrence belongs to.
 *
 * Two ways an occurrence relates to the specifier, and both are exact. When
 * the localized symbol *is* the specifier (a package name or URL path, which
 * `matcherFor` searches for inside strings), the containing quoted span is the
 * target. When the localized symbol is an imported *name* — a `moved-export`,
 * where the name stays and the path changes — the target is the quoted span
 * holding `from`, and it must be the only one on the line. Two identical
 * specifiers on one import line would leave Drift unable to say which it
 * meant, so it declines instead of rewriting both.
 */
function replaceImportPathAt(
  line: string,
  from: string,
  to: string,
  start: number,
  end: number,
): LineEdit | null {
  if (!IMPORT_LINE.test(line)) return null;

  const spans = quotedSpans(line).filter((span) => span.content === from);
  if (spans.length === 0) return null;

  const containing = spans.filter((span) => span.start < start && span.end >= end);
  const target = containing.length === 1 ? containing[0]! : spans.length === 1 ? spans[0]! : null;
  if (!target) return null;

  return { start: target.start + 1, end: target.end, text: to };
}

/**
 * Module specifiers this line declares, and nothing else.
 *
 * A bare "does this line contain the old path in quotes" would rewrite a log
 * message, a documentation string, or a config value that names the package
 * for an unrelated reason. Requiring an import keyword on the line costs one
 * regex and removes that entire class of false edit. The keywords cover the
 * import syntaxes across the ecosystems Drift indexes rather than any one
 * language's grammar, in keeping with the rest of the line-based pipeline.
 */
const IMPORT_LINE = /(^|[^\w$])(import|export|require|from|use|include|using|open|extern|source|load)([^\w$]|$)/;

/**
 * Insert an argument into the one call this occurrence names.
 *
 * A call whose argument list does not close on this line is declined outright.
 * This engine sees one line at a time by design, and an insertion made
 * without seeing the whole list could land in the wrong position or inside a
 * nested call. Declining sends the site to an agent, which is exactly the
 * intended behaviour for a call this rule cannot read.
 */
function insertArgumentAt(
  line: string,
  callee: string,
  index: number,
  text: string,
  start: number,
  end: number,
): LineEdit | null {
  const masked = maskQuotedSpans(line);
  const call = callAt(masked, callee, start, end);
  if (!call) return null;

  const args = splitArguments(masked, call.open, call.close);
  if (args === null || index > args.length) return null;

  // Already carries this argument in this position — the plan has been
  // applied here before. Declining keeps the op idempotent.
  const existing = args[index];
  if (existing && masked.slice(existing.start, existing.end).trim() === text.trim()) return null;

  if (args.length === 0) return { start: call.open + 1, end: call.open + 1, text };
  if (index === args.length) {
    const last = args[args.length - 1]!;
    return { start: last.end, end: last.end, text: `, ${text}` };
  }
  return { start: args[index]!.start, end: args[index]!.start, text: `${text}, ` };
}

/**
 * Prefix the one call this occurrence names with `await` or `new`.
 *
 * Declines where the prefix is already present, which is what makes the op
 * idempotent. This cannot verify the prefix is *legal* here — `await` outside
 * an async function does not parse — which is why the op is classified
 * `checked` rather than `proven`, and why a plan containing one is never
 * applied automatically without the project's own checks passing.
 */
function wrapCallAt(
  line: string,
  callee: string,
  wrapper: 'await' | 'new',
  start: number,
  end: number,
): LineEdit | null {
  const masked = maskQuotedSpans(line);
  const call = callAt(masked, callee, start, end);
  if (!call) return null;

  if (new RegExp(`\\b${wrapper}\\s+$`).test(masked.slice(0, call.start))) return null;
  return { start: call.start, end: call.start, text: `${wrapper} ` };
}

/**
 * The single `callee(...)` this occurrence names, or `null`.
 *
 * Searched only within the occurrence, so a second call to the same function
 * later on the same line is invisible to this. The callee may be dotted, and
 * the occurrence may begin before it (`new Foo(` starts at `new`), so the
 * search spans the occurrence rather than anchoring at its first character.
 */
function callAt(
  masked: string,
  callee: string,
  start: number,
  end: number,
): { start: number; open: number; close: number } | null {
  const matcher = new RegExp(`(?<![\\w$.])${escapeRegExp(callee)}\\s*\\(`, 'g');

  const found: { start: number; open: number; close: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(masked))) {
    if (match.index < start || match.index >= end) continue;
    const open = match.index + match[0].length - 1;
    const close = matchingParen(masked, open);
    if (close === -1) continue;
    found.push({ start: match.index, open, close });
  }

  return found.length === 1 ? found[0]! : null;
}

/** Index of the `)` closing the `(` at `open`, or -1 if it does not close here. */
function matchingParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return ch === ')' ? i : -1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * Top-level argument spans between `open` and `close`.
 *
 * Commas nested inside a further call, array, or object are not separators;
 * depth tracking is what tells them apart. Returns `null` when the list is
 * unreadable, and an empty array for `f()`.
 */
function splitArguments(
  masked: string,
  open: number,
  close: number,
): { start: number; end: number }[] | null {
  if (masked.slice(open + 1, close).trim() === '') return [];

  const spans: { start: number; end: number }[] = [];
  let depth = 0;
  let start = open + 1;

  for (let i = open + 1; i < close; i++) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      spans.push({ start, end: i });
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  spans.push({ start, end: close });

  // A trailing comma leaves a whitespace-only final span, which is not an
  // argument and would otherwise shift every index after it.
  const last = spans[spans.length - 1]!;
  if (masked.slice(last.start, last.end).trim() === '') spans.pop();

  return spans;
}

/**
 * The first op that applies at this occurrence, and the edit it makes.
 *
 * First-match rather than compose-all, because an occurrence is one token and
 * only one rule can meaningfully own it. Composition was what the old
 * line-wide design needed (an import line could want both a path change and a
 * rename); with exact anchors those are two distinct occurrences and each
 * gets its own anchor.
 */
export function editAtOccurrence(
  line: string,
  ops: readonly FixOp[],
  occurrence: Occurrence,
): { edit: LineEdit; op: FixOpKind } | null {
  for (const op of ops) {
    const edit = opEditAt(line, op, occurrence);
    if (edit && (edit.start !== edit.end || edit.text !== '')) return { edit, op: op.kind };
  }
  return null;
}

/**
 * Where an anchor points *now*, or `null` if that cannot be established.
 *
 * Two ways to resolve, and a deliberate refusal as the third outcome:
 *
 * 1. The recorded line number still holds the recorded text, with the
 *    recorded occurrence at the recorded column. Nothing moved.
 * 2. It does not — earlier commit units in the same run added or removed
 *    lines above this one — so the line is relocated *by its exact text*.
 *    Only when that text appears exactly once in the file: two identical
 *    lines leave Drift unable to say which one was localized, and rewriting
 *    the wrong one is worse than rewriting neither.
 * 3. Otherwise `null`. A file whose content moved out from under a plan fails
 *    closed, which is what keeps the second and Nth application correct
 *    rather than only the first.
 */
export function resolveAnchor(lines: readonly string[], anchor: FixPlanAnchor): number | null {
  const holdsOccurrence = (index: number): boolean =>
    lines[index] === anchor.line &&
    lines[index]!.slice(anchor.column, anchor.column + anchor.matchedText.length) === anchor.matchedText;

  const recorded = anchor.lineNumber - 1;
  if (recorded >= 0 && recorded < lines.length && holdsOccurrence(recorded)) return recorded;

  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== anchor.line) continue;
    if (found !== -1) return null;
    found = i;
  }

  return found !== -1 && holdsOccurrence(found) ? found : null;
}

/**
 * Re-apply a validated plan to one file's live content, at its exact anchors.
 *
 * Deliberately re-derived from the ops and their anchors rather than replayed
 * from a stored before/after snapshot: a plan can be applied well after
 * analysis, and after earlier commit units in the same run have already added
 * or removed lines above these. Re-deriving against whatever the file
 * actually contains is what makes the Nth application correct, not just the
 * first.
 *
 * Idempotent by construction rather than by a separate guard: once an
 * occurrence has been rewritten, `matchedText` is no longer at that offset
 * and the anchor no longer resolves, so a second run finds nothing to do.
 */
export function applyFixPlanToContent(
  content: string,
  ops: readonly FixOp[],
  anchors: readonly FixPlanAnchor[],
  file: string,
): string {
  const fileAnchors = anchors.filter((anchor) => anchor.file === file);
  if (fileAnchors.length === 0) return content;

  const lines = content.split('\n');

  // Collected per line, then applied right to left, so two anchored
  // occurrences on the same line do not invalidate each other's offsets.
  const editsByLine = new Map<number, LineEdit[]>();

  for (const anchor of fileAnchors) {
    const index = resolveAnchor(lines, anchor);
    if (index === null) continue;

    const applied = editAtOccurrence(lines[index]!, ops, {
      column: anchor.column,
      matchedText: anchor.matchedText,
    });
    if (!applied) continue;

    const bucket = editsByLine.get(index);
    if (bucket) bucket.push(applied.edit);
    else editsByLine.set(index, [applied.edit]);
  }

  for (const [index, edits] of editsByLine) {
    let line = lines[index]!;
    const ordered = [...edits].sort((a, b) => b.start - a.start);

    let previousStart = Number.POSITIVE_INFINITY;
    for (const edit of ordered) {
      // Overlapping edits on one line cannot both be applied without one
      // silently corrupting the other. Skip rather than interleave.
      if (edit.end > previousStart) continue;
      line = line.slice(0, edit.start) + edit.text + line.slice(edit.end);
      previousStart = edit.start;
    }

    lines[index] = line;
  }

  return lines.join('\n');
}

/**
 * Every occurrence on a line an op could plausibly be anchored to.
 *
 * Used only by inference (`infer.ts`), which has a recipe's before/after pair
 * and has to work out which rule explains it — the reverse of the normal
 * direction, where localization supplies the occurrence. Enumerating
 * candidates keeps that search inside the same one-occurrence-at-a-time model
 * the rest of this module enforces, so a recipe that rewrote *two*
 * occurrences on one line cannot be explained by any single op and is
 * correctly reported as un-derivable rather than approximated.
 */
export function candidateOccurrences(line: string): Occurrence[] {
  const found: Occurrence[] = [];

  for (const match of line.matchAll(/[A-Za-z_$][\w$]*/g)) {
    found.push({ column: match.index, matchedText: match[0] });
    // A call occurrence includes the opening paren, which is what
    // `matcherFor` consumes and therefore what a real anchor looks like.
    const rest = line.slice(match.index + match[0].length);
    const paren = /^\s*\(/.exec(rest);
    if (paren) found.push({ column: match.index, matchedText: match[0] + paren[0] });
  }

  for (const span of quotedSpans(line)) {
    found.push({ column: span.start + 1, matchedText: span.content });
  }

  return found;
}

/**
 * Apply one op at the first occurrence where it fires, or return the line
 * unchanged.
 *
 * Inference only. Deterministic (leftmost occurrence wins) so the same
 * observed edits infer the same ops on every machine, which is what keeps a
 * plan's content-derived id stable.
 */
export function applyOpLeftmost(line: string, op: FixOp): string {
  for (const occurrence of candidateOccurrences(line)) {
    const edit = opEditAt(line, op, occurrence);
    if (!edit) continue;
    const next = line.slice(0, edit.start) + edit.text + line.slice(edit.end);
    if (next !== line) return next;
  }
  return line;
}
