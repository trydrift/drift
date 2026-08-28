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
import { raceAgainstBudget, unavailable, type SurfaceProvider, type SurfaceRequest, type SurfaceOutcome } from './types.js';

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

    // `timeoutMs` is documented as the wall-clock budget for the *whole*
    // computation, not a per-attempt allowance to be handed out again at
    // every retry. Below this point every PyPI attempt, GitHub-fallback
    // attempt and parser invocation — for both `from` and `to` — draws down
    // this one fixed deadline instead of each separately receiving the full
    // budget, which is how a nominal three-minute computation could run for
    // a very large multiple of three minutes under network failure. Fixed
    // for the life of this call: `surfaceOf` never lets a later joiner (or
    // an earlier owner) rewrite it — see the comment on `inFlightSurfaces`.
    const deadlineMs = Date.now() + request.timeoutMs;

    const beforePromise = surfaceOf(request, request.from, scriptPath, analyzer, deadlineMs);
    const afterPromise = surfaceOf(request, request.to, scriptPath, analyzer, deadlineMs);
    afterPromise.catch(() => undefined);
    const before = await beforePromise;
    if (!before.ok) return before.failure;
    const after = await afterPromise;
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
  | {
      ok: false;
      failure: SurfaceOutcome;
      /**
       * Set only in `surfaceOf`, after the fact: true when this failure was
       * discovered once the *owner's* own deadline had already elapsed —
       * i.e. this specific attempt ran out of the owner's time, rather than
       * hitting a genuine, budget-independent problem (no archive published,
       * an unreadable package, a real 404). A joiner with its own remaining
       * budget uses this to decide whether the owner's failure is
       * authoritative for it too, or just an artifact of a shorter budget
       * it never agreed to share.
       */
      budgetExhausted?: boolean;
    };

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
/** Time left before `deadline`, never negative. */
function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/**
 * In-flight single-flight cache, keyed identically to the persistent cache
 * key below. The scan-level exact-upgrade cache only dedupes identical
 * `(from, to)` pairs; it does nothing for two upgrades of the *same* package
 * that happen to share only one endpoint (pandas 2.2.2→3.0.5 and pandas
 * 2.2.3→3.0.5 both need pandas@3.0.5 computed exactly once). The promise is
 * inserted synchronously, before any `await`, so two concurrent callers for
 * the same immutable version race into the same computation rather than each
 * starting their own `python3` process.
 *
 * Every entry is removed once its promise settles, regardless of outcome:
 * the map exists only to let concurrent callers for the same immutable
 * version join a single computation in flight, not to serve as a second,
 * unbounded cache. A canonical PyPI success is already durably written to
 * the persistent cache by `surfaceOf` below, so later, independent calls
 * hit that cheap on-disk read instead — keeping the settled promise around
 * would just pin the whole `SurfaceApi` map in memory for the life of the
 * extension host for no benefit. A GitHub-fallback result or a failure must
 * not linger either: both are properties of this run's transient state, not
 * of the version, so a later independent caller must retry PyPI from
 * scratch rather than inherit a fallback or failure that concurrent callers
 * merely happened to share while it was still in flight.
 *
 * Deliberately no shared/mutable deadline here (there used to be one, via a
 * `DeadlineRef` every joiner could `extend()`). That let a late joiner with
 * a large budget of its own silently rewrite the deadline actually driving
 * the *owner's* already-running computation — and, symmetrically, meant a
 * short-budget joiner could never detach from a long-running owner without
 * also cutting that owner off. `timeoutMs` is documented as the wall-clock
 * budget for the calling computation; a shared mutable deadline violates
 * that in both directions at once. Each in-flight entry is now bounded only
 * by whichever caller *created* it — fixed for that computation's whole
 * lifetime — and every other caller (including one with a much larger
 * budget of its own) only ever races that entry's promise against its own,
 * separate deadline in `surfaceOf` below; it never mutates the entry.
 */
interface InFlightSurface {
  promise: Promise<SurfaceAttempt>;
}

const inFlightSurfaces = new Map<string, InFlightSurface>();

async function surfaceOf(
  request: SurfaceRequest,
  version: string,
  scriptPath: string,
  analyzer: string,
  deadlineMs: number,
): Promise<SurfaceAttempt> {
  const key = `python-surface:${analyzer}:${request.name}@${version}`;

  for (;;) {
    const ownBudget = remainingMs(deadlineMs);
    if (ownBudget <= 0) {
      return {
        ok: false,
        failure: unavailable(
          TOOL,
          'toolchain-failed',
          `Ran out of time comparing ${request.name}'s public symbols before ${version} could be checked.`,
        ),
      };
    }

    const existing = inFlightSurfaces.get(key);
    if (existing) {
      // Join the computation in flight, but never wait past *this caller's*
      // own remaining budget for it, and never touch the deadline actually
      // driving it — see the comment on `inFlightSurfaces`.
      const outcome = await raceAgainstBudget(existing.promise, ownBudget);
      if (outcome.timedOut) {
        // This caller's own budget ran out while waiting. The owner's
        // computation is left running untouched for whoever else still
        // needs it — nothing here cancels it.
        return {
          ok: false,
          failure: unavailable(
            TOOL,
            'toolchain-failed',
            `Ran out of time comparing ${request.name}'s public symbols before ${version} could be checked.`,
          ),
        };
      }
      if (!outcome.value.ok && outcome.value.budgetExhausted) {
        // The *owner's* own (shorter) deadline is why that attempt failed —
        // not a fact about this package version, and not authoritative for
        // a caller with budget of its own left (checked at the top of this
        // loop). Evict the stale entry (harmless if another caller already
        // did) and retry as a fresh owner, bounded by this caller's own
        // deadline instead of inheriting someone else's.
        if (inFlightSurfaces.get(key) === existing) inFlightSurfaces.delete(key);
        continue;
      }
      return outcome.value;
    }

    // No one else is computing this version right now: become the owner,
    // bounded only by this caller's own deadline — fixed for the life of
    // this computation, never extended by a later joiner.
    const promise = (async (): Promise<SurfaceAttempt> => {
      // Stored as entry pairs: a `Map` is not JSON, and every field of a
      // `SurfaceEntry` is a string or an array of them, so the round trip is exact.
      const remembered = await readComputed<[string, SurfaceEntry][]>(key);
      // Always `false`: a fallback-derived surface is never written under `key`
      // below, so anything read back from it is guaranteed to be PyPI-derived.
      if (remembered) return { ok: true, api: new Map(remembered), usedGitHubFallback: false };

      const computed = await computeSurfaceOf(request, version, scriptPath, deadlineMs);
      if (computed.ok) {
        if (!computed.usedGitHubFallback) await writeComputed(key, [...computed.api]);
        return computed;
      }
      // A failure discovered once this owner's own deadline had already
      // passed is this call running out of time, not a fact about the
      // package — flagged so a joiner with its own remaining budget knows
      // to retry independently rather than treat it as authoritative.
      return remainingMs(deadlineMs) <= 0 ? { ...computed, budgetExhausted: true } : computed;
    })();
    inFlightSurfaces.set(key, { promise });
    promise
      .catch(() => undefined)
      .then(() => {
        // Always evict on settle, success included: the persistent cache
        // above already serves later independent calls cheaply, so keeping a
        // settled promise here would only pin the whole surface map in memory
        // for the life of the extension host.
        if (inFlightSurfaces.get(key)?.promise === promise) inFlightSurfaces.delete(key);
      });
    return promise;
  }
}

async function computeSurfaceOf(
  request: SurfaceRequest,
  version: string,
  scriptPath: string,
  deadlineMs: number,
): Promise<SurfaceAttempt> {
  if (remainingMs(deadlineMs) <= 0) {
    // The other version (`from` or `to`) already spent the whole request
    // budget — most likely retrying a download that kept failing. Starting
    // this one anyway would mean a zero-timeout request whose only possible
    // outcome is an abort, worded as if the network had just failed rather
    // than as what actually happened.
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'toolchain-failed',
        `Ran out of time comparing ${request.name}'s public symbols before ${version} could be checked.`,
      ),
    };
  }

  const source = await sourceArchiveUrl(request.name, version, remainingMs(deadlineMs));
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
    const downloaded = await fetchArchive(source.url, { timeoutMs: remainingMs(deadlineMs), retries: 2 });
    if (downloaded.ok) {
      bytes = downloaded.bytes;
    } else {
      // PyPI's own archive is the canonical artifact — the one actually
      // installed — so it is always tried first and never skipped in its
      // favour. Only once it is genuinely unreadable is a GitHub tag tried,
      // as a best-effort mirror: a tag can be missing, misnamed, or not
      // bit-for-bit what PyPI published, so this is never preferred over a
      // working PyPI response.
      // No point starting a fresh multi-retry network operation (tag lookup,
      // then the archive itself) with nothing left of the budget to spend on
      // it — the PyPI failure just recorded is the honest reason either way.
      const fallback =
        remainingMs(deadlineMs) > 0 ? await githubArchiveFallback(request.name, version, deadlineMs) : null;
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
    const entries = readArchive(bytes);

    // Only for the GitHub-tag fallback: PyPI's own sdist/wheel is already
    // scoped to exactly this package, but a GitHub repository can be a
    // monorepo hosting several PyPI distributions side by side, and parsing
    // every .py/.pyi in it would misattribute a sibling package's API to this
    // one. Declining (rather than diffing the whole repository) when the
    // subtree cannot be confidently identified is deliberate — see
    // `packageSubtree`.
    let selected = entries;
    let selectedPrefix = '';
    if (usedGitHubFallback) {
      const subtree = packageSubtree(entries.map((entry) => entry.path), request.name);
      if (!subtree) {
        return {
          ok: false,
          failure: unavailable(
            TOOL,
            'no-public-surface',
            `Could not confidently identify ${request.name}'s own source directory inside its GitHub repository, so the fallback was declined rather than comparing the whole repository.`,
          ),
        };
      }
      const prefix = `${subtree}/`;
      selected = entries.filter((entry) => entry.path.startsWith(prefix));
      // `subtree` is the proved import package itself. Materialize it at the
      // extraction root instead of retaining codeload's owner/revision and
      // optional src/ transport parents. This is explicit fallback scoping,
      // not the Python reader guessing that an arbitrary sole directory is a
      // wrapper (which would break PEP 420 namespace packages).
      selectedPrefix = subtree.slice(0, subtree.lastIndexOf('/') + 1);
    }

    for (const entry of selected) {
      const path = safeRelativePath(selectedPrefix ? entry.path.slice(selectedPrefix.length) : entry.path);
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

  // `exec`'s underlying `child_process` `timeout` option treats `0` as
  // "disabled" rather than "expired" — the opposite of what an exhausted
  // budget must mean here — so this is checked explicitly rather than
  // handing a possibly-zero `remainingMs(deadlineMs)` straight through.
  if (remainingMs(deadlineMs) <= 0) {
    return {
      ok: false,
      failure: unavailable(
        TOOL,
        'toolchain-failed',
        `Ran out of time comparing ${request.name}'s public symbols before ${version}'s source could be parsed.`,
      ),
    };
  }

  const read = await request.exec('python3', [scriptPath, dir, request.name], { timeoutMs: remainingMs(deadlineMs) });
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
 * cheap one: only Python sources and the small packaging metadata files used
 * to establish import roots are ever read, and only outside the directories
 * the reader prunes, so nothing else is worth the write.
 */
const PRUNED_DIRECTORIES = new Set(['test', 'tests', '.git', '__pycache__']);

export function safeRelativePath(entryPath: string): string | null {
  const parts = entryPath.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0) return null;
  if (parts.some((part) => part === '..')) return null;
  // An absolute path in the archive, or a Windows drive letter.
  if (entryPath.startsWith('/') || /^[a-zA-Z]:/.test(entryPath)) return null;
  if (parts.slice(0, -1).some((part) => PRUNED_DIRECTORIES.has(part))) return null;

  const base = parts.at(-1)!;
  const pythonSource = base.endsWith('.py') || base.endsWith('.pyi');
  const projectMetadata = ['pyproject.toml', 'setup.cfg', 'setup.py'].includes(base);
  const topLevelMetadata =
    base === 'top_level.txt' && parts.some((part) => part.endsWith('.dist-info') || part.endsWith('.egg-info'));
  if (!pythonSource && !projectMetadata && !topLevelMetadata) return null;

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
async function githubArchiveFallback(name: string, version: string, deadlineMs: number): Promise<Buffer | null> {
  // `deadlineMs` is threaded through rather than a `timeoutMs` snapshot, so
  // every step below — the tags lookup and the eventual archive download —
  // draws down what is actually left of the *outer* budget at the moment it
  // runs, instead of each independently re-spending a fixed allowance taken
  // once at the top of this function.
  const info = await fetchRegistryInfo(name, 'pypi', version);
  if (!info?.githubRepo) return null;
  if (remainingMs(deadlineMs) <= 0) return null;

  const tags = await fetchJson<{ name?: string; commit?: { sha?: string } }[]>(
    `https://api.github.com/repos/${info.githubRepo}/tags?per_page=100`,
    { timeoutMs: remainingMs(deadlineMs) },
  );
  const tag = matchingTag(tags ?? [], name, version);
  if (!tag) return null;
  if (remainingMs(deadlineMs) <= 0) return null;

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
    timeoutMs: remainingMs(deadlineMs),
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
 *
 * "Names this package" is delimiter/token-aware, not a bare substring test: a
 * short project name like `api`, `core` or `client` is a substring of any
 * number of unrelated words (`capitalize`, `scored`, `clients`), so a plain
 * `.includes()` could match a tag with nothing to do with this package. A tag
 * only counts as naming the package when the normalized name appears as its
 * own token, bounded by the start/end of the tag or a non-alphanumeric
 * separator. And more than one such named match is still ambiguity, not a
 * winner — it no longer short-circuits past the single-candidate check the
 * unqualified case already had to satisfy.
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
  const slugPattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(slug)}([^a-z0-9]|$)`);
  const named = candidates.filter((entry) => slugPattern.test(entry.name.toLowerCase().replace(/[_.]/g, '-')));
  if (named.length === 1) return named[0]!.name;
  if (named.length > 1) return null;

  return candidates.length === 1 ? candidates[0]!.name : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which directory inside a GitHub-fallback archive is this PyPI project's own
 * source, so parsing is restricted to it rather than the whole repository —
 * a monorepo's sibling packages must never be diffed as though they belonged
 * to the package actually being compared.
 *
 * PyPI's JSON metadata does not expose a project's installed file list (that
 * would require successfully downloading the very archive this fallback
 * exists because PyPI's own copy could not be read), so this cannot consult
 * a published sdist/wheel file listing the way a healthier download would
 * allow. It falls back to the standard Python packaging convention instead:
 * the top-level importable package is the project name normalized to a valid
 * identifier (hyphens/dots become underscores), optionally nested under
 * `src/`, at whatever depth a repository happens to nest it at (a bare
 * top-level directory, or one more level in under the archive's own
 * `owner-repo-sha/` wrapper).
 *
 * If that directory does not appear at a single, consistent path across the
 * whole archive, there is no accountable way to scope the diff to the right
 * package — this returns `null`, and the caller declines the fallback
 * entirely rather than guessing across the whole repository.
 */
export function packageSubtree(paths: readonly string[], name: string): string | null {
  const normalized = name.toLowerCase().replace(/[-.]+/g, '_');
  const candidates = new Set<string>();

  for (const entryPath of paths) {
    const parts = entryPath.split('/').filter((part) => part !== '');
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] === normalized) {
        candidates.add(parts.slice(0, i + 1).join('/'));
        break;
      }
      if (parts[i] === 'src' && parts[i + 1] === normalized) {
        candidates.add(parts.slice(0, i + 2).join('/'));
        break;
      }
    }
  }

  return candidates.size === 1 ? [...candidates][0]! : null;
}

/** The sdist if there is one, else a wheel — both are archives `tar` can open. */
export async function sourceArchiveUrl(
  name: string,
  version: string,
  timeoutMs?: number,
): Promise<SourceArchive | null> {
  const data = await fetchJson<{
    releases?: Record<string, { url: string; filename: string; packagetype: string }[]>;
  }>(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, timeoutMs !== undefined ? { timeoutMs } : {});

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
  unknown: 'unknown',
};

interface PythonSymbol {
  name: string;
  kind: string;
  signature: string;
  members?: string[];
  /**
   * The helper proved this name is public (explicitly imported and listed in
   * `__all__`) but could not resolve its declaration from the parsed package —
   * the target is re-exported from a third party, or built in a way a static
   * read cannot follow. Existence is known; `kind`/`signature` are not.
   */
  shapeUnknown?: boolean;
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
    // A re-export whose target shape could not be resolved: existence is real,
    // the rest is a placeholder. `diffSurfaces` keys off `shapeUnknown`, never
    // off `kind`, for these — the `'unknown'` kind is only carried so a finding
    // that does surface (the symbol going missing entirely) does not claim a
    // fabricated one.
    if (symbol.shapeUnknown) {
      api.set(symbol.name, {
        name: symbol.name,
        kind: 'unknown',
        signature: symbol.name,
        members: [],
        requiredMembers: [],
        shapeUnknown: true,
      });
      continue;
    }
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
export const SURFACE_SCRIPT = `import ast, json, os, re, sys

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

def module_name(import_root, path):
    # A basename alone collides across subpackages -- pkg/a/module.py and
    # pkg/b/module.py are different modules with potentially different public
    # symbols, and reporting both under the bare key 'module' would silently
    # merge (or clobber) one's symbols with the other's. This keeps enough of
    # the path relative to the walked root to tell them apart, the same way
    # Python's own import system would: pkg/a/module.py -> 'pkg.a.module'.
    rel = os.path.relpath(path, import_root).replace(os.sep, '/')
    parts = [p for p in rel.split('/') if p not in ('', '.')]
    if not parts:
        parts = [rel]
    last = parts[-1]
    if last in ('__init__.py', '__init__.pyi'):
        parts = parts[:-1]
    else:
        parts[-1] = last.rsplit('.', 1)[0]
    return '.'.join(parts) if parts else '__main__'

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

distribution = sys.argv[2] if len(sys.argv) > 2 else ''
extraction_root = sys.argv[1]

# Prefer a stub over the implementation: a .pyi is the author's own statement
# of the public interface, which beats inferring one. A Python sdist also
# contains documentation, examples, build scripts and metadata beside the
# package. Those are not consumer import identity, even when they happen to
# define a public-looking function.
excluded_dirs = {
    'test', 'tests', '.git', '__pycache__', 'docs', 'doc', 'examples',
    'example', 'bench', 'benchmarks', 'demos', 'demo', 'scripts',
}
excluded_files = {'setup.py', 'conftest.py', 'tox.ini', 'noxfile.py', 'build.py'}

def normalized_distribution(name):
    return name.lower().replace('-', '_').replace('.', '_')

def declared_project_name(path):
    pyproject = os.path.join(path, 'pyproject.toml')
    if os.path.isfile(pyproject):
        try:
            text = open(pyproject, encoding='utf-8', errors='replace').read()
            project = re.search(r'(?ms)^\\s*\\[project\\]\\s*(.*?)(?=^\\s*\\[|\\Z)', text)
            name = re.search(r'(?m)^\\s*name\\s*=\\s*[\\x22\\x27]([^\\x22\\x27]+)', project.group(1)) if project else None
            if name: return name.group(1)
        except OSError:
            pass
    setup_cfg = os.path.join(path, 'setup.cfg')
    if os.path.isfile(setup_cfg):
        try:
            text = open(setup_cfg, encoding='utf-8', errors='replace').read()
            metadata = re.search(r'(?ms)^\\s*\\[metadata\\]\\s*(.*?)(?=^\\s*\\[|\\Z)', text)
            name = re.search(r'(?m)^\\s*name\\s*=\\s*([^\\n#]+)', metadata.group(1)) if metadata else None
            if name: return name.group(1).strip()
        except OSError:
            pass
    setup_py = os.path.join(path, 'setup.py')
    if os.path.isfile(setup_py):
        try:
            text = open(setup_py, encoding='utf-8', errors='replace').read()
            name = re.search(r"(?m)\\b(?:setuptools\\.)?setup\\s*\\([^)]*\\bname\\s*=\\s*[\\\"']([^\\\"']+)", text, re.S)
            if name: return name.group(1)
        except OSError:
            pass
    return None

# Locate the project through packaging metadata. A sole directory without an
# __init__.py may be a PEP 420 namespace package such as google/, so directory
# cardinality is not evidence that the directory is an archive wrapper.
def project_root(root):
    candidates = []
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in excluded_dirs]
        if any(marker in files for marker in ('pyproject.toml', 'setup.cfg', 'setup.py')):
            candidates.append(base)
        if any(d.endswith(('.dist-info', '.egg-info')) for d in dirs):
            candidates.append(base)
    candidates = sorted(set(candidates), key=lambda path: (path.count(os.sep), path))
    wanted = normalized_distribution(distribution)
    named = [path for path in candidates if normalized_distribution(declared_project_name(path) or '') == wanted]
    if len(named) == 1: return named[0]
    if len(candidates) == 1: return candidates[0]
    return root

root = project_root(extraction_root)

def metadata_top_levels(root):
    names = set()
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in excluded_dirs]
        if os.path.basename(base).endswith(('.dist-info', '.egg-info')) and 'top_level.txt' in files:
            try:
                with open(os.path.join(base, 'top_level.txt'), encoding='utf-8', errors='replace') as handle:
                    names.update(line.strip() for line in handle if re.match(r'^[A-Za-z_]\\w*$', line.strip()))
            except OSError:
                pass
    return names

def declared_modules(root):
    names = set()
    setup_cfg = os.path.join(root, 'setup.cfg')
    if os.path.isfile(setup_cfg):
        try:
            text = open(setup_cfg, encoding='utf-8', errors='replace').read()
            match = re.search(r'(?ims)^\\s*py_modules\\s*=\\s*([^\\n]+(?:\\n[ \\t]+[^\\n]+)*)', text)
            if match:
                names.update(re.findall(r'[A-Za-z_]\\w*', match.group(1)))
        except OSError:
            pass
    pyproject = os.path.join(root, 'pyproject.toml')
    if os.path.isfile(pyproject):
        try:
            text = open(pyproject, encoding='utf-8', errors='replace').read()
            match = re.search(r'(?ms)^\\s*py-modules\\s*=\\s*\\[([^]]*)\\]', text)
            if match:
                names.update(re.findall(r'[A-Za-z_]\\w*', match.group(1)))
        except OSError:
            pass
    return names

def has_package_marker(path):
    return os.path.isfile(os.path.join(path, '__init__.py')) or os.path.isfile(os.path.join(path, '__init__.pyi'))

def package_roots(root):
    metadata = metadata_top_levels(root)
    normalized = normalized_distribution(distribution)
    hinted = metadata | ({normalized} if re.match(r'^[A-Za-z_]\\w*$', normalized) else set())
    bases = []
    src = os.path.join(root, 'src')
    if os.path.isdir(src):
        bases.append(src)
    bases.append(root)

    roots = []
    seen = set()
    for base in bases:
        try:
            entries = os.listdir(base)
        except OSError:
            continue
        package_names = set()
        module_names = set(metadata) | declared_modules(root)
        for name in entries:
            path = os.path.join(base, name)
            if os.path.isdir(path):
                if (name in excluded_dirs and name not in metadata) or not re.match(r'^[A-Za-z_]\\w*$', name):
                    continue
                if base == root and name == 'src':
                    continue
                implicit_namespace = (not metadata and any(
                    f.endswith(('.py', '.pyi')) for _, _, fs in os.walk(path) for f in fs
                ))
                if has_package_marker(path) or name in hinted or implicit_namespace:
                    package_names.add(name)
            elif name.endswith(('.py', '.pyi')):
                stem = name.rsplit('.', 1)[0]
                if stem in hinted:
                    module_names.add(stem)
        if package_names or module_names:
            key = os.path.realpath(base)
            if key not in seen:
                roots.append((base, package_names, module_names))
                seen.add(key)

    # The selected GitHub fallback may itself be exactly the package directory.
    if has_package_marker(root):
        roots = [(os.path.dirname(root), {os.path.basename(root)}, set())]
    return roots

package_root_info = package_roots(root)
sources = {}
for import_root, package_names, module_names in package_root_info:
    for base, dirs, files in os.walk(import_root):
        rel = os.path.relpath(base, import_root).replace(os.sep, '/')
        top = '' if rel == '.' else rel.split('/')[0]
        if top and top not in package_names:
            dirs[:] = []
            continue
        dirs[:] = [d for d in dirs if d not in excluded_dirs and (not top or top in package_names)]
        for name in files:
            if not (name.endswith('.py') or name.endswith('.pyi')): continue
            if name in excluded_files: continue
            stem = name.rsplit('.', 1)[0]
            if not top and stem not in module_names: continue
            path = os.path.join(base, name)
            key = path[:-1] if name.endswith('.pyi') else path
            if key in sources and name.endswith('.py'): continue
            sources[key] = (path, import_root)

# Public-surface extraction is two passes, not one. A package commonly moves
# an implementation into a private module and keeps exporting it from the
# original public one (\`from ._impl import Foo\` + \`__all__ = ["Foo"]\`). A
# single-file pass loses \`Foo\` from the new surface and reports a false
# removal. So every module is indexed first (locals, \`__all__\`, and import
# bindings), then re-exports are resolved against that whole-package index --
# \`from ._impl import Foo\` cannot be followed until \`_impl\` has also been read.
# Nothing is imported or executed; this stays an AST-only read.

def is_package_init(path):
    return os.path.basename(path) in ('__init__.py', '__init__.pyi')

def resolve_relative(module, is_pkg, level, target):
    # Python's own rule: inside a non-package module 'pkg.sub.mod' a single
    # leading dot means 'pkg.sub'; inside a package '__init__' it means the
    # package itself. Each further dot strips one more trailing component.
    if level == 0:
        return target or None
    parts = module.split('.') if module else []
    base = parts[:] if is_pkg else parts[:-1]
    strip = level - 1
    if strip > len(base):
        return None
    if strip:
        base = base[:len(base) - strip]
    if target:
        base = base + target.split('.')
    return '.'.join(base) if base else None

def local_symbol(node):
    if isinstance(node, ast.ClassDef):
        return {'decl': node.name, 'kind': 'class', 'signature': signature(node), 'members': sorted(members(node))}
    return {'decl': node.name, 'kind': 'function', 'signature': signature(node), 'members': []}

# ---- Stage 1: index every module's declarations and import bindings ----
index = {}
for path, import_root in sorted(sources.values()):
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as handle:
            tree = ast.parse(handle.read(), path)
    except Exception:
        continue

    module = module_name(import_root, path)
    is_pkg = is_package_init(path)
    entry = index.get(module)
    if entry is None:
        entry = {'all': None, 'has_all': False, 'locals': {}, 'imports': {}, 'stars': []}
        index[module] = entry

    declared = declared_all(tree)
    if declared is not None:
        entry['all'] = declared
        entry['has_all'] = True

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            entry['locals'].setdefault(node.name, local_symbol(node))
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            entry['locals'].setdefault(node.targets[0].id, {'decl': node.targets[0].id, 'kind': 'variable', 'signature': None, 'members': []})
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            entry['locals'].setdefault(node.target.id, {'decl': node.target.id, 'kind': 'variable', 'signature': None, 'members': []})
        elif isinstance(node, ast.ImportFrom):
            target_mod = resolve_relative(module, is_pkg, node.level, node.module)
            for alias in node.names:
                if alias.name == '*':
                    if target_mod:
                        entry['stars'].append(target_mod)
                    continue
                entry['imports'][alias.asname or alias.name] = (target_mod, alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                # 'import a.b as c' binds 'c' to the module a.b; a plain
                # 'import a.b' binds the top-level name 'a'. Only the aliased
                # form can be a name a later '__all__' re-exports, and only as
                # a module -- no symbol shape -- recorded here as (module, None).
                if alias.asname:
                    entry['imports'][alias.asname] = (alias.name, None)

# ---- Stage 2: resolve public re-exports against the whole-package index ----
# Follow an import binding to the declaration it ultimately names, across
# re-export chains, with cycle detection. The outcome is not a single None:
# the four cases below mean genuinely different things for the public surface.
#   ('resolved', <local-symbol dict>) -- a concrete declaration was reached.
#   ('external', None) -- the chain leaves the parsed package (an unparsed or
#       third-party module, or a bound module object with no symbol shape).
#       Existence is only known when the public module imported the name
#       explicitly; shape is not.
#   ('missing', None) -- the chain stayed inside parsed modules and the symbol
#       does not exist in any of them. The re-export is broken; the public
#       name must be omitted so a prior real export can become 'export-removed'.
#   ('cycle', None) -- cycle detection stopped the walk before any concrete
#       declaration. A cycle proves nothing exists; treated like 'missing'.
def resolve(module, name, seen):
    if not module:
        return ('external', None)
    if (module, name) in seen:
        return ('cycle', None)
    seen = seen | {(module, name)}
    entry = index.get(module)
    if entry is None:
        # A target module absent from the index is only 'external' when its
        # top-level name is genuinely foreign. A name this distribution owns
        # (see owned_tops) that is missing from the parsed sources is a module
        # the new archive dropped -- 'missing', so a broken internal re-export
        # yields export-removed rather than being masked as shapeUnknown.
        return ('missing', None) if module.split('.')[0] in owned_tops else ('external', None)
    local = entry['locals'].get(name)
    if local is not None:
        return ('resolved', local)
    if name in entry['imports']:
        tmod, tname = entry['imports'][name]
        if tname is None:
            return ('external', None)
        return resolve(tmod, tname, seen)
    outcome = ('missing', None)
    for star_mod in entry['stars']:
        status, shape = resolve(star_mod, name, seen)
        if status == 'resolved':
            return (status, shape)
        if status == 'external':
            outcome = ('external', None)
        elif status == 'cycle' and outcome[0] == 'missing':
            outcome = ('cycle', None)
    return outcome

# The top-level import names this distribution owns: every package/module root
# package_roots() discovered, plus the first component of every parsed module.
# resolve() uses this to tell a dropped internal module ('missing') from a
# third-party dependency ('external') when a re-export target is not in the
# index -- derived from the sources already parsed, not a second package guess.
owned_tops = set()
for _ir, _package_names, _module_names in package_root_info:
    owned_tops |= set(_package_names) | set(_module_names)
for _module in index:
    if _module and _module not in ('__init__', '__main__'):
        owned_tops.add(_module.split('.')[0])

symbols = {}
for module, entry in index.items():
    prefix = '' if module in ('', '__init__', '__main__') else module + '.'
    exported = entry['all'] if entry['has_all'] else None
    names = list(exported) if exported is not None else [n for n in entry['locals'] if public(n)]

    for name in names:
        if not isinstance(name, str):
            continue
        key = prefix + name
        if key in symbols:
            continue

        shape = entry['locals'].get(name)
        if shape is None and exported is not None:
            # A name '__all__' promises that this module does not itself define.
            status = 'missing'
            if name in entry['imports']:
                tmod, tname = entry['imports'][name]
                status, shape = resolve(tmod, tname, set()) if tname is not None else ('external', None)
            if status not in ('resolved', 'external'):
                for star_mod in entry['stars']:
                    star_status, star_shape = resolve(star_mod, name, set())
                    if star_status == 'resolved':
                        status, shape = star_status, star_shape
                        break
                    if star_status == 'external':
                        status = 'external'
            if status == 'external' and name in entry['imports']:
                # Proven public -- explicitly imported and in '__all__' -- but
                # the target declaration is outside the parsed package. Existence
                # is known, shape is not: never a removal.
                symbols[key] = {'name': key, 'kind': 'unknown', 'signature': key, 'members': [], 'shapeUnknown': True}
                continue
            elif status != 'resolved':
                # 'missing': the referenced module was parsed but has no such
                # symbol -- the public re-export is broken, so omit it and let a
                # prior real export correctly become 'export-removed'.
                # 'cycle': a circular chain that never reached a declaration
                # proves nothing exists.
                # 'external' via a star import only (no explicit binding), or a
                # bare name with no binding at all: not enough evidence the
                # public name exists, so say nothing about it.
                continue

        if shape is None:
            continue

        sig = shape['signature']
        if sig is None:
            sig = name
        elif shape.get('decl') and shape['decl'] != name:
            sig = re.sub(r'\\b' + re.escape(shape['decl']) + r'\\b', name, sig, count=1)
        symbols[key] = {'name': key, 'kind': shape['kind'], 'signature': sig, 'members': list(shape['members'])}

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
