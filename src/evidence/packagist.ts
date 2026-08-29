import { fetchJson } from '../util/http.js';

/**
 * One reading of Packagist's p2 metadata format.
 *
 * The p2 endpoint serves "minified" (`composer/2.0`) documents: releases come
 * newest-first, the first entry is complete, and every later entry carries
 * only the fields that *differ* from the entry before it. A reader that treats
 * each entry as self-contained therefore finds no `source`, no `homepage` and
 * no `autoload` on almost every version — which is how `phpstan/phpstan` lost
 * its source repository, and with it every release note and changelog that
 * repository would have supplied.
 *
 * Drift had two readings of this format: a correct forward-merge in the module
 * mapping and a weaker one in the registry provider. This is the single one
 * both use.
 */

export interface PhpAutoload {
  'psr-4'?: Record<string, string | string[]>;
  'psr-0'?: Record<string, string | string[]>;
}

/** A p2 entry exactly as served, before inheritance is expanded. */
interface RawPackagistVersion {
  version?: string;
  description?: string | null;
  homepage?: string | null;
  source?: { url?: string } | null;
  abandoned?: boolean | string | null;
  autoload?: PhpAutoload | null;
}

/** Effective metadata for one exact published version. */
export interface PackagistRelease {
  /** The registry's exact spelling. Never normalised. */
  version: string;
  description: string | null;
  homepage: string | null;
  sourceUrl: string | null;
  /** `false`/absent, `true`, or the replacement package's name. */
  abandoned: boolean | string | null;
  autoload: PhpAutoload | null;
}

/**
 * Expand p2 inheritance into effective per-version metadata.
 *
 * Entries are walked in served order, carrying each field forward until a
 * later entry restates it. An explicit `null` means the field was *removed*
 * at that version rather than left unchanged, so it clears the carried value.
 */
export function expandPackagistVersions(raw: readonly unknown[]): PackagistRelease[] {
  const carried: Omit<PackagistRelease, 'version'> = {
    description: null,
    homepage: null,
    sourceUrl: null,
    abandoned: null,
    autoload: null,
  };
  const out: PackagistRelease[] = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as RawPackagistVersion;

    if (entry.description !== undefined) carried.description = entry.description ?? null;
    if (entry.homepage !== undefined) carried.homepage = entry.homepage ?? null;
    if (entry.source !== undefined) carried.sourceUrl = entry.source?.url ?? null;
    if (entry.abandoned !== undefined) carried.abandoned = entry.abandoned ?? null;
    if (entry.autoload !== undefined) carried.autoload = entry.autoload ?? null;

    const version = typeof entry.version === 'string' ? entry.version : null;
    if (!version) continue;
    out.push({ version, ...carried });
  }

  return out;
}

/** Every release of one package, with inheritance already expanded. */
export async function fetchPackagistReleases(
  name: string,
  options: { timeoutMs?: number } = {},
): Promise<PackagistRelease[] | null> {
  const key = name.toLowerCase();
  const data = await fetchJson<{ packages?: Record<string, unknown[]> }>(
    `https://repo.packagist.org/p2/${key}.json`,
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );
  const releases = data?.packages?.[key] ?? data?.packages?.[name];
  if (!Array.isArray(releases) || releases.length === 0) return null;
  return expandPackagistVersions(releases);
}

/**
 * The effective metadata for one exact version.
 *
 * Matched on the raw identity first. Composer writes tags as both `1.2.3` and
 * `v1.2.3` and Packagist keeps whichever the tag used, so the `v` prefix is
 * tolerated as a second pass — it is a spelling of the same release, never a
 * different one.
 */
export function packagistReleaseFor(
  releases: readonly PackagistRelease[],
  version: string,
): PackagistRelease | null {
  const exact = releases.find((release) => release.version === version);
  if (exact) return exact;
  const unprefixed = version.replace(/^v/, '');
  return releases.find((release) => release.version.replace(/^v/, '') === unprefixed) ?? null;
}
