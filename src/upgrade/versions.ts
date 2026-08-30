import type { Ecosystem } from '../types.js';
import { fetchRegistryInfo } from '../evidence/registry.js';
import { fetchOpamPackageVersions } from '../evidence/opam-repository.js';
import { fetchJson } from '../util/http.js';
import {
  compareParsedVersions,
  parsePublishedVersion,
  versionSemantics,
  type ParsedPublishedVersion,
} from '../version-semantics.js';

/**
 * "Is there a newer version of this, and can I even tell?"
 *
 * Split out of `scan.ts` because the answer has three shapes and the scanner
 * used to have room for two. It asked a registry, and anything that was not a
 * usable version list — a timeout, a malformed body, an ecosystem with no
 * version API at all — came back as `null`, which the scan reported as **“Up
 * to date.”**
 *
 * That is the one thing Drift must never say. `severity.ts` exists because
 * zero findings from a complete check and zero findings from a check that
 * never happened are different facts; this module applies the same rule one
 * stage earlier, to the version lookup itself. A registry Drift could not
 * reach is not a package with no releases.
 */

/** The three honest answers to "what newer versions exist?". */
export type VersionLookup =
  | {
      outcome: 'upgrade';
      latest: string;
      safeLatest?: string;
      latestMinor?: string;
      versions: string[];
    }
  /** A source answered, and nothing it published is newer than what is installed. */
  | { outcome: 'up-to-date' }
  /**
   * No source answered, or what came back could not be read as versions.
   *
   * `reason` is written for the developer reading the scan, and says which
   * source was tried — "could not reach PyPI" and "opam publishes no version
   * API" both land here but are not the same news.
   */
  | { outcome: 'unchecked'; reason: string };

export interface VersionLookupRequest {
  name: string;
  ecosystem: Ecosystem;
  /** The installed version, per the lockfile or manifest. */
  current: string;
  /** The constraint as written in the manifest, e.g. `^1.2.0`. */
  range: string;
  /** Raises the GitHub rate limit for the tag-derived ecosystems. */
  githubToken?: string;
  /**
   * Where this dependency actually resolves from, when it is not the registry.
   *
   * A Go module redirected to a directory by a `replace` directive is
   * controlled by the workspace, not by a registry release, and asking a
   * registry what is newer than its `v0.0.0` placeholder produces an upgrade
   * that cannot be applied.
   */
  resolution?: { kind: 'local-replace'; target: string };
}

/**
 * A published release has two identities which must never be confused.
 * `raw` is the registry identity and is the only value returned to callers;
 * `comparable` exists solely so releases can be ordered locally.
 */
export type PublishedVersion = ParsedPublishedVersion;

/** Parse a registry version without changing its upstream identity. */
export function publishedVersion(raw: string, ecosystem: Ecosystem): PublishedVersion | null {
  return parsePublishedVersion(raw, ecosystem);
}

/** Ecosystem-local ordering. Raw values are never returned from this helper. */
export function comparePublishedVersions(a: PublishedVersion, b: PublishedVersion): number {
  return compareParsedVersions(a, b) ?? 0;
}

interface NpmPackument {
  versions?: Record<string, unknown>;
  'dist-tags'?: Record<string, string>;
}

/** What each ecosystem's versions are actually read out of, for `reason` text. */
export function versionSourceLabel(ecosystem: Ecosystem): string {
  switch (ecosystem) {
    case 'npm':
      return 'the npm registry';
    case 'pypi':
      return 'PyPI';
    case 'cargo':
      return 'crates.io';
    case 'go':
      return 'the Go module proxy';
    case 'maven':
      return 'Maven Central';
    case 'rubygems':
      return 'RubyGems';
    case 'nuget':
      return 'NuGet';
    case 'packagist':
      return 'Packagist';
    case 'hex':
      return 'Hex';
    case 'pub':
      return 'pub.dev';
    case 'cocoapods':
      return 'CocoaPods Trunk';
    case 'conan':
      return 'ConanCenter';
    case 'vcpkg':
      return 'the vcpkg registry';
    case 'arduino':
      return 'the Arduino Library Manager';
    // Neither has a registry to name. SwiftPM resolves packages straight from
    // their git host, and opam's index is a git repository of package
    // definitions rather than a queryable service.
    case 'swift':
      return 'the package’s git tags';
    case 'opam':
      return 'the opam repository';
  }
}

/**
 * Newer published versions of one package.
 *
 * npm is special-cased for its `dist-tags`, which is the only registry that
 * tells us which version the maintainer considers current rather than merely
 * highest. Everywhere else the highest stable version is the best available
 * answer, and prereleases are excluded so a scan never proposes an alpha.
 *
 * Never throws: a thrown lookup and a failed one are the same fact, and both
 * must reach the caller as `unchecked` rather than as an exception the scan
 * loop would have to remember to interpret.
 */
export async function lookupVersions(request: VersionLookupRequest): Promise<VersionLookup> {
  try {
    return await lookup(request);
  } catch (err) {
    return {
      outcome: 'unchecked',
      reason: `Checking ${versionSourceLabel(request.ecosystem)} for ${request.name} failed: ${(err as Error).message}`,
    };
  }
}

async function lookup(request: VersionLookupRequest): Promise<VersionLookup> {
  const { name, ecosystem, current, range } = request;
  const source = versionSourceLabel(ecosystem);

  // A dependency the workspace answers for itself. Its declared version is a
  // placeholder, not an outdated release, and the registry has no say in it.
  if (request.resolution?.kind === 'local-replace') {
    return {
      outcome: 'unchecked',
      reason: `${name} is replaced by ${request.resolution.target} in this workspace, so its version is controlled locally rather than by ${source}.`,
    };
  }

  const comparisonCurrent = publishedVersion(current, ecosystem);

  // Everything below compares against `current`. If that is not a version
  // semver can order, no comparison is meaningful and every answer would be
  // arbitrary — which is exactly the case that used to render as "up to date".
  if (!comparisonCurrent) {
    return {
      outcome: 'unchecked',
      reason: `${name} is installed at “${current}”, which Drift cannot compare against published versions.`,
    };
  }

  // An identity Drift recognises but cannot order. Comparing published
  // versions would be arbitrary, and "nothing is newer" would read as a clean
  // bill of health for a question that was never answered. Explicitly
  // supplied changes still reach analysis — see `parsePublishedVersion` — but
  // *discovering* an upgrade needs an ordering.
  if (comparisonCurrent.comparable.kind === 'opaque') {
    return {
      outcome: 'unchecked',
      reason: `${name} is installed at “${current}”, and ${source} defines no single ordering for ${ecosystem} versions, so Drift cannot say whether a newer release exists.`,
    };
  }

  const published = await publishedVersions(request);
  if (!published) {
    return { outcome: 'unchecked', reason: `Drift could not reach ${source} for ${name}.` };
  }

  if (published.complete === false) {
    return {
      outcome: 'unchecked',
      reason: `Drift could not enumerate all of ${source} for ${name}, so it cannot establish whether a newer compatible version exists.`,
    };
  }

  if (published.versions.length === 0) {
    return {
      outcome: 'unchecked',
      reason: `${source} returned no versions for ${name}, so Drift has nothing to compare against.`,
    };
  }

  const compatiblePublished =
    ecosystem === 'swift'
      ? published.versions.filter((version) => versionFamily(version) === versionFamily(current))
      : published.versions;
  const parsed = compatiblePublished
    .map((raw) => publishedVersion(raw, ecosystem))
    .filter((version): version is PublishedVersion => version !== null);

  // Versions came back and not one of them parsed. That is a source Drift
  // cannot read, not a package that is current.
  if (parsed.length === 0) {
    if (ecosystem === 'swift') {
      return {
        outcome: 'unchecked',
        reason: `${source} returned no tags in the installed version's ${versionFamily(current)} family for ${name}.`,
      };
    }
    return {
      outcome: 'unchecked',
      reason: `Drift could not read any of the ${published.versions.length} version numbers ${source} published for ${name}.`,
    };
  }

  // A stable installation does not opt into prereleases merely because the
  // registry has no newer stable release. Once already on a prerelease, the
  // ecosystem ordering may progress through prereleases and into the final.
  const eligible = comparisonCurrent.prerelease ? parsed : parsed.filter((version) => !version.prerelease);
  const newer = eligible
    .filter((version) => comparePublishedVersions(version, comparisonCurrent) > 0)
    .sort((a, b) => comparePublishedVersions(b, a));

  const publishedLatest = published.latest ? publishedVersion(published.latest, ecosystem) : null;

  const latest =
    ecosystem === 'swift'
      ? newer[0]
      : publishedLatest && (comparisonCurrent.prerelease || !publishedLatest.prerelease)
        ? publishedLatest
        : newer[0];
  if (!latest || comparePublishedVersions(latest, comparisonCurrent) <= 0) return { outcome: 'up-to-date' };

  // Computed over every published version, never over the truncated list the
  // caller shows: `maxSatisfying` of the twenty newest releases of a busy
  // package is `null` for anything still on the previous major, which left
  // `safeLatest` undefined precisely where it mattered most.
  const safe = safeLatest(newer, comparisonCurrent, range, ecosystem);

  // Prereleases are noise unless the developer is already on one. Twenty
  // versions of zod came back as one release and nine canaries, with no 3.x in
  // sight — the safe upgrade was not merely hard to find, it was not on the
  // list. The in-range version is now pinned into the list by construction.
  const stable = newer;

  const withinMajor = latestWithinMajor(stable, comparisonCurrent, ecosystem);

  const versions = [
    ...new Map([latest, ...(safe ? [safe] : []), ...(withinMajor ? [withinMajor] : []), ...stable.slice(0, 18)].map((version) => [version.raw, version])).values(),
  ]
    .filter((version) => comparePublishedVersions(version, comparisonCurrent) > 0)
    .sort((a, b) => comparePublishedVersions(b, a))
    .map((version) => version.raw);

  return {
    outcome: 'upgrade',
    latest: latest.raw,
    ...(safe ? { safeLatest: safe.raw } : {}),
    ...(withinMajor ? { latestMinor: withinMajor.raw } : {}),
    versions,
  };
}

type VersionFamily = 'semver' | 'calendar' | 'unknown';

/** Classify tag schemes before normalization puts incompatible versions together. */
function versionFamily(raw: string): VersionFamily {
  const value = raw.trim().replace(/^[^\d]*/, '');
  if (/^\d{4}[.-]\d{1,2}[.-]\d{1,2}(?:[.-]\d+)?(?:$|[-+])/.test(value)) return 'calendar';
  return parsePublishedVersion(raw, 'swift') ? 'semver' : 'unknown';
}

/**
 * Every version a source knows about, plus the one it calls current.
 *
 * `latest` is null everywhere but npm: no other registry publishes a "current"
 * tag, so the caller derives one from the list rather than inventing an
 * authority for it.
 */
async function publishedVersions(
  request: VersionLookupRequest,
): Promise<{ latest: string | null; versions: string[]; complete?: boolean } | null> {
  switch (request.ecosystem) {
    case 'npm':
      return npmVersions(request.name);
    // Two ecosystems whose versions do not live in a package registry at all.
    // The generic path below asks `fetchRegistryInfo(...).versions`, which for
    // these is empty by construction — Swift's registry record is a
    // rearrangement of the git URL, and opam has no JSON API and returns null.
    // Both therefore reported every Swift and opam dependency as up to date
    // while never having looked. They are read from where the versions
    // genuinely are instead.
    case 'swift':
      return swiftTagVersions(request.name, request.githubToken);
    case 'opam':
      return opamRepositoryVersions(request.name, request.githubToken);
    default: {
      const info = await fetchRegistryInfo(request.name, request.ecosystem, null);
      return info ? { latest: null, versions: info.versions } : null;
    }
  }
}

/**
 * npm's abbreviated packument — the same document `npm outdated` asks for.
 *
 * The full packument carries every README, every `dist` block and every
 * dependency map of every release ever published, which for a package like
 * `typescript` or `@types/node` is tens of megabytes to answer a question about
 * two version numbers. The abbreviated form is the registry's own answer to
 * that: it keeps `dist-tags` and the version keys, which is exactly and only
 * what this module reads, and it is routinely an order of magnitude smaller.
 *
 * The evidence layer still asks for the full document where it genuinely needs
 * the rest; `variantFingerprint` in `util/http.ts` keeps the two apart in the
 * cache.
 */
const NPM_ABBREVIATED = 'application/vnd.npm.install-v1+json, application/json';

async function npmVersions(name: string): Promise<{ latest: string | null; versions: string[] } | null> {
  const packument = await fetchJson<NpmPackument>(
    `https://registry.npmjs.org/${encodeURIComponent(name).replaceAll('%40', '@')}`,
    { timeoutMs: 12_000, headers: { Accept: NPM_ABBREVIATED } },
  );
  if (!packument) return null;

  return {
    latest: packument['dist-tags']?.latest?.trim() ?? null,
    versions: Object.keys(packument.versions ?? {}),
  };
}

/** GitHub's REST headers, with the caller's token when there is one. */
function githubHeaders(token?: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * SwiftPM versions are git tags.
 *
 * There is no Swift package registry to ask — SwiftPM resolves a package
 * straight from its git host, and a "version" is a tag on that repository. The
 * dependency name Drift carries for Swift is already the `owner/repo` slug
 * (see `detect/ecosystems/swift.ts`), so the tag list is one documented API
 * call away.
 *
 * Anything not hosted on GitHub returns `null` — honestly unchecked, since
 * Drift has no way to enumerate tags on an arbitrary git host without cloning
 * it, and cloning every Swift dependency to answer "is there an upgrade" is not
 * a trade a scan should make.
 */
async function swiftTagVersions(
  name: string,
  token?: string,
): Promise<{ latest: string | null; versions: string[]; complete: boolean } | null> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) return null;

  // GitHub caps this endpoint at 100 tags per page. A single page can omit the
  // installed package's entire tag family, and an omitted family is not proof
  // that it has no upgrades. Twenty pages bounds scan cost while making the
  // truncation explicit: reaching the bound returns an incomplete result that
  // `lookup` must report as unchecked.
  const perPage = 100;
  const maxPages = 20;
  const versions: string[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const tags = await fetchJson<{ name?: string }[]>(
      `https://api.github.com/repos/${name}/tags?per_page=${perPage}&page=${page}`,
      { headers: githubHeaders(token) },
    );
    if (!tags) return page === 1 ? null : { latest: null, versions: [...new Set(versions)], complete: false };
    versions.push(...tags.map((tag) => tag.name).filter((tag): tag is string => Boolean(tag)));
    if (tags.length < perPage) return { latest: null, versions: [...new Set(versions)], complete: true };
  }

  return { latest: null, versions: [...new Set(versions)], complete: false };
}

/**
 * opam versions are directory names in the opam repository.
 *
 * opam publishes no JSON metadata API — its index *is* a git repository, where
 * every release of every package is a directory `packages/<name>/<name>.<version>/`.
 * Listing that one directory through GitHub's contents API is the documented,
 * stable way to enumerate a package's releases without cloning an index that
 * is well over a gigabyte.
 */
async function opamRepositoryVersions(
  name: string,
  token?: string,
): Promise<{ latest: string | null; versions: string[] } | null> {
  const versions = await fetchOpamPackageVersions(name, { headers: githubHeaders(token) });
  return versions ? { latest: null, versions } : null;
}

/**
 * The newest release that does not cross a major boundary.
 *
 * Distinct from `safeLatest`, which is bounded by the range the manifest
 * declares: a caret range on `4.2.0` stops at the 4.x line *and* at whatever
 * the developer pinned, so a repository pinned to `4.2.0` exactly has no safe
 * upgrade at all while 4.9.0 sits published and compatible. This is the target
 * a developer means by "update it, but don't put me on the next major".
 *
 * Returns undefined when the only thing ahead is a major bump — in which case
 * offering it would be offering a choice that does not exist.
 */
function latestWithinMajor(
  versions: readonly PublishedVersion[],
  current: PublishedVersion,
  ecosystem: Ecosystem,
): PublishedVersion | undefined {
  const semantics = versionSemantics(ecosystem);
  return versions
    .filter((version) => semantics.sameCompatibilityLine(current, version) === true)
    .sort((a, b) => comparePublishedVersions(b, a))[0];
}

/**
 * The newest release the manifest's own range already permits — npm's "wanted".
 *
 * The distinction that matters here is between a range that *forbids*
 * everything newer and a range this function could not read at all. They are
 * not the same fact and used to produce the same answer.
 *
 * `site/package.json` pins `"next": "16.3.0"` exactly. That range is perfectly
 * valid semver, and it admits nothing newer — `npm outdated` prints `wanted
 * 16.3.0`, meaning "there is no upgrade here you have not already forbidden".
 * Falling through to the compatibility band answered `16.3.1` instead, which
 * quietly rewrote the developer's pin into a caret they did not write, and made
 * Drift's table disagree with `npm outdated` on a column both claim to compute
 * the same way.
 *
 * The band remains, for the case it was built for: a range no semver parser can
 * read. Go's `v1.2.3`, a Maven `[1.0,2.0)`, a Gradle `1.2.+` — for those there
 * is no bound to respect, and "the newest release on the same compatibility
 * line" is a better answer than none. That is a fallback for an unreadable
 * range, never for a readable one that said no.
 *
 * When this returns undefined the caller is not left without a suggestion:
 * `latestMinor` still offers the newest release inside the current major, which
 * is exactly the "update it, but don't put me on the next major" a pinned
 * repository wants.
 */
function safeLatest(
  versions: readonly PublishedVersion[],
  current: PublishedVersion,
  range: string,
  ecosystem: Ecosystem,
): PublishedVersion | undefined {
  const semantics = versionSemantics(ecosystem);
  const candidates = versions.filter((version) => comparePublishedVersions(version, current) > 0);
  const satisfaction = candidates.map((version) => ({ version, satisfies: semantics.satisfies(version, range) }));
  // Unknown range grammar fails closed. `latestMinor` may still be offered
  // independently when the ecosystem defines a compatibility line.
  if (satisfaction.some((item) => item.satisfies === null)) return undefined;
  return satisfaction
    .filter((item) => item.satisfies)
    .map((item) => item.version)
    .sort((a, b) => comparePublishedVersions(b, a))[0];
}
