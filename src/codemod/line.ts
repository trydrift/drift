/**
 * Line-level primitives shared by every deterministic transform Drift runs.
 *
 * Extracted from `codemod/index.ts` rather than duplicated because the fix
 * plan engine (`src/fixplan/`) has to make exactly the same judgements the
 * built-in codemod does — what counts as a whole word, what is inside a
 * string literal, what is a comment — and two implementations of "is this
 * occurrence real" that drifted apart would mean a transform Drift proved
 * safe under one set of rules being applied under another.
 *
 * All of it is line-based on purpose. Drift indexes a dozen ecosystems with
 * the same line-based convention (`localize/index.ts`) precisely so no stage
 * needs a bespoke AST per language; a transform engine that only worked for
 * TypeScript would undercut the point of putting it in the shared pipeline.
 */

/**
 * Replace the contents of every quoted string on a line with spaces, keeping
 * the delimiters and the line's length.
 *
 * Indices into the result therefore still line up with the original line, so
 * a caller can match against the masked text and substitute into the real
 * one. Handles single, double, and backtick quotes with backslash-escaped
 * delimiters — the common case across every ecosystem Drift indexes, not a
 * full per-language string grammar. Template literal interpolations are
 * masked along with everything else between the backticks, which only makes
 * this stricter, never looser.
 */
export function maskQuotedSpans(line: string): string {
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

/**
 * Every quoted string on a line, as `[start, end]` index pairs into the
 * original line covering the delimiters and their contents.
 *
 * The inverse view of `maskQuotedSpans`, for the one transform that has to
 * work *inside* a string rather than outside it: a module specifier is a
 * string literal, so rewriting an import path is the exact case where the
 * masking rule the other transforms rely on has to be turned around.
 */
export function quotedSpans(line: string): { start: number; end: number; quote: string; content: string }[] {
  const spans: { start: number; end: number; quote: string; content: string }[] = [];
  let quote: string | null = null;
  let start = -1;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;

    if (quote) {
      if (ch === '\\' && i + 1 < line.length) {
        i += 1;
        continue;
      }
      if (ch === quote) {
        spans.push({ start, end: i, quote, content: line.slice(start + 1, i) });
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      start = i;
    }
  }

  return spans;
}

/**
 * Replace every match of `matcher` that falls outside a quoted string.
 *
 * A real impact-site line can legitimately contain the old name a second
 * time inside a string literal — a log message, an error string, a fixture —
 * that has nothing to do with the identifier being changed. `matcher` is
 * applied to the masked line and the substitution is made in the real one.
 */
export function replaceOutsideStrings(line: string, matcher: RegExp, replacement: string): string {
  const masked = maskQuotedSpans(line);
  matcher.lastIndex = 0;

  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(masked))) {
    const start = match.index;
    const end = start + match[0].length;
    result += line.slice(cursor, start) + replacement;
    cursor = end;
  }
  result += line.slice(cursor);
  return result;
}

/** A line that is nothing but a comment, in any of the syntaxes Drift indexes. */
export function isCommentOnly(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  );
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
