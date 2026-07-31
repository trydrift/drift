import semver from 'semver';
import { normalizeVersion } from '../detect/version.js';
import { fetchJson } from '../util/http.js';

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
  options: { token?: string; maxReleases?: number } = {},
): Promise<ReleaseNote[]> {
  const { token, maxReleases = 25 } = options;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const lower = normalizeVersion(from);
  const upper = normalizeVersion(to);
  if (!lower || !upper) return [];

  const [lo, hi] = semver.gt(upper, lower) ? [lower, upper] : [upper, lower];

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

      const version = normalizeVersion(release.tag_name);
      if (!version) continue;

      // Releases come back newest-first, so once we are below the range we can
      // stop paginating instead of walking the project's entire history.
      if (semver.lte(version, lo)) {
        sawOlderThanRange = true;
        continue;
      }
      if (semver.gt(version, hi)) continue;

      collected.push({
        tag: release.tag_name,
        version,
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

  return selectReleases(collected, maxReleases);
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
export function selectReleases(releases: readonly ReleaseNote[], max: number): ReleaseNote[] {
  const ordered = [...releases].sort((a, b) => semver.rcompare(a.version, b.version));
  if (ordered.length <= max) return ordered;

  const boundaries = ordered
    .filter((release) => {
      const parsed = semver.parse(release.version);
      return parsed !== null && parsed.patch === 0 && !parsed.prerelease.length;
    })
    .sort((a, b) => semver.compare(a.version, b.version));

  const kept = new Map<string, ReleaseNote>();
  for (const release of boundaries) {
    if (kept.size >= max) break;
    kept.set(release.version, release);
  }
  for (const release of ordered) {
    if (kept.size >= max) break;
    kept.set(release.version, release);
  }

  return [...kept.values()].sort((a, b) => semver.rcompare(a.version, b.version));
}
