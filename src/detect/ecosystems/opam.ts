import type { DependencyKind } from '../../types.js';
import { basename, type DependencyMap, type ManifestParser } from './types.js';

/**
 * OCaml — `*.opam`, `dune-project`, and `*.opam.locked`.
 *
 * opam's `depends:` field is a list whose elements are either a bare package
 * name or a name followed by a constraint formula:
 *
 *   depends: [
 *     "ocaml" {>= "4.14"}
 *     "dune" {>= "3.0" & build}
 *     "alcotest" {with-test}
 *   ]
 *
 * The braces carry both version constraints and *filters* — `with-test`,
 * `with-doc`, `build`, `dev` — which is how opam spells a dev dependency. Both
 * live in the same expression, so they are read together rather than by two
 * passes that could disagree.
 */
export const opamParser: ManifestParser = {
  ecosystem: 'opam',
  name: 'opam',

  handles(path) {
    const base = basename(path);
    return base.endsWith('.opam') || base.endsWith('.opam.locked') || base === 'dune-project';
  },

  isLockfile(path) {
    return basename(path).endsWith('.opam.locked');
  },

  parse(content, path) {
    const lockfile = basename(path).endsWith('.opam.locked');
    return parseOpam(content, lockfile);
  },
};

/** Fields that hold dependencies, and what a bare entry in them means. */
const DEPENDS_FIELDS: Record<string, DependencyKind> = {
  depends: 'runtime',
  depopts: 'optional',
};

function parseOpam(content: string, lockfile: boolean): DependencyMap {
  const out: DependencyMap = new Map();

  for (const [field, defaultKind] of Object.entries(DEPENDS_FIELDS)) {
    for (const body of listsOf(content, field)) {
      for (const entry of splitEntries(body)) {
        const name = /^"([^"]+)"/.exec(entry)?.[1];
        if (!name) continue;

        const constraint = /\{([\s\S]*)\}/.exec(entry)?.[1] ?? '';

        // A filter, not a version. `with-test` and `with-doc` mark a package
        // that is only pulled in for tests or docs.
        const kind: DependencyKind = /\bwith-test\b|\bwith-doc\b|\bdev\b/.test(constraint)
          ? 'dev'
          : defaultKind;

        out.set(name, {
          version: versionOf(constraint),
          // A `.locked` file is a resolved snapshot: every entry in it is a
          // fact about what was installed, which is the transitive set.
          kind: lockfile ? 'transitive' : kind,
        });
      }
    }
  }

  return out;
}

/**
 * The version a constraint formula pins.
 *
 * `{= "1.2.3"}` is an exact pin and the common case in a `.locked` file.
 * Anything else — `>= "4.14" & < "5.0"` — is kept verbatim as a range, since
 * that is what the manifest actually says and rewriting it would be a claim.
 * A formula with no version at all (`{build}`, `{with-test}`) yields `null`.
 */
function versionOf(constraint: string): string | null {
  if (!constraint.trim()) return null;

  const comparisons = [...constraint.matchAll(/([<>=!]+)\s*"([^"]+)"/g)].map(
    (m) => `${m[1]} ${m[2]}`,
  );
  if (comparisons.length === 0) return null;

  const exact = /^=\s/.exec(comparisons[0]!) && comparisons.length === 1;
  return exact ? comparisons[0]!.slice(2) : comparisons.join(' & ');
}

/** The bracketed bodies of every `field: [ … ]` in the document. */
function listsOf(content: string, field: string): string[] {
  const out: string[] = [];
  const opener = new RegExp(`(?:^|\\n)\\s*${field}\\s*:\\s*\\[`, 'g');

  for (const match of content.matchAll(opener)) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    for (; i < content.length && depth > 0; i++) {
      const ch = content[i];
      if (ch === '"') {
        // Skip the whole string, so a `]` inside one does not close the list.
        i += 1;
        while (i < content.length && content[i] !== '"') {
          if (content[i] === '\\') i += 1;
          i += 1;
        }
        continue;
      }
      if (ch === '[') depth += 1;
      else if (ch === ']') depth -= 1;
    }
    out.push(content.slice(start, i - 1));
  }

  return out;
}

/**
 * Split a `depends:` body into one entry per package.
 *
 * Entries are whitespace-separated, but a `{ … }` formula may contain spaces,
 * so the split has to respect brace depth rather than being a `.split(/\s+/)`.
 */
function splitEntries(body: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;

    if (ch === '"') {
      current += ch;
      i += 1;
      while (i < body.length && body[i] !== '"') {
        current += body[i];
        if (body[i] === '\\') {
          i += 1;
          current += body[i] ?? '';
        }
        i += 1;
      }
      current += '"';
      continue;
    }

    if (ch === '{' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ')') depth -= 1;

    // A new entry begins at a quote that starts at depth zero.
    if (depth === 0 && /\s/.test(ch)) {
      if (current.trim() && !current.trimEnd().endsWith('&') && peekStartsEntry(body, i)) {
        out.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }

  if (current.trim()) out.push(current.trim());
  return out;
}

/** True when the next non-space character opens a new `"name"` entry. */
function peekStartsEntry(body: string, from: number): boolean {
  for (let i = from; i < body.length; i++) {
    if (/\s/.test(body[i]!)) continue;
    return body[i] === '"';
  }
  return false;
}
