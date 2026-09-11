import { githubRepoSlug } from '../util/github-url.js';
import { fetchJson, fetchText } from '../util/http.js';

/**
 * One shared reader for `ocaml/opam-repository`.
 *
 * opam has no JSON metadata API — its index *is* a git repository, where every
 * release lives at `packages/<name>/<name>.<version>/opam`. Drift already
 * listed that directory to enumerate versions, but `fetchRegistryInfo(...,
 * 'opam')` still returned `null`, so packages with an explicit GitHub
 * `dev-repo` in their `opam` file lost all release/changelog research.
 *
 * This module reads *only literal metadata* out of the `opam` file with a
 * line/quote parser. It never runs opam, never evaluates a build script,
 * filter, or variable interpolation.
 */

const CONTENTS_API = (name: string): string =>
  `https://api.github.com/repos/ocaml/opam-repository/contents/packages/${encodeURIComponent(name)}`;
const BRANCH_API = 'https://api.github.com/repos/ocaml/opam-repository/branches/master';
const RAW_OPAM = (name: string, version: string, ref: string): string =>
  `https://raw.githubusercontent.com/ocaml/opam-repository/${ref}/packages/${encodeURIComponent(
    name,
  )}/${encodeURIComponent(`${name}.${version}`)}/opam`;

/**
 * Resolve `opam-repository`'s `master` to the commit SHA it currently points
 * at. `master` is a moving ref, so a raw URL built on it is *not* immutable;
 * pinning it to a commit first makes the blob URL genuinely content-addressed
 * and safe to cache immutably. Fetched with ordinary cache/TTL behaviour (the
 * SHA does move), and `null` when the API is unreachable — the caller then
 * falls back to `master` with non-immutable caching.
 */
async function resolveOpamRepoCommit(headers?: Record<string, string>): Promise<string | null> {
  const branch = await fetchJson<{ commit?: { sha?: string } }>(BRANCH_API, {
    ...(headers ? { headers } : {}),
  }).catch(() => null);
  const sha = branch?.commit?.sha;
  return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export interface OpamMetadata {
  name: string;
  version: string;
  devRepo: string | null;
  homepage: string | null;
  bugReports: string | null;
  doc: string | null;
  synopsis: string | null;
  description: string | null;
  /** The `src:` URL from the `url { ... }` stanza — a tarball or archive link. */
  sourceUrl: string | null;
}

function validName(name: string): boolean {
  return /^[\w.+-]+$/.test(name);
}

/**
 * Every published version of `name`, as directory names under
 * `packages/<name>/`. `null` when the listing could not be read (a package
 * published only in a custom repository, a rate-limited API).
 */
export async function fetchOpamPackageVersions(
  name: string,
  options: { headers?: Record<string, string> } = {},
): Promise<string[] | null> {
  if (!validName(name)) return null;

  // No local memo: the HTTP layer already dedupes an in-flight GET and caches
  // the response, so both callers (evidence and the version scanner) share one
  // request without this module holding state across scans or tests.
  const entries = await fetchJson<{ name?: string; type?: string }[]>(CONTENTS_API(name), {
    ...(options.headers ? { headers: options.headers } : {}),
  }).catch(() => null);
  if (!Array.isArray(entries)) return null;

  const prefix = `${name}.`;
  return entries
    .filter((entry) => entry.type === 'dir' && entry.name?.startsWith(prefix))
    .map((entry) => entry.name!.slice(prefix.length));
}

/** Literal metadata from `packages/<name>/<name>.<version>/opam`, or `null`. */
export async function fetchOpamMetadata(name: string, version: string): Promise<OpamMetadata | null> {
  if (!validName(name)) return null;

  // Pin `master` to a commit so the blob URL is content-addressed and can be
  // cached immutably. Without a resolvable commit, read from `master` under
  // ordinary cache/TTL rules — never as immutable, since the ref moves.
  const commit = await resolveOpamRepoCommit();
  const text = commit
    ? await fetchText(RAW_OPAM(name, version, commit), { immutable: true }).catch(() => null)
    : await fetchText(RAW_OPAM(name, version, 'master')).catch(() => null);
  return text ? parseOpamMetadata(text, name, version) : null;
}

/**
 * Parse the literal fields Drift needs from an `opam` file.
 *
 * Only quoted string scalars and the `url { src: "…" }` stanza are read.
 * Anything with a variable (`%{name}%`), a filter (`{ build }`), or a list is
 * left alone — this is a metadata read, not an evaluation.
 */
export function parseOpamMetadata(text: string, name: string, version: string): OpamMetadata {
  // `field: "value"` string scalars. Every field read here is metadata Drift
  // treats as a *resolved literal* (a URL, an attribution target), so a value
  // carrying an opam variable expansion — `%{name}%`, `%{version}%` — is not a
  // literal and must be rejected rather than used verbatim. Prose fields
  // (synopsis, description) are captured separately and never evaluated.
  const literal = (field: string): string | null => {
    const m = new RegExp(`(?:^|\\n)\\s*${field}\\s*:\\s*"([^"\\n]*)"`).exec(text);
    return m ? asLiteral(m[1]!) : null;
  };
  const scalar = (field: string): string | null => {
    const m = new RegExp(`(?:^|\\n)\\s*${field}\\s*:\\s*"([^"\\n]*)"`).exec(text);
    const value = m?.[1]?.trim();
    return value ? value : null;
  };

  // `description: """ ... """` (triple-quoted block) or a single-quoted string.
  const description = (() => {
    const block = /(?:^|\n)\s*description\s*:\s*"""([\s\S]*?)"""/.exec(text);
    if (block) return block[1]!.trim() || null;
    return scalar('description');
  })();

  const sourceUrl = (() => {
    // opam permits the stanza's closing brace to be indented (`  }`), and some
    // published `opam` files write it that way. Anchoring on `\n}` at column 0
    // dropped the whole `url { … }` scope for those, losing the `src:` URL —
    // the primary source-of-truth for GitHub attribution. Allow leading
    // whitespace before the brace.
    const stanza = /(?:^|\n)\s*url\s*\{([\s\S]*?)\n[ \t]*\}/.exec(text);
    const scope = stanza ? stanza[1]! : text;
    const src = /(?:^|\n)\s*src\s*:\s*"([^"\n]+)"/.exec(scope) ?? /(?:^|\n)\s*archive\s*:\s*"([^"\n]+)"/.exec(scope);
    // `src:`/`archive:` are literal URL evidence, held to the same bar as the
    // other URL fields: an interpolated value is not a resolved location.
    return src ? asLiteral(src[1]!) : null;
  })();

  return {
    name,
    version,
    devRepo: literal('dev-repo'),
    homepage: literal('homepage'),
    bugReports: literal('bug-reports'),
    doc: literal('doc'),
    synopsis: scalar('synopsis'),
    description,
    sourceUrl,
  };
}

/**
 * A value used as literal URL / attribution evidence, or `null`.
 *
 * opam values can carry variable expansions (`%{version}%`, `%{name}%`),
 * filter interpolations, and conditionals. Drift does not evaluate opam, so a
 * value containing any of that is not a resolved literal and must not be used
 * as one. Prose fields go through a separate path and are never interpreted.
 */
function asLiteral(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/%\{[^}]*\}%?/.test(value)) return null;
  return value;
}

/**
 * The `owner/repo` an opam package points at, or `null` — never a guess.
 *
 * Priority: `dev-repo`, then a GitHub source/archive URL, then `homepage` or
 * `bug-reports` *only* when they are themselves GitHub URLs.
 */
export function githubRepoFromOpam(meta: OpamMetadata): string | null {
  return (
    githubRepoSlug(meta.devRepo) ??
    githubRepoSlug(meta.sourceUrl) ??
    githubRepoSlug(meta.homepage) ??
    githubRepoSlug(meta.bugReports)
  );
}
