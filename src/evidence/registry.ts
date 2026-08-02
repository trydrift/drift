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
    case 'nuget':
      return fetchNuGet(name);
    case 'packagist':
      return fetchPackagist(name);
    case 'hex':
      return fetchHex(name);
    case 'pub':
      return fetchPub(name);
    case 'swift':
      return swiftRegistryInfo(name);
    case 'cocoapods':
      return fetchCocoaPods(name);
    // opam publishes no JSON metadata API. Returning `null` means the evidence
    // stage reports "no registry data" rather than an empty version list, which
    // would read as "this package has no releases".
    case 'opam':
      return null;
    default:
      return null;
  }
}

async function fetchNuGet(name: string): Promise<RegistryInfo | null> {
  // NuGet's flat container is case-sensitive and wants the lowercase id.
  const id = name.toLowerCase();

  const [versions, registration] = await Promise.all([
    fetchJson<{ versions?: string[] }>(
      `https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(id)}/index.json`,
    ),
    fetchJson<{
      items?: { items?: { catalogEntry?: NuGetCatalogEntry }[] }[];
    }>(`https://api.nuget.org/v3/registration5-gz-semver2/${encodeURIComponent(id)}/index.json`),
  ]);
  if (!versions && !registration) return null;

  // The newest catalog entry carries the project URL and deprecation state.
  const entries = (registration?.items ?? []).flatMap((page) => page.items ?? []);
  const latest = entries[entries.length - 1]?.catalogEntry;

  return {
    name,
    ecosystem: 'nuget',
    githubRepo:
      parseGitHubRepo(latest?.repository?.url ?? null) ?? parseGitHubRepo(latest?.projectUrl ?? null),
    homepage: latest?.projectUrl ?? `https://www.nuget.org/packages/${name}`,
    versions: versions?.versions ?? [],
    deprecated: latest?.deprecation?.message ?? null,
    description: latest?.description ?? null,
  };
}

interface NuGetCatalogEntry {
  projectUrl?: string;
  description?: string;
  repository?: { url?: string };
  deprecation?: { message?: string };
}

async function fetchPackagist(name: string): Promise<RegistryInfo | null> {
  const data = await fetchJson<{
    packages?: Record<string, PackagistVersion[]>;
  }>(`https://repo.packagist.org/p2/${name}.json`);

  const releases = data?.packages?.[name];
  if (!releases || releases.length === 0) return null;

  // p2 returns newest first.
  const latest = releases[0]!;

  // Packagist spells deprecation as `abandoned`, whose value is either `true`
  // or the name of the package that replaced it — and the replacement is the
  // single most useful thing to tell someone, so it is not flattened away.
  const abandoned = latest.abandoned;
  const deprecated =
    abandoned === undefined || abandoned === false
      ? null
      : typeof abandoned === 'string'
        ? `This package is abandoned; the author suggests using ${abandoned} instead.`
        : 'This package is abandoned and is no longer maintained.';

  return {
    name,
    ecosystem: 'packagist',
    githubRepo: parseGitHubRepo(latest.source?.url ?? null) ?? parseGitHubRepo(latest.homepage ?? null),
    homepage: latest.homepage ?? `https://packagist.org/packages/${name}`,
    versions: releases.map((release) => release.version).filter((v): v is string => Boolean(v)),
    deprecated,
    description: latest.description ?? null,
  };
}

interface PackagistVersion {
  version?: string;
  description?: string;
  homepage?: string;
  source?: { url?: string };
  abandoned?: boolean | string;
}

async function fetchHex(name: string): Promise<RegistryInfo | null> {
  const data = await fetchJson<{
    meta?: { description?: string; links?: Record<string, string> };
    html_url?: string;
    releases?: { version?: string }[];
    retirements?: Record<string, { message?: string; reason?: string }>;
  }>(`https://hex.pm/api/packages/${encodeURIComponent(name)}`);
  if (!data) return null;

  const links = data.meta?.links ?? {};
  // Hex link keys are author-chosen and inconsistently capitalised.
  const linkValues = Object.entries(links).map(([key, value]) => ({ key: key.toLowerCase(), value }));
  const github =
    linkValues.find((l) => l.key === 'github')?.value ?? linkValues.find((l) => l.key === 'source')?.value;

  // A retired release is Hex's deprecation. Any retirement is worth surfacing,
  // so the most recent one is reported rather than only an exact-version match.
  const retirement = Object.values(data.retirements ?? {})[0];

  return {
    name,
    ecosystem: 'hex',
    githubRepo:
      parseGitHubRepo(github ?? null) ??
      linkValues.map((l) => parseGitHubRepo(l.value)).find(Boolean) ??
      null,
    homepage: data.html_url ?? `https://hex.pm/packages/${name}`,
    versions: (data.releases ?? []).map((r) => r.version).filter((v): v is string => Boolean(v)),
    deprecated: retirement ? (retirement.message ?? retirement.reason ?? 'This release is retired.') : null,
    description: data.meta?.description ?? null,
  };
}

async function fetchPub(name: string): Promise<RegistryInfo | null> {
  const data = await fetchJson<{
    latest?: { pubspec?: PubSpec; retracted?: boolean };
    versions?: { version?: string; retracted?: boolean }[];
  }>(`https://pub.dev/api/packages/${encodeURIComponent(name)}`);
  if (!data) return null;

  const pubspec = data.latest?.pubspec;
  const repository = pubspec?.repository ?? pubspec?.homepage ?? pubspec?.issue_tracker;

  return {
    name,
    ecosystem: 'pub',
    githubRepo: parseGitHubRepo(repository ?? null),
    homepage: pubspec?.homepage ?? `https://pub.dev/packages/${name}`,
    versions: (data.versions ?? []).map((v) => v.version).filter((v): v is string => Boolean(v)),
    deprecated: data.latest?.retracted ? 'The latest version of this package has been retracted.' : null,
    description: pubspec?.description ?? null,
  };
}

interface PubSpec {
  description?: string;
  homepage?: string;
  repository?: string;
  issue_tracker?: string;
}

/**
 * Swift packages, which have no registry to fetch from.
 *
 * SwiftPM identifies a package by its git URL, and the parser already reduced
 * that to `owner/repo` — so the "lookup" is a rearrangement of what we know,
 * not a network call. `versions` is empty because git tags are the version
 * list and the releases stage reads them directly; an empty list here would be
 * a lie only if something downstream read it as "no releases exist", which is
 * why the capability matrix marks Swift's evidence stage partial.
 */
function swiftRegistryInfo(name: string): RegistryInfo | null {
  const isSlug = /^[\w.-]+\/[\w.-]+$/.test(name);
  if (!isSlug) return null;

  return {
    name,
    ecosystem: 'swift',
    githubRepo: name,
    homepage: `https://github.com/${name}`,
    versions: [],
    deprecated: null,
    description: null,
  };
}

async function fetchCocoaPods(name: string): Promise<RegistryInfo | null> {
  // Trunk answers with the owner and the published versions, but nothing about
  // the source repository — that lives in the podspec, which is served from the
  // CDN as JSON at a path keyed by a hash of the name. Following that would
  // cost two more round trips for a link, so Drift takes the versions and lets
  // the changelog stage find the repository from the GitHub search it already
  // does for every ecosystem.
  const data = await fetchJson<{ versions?: { name?: string }[] }>(
    `https://trunk.cocoapods.org/api/v1/pods/${encodeURIComponent(name)}`,
  );
  if (!data) return null;

  return {
    name,
    ecosystem: 'cocoapods',
    githubRepo: null,
    homepage: `https://cocoapods.org/pods/${name}`,
    versions: (data.versions ?? []).map((v) => v.name).filter((v): v is string => Boolean(v)),
    deprecated: null,
    description: null,
  };
}

/**
 * Facts about one specific published version.
 *
 * Separate from `RegistryInfo`, which is about the package as a whole, because
 * the questions are different: "who maintains this" is asked once, and "what
 * did *this release* declare" is asked twice per upgrade — once for the version
 * installed and once for the version proposed. The interesting answers are all
 * in the difference between the two.
 */
export interface VersionInfo {
  version: string;
  /** License identifier exactly as declared. Never normalised or interpreted. */
  license: string | null;
  /** ISO 8601 publication timestamp, when the registry records one. */
  releasedAt: string | null;
  /**
   * The runtime this version requires, e.g. `{ name: 'node', requirement: '>=18' }`.
   *
   * A raised minimum is one of the two breaking changes that renames nothing,
   * so no symbol-based rule can catch it and the registry is the only place it
   * is written down.
   */
  runtime: { name: string; requirement: string } | null;
  /** Names of the direct dependencies this version declares, when published. */
  dependencies: string[];
  /**
   * Set when the registry marks this version withdrawn — npm deprecation, a
   * PyPI yank, a crates.io yank, or a Go `retract` directive.
   */
  withdrawn: string | null;
}

/** Per-version metadata, across every ecosystem that publishes it. */
export async function fetchVersionInfo(
  name: string,
  ecosystem: Ecosystem,
  version: string,
): Promise<VersionInfo | null> {
  switch (ecosystem) {
    case 'npm':
      return npmVersionInfo(name, version);
    case 'pypi':
      return pypiVersionInfo(name, version);
    case 'go':
      return goVersionInfo(name, version);
    case 'cargo':
      return cargoVersionInfo(name, version);
    default:
      // Maven Central and RubyGems publish this, but not on an endpoint that
      // answers for one version without a search. Absent beats guessed.
      return null;
  }
}

function emptyVersionInfo(version: string): VersionInfo {
  return { version, license: null, releasedAt: null, runtime: null, dependencies: [], withdrawn: null };
}

async function npmVersionInfo(name: string, version: string): Promise<VersionInfo | null> {
  const data = await fetchJson<NpmPackument>(
    `https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`,
  );
  const entry = data?.versions?.[version];
  if (!entry) return null;

  const engines = entry.engines?.node;
  return {
    ...emptyVersionInfo(version),
    license: typeof entry.license === 'string' ? entry.license : (entry.license?.type ?? null),
    releasedAt: data?.time?.[version] ?? null,
    runtime: engines ? { name: 'Node.js', requirement: engines } : null,
    dependencies: Object.keys(entry.dependencies ?? {}),
    withdrawn: entry.deprecated ?? null,
  };
}

async function pypiVersionInfo(name: string, version: string): Promise<VersionInfo | null> {
  const data = await fetchJson<{
    info?: { license?: string; requires_python?: string; requires_dist?: string[]; yanked?: boolean; yanked_reason?: string };
    urls?: { upload_time_iso_8601?: string }[];
  }>(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`);
  if (!data?.info) return null;

  const requiresPython = data.info.requires_python;
  return {
    ...emptyVersionInfo(version),
    license: data.info.license || null,
    releasedAt: data.urls?.[0]?.upload_time_iso_8601 ?? null,
    runtime: requiresPython ? { name: 'Python', requirement: requiresPython } : null,
    // `requires_dist` entries are PEP 508 strings; the name is the leading token.
    dependencies: (data.info.requires_dist ?? [])
      .map((spec) => /^\s*([A-Za-z0-9._-]+)/.exec(spec)?.[1])
      .filter((n): n is string => Boolean(n)),
    withdrawn: data.info.yanked ? `Release yanked: ${data.info.yanked_reason ?? 'no reason given'}` : null,
  };
}

/**
 * Go publishes no package metadata beyond the module file itself, which is
 * exactly enough: the `go` directive is the runtime requirement, and a
 * `retract` naming this version is the withdrawal notice.
 */
async function goVersionInfo(name: string, version: string): Promise<VersionInfo | null> {
  const tag = version.startsWith('v') ? version : `v${version}`;
  const base = `https://proxy.golang.org/${encodeURI(name.toLowerCase())}/@v/${encodeURIComponent(tag)}`;

  const [mod, info] = await Promise.all([
    fetchText(`${base}.mod`),
    fetchJson<{ Time?: string }>(`${base}.info`),
  ]);
  if (!mod && !info) return null;

  const goDirective = mod ? /^\s*go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(mod)?.[1] : null;

  return {
    ...emptyVersionInfo(tag),
    releasedAt: info?.Time ?? null,
    runtime: goDirective ? { name: 'Go', requirement: `>=${goDirective}` } : null,
    withdrawn: mod ? goRetraction(mod, tag) : null,
  };
}

/**
 * A `retract` directive naming this version.
 *
 * Both forms are recognised: a single version, and a `[low, high]` range. A
 * retracted version is one the maintainer has asked people not to use, which is
 * the strongest statement Go's tooling can make about a release and is not
 * surfaced anywhere else in the ecosystem's metadata.
 */
export function goRetraction(modFile: string, version: string): string | null {
  const target = version.replace(/^v/, '');

  for (const match of modFile.matchAll(/^\s*retract\s+(.+)$/gm)) {
    const body = match[1]!.trim();
    const comment = /\/\/\s*(.+)$/.exec(body)?.[1]?.trim();
    const stated = comment ? `Retracted by the maintainer: ${comment}` : 'Retracted by the maintainer.';

    const single = /^v?([\w.+-]+)/.exec(body.replace(/\/\/.*$/, '').trim())?.[1];
    if (single && single === target) return stated;

    const range = /\[\s*v?([\w.+-]+)\s*,\s*v?([\w.+-]+)\s*\]/.exec(body);
    if (range && withinRange(target, range[1]!, range[2]!)) return stated;
  }

  // Block form: `retract (` … `)`.
  const block = /^\s*retract\s*\(([\s\S]*?)^\s*\)/m.exec(modFile)?.[1];
  if (block) {
    for (const line of block.split('\n')) {
      const trimmed = line.replace(/\/\/.*$/, '').trim();
      if (!trimmed) continue;
      const comment = /\/\/\s*(.+)$/.exec(line)?.[1]?.trim();
      const stated = comment ? `Retracted by the maintainer: ${comment}` : 'Retracted by the maintainer.';
      if (/^v?([\w.+-]+)$/.exec(trimmed)?.[1] === target) return stated;
      const range = /\[\s*v?([\w.+-]+)\s*,\s*v?([\w.+-]+)\s*\]/.exec(trimmed);
      if (range && withinRange(target, range[1]!, range[2]!)) return stated;
    }
  }

  return null;
}

function withinRange(version: string, low: string, high: string): boolean {
  return compareLoose(version, low) >= 0 && compareLoose(version, high) <= 0;
}

/** Numeric-segment comparison. Deliberately not semver: a retract range is written loosely. */
function compareLoose(a: string, b: string): number {
  const left = a.split(/[.+-]/).map((p) => Number.parseInt(p, 10));
  const right = b.split(/[.+-]/).map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    if (x !== y) return x - y;
  }
  return 0;
}

async function cargoVersionInfo(name: string, version: string): Promise<VersionInfo | null> {
  const data = await fetchJson<{
    version?: { license?: string; created_at?: string; yanked?: boolean; rust_version?: string };
  }>(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
  if (!data?.version) return null;

  const rust = data.version.rust_version;
  return {
    ...emptyVersionInfo(version),
    license: data.version.license ?? null,
    releasedAt: data.version.created_at ?? null,
    runtime: rust ? { name: 'Rust', requirement: `>=${rust}` } : null,
    withdrawn: data.version.yanked ? 'This release was yanked from crates.io.' : null,
  };
}

/** Upstream repository status, for the maintenance section. */
export interface RepositoryStatus {
  archived: boolean;
  /** ISO timestamp of the last push, when GitHub reports one. */
  pushedAt: string | null;
  /** License GitHub detected in the repository, which may differ from the registry's. */
  license: string | null;
  url: string;
}

export async function fetchRepositoryStatus(
  githubRepo: string,
  token?: string,
): Promise<RepositoryStatus | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const data = await fetchJson<{
    archived?: boolean;
    pushed_at?: string;
    license?: { spdx_id?: string } | null;
    html_url?: string;
  }>(`https://api.github.com/repos/${githubRepo}`, { headers });
  if (!data) return null;

  const spdx = data.license?.spdx_id;
  return {
    archived: data.archived === true,
    pushedAt: data.pushed_at ?? null,
    license: spdx && spdx !== 'NOASSERTION' ? spdx : null,
    url: data.html_url ?? `https://github.com/${githubRepo}`,
  };
}

interface NpmPackument {
  description?: string;
  homepage?: string;
  repository?: string | { url?: string };
  time?: Record<string, string>;
  versions?: Record<
    string,
    {
      deprecated?: string;
      repository?: string | { url?: string };
      license?: string | { type?: string };
      engines?: { node?: string };
      dependencies?: Record<string, string>;
    }
  >;
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
    githubRepo: goSourceRepo(name),
    homepage: `https://pkg.go.dev/${name}`,
    versions: versions ? versions.split('\n').map((v) => v.trim()).filter(Boolean) : [],
    deprecated: null,
    description: null,
  };
}

/**
 * The GitHub repository behind a Go module path.
 *
 * For most modules the import path *is* the repository, which is the shape
 * `parseGitHubRepo` already handles. The exceptions are vanity domains, and
 * between them they cover a large share of the Go ecosystem — `golang.org/x/*`
 * alone is `net`, `sys`, `text`, `crypto`, and `sync`.
 *
 * Getting this wrong is not cosmetic: an unresolved repository means no release
 * notes and no changelog, which is precisely the prose evidence a developer
 * falls back on. Every mapping here is a documented, stable redirect rather
 * than a guess at a naming convention.
 */
const GOOGLE_GO_REPOS: Record<string, string> = {
  grpc: 'grpc/grpc-go',
  protobuf: 'protocolbuffers/protobuf-go',
  api: 'googleapis/google-api-go-client',
  genproto: 'googleapis/go-genproto',
  appengine: 'golang/appengine',
};

export function goSourceRepo(modulePath: string): string | null {
  // Strip the `/v2`, `/v3` major-version suffix; the repository has no such path.
  const path = modulePath.replace(/\/v[2-9]\d*$/, '');

  const vanity: [RegExp, (m: RegExpExecArray) => string][] = [
    [/^golang\.org\/x\/([\w.-]+)/, (m) => `golang/${m[1]}`],
    // Google's vanity paths follow no pattern at all — each is its own repo
    // name — so they are enumerated rather than derived.
    [/^google\.golang\.org\/(\w+)/, (m) => GOOGLE_GO_REPOS[m[1]!] ?? `googleapis/go-${m[1]}`],
    [/^go\.uber\.org\/([\w.-]+)/, (m) => `uber-go/${m[1]}`],
    [/^sigs\.k8s\.io\/([\w.-]+)/, (m) => `kubernetes-sigs/${m[1]}`],
    [/^k8s\.io\/([\w.-]+)/, (m) => `kubernetes/${m[1]}`],
    // `gopkg.in/user/pkg.v3` is `github.com/user/pkg`; the one-segment form
    // `gopkg.in/yaml.v3` is `github.com/go-yaml/yaml`.
    [/^gopkg\.in\/([\w.-]+)\/([\w.-]+?)\.v\d+$/, (m) => `${m[1]}/${m[2]}`],
    [/^gopkg\.in\/([\w.-]+?)\.v\d+$/, (m) => `go-${m[1]}/${m[1]}`],
  ];

  for (const [pattern, resolve] of vanity) {
    const match = pattern.exec(path);
    if (match) return resolve(match);
  }

  return parseGitHubRepo(`https://${path}`);
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
