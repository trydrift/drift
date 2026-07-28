/**
 * A deliberately partial TOML reader.
 *
 * Drift only ever reads dependency tables and inline arrays of requirement
 * strings from `pyproject.toml` / `Cargo.toml`. A full TOML parser is a
 * meaningful dependency to take on, and getting the last 10% of the grammar
 * right buys us nothing — so this scans table headers and key/value lines and
 * stops there. Anything it can't understand is simply not reported, which
 * degrades to "Drift saw no change" rather than to a wrong answer.
 */

export interface TomlTable {
  /** Dotted header, e.g. `tool.poetry.dependencies`. */
  header: string;
  /** Raw `key = value` pairs, values still quoted/braced as written. */
  entries: Map<string, string>;
  /** Lines belonging to this table, for array-valued keys. */
  lines: string[];
}

export function scanTomlTables(content: string): TomlTable[] {
  const tables: TomlTable[] = [];
  let current: TomlTable = { header: '', entries: new Map(), lines: [] };
  tables.push(current);

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replace(/\r$/, '');
    const line = stripComment(raw).trim();
    if (!line) continue;

    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line)?.[1];
    if (header) {
      current = { header: header.trim(), entries: new Map(), lines: [] };
      tables.push(current);
      continue;
    }

    current.lines.push(line);

    const eq = indexOfTopLevelEquals(line);
    if (eq === -1) continue;

    const key = unquote(line.slice(0, eq).trim());
    let value = line.slice(eq + 1).trim();

    // Multi-line arrays: keep consuming until brackets balance.
    if (value.startsWith('[') && countUnescaped(value, '[') > countUnescaped(value, ']')) {
      let depth = countUnescaped(value, '[') - countUnescaped(value, ']');
      while (depth > 0 && i + 1 < lines.length) {
        i += 1;
        const next = stripComment(lines[i]!).trim();
        value += ` ${next}`;
        current.lines.push(next);
        depth += countUnescaped(next, '[') - countUnescaped(next, ']');
      }
    }

    if (key) current.entries.set(key, value);
  }

  return tables;
}

export function findTable(tables: TomlTable[], header: string): TomlTable | undefined {
  return tables.find((t) => t.header === header);
}

/** Extract the string elements of a TOML array literal. */
export function parseTomlArray(value: string): string[] {
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  const out: string[] = [];
  for (const match of inner.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
    const v = match[1] ?? match[2];
    if (v !== undefined) out.push(v);
  }
  return out;
}

/**
 * Pull a version out of an inline table like `{ version = "1.2", optional = true }`,
 * falling back to a bare quoted string.
 */
export function parseTomlVersionValue(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) {
    const version = /(?:^|[{,]\s*)version\s*=\s*"([^"]*)"/.exec(trimmed)?.[1];
    return version ?? null;
  }
  const quoted = /^"([^"]*)"$/.exec(trimmed)?.[1] ?? /^'([^']*)'$/.exec(trimmed)?.[1];
  return quoted ?? null;
}

export function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

/** Strip a `#` comment, ignoring `#` that appears inside a quoted string. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

/** Index of the `=` that separates key from value, skipping quoted regions. */
function indexOfTopLevelEquals(line: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '=' && !inSingle && !inDouble) return i;
  }
  return -1;
}

function countUnescaped(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i += 1;
      continue;
    }
    if (s[i] === ch) n += 1;
  }
  return n;
}
