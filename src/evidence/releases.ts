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

    if (sawOlderThanRange || releases.length < PER_PAGE) break;
    if (collected.length >= maxReleases) break;
  }

  return collected
    .sort((a, b) => semver.rcompare(a.version, b.version))
    .slice(0, maxReleases);
}
