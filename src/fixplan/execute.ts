import { escapeRegExp, maskQuotedSpans, quotedSpans, replaceOutsideStrings } from '../codemod/line.js';
import type { FixOp, FixOpKind } from './schema.js';

/**
 * The deterministic half of the fix plan engine: given a rule, produce the
 * edit. No model, no network, no filesystem — a pure function from a line
 * and an op to a line.
 *
 * Every op declines rather than guesses. Returning `null` for "my
 * preconditions do not hold here" is the whole reason a plan can cover nine
 * call sites and leave the tenth to an agent: the tenth is not a failure,
 * it is this module refusing to pretend it understood a line it did not.
 *
 * Structure is read off the *masked* line — `maskQuotedSpans` blanks string
 * contents while preserving length — so a parenthesis inside a string
 * literal can never be mistaken for a real one, and indices into the masked
 * line still address the original. The one exception is
 * `replace-import-path`, whose whole job is inside a string; it uses
 * `quotedSpans` instead, which is the same idea turned around.
 */

/** Applying `ops` in order to one line. `applied` is empty when nothing matched. */
export interface LineOutcome {
  line: string;
  applied: FixOpKind[];
}

/**
 * Apply every op in a plan to one line, in order.
 *
 * Sequential rather than first-match-wins because a single line legitimately
 * needs more than one op: an import line whose module path moved *and* whose
 * symbol was renamed is one line, two rules, and stopping at the first would
 * leave the file half-migrated in a way that still compiles — the worst
 * possible outcome, because nothing would report it.
 */
export function applyOpsToLine(line: string, ops: readonly FixOp[]): LineOutcome {
  let current = line;
  const applied: FixOpKind[] = [];

  for (const op of ops) {
    const next = applyOpToLine(current, op);
    if (next === null || next === current) continue;
    current = next;
    applied.push(op.kind);
  }

  return { line: current, applied };
}

/** One op against one line. `null` means the op's preconditions did not hold. */
export function applyOpToLine(line: string, op: FixOp): string | null {
  switch (op.kind) {
    case 'rename-identifier':
      return renameIdentifier(line, op.from, op.to);
    case 'rename-member':
      return renameMember(line, op.from, op.to);
    case 'replace-import-path':
      return replaceImportPath(line, op.from, op.to);
    case 'insert-argument':
      return insertArgument(line, op.callee, op.index, op.text);
    case 'wrap-call':
      return wrapCall(line, op.callee, op.wrapper);
  }
}

/**
 * A bare identifier, never a member.
 *
 * The negative lookbehind for `.` is what separates this from
 * `renameMember`: `obj.parse` reads a member that merely happens to share an
 * imported symbol's name, and rewriting it would touch an unrelated binding.
 */
function renameIdentifier(line: string, from: string, to: string): string | null {
  const matcher = new RegExp(`(?<!\\.)\\b${escapeRegExp(from)}\\b`, 'g');
  const result = replaceOutsideStrings(line, matcher, to);
  return result === line ? null : result;
}

/**
 * A member access, and only a member access.
 *
 * The variable-length lookbehind tolerates the whitespace a fluent chain
 * broken across a line puts between the dot and the name.
 */
function renameMember(line: string, from: string, to: string): string | null {
  const matcher = new RegExp(`(?<=\\.\\s*)${escapeRegExp(from)}\\b`, 'g');
  const result = replaceOutsideStrings(line, matcher, to);
  return result === line ? null : result;
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

function replaceImportPath(line: string, from: string, to: string): string | null {
  if (!IMPORT_LINE.test(line)) return null;

  const spans = quotedSpans(line);
  // Right to left, so an earlier span's indices are not invalidated by a
  // later span's substitution.
  const targets = spans.filter((span) => span.content === from).reverse();
  if (targets.length === 0) return null;

  let result = line;
  for (const span of targets) {
    result = `${result.slice(0, span.start + 1)}${to}${result.slice(span.end)}`;
  }
  return result;
}

/**
 * Insert an argument into every call to `callee` that opens and closes on
 * this line.
 *
 * A call whose argument list spans lines is declined outright. This engine
 * sees one line at a time by design, and an insertion made without seeing
 * the whole list could land in the wrong position or inside a nested call.
 * Declining sends the site to an agent, which is exactly the intended
 * behaviour for a site this rule cannot read.
 */
function insertArgument(line: string, callee: string, index: number, text: string): string | null {
  const masked = maskQuotedSpans(line);
  const calls = findCalls(masked, callee).reverse();
  if (calls.length === 0) return null;

  let result = line;
  let changed = false;

  for (const call of calls) {
    const args = splitArguments(masked, call.open, call.close);
    if (args === null) continue;
    if (index > args.length) continue;

    // Already carries this argument in this position — the plan has been
    // applied here before. Declining keeps the op idempotent, which
    // `validate.ts` proves by running the whole plan twice.
    if (args[index] !== undefined && masked.slice(args[index]!.start, args[index]!.end).trim() === text.trim()) {
      continue;
    }

    const insertion = args.length === 0 ? text : index === args.length ? `, ${text}` : `${text}, `;
    const at = args.length === 0 ? call.open + 1 : index === args.length ? args[args.length - 1]!.end : args[index]!.start;

    result = `${result.slice(0, at)}${insertion}${result.slice(at)}`;
    changed = true;
  }

  return changed ? result : null;
}

/**
 * Prefix every call to `callee` on this line with `await` or `new`.
 *
 * Declines where the prefix is already present, which is what makes the op
 * idempotent. Note that this cannot verify the prefix is *legal* here —
 * `await` outside an async function does not parse — which is why the op is
 * classified `checked` rather than `proven` and why a plan containing one is
 * never applied automatically without the project's own checks passing.
 */
function wrapCall(line: string, callee: string, wrapper: 'await' | 'new'): string | null {
  const masked = maskQuotedSpans(line);
  const calls = findCalls(masked, callee).reverse();
  if (calls.length === 0) return null;

  const already = new RegExp(`\\b${wrapper}\\s+$`);
  let result = line;
  let changed = false;

  for (const call of calls) {
    if (already.test(masked.slice(0, call.start))) continue;
    result = `${result.slice(0, call.start)}${wrapper} ${result.slice(call.start)}`;
    changed = true;
  }

  return changed ? result : null;
}

/**
 * Every `callee(...)` on a masked line whose parentheses balance on it.
 *
 * `start` is the first character of the callee (where a wrapper prefix
 * goes), `open`/`close` bracket the argument list.
 */
function findCalls(masked: string, callee: string): { start: number; open: number; close: number }[] {
  // A dotted callee is matched whole, so `client.connect` does not match a
  // bare `connect`. The lookbehind stops `a.connect` matching a plain
  // `connect` for the same reason `renameIdentifier` refuses members.
  const matcher = new RegExp(`(?<![\\w$.])${escapeRegExp(callee)}\\s*\\(`, 'g');
  const found: { start: number; open: number; close: number }[] = [];

  let match: RegExpExecArray | null;
  while ((match = matcher.exec(masked))) {
    const open = match.index + match[0].length - 1;
    const close = matchingParen(masked, open);
    if (close === -1) continue;
    found.push({ start: match.index, open, close });
    matcher.lastIndex = close;
  }

  return found;
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
  const inner = masked.slice(open + 1, close);
  if (inner.trim() === '') return [];

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
 * Re-apply a validated plan to one file's live content, anchored.
 *
 * Deliberately re-derived from the ops and their anchors rather than replayed
 * from a stored before/after snapshot, for the same reason
 * `applyCodemodTransform` is: a plan can be applied well after analysis, and
 * after earlier commit units in the same run have already added or removed
 * lines above these. Matching each anchor by its exact original text, and
 * falling back to a line number only when that text is unambiguous, is what
 * makes the second and Nth application correct rather than only the first.
 */
export function applyFixPlanToContent(
  content: string,
  ops: readonly FixOp[],
  anchors: readonly { file: string; line: string; lineNumber: number }[],
  file: string,
): string {
  const fileAnchors = anchors.filter((anchor) => anchor.file === file);
  if (fileAnchors.length === 0) return content;

  const lines = content.split('\n');

  const textCounts = new Map<string, number>();
  for (const line of lines) textCounts.set(line, (textCounts.get(line) ?? 0) + 1);

  const targets = new Set<number>();
  for (const anchor of fileAnchors) {
    const recorded = anchor.lineNumber - 1;
    if (lines[recorded] === anchor.line) {
      targets.add(recorded);
      continue;
    }
    // The recorded number no longer holds this text — earlier edits shifted
    // the file. Fall back to a text match only when it is unambiguous;
    // otherwise leave the anchor unresolved rather than risk a line that was
    // never localized for this finding.
    if ((textCounts.get(anchor.line) ?? 0) === 1) {
      const fallback = lines.indexOf(anchor.line);
      if (fallback !== -1) targets.add(fallback);
    }
  }

  if (targets.size === 0) return content;

  return lines.map((line, i) => (targets.has(i) ? applyOpsToLine(line, ops).line : line)).join('\n');
}
