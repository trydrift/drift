import { dirname, join, sep } from 'node:path';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readArchive, type ArchiveEntry } from '../util/archive.js';
import type { Exec } from '../util/exec.js';
import { fetchJson } from '../util/http.js';
import { sourceArchiveUrl } from './surface/python.js';
import { parseCoordinate } from './surface/java.js';

/**
 * A real diff between two published versions of a package's source, for the
 * one piece of evidence Drift has that is a claim rather than an observation:
 * the semver heuristic ("this is a patch bump, breakage is usually
 * accidental"). Everything else Drift cites is either a passage someone
 * wrote down or a computed API diff; this is the one place a developer might
 * reasonably want to go and look for themselves, so this fetches what they'd
 * see if they did.
 *
 * Covers every ecosystem that publishes a fetchable archive of its actual
 * source at a URL derivable without a build step or a registry search:
 * npm, cargo, PyPI, Go (via the module proxy), pub.dev, and Hex — the same
 * archives `pythonSurface`, `pubSurface` and `hexSurface` already read for
 * their own computed diffs. Maven is best-effort: Central hosts a
 * `-sources.jar` for most libraries but not all, and there is no source
 * archive to fall back to when one is missing. NuGet and the C/C++
 * ecosystems are absent on purpose — a `.nupkg` ships a compiled assembly,
 * not source, and C/C++ has no registry with a single fetchable archive at
 * all, so pretending otherwise would mean diffing the wrong thing rather
 * than saying so.
 *
 * Nothing here executes anything from the package — only downloads and
 * reads it in memory, the same rule `pythonSurface`, `pubSurface` and
 * `hexSurface` already follow for the same reason.
 */

export interface VersionDiffFile {
  status: 'added' | 'removed' | 'modified';
  /** Relative to the extracted package root, on both sides. */
  path: string;
}

export type VersionDiffResult =
  | {
      available: true;
      beforeDir: string;
      afterDir: string;
      files: VersionDiffFile[];
      /** True when the file list was capped before every file was compared. */
      truncated: boolean;
    }
  | { available: false; reason: string };

const MAX_FILES = 4000;

export async function fetchVersionDiff(args: {
  ecosystem: string;
  name: string;
  from: string;
  to: string;
  exec: Exec;
  timeoutMs?: number;
}): Promise<VersionDiffResult> {
  const fetcher = fetcherFor(args.ecosystem);
  if (!fetcher) {
    return {
      available: false,
      reason: `Drift does not yet know how to fetch ${args.ecosystem} package sources to build a diff.`,
    };
  }

  const before = await extracted(fetcher, args.name, args.from, args.timeoutMs);
  if (!before.ok) return { available: false, reason: before.reason };
  const after = await extracted(fetcher, args.name, args.to, args.timeoutMs);
  if (!after.ok) return { available: false, reason: after.reason };

  const files = await diffFileList(before.dir, after.dir, args.exec, args.timeoutMs);
  if (!files.ok) return { available: false, reason: files.reason };

  return { available: true, beforeDir: before.dir, afterDir: after.dir, ...files };
}

/**
 * The unified diff itself, in exactly the format `git diff` prints — because
 * it is one, run with `--no-index` across the two extracted trees rather than
 * against a repository's own history. The CLI hands this to the terminal
 * verbatim; nothing here reformats a single line of it.
 */
export async function unifiedDiffText(
  beforeDir: string,
  afterDir: string,
  exec: Exec,
  timeoutMs?: number,
): Promise<string> {
  // `git diff --no-index a b` prints paths rooted at whichever of `a`/`b` it
  // read from — there is no shared root to make them relative to unless one
  // is manufactured. `beforeDir` and `afterDir` live under unrelated version
  // directories (so the cache in `extracted()` can key on each independently
  // and be reused across diffs), so a throwaway pair of `before`/`after`
  // copies is what turns `/tmp/…/0.17.10/indicatif-0.17.10/src/lib.rs` into
  // the `before/src/lib.rs` a reader actually wants to see.
  const staging = await mkdtemp(join(tmpdir(), 'drift-version-diff-view-'));
  try {
    await Promise.all([
      cp(beforeDir, join(staging, 'before'), { recursive: true }),
      cp(afterDir, join(staging, 'after'), { recursive: true }),
    ]);

    const result = await exec('git', ['diff', '--no-index', '--no-prefix', 'before', 'after'], {
      cwd: staging,
      timeoutMs: timeoutMs ?? 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    // `git diff --no-index` exits 1 when the compared trees differ — the
    // ordinary case here — and only >1 on an actual failure to run the diff.
    return result.code <= 1 ? result.stdout : '';
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

type EntriesResult = { ok: true; entries: ArchiveEntry[] } | { ok: false; reason: string };

interface EcosystemFetcher {
  cacheKey: string;
  fetchEntries(name: string, version: string, timeoutMs: number): Promise<EntriesResult>;
}

async function fetchArchiveEntries(url: string, timeoutMs: number): Promise<EntriesResult> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, reason: `${url} returned HTTP ${response.status}.` };
    return { ok: true, entries: readArchive(Buffer.from(await response.arrayBuffer())) };
  } catch (err) {
    return { ok: false, reason: `Could not download ${url}: ${(err as Error).message}` };
  }
}

function fetcherFor(ecosystem: string): EcosystemFetcher | null {
  switch (ecosystem) {
    case 'npm':
      return {
        cacheKey: 'npm',
        async fetchEntries(name, version, timeoutMs) {
          const data = await fetchJson<{ versions?: Record<string, { dist?: { tarball?: string } }> }>(
            `https://registry.npmjs.org/${encodeURIComponent(name).replaceAll('%40', '@')}`,
          );
          const url = data?.versions?.[version]?.dist?.tarball;
          if (!url) return { ok: false, reason: `Could not find a tarball for ${name} ${version} on the npm registry.` };
          return fetchArchiveEntries(url, timeoutMs);
        },
      };
    case 'cargo':
      return {
        cacheKey: 'cargo',
        // crates.io serves the source of truth at this fixed, versioned path;
        // no lookup needed, it either exists or the download 404s.
        fetchEntries: (name, version, timeoutMs) =>
          fetchArchiveEntries(
            `https://static.crates.io/crates/${encodeURIComponent(name)}/${encodeURIComponent(name)}-${encodeURIComponent(version)}.crate`,
            timeoutMs,
          ),
      };
    case 'pypi':
      return {
        cacheKey: 'pypi',
        async fetchEntries(name, version, timeoutMs) {
          const source = await sourceArchiveUrl(name, version);
          if (!source) {
            return {
              ok: false,
              reason: `PyPI has no source archive for ${name} ${version}. It may be private, yanked, or published only as a built wheel with no sdist.`,
            };
          }
          return fetchArchiveEntries(source.url, timeoutMs);
        },
      };
    case 'go':
      return {
        cacheKey: 'go',
        // The module proxy protocol case-encodes uppercase letters (an
        // artefact of module paths living on case-insensitive filesystems,
        // same reason `GOFLAGS` documents it) and expects the leading `v`
        // Drift's own version strings do not always carry.
        fetchEntries: (name, version, timeoutMs) => {
          const tag = version.startsWith('v') ? version : `v${version}`;
          const url = `https://proxy.golang.org/${escapeGoModulePath(name)}/@v/${escapeGoModulePath(tag)}.zip`;
          return fetchArchiveEntries(url, timeoutMs);
        },
      };
    case 'pub':
      return {
        cacheKey: 'pub',
        fetchEntries: (name, version, timeoutMs) =>
          fetchArchiveEntries(
            `https://pub.dev/api/archives/${encodeURIComponent(name)}-${encodeURIComponent(version)}.tar.gz`,
            timeoutMs,
          ),
      };
    case 'hex':
      return {
        cacheKey: 'hex',
        // A Hex tarball is a tar whose payload is another, gzipped tar (see
        // `hexSurface`) — the outer layer carries metadata and a checksum
        // alongside the one entry that is actually the package's source.
        async fetchEntries(name, version, timeoutMs) {
          const url = `https://repo.hex.pm/tarballs/${encodeURIComponent(name)}-${encodeURIComponent(version)}.tar`;
          const outer = await fetchArchiveEntries(url, timeoutMs);
          if (!outer.ok) return outer;

          const contents = outer.entries.find(
            (entry) => entry.path === 'contents.tar.gz' || entry.path.endsWith('/contents.tar.gz'),
          );
          if (!contents) {
            return { ok: false, reason: `${name} ${version} is not in the layout Hex tarballs use.` };
          }
          try {
            return { ok: true, entries: readArchive(contents.read()) };
          } catch (err) {
            return { ok: false, reason: `Could not unpack ${name} ${version}: ${(err as Error).message}` };
          }
        },
      };
    case 'maven':
      return {
        cacheKey: 'maven',
        async fetchEntries(name, version, timeoutMs) {
          const coordinate = parseCoordinate(name);
          if (!coordinate) {
            return { ok: false, reason: `\`${name}\` is not a \`groupId:artifactId\` coordinate.` };
          }
          const path = coordinate.groupId.replace(/\./g, '/');
          const url = `https://repo1.maven.org/maven2/${path}/${coordinate.artifactId}/${version}/${coordinate.artifactId}-${version}-sources.jar`;
          const result = await fetchArchiveEntries(url, timeoutMs);
          if (!result.ok) {
            // Central hosts compiled jars for every release but a sources jar
            // only by convention, not by requirement — this is the ordinary
            // shape of "not published", not a fetch failure worth detailing.
            return {
              ok: false,
              reason: `${name} ${version} has no sources jar published on Maven Central, so there is no source to diff (only compiled classfiles are).`,
            };
          }
          return result;
        },
      };
    default:
      return null;
  }
}

/** Uppercase letters case-encoded as `!` + lowercase, per the Go module proxy protocol. */
function escapeGoModulePath(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
}

type ExtractAttempt = { ok: true; dir: string } | { ok: false; reason: string };

async function extracted(
  fetcher: EcosystemFetcher,
  name: string,
  version: string,
  timeoutMs?: number,
): Promise<ExtractAttempt> {
  // Cached by ecosystem/name/version rather than a fresh mkdtemp per call: a
  // patch bump's diff gets opened more than once in a session, and a
  // published archive never changes shape once fetched.
  const dir = join(tmpdir(), 'drift-version-diff', fetcher.cacheKey, safeSegment(name), safeSegment(version));
  const marker = join(dir, '.drift-extracted');

  if (await readFile(marker, 'utf8').then(() => true, () => false)) return { ok: true, dir };

  const result = await fetcher.fetchEntries(name, version, timeoutMs ?? 60_000);
  if (!result.ok) return { ok: false, reason: result.reason };

  await mkdir(dir, { recursive: true });
  for (const { path, entry } of stripCommonPrefix(result.entries)) {
    const target = join(dir, path);
    // The archive is a third party's; a path like `../../etc/passwd` inside
    // one is not hypothetical, and the only safe response is never to write
    // outside the directory this extraction owns.
    if (!(target === dir || target.startsWith(dir + sep))) continue;

    let bytes: Buffer;
    try {
      bytes = entry.read();
    } catch {
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }

  await writeFile(marker, '.');
  return { ok: true, dir };
}

/**
 * Most registries wrap every entry in one throwaway directory path — `package/`
 * for npm, `{name}-{version}/` for a crate, and the *whole* module path plus
 * version for a Go proxy zip (`github.com/gorilla/mux@v1.8.0/`, three levels
 * deep, not one) — that exists only so extracting the archive by hand doesn't
 * scatter files into whatever directory you're standing in. Some (pub.dev's
 * archive, a Hex release's inner tarball) publish flat instead.
 *
 * The common directory prefix shared by every entry is stripped, however many
 * levels deep it goes, capped so every entry always keeps at least its own
 * filename — a directory that turned out to *be* one of the archive's own
 * files is left alone rather than eaten as part of the wrapper.
 */
export function stripCommonPrefix(entries: readonly ArchiveEntry[]): { path: string; entry: ArchiveEntry }[] {
  const parsed = entries
    .map((entry) => ({ entry, segments: entry.path.split('/').filter(Boolean) }))
    .filter((parsed) => parsed.segments.length > 0);
  if (parsed.length === 0) return [];

  const shortest = Math.min(...parsed.map((p) => p.segments.length));
  let prefixLen = Math.max(0, shortest - 1);
  for (let i = 0; i < prefixLen; i++) {
    const segment = parsed[0]!.segments[i];
    if (!parsed.every((p) => p.segments[i] === segment)) {
      prefixLen = i;
      break;
    }
  }

  return parsed.map((p) => ({ entry: p.entry, path: p.segments.slice(prefixLen).join('/') }));
}

type FileListAttempt =
  | { ok: true; files: VersionDiffFile[]; truncated: boolean }
  | { ok: false; reason: string };

async function diffFileList(
  beforeDir: string,
  afterDir: string,
  exec: Exec,
  timeoutMs?: number,
): Promise<FileListAttempt> {
  const result = await exec('git', ['diff', '--no-index', '--no-prefix', '--name-status', beforeDir, afterDir], {
    timeoutMs: timeoutMs ?? 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.code > 1) {
    return { ok: false, reason: `Could not diff the two extracted trees: ${firstLine(result.stderr)}` };
  }

  // `--no-prefix` drops the usual `a/`/`b/` markers, but the path git prints
  // is still rooted at whichever of `beforeDir`/`afterDir` it read the file
  // from (there is no third, shared root to report a path relative to) — so
  // the directory argument itself has to be stripped back off by hand.
  const beforePrefix = `${beforeDir}/`;
  const afterPrefix = `${afterDir}/`;

  const files: VersionDiffFile[] = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [code, ...rest] = line.split('\t');
    const rawPath = rest.join('\t');
    if (!rawPath) continue;

    const status = code?.startsWith('A') ? 'added' : code?.startsWith('D') ? 'removed' : 'modified';
    const path = rawPath.startsWith(afterPrefix)
      ? rawPath.slice(afterPrefix.length)
      : rawPath.startsWith(beforePrefix)
        ? rawPath.slice(beforePrefix.length)
        : rawPath;
    files.push({ status, path });
    if (files.length >= MAX_FILES) break;
  }

  return { ok: true, files, truncated: files.length >= MAX_FILES };
}

function safeSegment(text: string): string {
  return text.replace(/[^\w.-]/g, '_');
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'no output';
}
