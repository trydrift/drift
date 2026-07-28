import type { Ecosystem } from '../types.js';
import { fetchJson, fetchText } from '../util/http.js';

/** Normalised registry facts Drift needs, across every ecosystem. */
export interface RegistryInfo {
  name: string;
  ecosystem: Ecosystem;
  /** `owner/repo` when the package declares a GitHub source repository. */
  githubRepo: string | null;
  homepage: string | null;
  /** All published versions, unsorted. */
  versions: string[];
  /** Deprecation notice for the *target* version, when the registry has one. */
  deprecated: string | null;
  description: string | null;
}

/**
 * Look up a package in its ecosystem's registry.
 *
 * The single most valuable field here is `githubRepo`: it unlocks release
 * notes and CHANGELOG retrieval, which is where the actual breaking-change
 * prose lives. Everything else is supporting context.
 */
export async function fetchRegistryInfo(
  name: string,
  ecosystem: Ecosystem,
  targetVersion: string | null,
): Promise<RegistryInfo | null> {
  switch (ecosystem) {
    case 'npm':
      return fetchNpm(name, targetVersion);
    case 'pypi':
      return fetchPyPI(name, targetVersion);
    case 'cargo':
      return fetchCrates(name);
    case 'go':
      return fetchGo(name);
    case 'maven':
      return fetchMaven(name);
    case 'rubygems':
      return fetchRubyGems(name);
    default:
      return null;
  }
}

interface NpmPackument {
  description?: string;
  homepage?: string;
  repository?: string | { url?: string };
  versions?: Record<string, { deprecated?: string; repository?: string | { url?: string } }>;
}

async function fetchNpm(name: string, targetVersion: string | null): Promise<RegistryInfo | null> {
  const data = await fetchJson<NpmPackument>(
    `https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`,
  );
  if (!data) return null;

  const versions = Object.keys(data.versions ?? {});
  const versionEntry = targetVersion ? data.versions?.[targetVersion] : undefined;

  return {
    name,
    ecosystem: 'npm',
    githubRepo:
      parseGitHubRepo(repoUrl(data.repository)) ?? parseGitHubRepo(repoUrl(versionEntry?.repository)) ?? parseGitHubRepo(data.homepage),
    homepage: data.homepage ?? null,
    versions,
    deprecated: versionEntry?.deprecated ?? null,
    description: data.description ?? null,
  };
}

interface PyPIResponse {
  info?: {
    summary?: string;
    home_page?: string;
    project_urls?: Record<string, string>;
    yanked_reason?: string;
  };
  releases?: Record<string, { yanked?: boolean; yanked_reason?: string }[]>;
}

async function fetchPyPI(name: string, targetVersion: string | null): Promise<RegistryInfo | null> {
  const data = await fetchJson<PyPIResponse>(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  if (!data) return null;

  const urls = Object.values(data.info?.project_urls ?? {});
  const candidates = [...urls, data.info?.home_page ?? ''];
  const githubRepo = candidates.map(parseGitHubRepo).find((r): r is string => r !== null) ?? null;

  const files = targetVersion ? data.releases?.[targetVersion] ?? [] : [];
  const yanked = files.find((f) => f.yanked);

  return {
    name,
    ecosystem: 'pypi',
    githubRepo,
    homepage: data.info?.home_page ?? null,
    versions: Object.keys(data.releases ?? {}),
    deprecated: yanked ? `Release yanked: ${yanked.yanked_reason ?? 'no reason given'}` : null,
    description: data.info?.summary ?? null,
  };
}

interface CratesResponse {
  crate?: { description?: string; homepage?: string; repository?: string };
  versions?: { num: string; yanked?: boolean }[];
}

async function fetchCrates(name: string): Promise<RegistryInfo | null> {
  const data = await fetchJson<CratesResponse>(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`);
  if (!data) return null;

  return {
    name,
    ecosystem: 'cargo',
    githubRepo: parseGitHubRepo(data.crate?.repository) ?? parseGitHubRepo(data.crate?.homepage),
    homepage: data.crate?.homepage ?? null,
    versions: (data.versions ?? []).map((v) => v.num),
    deprecated: null,
    description: data.crate?.description ?? null,
  };
}

/**
 * Go modules are identified by their import path, which for the overwhelming
 * majority of packages *is* the repository URL. No registry call needed.
 */
async function fetchGo(name: string): Promise<RegistryInfo | null> {
  const versions = await fetchText(`https://proxy.golang.org/${encodeURI(name.toLowerCase())}/@v/list`);
  return {
    name,
    ecosystem: 'go',
    githubRepo: parseGitHubRepo(`https://${name}`),
    homepage: `https://pkg.go.dev/${name}`,
    versions: versions ? versions.split('\n').map((v) => v.trim()).filter(Boolean) : [],
    deprecated: null,
    description: null,
  };
}

async function fetchMaven(coordinate: string): Promise<RegistryInfo | null> {
  const [groupId, artifactId] = coordinate.split(':');
  if (!groupId || !artifactId) return null;

  const data = await fetchJson<{ response?: { docs?: { v: string }[] } }>(
    `https://search.maven.org/solrsearch/select?q=g:%22${encodeURIComponent(groupId)}%22+AND+a:%22${encodeURIComponent(artifactId)}%22&core=gav&rows=100&wt=json`,
  );

  return {
    name: coordinate,
    ecosystem: 'maven',
    // Maven Central exposes no SCM URL on this endpoint; the analyser falls
    // back to semver and any migration guide the user configured.
    githubRepo: null,
    homepage: `https://central.sonatype.com/artifact/${groupId}/${artifactId}`,
    versions: (data?.response?.docs ?? []).map((d) => d.v),
    deprecated: null,
    description: null,
  };
}

async function fetchRubyGems(name: string): Promise<RegistryInfo | null> {
  const data = await fetchJson<{
    info?: string;
    homepage_uri?: string;
    source_code_uri?: string;
    changelog_uri?: string;
  }>(`https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`);
  if (!data) return null;

  const versions = await fetchJson<{ number: string }[]>(
    `https://rubygems.org/api/v1/versions/${encodeURIComponent(name)}.json`,
  );

  return {
    name,
    ecosystem: 'rubygems',
    githubRepo:
      parseGitHubRepo(data.source_code_uri) ??
      parseGitHubRepo(data.homepage_uri) ??
      parseGitHubRepo(data.changelog_uri),
    homepage: data.homepage_uri ?? null,
    versions: (versions ?? []).map((v) => v.number),
    deprecated: null,
    description: data.info ?? null,
  };
}

function repoUrl(repository: string | { url?: string } | undefined): string | undefined {
  if (!repository) return undefined;
  return typeof repository === 'string' ? repository : repository.url;
}

/**
 * Extract `owner/repo` from the many shapes a repository field takes:
 * `git+https://github.com/o/r.git`, `git@github.com:o/r.git`, `github:o/r`,
 * or a plain browse URL with extra path segments.
 */
export function parseGitHubRepo(url: string | null | undefined): string | null {
  if (!url) return null;

  const shorthand = /^github:([\w.-]+)\/([\w.-]+)$/.exec(url.trim());
  if (shorthand) return `${shorthand[1]}/${stripGitSuffix(shorthand[2]!)}`;

  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+)/.exec(url);
  if (!match) return null;

  const owner = match[1]!;
  const repo = stripGitSuffix(match[2]!);
  if (!owner || !repo || owner === 'sponsors') return null;
  return `${owner}/${repo}`;
}

function stripGitSuffix(repo: string): string {
  return repo.replace(/\.git$/, '');
}
