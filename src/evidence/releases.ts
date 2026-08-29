import type { Ecosystem } from '../types.js';
import { fetchJson } from '../util/http.js';
import { compareParsedVersions, parsePublishedVersion } from '../version-semantics.js';

export interface ReleaseNote {
  tag: string;
  version: string;
  name: string | null;
  body: string;
  url: string;
  publishedAt: string | null;
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
}

/**
 * Fetch GitHub release notes for the versions in `(from, to]`.
 *
 * Release notes are usually richer than a CHANGELOG for the specific question
 * Drift asks — maintainers write "BREAKING:" in a release body far more often
 * than they maintain a changelog file — so this runs even when a changelog was
 * found, and the analyser considers both.
 *
 * A token is optional. Without one this works against public repos at the
 * unauthenticated rate limit; the Action always supplies its `GITHUB_TOKEN`,
 * which raises the limit without granting access to anything new.
 */
export async function fetchReleaseNotes(
  githubRepo: string,
  from: string,
  to: string,
  ecosystem: Ecosystem,
  options: { token?: string; maxReleases?: number } = {},
): Promise<ReleaseNote[]> {
  const { token, maxReleases = 25 } = options;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const lower = parsePublishedVersion(from, ecosystem);
  const upper = parsePublishedVersion(to, ecosystem);
  if (!lower || !upper) return [];

  const direction = compareParsedVersions(upper, lower);
  if (direction === null) return [];
  const [lo, hi] = direction > 0 ? [lower, upper] : [upper, lower];

  const collected: ReleaseNote[] = [];
  const PER_PAGE = 100;
  const MAX_PAGES = 5;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const releases = await fetchJson<GitHubRelease[]>(
      `https://api.github.com/repos/${githubRepo}/releases?per_page=${PER_PAGE}&page=${page}`,
      { headers },
    );
    if (!releases || releases.length === 0) break;

    let sawOlderThanRange = false;

    for (const release of releases) {
      if (release.draft) continue;

      const version = versionFromTag(release.tag_name, ecosystem);
      if (!version) continue;

      // Releases come back newest-first, so once we are below the range we can
      // stop paginating instead of walking the project's entire history.
      const comparedLow = compareParsedVersions(version, lo);
      const comparedHigh = compareParsedVersions(version, hi);
      if (comparedLow === null || comparedHigh === null) continue;
      if (comparedLow <= 0) {
        sawOlderThanRange = true;
        continue;
      }
      if (comparedHigh > 0) continue;

      collected.push({
        tag: release.tag_name,
        version: version.raw,
        name: release.name,
        body: release.body ?? '',
        url: release.html_url,
        publishedAt: release.published_at,
      });
    }

    // Deliberately no "we have enough now" break. Releases arrive newest-first,
    // so stopping once `maxReleases` were collected meant never paginating back
    // to the major release at the bottom of the range — the one release that
    // actually documents the migration. Pagination stops when the range is
    // exhausted, and `selectReleases` decides what to keep.
    if (sawOlderThanRange || releases.length < PER_PAGE) break;
  }

  return selectReleases(collected, maxReleases, ecosystem);
}

/**
 * Which releases to keep when the range holds more than the cap.
 *
 * Sorting newest-first and slicing keeps the wrong end. Upgrading zod 3.24.1 →
 * 4.4.3 spans about a hundred releases, and taking the twenty newest kept
 * 4.4.3 down to 4.1.7 — patch notes — while dropping every release that
 * crossed a major boundary, which is where a maintainer writes down what
 * breaks. The result was a major upgrade reported as having no breaking
 * changes.
 *
 * So major and minor boundaries are taken first, oldest first, because the
 * `x.0.0` release is where the migration is documented. Whatever budget is
 * left goes to the newest remaining releases, which is where "we broke this by
 * accident, sorry" tends to appear.
 */
export function selectReleases(
  releases: readonly ReleaseNote[],
  max: number,
  ecosystem: Ecosystem = 'npm',
): ReleaseNote[] {
  const parsed = (release: ReleaseNote) => parsePublishedVersion(release.version, ecosystem);
  const ordered = [...releases].sort((a, b) => {
    const left = parsed(a);
    const right = parsed(b);
    return left && right ? -(compareParsedVersions(left, right) ?? 0) : 0;
  });
  if (ordered.length <= max) return ordered;

  const boundaries = ordered
    .filter((release) => {
      const version = parsed(release);
      return Boolean(version?.release && (version.release[2] ?? 0) === 0 && !version.prerelease);
    })
    .sort((a, b) => {
      const left = parsed(a);
      const right = parsed(b);
      return left && right ? (compareParsedVersions(left, right) ?? 0) : 0;
    });

  const kept = new Map<string, ReleaseNote>();
  for (const release of boundaries) {
    if (kept.size >= max) break;
    kept.set(release.version, release);
  }
  for (const release of ordered) {
    if (kept.size >= max) break;
    kept.set(release.version, release);
  }

  return [...kept.values()].sort((a, b) => {
    const left = parsed(a);
    const right = parsed(b);
    return left && right ? -(compareParsedVersions(left, right) ?? 0) : 0;
  });
}

/** Keep the Git tag intact while extracting only a comparison candidate. */
function versionFromTag(tag: string, ecosystem: Ecosystem) {
  const direct = parsePublishedVersion(tag, ecosystem);
  if (direct) return direct;
  const candidates = tag.match(/v?\d[0-9A-Za-z.!+_-]*(?:\.[0-9A-Za-z!+_-]+)*/g) ?? [];
  for (const candidate of candidates) {
    const parsed = parsePublishedVersion(candidate, ecosystem)
      ?? (candidate.startsWith('v') ? parsePublishedVersion(candidate.slice(1), ecosystem) : null);
    if (parsed) return parsed;
  }
  return null;
}
