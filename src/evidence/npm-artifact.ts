import { isGzip, isZip, readArchive } from '../util/archive.js';
import { fetchArchive, fetchJson } from '../util/http.js';

/**
 * The published npm tarball, read as an authoritative fallback.
 *
 * jsDelivr is a fast path, not an authority. When it has not mirrored a
 * release, rate-limits, or answers with a partial listing, Drift used to
 * conclude that the *package* publishes nothing — `emoji-regex@10.6.0` ships
 * `index.d.ts` and was reported as having no declaration surface at all. That
 * is a provider failure wearing a package fact's clothes, and it is exactly
 * the kind of claim a first scan must never make.
 *
 * So the registry's own `dist.tarball` for the exact raw version is read
 * instead. Nothing is executed: no install scripts, no package code, no build
 * steps, no loaders. The archive is enumerated in memory and read from.
 *
 * One reader serves declaration discovery, `package.json`, nested package
 * scopes, and exports-map inspection, so there is a single npm artifact
 * implementation rather than one per question.
 */

/** Why an artifact could not be read. Distinct states, never collapsed. */
export type NpmArtifactFailure = 'artifact-unavailable' | 'artifact-corrupt';

export interface NpmArtifact {
  /** The archive's own `package.json`, or null when it carries none. */
  packageJson: Record<string, unknown> | null;
  /** Every published path, relative to the package root. */
  files: ReadonlySet<string>;
  /** File contents as UTF-8, or null when the archive has no such path. */
  read(path: string): string | null;
}

export type NpmArtifactResult =
  | { state: 'ok'; artifact: NpmArtifact }
  | { state: NpmArtifactFailure; detail: string };

/**
 * A ceiling on the tarball Drift will pull to answer a surface question.
 * Declaration surfaces live in packages of a few megabytes; a package larger
 * than this is left unread rather than downloaded in full during a scan.
 */
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;

const artifacts = new Map<string, Promise<NpmArtifactResult>>();

/** Drop the memoised artifacts. Used by tests. */
export function clearNpmArtifactCache(): void {
  artifacts.clear();
}

/**
 * Read one exact published version's tarball.
 *
 * `version` is the raw registry identity and is used verbatim: the artifact
 * that gets inspected is the one the lockfile names, never a normalised
 * neighbour of it.
 */
export function fetchNpmArtifact(packageName: string, version: string): Promise<NpmArtifactResult> {
  const key = `${packageName}@${version}`;
  const cached = artifacts.get(key);
  if (cached) return cached;

  const pending = readNpmArtifact(packageName, version);
  artifacts.set(key, pending);
  return pending;
}

async function readNpmArtifact(packageName: string, version: string): Promise<NpmArtifactResult> {
  const metadata = await fetchJson<{ dist?: { tarball?: unknown } }>(
    `${registryBase(packageName)}/${encodeURIComponent(version)}`,
    { immutable: true, retries: 1 },
  );
  const tarball = metadata?.dist?.tarball;
  if (typeof tarball !== 'string' || !tarball) {
    return {
      state: 'artifact-unavailable',
      detail: `the npm registry returned no tarball for ${packageName}@${version}`,
    };
  }

  const archive = await fetchArchive(tarball, { maxBytes: MAX_TARBALL_BYTES, retries: 1 });
  if (!archive.ok) {
    return {
      state: 'artifact-unavailable',
      detail: `the tarball for ${packageName}@${version} could not be downloaded (${archive.status || archive.error || 'no response'})`,
    };
  }

  // Every npm tarball is a gzipped tar carrying at least `package/package.json`.
  // Bytes that are not an archive at all are a corrupt download, not a package
  // that ships nothing.
  if (!isGzip(archive.bytes) && !isZip(archive.bytes)) {
    return {
      state: 'artifact-corrupt',
      detail: `the tarball for ${packageName}@${version} is not a readable archive`,
    };
  }

  let files: Map<string, () => Buffer>;
  try {
    files = new Map(
      readArchive(archive.bytes)
        .map((entry) => [stripPackagePrefix(entry.path), entry] as const)
        .filter(([path]) => path.length > 0)
        .map(([path, entry]) => [path, () => entry.read()]),
    );
  } catch (err) {
    return {
      state: 'artifact-corrupt',
      detail: `the tarball for ${packageName}@${version} could not be read (${(err as Error).message})`,
    };
  }

  if (files.size === 0) {
    return {
      state: 'artifact-corrupt',
      detail: `the tarball for ${packageName}@${version} contained no readable entries`,
    };
  }

  const read = (path: string): string | null => {
    const entry = files.get(normalize(path));
    if (!entry) return null;
    try {
      return entry().toString('utf8');
    } catch {
      return null;
    }
  };

  let packageJson: Record<string, unknown> | null = null;
  const manifestText = read('package.json');
  if (manifestText) {
    try {
      const parsed: unknown = JSON.parse(manifestText);
      if (parsed && typeof parsed === 'object') packageJson = parsed as Record<string, unknown>;
    } catch {
      // A tarball whose manifest will not parse is still worth enumerating —
      // the declaration files it ships are readable either way.
    }
  }

  return { state: 'ok', artifact: { packageJson, files: new Set(files.keys()), read } };
}

function registryBase(packageName: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName).replaceAll('%40', '@')}`;
}

/** npm tarballs nest everything under a single top-level directory. */
function stripPackagePrefix(path: string): string {
  const normalized = normalize(path);
  const slash = normalized.indexOf('/');
  return slash === -1 ? '' : normalized.slice(slash + 1);
}

function normalize(path: string): string {
  return path.replace(/^\.\//, '').replace(/^\/+/, '');
}
