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
const RAW_OPAM = (name: string, version: string): string =>
  `https://raw.githubusercontent.com/ocaml/opam-repository/master/packages/${encodeURIComponent(
    name,
  )}/${encodeURIComponent(`${name}.${version}`)}/opam`;

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
  const text = await fetchText(RAW_OPAM(name, version), { immutable: true }).catch(() => null);
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
  const scalar = (field: string): string | null => {
    // `field: "value"` — reject a value containing an opam variable expansion.
    const m = new RegExp(`(?:^|\\n)\\s*${field}\\s*:\\s*"([^"\\n]*)"`).exec(text);
    if (!m) return null;
    const value = m[1]!.trim();
    return value && !value.includes('%{') ? value : null;
  };

  // `description: """ ... """` (triple-quoted block) or a single-quoted string.
  const description = (() => {
    const block = /(?:^|\n)\s*description\s*:\s*"""([\s\S]*?)"""/.exec(text);
    if (block) return block[1]!.trim() || null;
    return scalar('description');
  })();

  const sourceUrl = (() => {
    const stanza = /(?:^|\n)\s*url\s*\{([\s\S]*?)\n\}/.exec(text);
    const scope = stanza ? stanza[1]! : text;
    const src = /(?:^|\n)\s*src\s*:\s*"([^"\n]+)"/.exec(scope) ?? /(?:^|\n)\s*archive\s*:\s*"([^"\n]+)"/.exec(scope);
    return src ? src[1]!.trim() : null;
  })();

  return {
    name,
    version,
    devRepo: scalar('dev-repo'),
    homepage: scalar('homepage'),
    bugReports: scalar('bug-reports'),
    doc: scalar('doc'),
    synopsis: scalar('synopsis'),
    description,
    sourceUrl,
  };
}

/**
 * The `owner/repo` an opam package points at, or `null` — never a guess.
 *
 * Priority: `dev-repo`, then a GitHub source/archive URL, then `homepage` or
 * `bug-reports` *only* when they are themselves GitHub URLs.
 */
export function githubRepoFromOpam(meta: OpamMetadata): string | null {
  return (
    githubSlug(meta.devRepo) ??
    githubSlug(meta.sourceUrl) ??
    githubSlug(meta.homepage) ??
    githubSlug(meta.bugReports)
  );
}

function githubSlug(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(url.trim());
  if (!match) return null;
  const owner = match[1]!;
  const repo = match[2]!;
  if (!owner || !repo || owner === 'sponsors') return null;
  return `${owner}/${repo}`;
}
