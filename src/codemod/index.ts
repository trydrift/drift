import type { BreakingChange, ImpactSite } from '../types.js';

/**
 * Deterministic codemods: mechanical fixes computed by code, never by a model.
 *
 * Scope is deliberately narrow, on purpose, in the same spirit as
 * `analyze/rules.ts` restricting prose rules to backtick-quoted identifiers:
 * a codemod here must be able to prove its own correctness by construction.
 * The only category that clears that bar today is a clean rename — one old
 * identifier, one new identifier, both plain identifiers with no dotted
 * member access, no import path, no punctuation — so a word-boundary replace
 * cannot silently rewrite something else that happens to share a substring.
 *
 * Matching follows `localize/index.ts`'s own word-boundary convention rather
 * than a per-language parser: Drift indexes a dozen ecosystems with the same
 * line-based approach precisely so no stage needs a bespoke AST for each one,
 * and a codemod that only ran for TypeScript would undercut the point of
 * putting it in the shared pipeline at all.
 *
 * Every edit is anchored to one of `localize`'s own impact sites — never to
 * "everywhere this word appears in the file." A rename that reused the
 * `renameIdentifier` word-boundary matcher across an entire file could
 * silently rewrite an unrelated string, object key, comment, or same-named
 * local that has nothing to do with this finding; anchoring to exact,
 * already-localized lines is what makes this "proved correct," not just
 * "usually correct." Quoted-string spans on an anchored line are masked
 * before matching for the same reason: a real impact-site line can still
 * contain the old name a second time inside a string literal that isn't the
 * identifier being renamed.
 *
 * This is why a codemod's edits are never trusted blindly: they still go
 * through the same scope validation and verification as an agent's output.
 * The lower cost comes from skipping the *generation* step for the cases this
 * module can resolve outright, not from a lower safety bar.
 */

/** A rule and its parameters — not a snapshot of any particular file. */
export interface CodemodTransform {
  ruleId: 'rename-identifier';
  from: string;
  to: string;
  /** Exact original lines this transform is allowed to touch. See `CodemodAnchor`. */
  anchors: CodemodAnchor[];
}

/**
 * One exact source line, as it read when Drift localized the site that
 * justified rewriting it.
 *
 * Re-application (`applyCodemodTransform`) matches against this verbatim
 * rather than against a stored line *number* — a plan can be applied well
 * after analysis, and after earlier commit units in the same run have already
 * added or removed lines above this one, which would silently invalidate a
 * number but not this line's own text. A line that no longer reads exactly
 * this way is left untouched rather than guessed at, the same "decline
 * rather than assume" rule `attemptCodemod` itself follows.
 */
export interface CodemodAnchor {
  file: string;
  line: string;
  /**
   * 1-indexed line number when this anchor was captured. Used only to
   * disambiguate two identical lines elsewhere in the same file — matching
   * on text alone would rewrite every line that happens to read the same,
   * including ones that were never localized as an impact site for this
   * change. If the file has shifted enough that this number no longer points
   * at `line`'s text, re-application falls back to a text match only when
   * that text is unique in the file; otherwise it declines rather than guess
   * which occurrence was the one actually localized.
   */
  lineNumber: number;
}

export interface CodemodEdit {
  file: string;
  before: string;
  after: string;
}

export interface CodemodResult {
  transform: CodemodTransform;
  /**
   * A preview computed against the file contents `attemptCodemod` was given,
   * for the report and the commit message. Not what a consumer should apply —
   * see `applyCodemodTransform`.
   */
  edits: CodemodEdit[];
  /** How many of the change's own impact sites this codemod actually touched. */
  sitesResolved: number;
}

const PLAIN_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Attempt a deterministic fix for one breaking change.
 *
 * `fileContents` must already hold the content of every file named by `sites`
 * — callers source it from the same in-memory read localization used, so this
 * never touches disk and stays a pure function over what the pipeline already
 * had in hand.
 *
 * Returns `null` when the change is not a plain rename, when either symbol
 * is not a plain identifier, or when nothing at the named impact sites
 * actually matched. "Declined to act" is a first-class outcome here, not an
 * error — the caller's fallback is simply to hand the finding to an agent as
 * before.
 */
export function attemptCodemod(
  change: BreakingChange,
  sites: readonly ImpactSite[],
  fileContents: ReadonlyMap<string, string>,
): CodemodResult | null {
  if (change.kind !== 'renamed-export') return null;
  if (change.symbols.length !== 1) return null;

  const from = change.symbols[0]!;
  const to = change.replacementSymbols?.[0];
  if (!to) return null;
  if (!PLAIN_IDENTIFIER.test(from) || !PLAIN_IDENTIFIER.test(to)) return null;
  if (from === to) return null;

  const sitesByFile = new Map<string, ImpactSite[]>();
  for (const site of sites) {
    if (site.matchedSymbol !== from) continue;
    const existing = sitesByFile.get(site.file);
    if (existing) existing.push(site);
    else sitesByFile.set(site.file, [site]);
  }

  const matcher = new RegExp(`\\b${escapeRegExp(from)}\\b`, 'g');
  const edits: CodemodEdit[] = [];
  const anchors: CodemodAnchor[] = [];
  let sitesResolved = 0;

  for (const [file, fileSites] of sitesByFile) {
    const before = fileContents.get(file);
    if (before === undefined) continue;

    const lines = before.split('\n');
    const resolvedLines = new Set<number>();

    for (const site of fileSites) {
      const index = site.line - 1;
      const line = lines[index];
      if (line === undefined || resolvedLines.has(index)) continue;
      if (isCommentOnly(line)) continue;

      const rewritten = renameOnLine(line, matcher, to);
      if (rewritten === line) continue;

      lines[index] = rewritten;
      resolvedLines.add(index);
      anchors.push({ file, line, lineNumber: index + 1 });
    }

    if (resolvedLines.size === 0) continue;

    edits.push({ file, before, after: lines.join('\n') });
    sitesResolved += fileSites.filter((site) => resolvedLines.has(site.line - 1)).length;
  }

  if (edits.length === 0) return null;

  const transform: CodemodTransform = { ruleId: 'rename-identifier', from, to, anchors };
  return { transform, edits, sitesResolved };
}

/**
 * Apply a codemod transform to one file's content, fresh.
 *
 * Deliberately re-derived from the rule and its anchors rather than replayed
 * from a stored `before`/`after` snapshot: a plan can be applied well after
 * analysis, and after earlier commit units have already changed the tree.
 * Re-applying the rule against whatever the file actually contains right now
 * — matching each anchor by its exact original text, not by line number — is
 * what makes the second, third, and Nth application correct, not just the
 * first, the same reason `advanceBase` in the extension's fix flow gives
 * every batch a fresh snapshot instead of reusing the run's original one.
 */
export function applyCodemodTransform(
  content: string,
  transform: { ruleId: string; from: string; to: string; anchors: readonly CodemodAnchor[] },
  file: string,
): string {
  switch (transform.ruleId) {
    case 'rename-identifier':
      return renameAtAnchors(content, transform.from, transform.to, transform.anchors, file);
    default:
      return content;
  }
}

function renameAtAnchors(
  source: string,
  from: string,
  to: string,
  anchors: readonly CodemodAnchor[],
  file: string,
): string {
  const fileAnchors = anchors.filter((a) => a.file === file);
  if (fileAnchors.length === 0) return source;

  const lines = source.split('\n');

  // How many lines in the file currently read exactly this text — needed
  // below to tell "the file shifted but this line is still uniquely
  // identifiable" apart from "this text is ambiguous, decline rather than
  // guess which occurrence was actually localized."
  const textCounts = new Map<string, number>();
  for (const line of lines) textCounts.set(line, (textCounts.get(line) ?? 0) + 1);

  const targetLines = new Set<number>();
  for (const anchor of fileAnchors) {
    const recordedIndex = anchor.lineNumber - 1;
    if (lines[recordedIndex] === anchor.line) {
      targetLines.add(recordedIndex);
      continue;
    }
    // The recorded line number no longer holds this exact text (earlier
    // edits shifted the file). Only fall back to a text match when it is
    // unambiguous — otherwise this anchor is left unresolved rather than
    // risking a line that was never localized for this change.
    if ((textCounts.get(anchor.line) ?? 0) === 1) {
      const fallbackIndex = lines.indexOf(anchor.line);
      if (fallbackIndex !== -1) targetLines.add(fallbackIndex);
    }
  }

  if (targetLines.size === 0) return source;

  const matcher = new RegExp(`\\b${escapeRegExp(from)}\\b`, 'g');
  return lines.map((line, index) => (targetLines.has(index) ? renameOnLine(line, matcher, to) : line)).join('\n');
}

/**
 * Replace every whole-word occurrence of `matcher` with `to` on a single
 * line, except where the occurrence falls inside a quoted string. A real
 * impact-site line can still legitimately contain the old name a second time
 * inside a string literal — a log message, an error string, a fixture — that
 * has nothing to do with the identifier being renamed.
 */
function renameOnLine(line: string, matcher: RegExp, to: string): string {
  const masked = maskQuotedSpans(line);
  matcher.lastIndex = 0;

  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(masked))) {
    const start = match.index;
    const end = start + match[0].length;
    result += line.slice(cursor, start) + to;
    cursor = end;
  }
  result += line.slice(cursor);
  return result;
}

/**
 * Replace the contents of every quoted string on a line with placeholder
 * characters of the same length, so indices still line up with the original
 * line for the caller's substitution. Handles single, double, and backtick
 * quotes with backslash-escaped delimiters — the common case across every
 * ecosystem Drift indexes, not a full per-language string grammar (template
 * literal interpolations, for instance, are masked along with everything
 * else between the backticks, which only makes this stricter, never looser).
 */
function maskQuotedSpans(line: string): string {
  let result = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;

    if (quote) {
      result += ch === quote ? ch : ' ';
      if (ch === '\\' && i + 1 < line.length) {
        result += ' ';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      result += ch;
      continue;
    }

    result += ch;
  }
  return result;
}

function isCommentOnly(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
