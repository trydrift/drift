import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from '../util/exec.js';
import { fetchJson } from '../util/http.js';

/**
 * A real diff between two published versions of a package's source, for the
 * one piece of evidence Drift has that is a claim rather than an observation:
 * the semver heuristic ("this is a patch bump, breakage is usually
 * accidental"). Everything else Drift cites is either a passage someone
 * wrote down or a computed API diff; this is the one place a developer might
 * reasonably want to go and look for themselves, so this fetches what they'd
 * see if they did.
 *
 * Scoped to npm and crates.io for now, both of which publish a single
 * content-addressed archive at a URL that needs no build step to read.
 * Nothing here executes anything from the package — only downloads and
 * extracts it, the same rule `pythonSurface` follows for the same reason.
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
  const source = archiveSourceFor(args.ecosystem);
  if (!source) {
    return {
      available: false,
      reason: `Drift does not yet know how to fetch ${args.ecosystem} package sources to build a diff.`,
    };
  }

  const before = await extracted(source, args.name, args.from, args.exec, args.timeoutMs);
  if (!before.ok) return { available: false, reason: before.reason };
  const after = await extracted(source, args.name, args.to, args.exec, args.timeoutMs);
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
      exec('cp', ['-R', beforeDir, join(staging, 'before')], { timeoutMs: timeoutMs ?? 30_000 }),
      exec('cp', ['-R', afterDir, join(staging, 'after')], { timeoutMs: timeoutMs ?? 30_000 }),
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

interface ArchiveSource {
  cacheKey: string;
  url(name: string, version: string): Promise<string | null>;
}

function archiveSourceFor(ecosystem: string): ArchiveSource | null {
  switch (ecosystem) {
    case 'npm':
      return {
        cacheKey: 'npm',
        async url(name, version) {
          const data = await fetchJson<{ versions?: Record<string, { dist?: { tarball?: string } }> }>(
            `https://registry.npmjs.org/${encodeURIComponent(name).replaceAll('%40', '@')}`,
          );
          return data?.versions?.[version]?.dist?.tarball ?? null;
        },
      };
    case 'cargo':
      return {
        cacheKey: 'cargo',
        async url(name, version) {
          // crates.io serves the source of truth at this fixed, versioned
          // path; no lookup needed, it either exists or the download 404s.
          return `https://static.crates.io/crates/${encodeURIComponent(name)}/${encodeURIComponent(name)}-${encodeURIComponent(version)}.crate`;
        },
      };
    default:
      return null;
  }
}

type ExtractAttempt = { ok: true; dir: string } | { ok: false; reason: string };

async function extracted(
  source: ArchiveSource,
  name: string,
  version: string,
  exec: Exec,
  timeoutMs?: number,
): Promise<ExtractAttempt> {
  // Cached by ecosystem/name/version rather than a fresh mkdtemp per call: a
  // patch bump's diff gets opened more than once in a session, and a
  // published archive never changes shape once fetched.
  const dir = join(tmpdir(), 'drift-version-diff', source.cacheKey, safeSegment(name), safeSegment(version));
  const marker = join(dir, '.drift-extracted');

  const cached = await readFile(marker, 'utf8').catch(() => null);
  if (cached !== null) return { ok: true, dir: cached === '.' ? dir : join(dir, cached) };

  const url = await source.url(name, version);
  if (!url) {
    return { ok: false, reason: `Could not find a source archive for ${name} ${version}.` };
  }

  let archiveBytes: Buffer;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs ?? 60_000) });
    if (!response.ok) {
      return { ok: false, reason: `${url} returned HTTP ${response.status}.` };
    }
    archiveBytes = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    return { ok: false, reason: `Could not download ${url}: ${(err as Error).message}` };
  }

  await mkdir(dir, { recursive: true });
  const archivePath = join(dir, 'archive.tgz');
  await writeFile(archivePath, archiveBytes);

  // `tar` reads gzip tarballs and .crate files alike; extracting an archive
  // executes nothing in it, the same guarantee `pythonSurface` relies on.
  const result = await exec('tar', ['-xf', archivePath, '-C', dir], { timeoutMs: timeoutMs ?? 30_000 });
  if (result.code !== 0) {
    return { ok: false, reason: `Could not unpack ${name} ${version}: ${firstLine(result.stderr)}` };
  }

  const root = await singleSubdirectory(dir);
  await writeFile(marker, root ?? '.');
  return { ok: true, dir: root ? join(dir, root) : dir };
}

/** npm tarballs unpack into `package/`, crates into `{name}-{version}/`. */
async function singleSubdirectory(dir: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((entry) => entry.isDirectory());
  return dirs.length === 1 ? dirs[0]!.name : null;
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
