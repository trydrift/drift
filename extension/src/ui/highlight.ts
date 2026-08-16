/**
 * A tiny, dependency-free syntax highlighter for the short snippets Drift
 * renders — a call-site excerpt, a before/after declaration, a fenced code
 * block copied out of a changelog. Not a real tokenizer for any one
 * language: just enough to tell comments, strings, numbers, keywords and
 * calls apart, so these read as code instead of a flat wall of text in
 * whatever color the webview's default `<code>` styling happens to be.
 */

const KEYWORDS = new Set([
  'function', 'const', 'let', 'var', 'return', 'if', 'else', 'for', 'while', 'do',
  'class', 'import', 'export', 'from', 'as', 'new', 'async', 'await',
  'public', 'private', 'protected', 'static', 'abstract', 'readonly', 'override',
  'get', 'set', 'def', 'fn', 'pub', 'struct', 'impl', 'trait', 'interface', 'type',
  'enum', 'namespace', 'module', 'package', 'func', 'val', 'object', 'when',
  'null', 'undefined', 'None', 'True', 'False', 'true', 'false', 'nil', 'NULL',
  'self', 'this', 'super', 'throw', 'try', 'catch', 'finally', 'switch', 'case',
  'break', 'continue', 'default', 'extends', 'implements', 'yield', 'in', 'of',
  'is', 'not', 'and', 'or', 'typeof', 'instanceof', 'void', 'delete',
  'elif', 'pass', 'raise', 'global', 'nonlocal', 'lambda', 'with', 'match',
  'mut', 'use', 'where', 'unsafe', 'mod', 'end', 'then', 'begin',
]);

// Ordered so a longer/more specific alternative always wins over a shorter
// one that would otherwise swallow part of it — a block comment before a
// line comment, a string before a bare number.
const TOKEN_RE =
  /\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b|[A-Za-z_$][\w$]*/g;

export function highlightCode(code: string): string {
  let out = '';
  let last = 0;
  for (const match of code.matchAll(TOKEN_RE)) {
    const start = match.index ?? 0;
    const text = match[0];
    out += escapeHtml(code.slice(last, start));
    out += classify(text, code, start + text.length);
    last = start + text.length;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

function classify(text: string, source: string, endIndex: number): string {
  const escaped = escapeHtml(text);
  const first = text[0]!;

  if (text.startsWith('//') || text.startsWith('#') || text.startsWith('/*')) {
    return `<span class="tok-com">${escaped}</span>`;
  }
  if (first === '"' || first === "'" || first === '`') {
    return `<span class="tok-str">${escaped}</span>`;
  }
  if (first >= '0' && first <= '9') {
    return `<span class="tok-num">${escaped}</span>`;
  }
  if (KEYWORDS.has(text)) {
    return `<span class="tok-kw">${escaped}</span>`;
  }
  // A bare identifier directly followed by `(` (skipping whitespace) is
  // being called — that is what actually distinguishes a function name from
  // any other variable in a snippet with no type information to lean on.
  let i = endIndex;
  while (i < source.length && /\s/.test(source[i]!)) i++;
  if (source[i] === '(') return `<span class="tok-fn">${escaped}</span>`;

  return escaped;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
