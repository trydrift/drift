/**
 * What PyPI would have resolved a range requirement to on a given historical
 * date — the fallback issue #213 asks for when no committed lockfile pins a
 * package's before-version.
 *
 * This is deliberately not a real dependency resolver: it does not consider
 * transitive constraints, environment markers, or wheel/platform
 * compatibility, all of which can change what `pip install` actually picks.
 * It answers a narrower, defensible question — "of the versions PyPI had
 * published by this date, which is the newest that satisfies the declared
 * specifier" — which is the same question a lockfile answers when one exists.
 * When the specifier cannot be parsed with confidence, this returns `null`
 * rather than guess; an unresolved case stays unresolved.
 */

export interface PypiRelease {
  /** ISO 8601 upload time of the release's earliest file, or `null` if PyPI reported none usable. */
  uploadedAt: string | null;
}

/** The shape this module needs from PyPI's JSON API, isolated for injection in tests. */
export type Fetcher = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/**
 * A PEP 440 version, loosely.
 *
 * Handles the overwhelming majority of real-world versions: a release segment
 * of arbitrary length (`1.2.3.4`) and an optional pre/post/dev qualifier.
 * What it does not handle — epochs (`1!2.0`), local versions (`+build.1`) —
 * is rare enough in practice that treating those as unparseable (returning
 * `null`, never a wrong ordering) is the safer trade.
 */
export interface ParsedVersion {
  release: number[];
  /** Ordering rank: dev < pre-release (a/b/rc) < final < post. */
  qualifierRank: number;
  qualifierNumber: number;
}

const VERSION_RE = /^\s*v?(\d+(?:\.\d+)*)((?:a|b|rc|c)\d*)?(?:\.?(post\d*))?(?:\.?(dev\d*))?\s*$/i;

export function parsePep440(raw: string): ParsedVersion | null {
  if (/[+!]/.test(raw)) return null; // epoch or local version — out of scope, see module doc.
  const match = VERSION_RE.exec(raw);
  if (!match) return null;

  const release = match[1]!.split('.').map(Number);
  const pre = match[2];
  const post = match[3];
  const dev = match[4];

  // dev < {a,b,rc/c} < final < post. A release can carry at most a pre or a
  // post in practice; when a real version carries both, the post rank wins,
  // which matches how pip orders `X.Ypost1` above `X.Yrc1`.
  let qualifierRank = 2; // final
  let qualifierNumber = 0;
  if (pre) {
    qualifierRank = pre[0]!.toLowerCase() === 'a' ? 0 : pre[0]!.toLowerCase() === 'b' ? 1 : 1.5; // rc/c
    qualifierNumber = Number(pre.slice(pre[0]!.length === 2 ? 2 : 1).replace(/^c|rc/i, '') || 0);
  }
  if (dev) {
    qualifierRank = -1;
    qualifierNumber = Number(dev.replace(/^dev/i, '') || 0);
  }
  if (post) {
    qualifierRank = 3;
    qualifierNumber = Number(post.replace(/^post/i, '') || 0);
  }

  return { release, qualifierRank, qualifierNumber };
}

/** -1, 0, 1 — release segments compared positionally (short segments pad with 0), then the qualifier. */
export function comparePep440(a: ParsedVersion, b: ParsedVersion): number {
  const len = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (a.release[i] ?? 0) - (b.release[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (a.qualifierRank !== b.qualifierRank) return a.qualifierRank > b.qualifierRank ? 1 : -1;
  if (a.qualifierNumber !== b.qualifierNumber) return a.qualifierNumber > b.qualifierNumber ? 1 : -1;
  return 0;
}

/**
 * Does `version` satisfy every comma-separated clause in `specifier`?
 *
 * Supports `==`, `!=`, `<=`, `>=`, `<`, `>`, and `~=` (compatible release: the
 * same behaviour as `>=X.Y, ==X.*` one level up). A `.*` prefix-match clause
 * (`!=3.5.*`) is handled by comparing release prefixes directly rather than
 * through the numeric comparator. A clause this cannot parse makes the whole
 * check return `null` — "unknown", not "fails" — so a caller can tell "this
 * version was rejected" apart from "this specifier could not be evaluated".
 */
export function satisfiesPep440(version: string, specifier: string): boolean | null {
  const target = parsePep440(version);
  if (!target) return null;

  const clauses = specifier
    .split(',')
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (clauses.length === 0) return true;

  for (const clause of clauses) {
    const match = /^(==|!=|<=|>=|<|>|~=)\s*(.+)$/.exec(clause);
    if (!match) return null;
    const [, op, rawBound] = match;
    const wildcard = rawBound!.endsWith('.*');
    const boundText = wildcard ? rawBound!.slice(0, -2) : rawBound!;
    const bound = parsePep440(boundText);
    if (!bound) return null;

    if (wildcard) {
      const prefix = bound.release;
      const matchesPrefix = prefix.every((part, i) => target.release[i] === part);
      if (op === '==' && !matchesPrefix) return false;
      if (op === '!=' && matchesPrefix) return false;
      if (op !== '==' && op !== '!=') return null; // `.*` is only meaningful with ==/!=
      continue;
    }

    const cmp = comparePep440(target, bound);
    const ok =
      op === '==' ? cmp === 0
      : op === '!=' ? cmp !== 0
      : op === '<=' ? cmp <= 0
      : op === '>=' ? cmp >= 0
      : op === '<' ? cmp < 0
      : op === '>' ? cmp > 0
      : // ~=X.Y means >=X.Y, ==X.* (drop the last release component for the prefix match)
        cmp >= 0 && bound.release.slice(0, -1).every((part, i) => target.release[i] === part);
    if (!ok) return false;
  }
  return true;
}

/**
 * The newest version PyPI had published, as of `isoDate`, that satisfies
 * `specifier` — or `null` when nothing qualifies or the answer could not be
 * established with confidence.
 *
 * "Published by `isoDate`" is read from the *earliest* uploaded file of each
 * release (a wheel and an sdist for the same version upload minutes apart;
 * the first is what a resolver on that date would have seen). A release with
 * no non-yanked file, or none PyPI reports a timestamp for, is skipped rather
 * than assumed available.
 */
export async function resolveVersionAsOfDate(
  name: string,
  isoDate: string,
  specifier: string | null,
  fetchImpl: Fetcher,
): Promise<{ version: string; source: 'pypi-date-filtered' } | null> {
  const cutoff = Date.parse(isoDate);
  if (Number.isNaN(cutoff)) return null;

  let payload: unknown;
  try {
    const response = await fetchImpl(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
    if (!response.ok) return null;
    payload = await response.json();
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object' || !('releases' in payload)) return null;
  const releases = (payload as { releases: unknown }).releases;
  if (!releases || typeof releases !== 'object') return null;

  let best: { raw: string; parsed: ParsedVersion } | null = null;
  for (const [raw, filesUnknown] of Object.entries(releases as Record<string, unknown>)) {
    if (!Array.isArray(filesUnknown) || filesUnknown.length === 0) continue;
    const files = filesUnknown as { upload_time_iso_8601?: string; upload_time?: string; yanked?: boolean }[];
    const usable = files.filter((file) => !file.yanked);
    if (usable.length === 0) continue;

    const earliest = usable
      .map((file) => Date.parse(file.upload_time_iso_8601 ?? file.upload_time ?? ''))
      .filter((time) => !Number.isNaN(time))
      .sort((a, b) => a - b)[0];
    if (earliest === undefined || earliest > cutoff) continue;

    if (specifier) {
      const satisfies = satisfiesPep440(raw, specifier);
      if (satisfies !== true) continue; // `false` rejects it, `null` (unparseable) also does not qualify
    }

    const parsed = parsePep440(raw);
    if (!parsed) continue;
    // A pre/dev release only counts when nothing else does — the same rule
    // pip's resolver applies by default (`--pre` opts in explicitly).
    if (parsed.qualifierRank < 2 && best && best.parsed.qualifierRank >= 2) continue;

    if (!best || comparePep440(parsed, best.parsed) > 0 || (best.parsed.qualifierRank < 2 && parsed.qualifierRank >= 2)) {
      best = { raw, parsed };
    }
  }

  return best ? { version: best.raw, source: 'pypi-date-filtered' } : null;
}
