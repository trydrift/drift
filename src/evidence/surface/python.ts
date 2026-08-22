import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readArchive } from '../../util/archive.js';
import { isAvailable } from '../../util/exec.js';
import { fetchArchive, fetchJson } from '../../util/http.js';
import { readComputed, writeComputed } from '../../util/artifact-cache.js';
import { fetchRegistryInfo } from '../registry.js';
import { diffSurfaces, type SurfaceApi, type SurfaceEntry, type SurfaceKind } from '../type-surface.js';
import { matchesVersion } from './c.js';
import { unavailable, type SurfaceProvider, type SurfaceRequest, type SurfaceOutcome } from './types.js';

/**
 * Python public-symbol diffing.
 *
 * Python has no `cargo public-api`, no japicmp, and no compiler that will tell
 * you what a package exports — so this is a reconstruction, and it is weighted
 * one notch below the true computed diffs to say so. It parses each version's
 * sources with Python's own `ast` module, honouring `__all__` where a package
 * declares one and the leading-underscore convention where it does not,
 * preferring `.pyi` stubs when the package ships them.
 *
 * The archive is downloaded and extracted, never installed. `pip download`
 * would execute the package's own build backend, and Drift does not run a
 * third party's code to find out what it contains.
 */

const TOOL = 'python ast';
const REMEDY = 'Install Python 3 and make `python3` available on PATH.';

/**
 * One notch under the true computed diffs.
 *
 * Deliberately below 0.95, so `analyze` caps a lone Python surface diff at
 * `medium` confidence. Known false negatives are why: re-exports through
 * `from . import *`, symbols created at import time by a decorator or a
 * metaclass, and anything conditional on the Python version or platform are all
 * invisible to a static read.
 */
const WEIGHT = 0.9;

/**
 * Below `CONFIDENT_SURFACE_WEIGHT`, deliberately: a diff computed from the
 * GitHub-tag fallback layers an unverified, possibly mismatched archive (see
 * `matchingTag`) on top of the same static-reconstruction limitations `WEIGHT`
 * already discounts for. The PyPI-sourced path is never downgraded — only
 * the fallback used when PyPI's own archive was genuinely unreadable.
 */
const FALLBACK_WEIGHT = 0.6;

export const pythonSurface: SurfaceProvider = {
  ecosystem: 'pypi',
  tool: TOOL,
  weight: WEIGHT,

  async compute(request: SurfaceRequest): Promise<SurfaceOutcome> {
    if (!(await isAvailable(request.exec, 'python3', ['--version']))) {
      return unavailable(
        TOOL,
        'tool-missing',
        `Python 3 is not installed, so ${request.name}'s public symbols could not be compared.`,
        REMEDY,
      );
    }

    await mkdir(request.workdir, { recursive: true });
    const scriptPath = join(request.workdir, 'surface.py');
    await writeFile(scriptPath, SURFACE_SCRIPT, 'utf8');

    // What would have to change for a remembered surface to be wrong: the
    // script that reads it, and the interpreter that runs the script.
    const analyzer = `${SCRIPT_FINGERPRINT}/${await interpreterVersion(request)}`;

    const before = await surfaceOf(request, request.from, scriptPath, analyzer);
    if (!before.ok) return before.failure;
    const after = await surfaceOf(request, request.to, scriptPath, analyzer);
    if (!after.ok) return after.failure;

    // PyPI's sdist/wheel is the artifact actually installed; a GitHub tag is
    // only reached when that archive could not be read, and is never a
    // guaranteed match for it — so a reader comparing this diff against PyPI
    // is told when the source underneath it was the fallback, not the
    // canonical published artifact.
    const usedFallback = before.usedGitHubFallback || after.usedGitHubFallback;
    const fallbackNote = usedFallback ? '; source: GitHub tag mirror, PyPI archive was unreadable' : '';

    return {
      available: true,
      changes: diffSurfaces(before.api, after.api),
      tool: TOOL,
      // Genuinely lower confidence, not merely a note in the citation: below
      // `CONFIDENT_SURFACE_WEIGHT`, so a fallback-derived diff does not earn
      // the same automatic high confidence a real computed diff does.
      weight: usedFallback ? FALLBACK_WEIGHT : WEIGHT,
      locator: `${request.name} ${request.from} → ${request.to} (public symbols, best-effort${fallbackNote})`,
    };
  },
};

type SurfaceAttempt =
  | { ok: true; api: SurfaceApi; usedGitHubFallback: boolean }
  | { ok: false; failure: SurfaceOutcome };

/**
 * The parsed public surface of one published version, computed at most once
 * per machine per analyzer.
 *
 * Everything below this — a download, an unpack, and an `ast` parse of every
 * Python file in the package — produces the same answer every time it runs,
 * because a published version is immutable and no registry permits anyone to
 * change one after the fact. On a warm scan of Scrapy's dependencies that was
 * thirty-odd `python3` invocations re-deriving what the last scan already knew.
 *
 * The key carries the analyzer, not just the artifact: a hash of the script
 * below and the interpreter that runs it. Keyed on the package alone, a fixed
 * parser would keep serving the answer it got wrong — a silent accuracy
 * regression, and the reason there is no TTL here instead.
 *
 * Only a *successful* surface computed from PyPI's own archive is remembered.
 * Every failure path below is either a fact about this machine (no `python3`)
 * or a transient one (a download that did not land), and neither is a
 * property of the version being asked about — but a surface computed from
 * the GitHub-tag fallback (see `githubArchiveFallback`) is a property of
 * *this run's* transient PyPI failure, not of the version, and is
 * deliberately never written here. Caching it would let a single transient
 * PyPI outage convert into a permanent, indefinitely-reused substitute for
 * the canonical artifact — there is no TTL on this cache to age it back out
 * — and every later scan would keep re-serving GitHub-derived data on a
 * package whose real PyPI archive may have been reachable the whole time
 * since. Leaving it uncached means the next call simply tries PyPI again
 * first, the same as any other call.
 */
async function surfaceOf(
  request: SurfaceRequest,
  version: string,
  scriptPath: string,
  analyzer: string,
): Promise<SurfaceAttempt> {
  const key = `python-surface:${analyzer}:${request.name}@${version}`;
  // Stored as entry pairs: a `Map` is not JSON, and every field of a
  // `SurfaceEntry` is a string or an array of them, so the round trip is exact.
  const remembered = await readComputed<[string, SurfaceEntry][]>(key);
  // Always `false`: a fallback-derived surface is never written under `key`
  // below, so anything read back from it is guaranteed to be PyPI-derived.
  if (remembered) return { ok: true, api: new Map(remembered), usedGitHubFallback: false };

  const computed = await computeSurfaceOf(request, version, scriptPath);
  if (computed.ok && !computed.usedGitHubFallback) await writeComputed(key, [...computed.api]);
  return computed;
}

async function computeSurfaceOf(
  request: SurfaceRequest,
  version: string,
  scriptPath: string,
): Promise<SurfaceAttempt> {
  const source = await sourceArchiveUrl(request.name, version);
  if (!source) {
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'version-unavailable',
        `PyPI has no source archive for ${request.name} ${version}. It may be private, yanked, or published only as a built wheel Drift cannot open.`,
      ),
    };
  }

  const dir = join(request.workdir, `probe-${version.replace(/[^\w.-]/g, '_')}`);

  let bytes: Buffer;
  let usedGitHubFallback = false;
  try {
    await mkdir(dir, { recursive: true });
    const downloaded = await fetchArchive(source.url, { timeoutMs: request.timeoutMs, retries: 2 });
    if (downloaded.ok) {
      bytes = downloaded.bytes;
    } else {
      // PyPI's own archive is the canonical artifact — the one actually
      // installed — so it is always tried first and never skipped in its
      // favour. Only once it is genuinely unreadable is a GitHub tag tried,
      // as a best-effort mirror: a tag can be missing, misnamed, or not
      // bit-for-bit what PyPI published, so this is never preferred over a
      // working PyPI response.
      const fallback = await githubArchiveFallback(request.name, version, request.timeoutMs);
      if (!fallback) {
        return downloaded.status === 0
          ? {
              ok: false,
              failure: unavailable(
                TOOL,
                'toolchain-failed',
                `Could not download ${source.url}: ${downloaded.error ?? 'the request did not complete'}`,
              ),
            }
          : {
              ok: false,
              failure: unavailable(TOOL, 'version-unavailable', `PyPI returned ${downloaded.status} for ${source.url}.`),
            };
      }
      bytes = fallback;
      usedGitHubFallback = true;
    }
  } catch (err) {
    return {
      ok: false,
      failure: unavailable(TOOL, 'toolchain-failed', `Could not download ${source.url}: ${(err as Error).message}`),
    };
  }

  // Unpacked in-process, and only the files the reader below will actually
  // open. This used to shell out to `tar -xf`, which was wrong in two ways at
  // once: it spawned a subprocess per archive — eighty-two of them on a scan of
  // Scrapy's dependencies, twelve seconds of wall time — and reading a *zip*
  // with `tar` is a BSD-tar behaviour, so the wheel path worked on macOS and
  // failed on every GNU/Linux runner in CI.
  //
  // The written set is exactly what `SURFACE_SCRIPT`'s own walk would have
  // picked up: `.py` and `.pyi`, with `test`, `tests`, `.git` and `__pycache__`
  // pruned. An sdist is mostly documentation, C sources and fixtures, none of
  // which the parser opens, so this writes a fraction of what it did.
  let written = 0;
  try {
    for (const entry of readArchive(bytes)) {
      const path = safeRelativePath(entry.path);
      if (!path) continue;
      const target = join(dir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, entry.read());
      written += 1;
    }
  } catch (err) {
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'toolchain-failed',
        `Could not unpack ${source.filename}: ${firstLine((err as Error).message)}`,
      ),
    };
  }

  if (written === 0) {
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'no-public-surface',
        `${request.name} ${version} ships no Python sources Drift could read.`,
      ),
    };
  }

  const read = await request.exec('python3', [scriptPath, dir], { timeoutMs: request.timeoutMs });
  if (read.code !== 0) {
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'parse-failed',
        `Could not read ${request.name} ${version}'s public symbols: ${firstLine(read.stderr)}`,
      ),
    };
  }

  const api = parsePythonSurface(read.stdout);
  if (!api) {
    return {
      ok: false,
      failure: unavailable(TOOL, 'parse-failed', `Unreadable symbol listing for ${request.name} ${version}.`),
    };
  }
  if (api.size === 0) {
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'no-public-surface',
        `${request.name} ${version} declares no public symbols Drift could read statically.`,
      ),
    };
  }

  return { ok: true, api, usedGitHubFallback };
}

/**
 * Where an archive entry may be written, or `null` for one that must not be.
 *
 * Two jobs. The safety one: an entry may name `../../etc/passwd`, and an
 * archive from a third party is exactly where that shows up, so anything that
 * escapes the extraction directory is dropped rather than reasoned about. The
 * cheap one: only `.py` and `.pyi` are ever read, and only outside the
 * directories the reader prunes, so nothing else is worth the write.
 */
const PRUNED_DIRECTORIES = new Set(['test', 'tests', '.git', '__pycache__']);

export function safeRelativePath(entryPath: string): string | null {
  if (!entryPath.endsWith('.py') && !entryPath.endsWith('.pyi')) return null;

  const parts = entryPath.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0) return null;
  if (parts.some((part) => part === '..')) return null;
  // An absolute path in the archive, or a Windows drive letter.
  if (entryPath.startsWith('/') || /^[a-zA-Z]:/.test(entryPath)) return null;
  if (parts.slice(0, -1).some((part) => PRUNED_DIRECTORIES.has(part))) return null;

  return parts.join('/');
}

export interface SourceArchive {
  url: string;
  filename: string;
}

/**
 * A generous ceiling for a repository archive fetched only as a last-resort
 * mirror. A PyPI sdist is typically a few hundred KB to a few MB; a whole
 * GitHub repository tarball for a large monorepo can be orders of magnitude
 * larger, and unlike a registry artifact there is no separate size Drift
 * already trusts going in. Buffering and decompressing an unbounded archive
 * for a best-effort fallback is not a cost this is worth paying — a
 * repository past this size fails the fallback the same way an unreadable
 * PyPI archive already does, rather than risking memory/disk pressure on
 * whatever happens to be checked out at that tag.
 */
const MAX_FALLBACK_ARCHIVE_BYTES = 25 * 1024 * 1024;

/**
 * A best-effort mirror of a version's source, from its GitHub repository,
 * for use only once PyPI's own archive is confirmed unreadable.
 *
 * Never preferred over PyPI: a git tag can be missing, misnamed, or scoped
 * to a monorepo, so it is not guaranteed to be the exact artifact PyPI
 * published — it is a fallback so a transient PyPI failure does not silently
 * drop the surface diff, not a replacement source.
 */
async function githubArchiveFallback(name: string, version: string, timeoutMs: number): Promise<Buffer | null> {
  const info = await fetchRegistryInfo(name, 'pypi', version);
  if (!info?.githubRepo) return null;

  const tags = await fetchJson<{ name?: string; commit?: { sha?: string } }[]>(
    `https://api.github.com/repos/${info.githubRepo}/tags?per_page=100`,
  );
  const tag = matchingTag(tags ?? [], name, version);
  if (!tag) return null;

  // A tag ref is mutable — a maintainer can force-move it to point at a
  // different commit at any time — so downloading by tag name would make the
  // archive cache below (keyed by URL, with no TTL: see `fetchArchive`) able
  // to permanently serve bytes from a commit the tag no longer points at.
  // Resolving to the commit SHA the tags API already returned makes the
  // download URL genuinely content-addressed, the same invariant every other
  // archive in that cache relies on.
  const sha = tags?.find((entry) => entry.name === tag)?.commit?.sha;
  const ref = sha ?? `refs/tags/${tag}`;

  const downloaded = await fetchArchive(`https://codeload.github.com/${info.githubRepo}/tar.gz/${ref}`, {
    timeoutMs,
    retries: 2,
    maxBytes: MAX_FALLBACK_ARCHIVE_BYTES,
  });
  return downloaded.ok ? downloaded.bytes : null;
}

/**
 * Which repository tag is this version, when a repository can host more than
 * one PyPI distribution.
 *
 * `matchesVersion` strips a tag down to its trailing numeric run, so in a
 * monorepo both `package-a-v1.0.0` and `package-b-v1.0.0` match version
 * `1.0.0` equally — whichever tag happened to sort first would otherwise win,
 * and the archive downloaded and parsed could be a sibling package's source
 * with nothing to do with the PyPI distribution actually being diffed. A tag
 * that also names this package is preferred; absent one, a bare version match
 * is only trusted when there is exactly one candidate across the whole
 * repository — more than one *is* the ambiguity this guards against, and
 * guessing which one is correct is worse than not falling back at all.
 */
export function matchingTag(
  tags: readonly { name?: string }[],
  name: string,
  version: string,
): string | null {
  const candidates = tags.filter(
    (entry): entry is { name: string } => Boolean(entry.name) && matchesVersion(entry.name!, version),
  );

  const slug = name.toLowerCase().replace(/[_.]/g, '-');
  const named = candidates.find((entry) => entry.name.toLowerCase().replace(/[_.]/g, '-').includes(slug));
  if (named) return named.name;

  return candidates.length === 1 ? candidates[0]!.name : null;
}

/** The sdist if there is one, else a wheel — both are archives `tar` can open. */
export async function sourceArchiveUrl(name: string, version: string): Promise<SourceArchive | null> {
  const data = await fetchJson<{
    releases?: Record<string, { url: string; filename: string; packagetype: string }[]>;
  }>(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);

  const files = data?.releases?.[version] ?? [];
  const sdist = files.find((f) => f.packagetype === 'sdist');
  const wheel = files.find((f) => f.packagetype === 'bdist_wheel');
  const chosen = sdist ?? wheel;
  return chosen ? { url: chosen.url, filename: chosen.filename } : null;
}

const PY_KINDS: Record<string, SurfaceKind> = {
  function: 'function',
  class: 'class',
  variable: 'variable',
};

interface PythonSymbol {
  name: string;
  kind: string;
  signature: string;
  members?: string[];
}

/** Read the JSON the helper script emits into the shared surface shape. */
export function parsePythonSurface(json: string): SurfaceApi | null {
  let parsed: PythonSymbol[];
  try {
    parsed = JSON.parse(json) as PythonSymbol[];
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const api: SurfaceApi = new Map();
  for (const symbol of parsed) {
    if (!symbol?.name) continue;
    api.set(symbol.name, {
      name: symbol.name,
      kind: PY_KINDS[symbol.kind] ?? 'variable',
      signature: symbol.signature ?? symbol.name,
      members: symbol.members ?? [],
      requiredMembers: [],
    });
  }
  return api;
}

/**
 * The helper, kept here as one string so there is no build step for it.
 *
 * It parses rather than imports, which is the whole point: importing a package
 * to inspect it runs its module-level code, and Drift will not run a
 * dependency's code to describe it.
 */
const SURFACE_SCRIPT = `import ast, json, os, sys

def public(name):
    return not name.startswith('_') or (name.startswith('__') and name.endswith('__'))

def signature(node):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        args = node.args
        names = [a.arg for a in getattr(args, 'posonlyargs', [])] + [a.arg for a in args.args]
        if args.vararg: names.append('*' + args.vararg.arg)
        names += [a.arg for a in args.kwonlyargs]
        if args.kwarg: names.append('**' + args.kwarg.arg)
        defaults = len(args.defaults) + len([d for d in args.kw_defaults or [] if d is not None])
        return 'def %s(%s) defaults=%d' % (node.name, ', '.join(names), defaults)
    if isinstance(node, ast.ClassDef):
        bases = [ast.unparse(b) if hasattr(ast, 'unparse') else '?' for b in node.bases]
        return 'class %s(%s)' % (node.name, ', '.join(bases))
    return node.name if hasattr(node, 'name') else ''

def members(node):
    out = []
    for item in node.body:
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if public(item.name): out.append(item.name)
        elif isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
            if public(item.target.id): out.append(item.target.id)
        elif isinstance(item, ast.Assign):
            for target in item.targets:
                if isinstance(target, ast.Name) and public(target.id): out.append(target.id)
    return out

def declared_all(tree):
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == '__all__':
                    try:
                        return set(ast.literal_eval(node.value))
                    except Exception:
                        return None
    return None

# Prefer a stub over the implementation: a .pyi is the author's own statement
# of the public interface, which beats inferring one.
sources = {}
for base, dirs, files in os.walk(sys.argv[1]):
    dirs[:] = [d for d in dirs if d not in ('test', 'tests', '.git', '__pycache__')]
    for name in files:
        if not (name.endswith('.py') or name.endswith('.pyi')): continue
        path = os.path.join(base, name)
        key = path[:-1] if name.endswith('.pyi') else path
        if key in sources and name.endswith('.py'): continue
        sources[key] = path

symbols = {}
for path in sorted(sources.values()):
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as handle:
            tree = ast.parse(handle.read(), path)
    except Exception:
        continue

    exported = declared_all(tree)
    module = os.path.basename(path).rsplit('.', 1)[0]
    prefix = '' if module in ('__init__', '__main__') else module + '.'

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            name = node.name
            kind = 'class' if isinstance(node, ast.ClassDef) else 'function'
            body = members(node) if isinstance(node, ast.ClassDef) else []
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name, kind, body = node.targets[0].id, 'variable', []
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            name, kind, body = node.target.id, 'variable', []
        else:
            continue

        if exported is not None:
            if name not in exported: continue
        elif not public(name):
            continue

        key = prefix + name
        if key not in symbols:
            symbols[key] = {'name': key, 'kind': kind, 'signature': signature(node) if kind != 'variable' else name, 'members': sorted(body)}

json.dump(sorted(symbols.values(), key=lambda s: s['name']), sys.stdout)
`;

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'no output';
}

/**
 * A fingerprint of the reader below, so a fix to it invalidates every surface
 * it could have got wrong.
 *
 * Hashing the script rather than versioning it by hand: a constant somebody has
 * to remember to bump is a constant that eventually is not bumped, and the
 * failure mode there is a cache quietly serving conclusions from a parser that
 * has since been corrected.
 */
const SCRIPT_FINGERPRINT = createHash('sha256').update(SURFACE_SCRIPT).digest('hex').slice(0, 12);

/**
 * Which `python3` this is, asked once per process.
 *
 * Part of the cache key because `ast` is a moving target: a syntax the running
 * interpreter cannot parse is a file the reader silently skips, so the same
 * package can have a different readable surface under 3.9 and under 3.13.
 */
let interpreter: Promise<string> | null = null;

function interpreterVersion(request: SurfaceRequest): Promise<string> {
  interpreter ??= request
    .exec('python3', ['--version'], { timeoutMs: 20_000 })
    .then((result) => (result.stdout || result.stderr).trim().replace(/\s+/g, '-') || 'unknown')
    .catch(() => 'unknown');
  return interpreter;
}
