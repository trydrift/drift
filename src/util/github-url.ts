/**
 * One place that turns a repository URL into a GitHub `owner/repo` slug.
 *
 * Registry metadata (a CocoaPods podspec `source`, an opam `dev-repo`, an
 * Arduino library `repository`) points at a repo in a dozen shapes:
 *
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   http://github.com/owner/repo
 *   ssh://git@github.com/owner/repo.git
 *   git@github.com:owner/repo.git          (scp-style, not a URL)
 *   git+https://github.com/owner/repo.git
 *   https://github.com/owner/repo/issues   (extra path — still the same repo)
 *
 * The tempting `url.includes('github.com')` also accepts
 * `https://evilgithub.com/owner/repo` and `https://github.com.evil.com/o/r`,
 * which then drive Drift to fetch releases and changelogs from an attacker's
 * host. This validates the *host*, not a substring, and pulls exactly the
 * first two path segments.
 */

/** First path segments that are GitHub product pages, never a repo owner. */
const RESERVED_OWNERS = new Set(['sponsors', 'apps', 'marketplace', 'settings', 'about', 'pricing', 'features']);

const SEGMENT = /^[A-Za-z0-9._-]+$/;

function validSlug(owner: string, repo: string): string | null {
  const cleanRepo = repo.replace(/\.git$/i, '');
  if (!owner || !cleanRepo) return null;
  if (!SEGMENT.test(owner) || !SEGMENT.test(cleanRepo)) return null;
  if (owner === '.' || owner === '..' || cleanRepo === '.' || cleanRepo === '..') return null;
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  return `${owner}/${cleanRepo}`;
}

function isGitHubHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'github.com' || host === 'www.github.com';
}

/**
 * `owner/repo` for a URL that genuinely points at github.com, or `null`.
 *
 * `null` for every non-GitHub host, look-alike host (`evilgithub.com`,
 * `github.com.evil.com`), and malformed or ambiguous input — never a guess.
 */
export function githubRepoSlug(url: string | null | undefined): string | null {
  if (!url) return null;
  let text = url.trim();
  if (!text) return null;

  // `git+https://…`, `git+ssh://…` — npm/opam decorate the scheme.
  text = text.replace(/^git\+/i, '');

  // scp-style `git@github.com:owner/repo.git` is not a parseable URL.
  const scp = /^(?:ssh:\/\/)?(?:[^@/\s]+@)?github\.com:(?<owner>[^/\s:]+)\/(?<repo>[^\s?#]+?)\/?$/i.exec(text);
  if (scp?.groups) {
    if (!isGitHubHost('github.com')) return null;
    return validSlug(scp.groups.owner!, scp.groups.repo!);
  }

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }

  if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) return null;
  if (!isGitHubHost(parsed.hostname)) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  return validSlug(segments[0]!, segments[1]!);
}
