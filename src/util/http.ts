/**
 * HTTP helper for registry and changelog fetches.
 *
 * Evidence gathering is best-effort by design: a registry being slow or a
 * changelog 404ing must degrade Drift's confidence, never fail the run. Every
 * function here returns `null` on failure instead of throwing, and the caller
 * records the absence as reduced evidence weight.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { count, profiling, span } from './profile.js';
import { noteCache, recordHttpRequest } from './diagnostics.js';

export interface FetchOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Retries on 5xx / network errors. 429 is always retried with backoff. */
  retries?: number;
  /** How long a disk-backed response stays fresh. Defaults to 24 hours. */
  cacheTtlMs?: number;
  /** A content-addressed fact that should not change once published. */
  immutable?: boolean;
  /**
   * Called before each retry, so a caller waiting on this fetch can say why
   * it is taking a while instead of showing a single frozen label.
   *
   * Not part of the cache key: two coalesced callers asking for the same
   * URL share one in-flight request, so only the first caller's callback
   * fires — the same way only its `headers` and `timeoutMs` apply.
   */
  onRetry?: (attempt: number, reason: 'rate-limited' | 'server-error' | 'network-error') => void;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DISK_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long a failed fetch (`null`) stays cached. Short and distinct from the
 * success TTL: a rate limit or network blip must not read as "confirmed
 * absent" for the rest of the process's life, the way an indefinite cache
 * entry would make it.
 */
const FAILURE_CACHE_TTL_MS = 60_000;
/**
 * How long a *definitive* absence stays on disk.
 *
 * Not the same thing as a failure, and the distinction is the whole point. A
 * 404 from `raw.githubusercontent.com` is the server successfully answering a
 * question — this repository has no `CHANGES.rst` — and that answer is as
 * cacheable as any other. A 403, a timeout or a 502 is the server declining to
 * answer, and remembering one of those as "absent" is precisely how a
 * throttled network turns into a report full of "no changelog found".
 *
 * It matters because absence is most of what a scan learns. There is no API
 * that says whether a third-party repository has a changelog without
 * credentials for it, so Drift guesses filenames — and on a warm scan of
 * Scrapy's dependencies, *every single one* of the 1,397 requests that still
 * went to the network was a 404 being re-asked, 148 seconds of cumulative wait
 * spent re-learning that files do not exist.
 *
 * Shorter than the 24-hour success TTL, deliberately. The two are not
 * symmetric: a stale success cites a slightly old changelog, while a stale
 * absence reports that a document does not exist when it was added this
 * morning — and that silently downgrades the evidence behind a finding. Six
 * hours collapses the repeat scans of a working day without letting "absent"
 * outlive the day it was true.
 */
const ABSENCE_DISK_TTL_MS = 6 * 60 * 60 * 1000;
const USER_AGENT = 'drift-bot/0.1 (+https://github.com/trydrift/drift)';

interface CacheEntry {
  value: unknown;
  /** `Infinity` for a successful response, which is good for the process's life. */
  expiresAt: number;
}

/** Process-lifetime response cache. Runs are short; a Map is the right size. */
const cache = new Map<string, CacheEntry>();

/**
 * Requests that have gone out and not yet come back.
 *
 * The response cache is only written once a response *lands*, so two callers
 * asking for the same URL a millisecond apart both saw a miss and both went to
 * the network. That is the normal case here, not a corner one: a scan checks
 * eight packages at a time, and packages share registries, repositories and —
 * through `type-surface`'s dependency following — whole declaration trees, so
 * the same handful of URLs is requested from several workers at once. Sharing
 * the in-flight promise makes the second asker wait for the first's answer
 * instead of duplicating the round trip.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Run `work` under `key`, or join the call already running under it.
 *
 * The entry is removed as soon as the work settles, so this only ever collapses
 * genuinely concurrent calls — everything afterwards is the response cache's
 * business, including whether a failure should be remembered at all.
 */
function coalesce<T>(key: string, work: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running;

  const started = work().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}
let diskCacheDir: string | null = null;

function cacheGet<T>(key: string): { hit: true; value: T } | { hit: false } {
  const entry = cache.get(key);
  if (!entry) return { hit: false };
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return { hit: false };
  }
  return { hit: true, value: entry.value as T };
}

function cacheSet(key: string, value: unknown): void {
  // `null` is always a failure/absence result in this module; every successful
  // parse or fetch caches a non-null value.
  const expiresAt = value === null ? Date.now() + FAILURE_CACHE_TTL_MS : Infinity;
  cache.set(key, { value, expiresAt });
}

/**
 * Fold the headers that change *what comes back* into the cache key.
 *
 * Two of them do. Credentials decide whether a response is the resource or a
 * rate-limited 403, and an unauthenticated failure must never be served back to
 * a call that supplies a token, or vice versa. `Accept` decides which
 * *representation* the server sends: `registry.npmjs.org/<name>` answers the
 * same URL with a full packument or npm's abbreviated install document
 * depending on what was asked for, and the abbreviated one is missing most of
 * the fields the evidence layer reads. Sharing one cache entry between those
 * two callers hands whichever asked second a document of the wrong shape.
 */
function variantFingerprint(headers?: Record<string, string>): string {
  if (!headers) return 'default';
  const relevant = Object.entries(headers)
    .filter(([key]) => /auth|token/i.test(key) || key.toLowerCase() === 'accept')
    .sort(([a], [b]) => a.localeCompare(b));
  if (relevant.length === 0) return 'default';
  const raw = relevant.map(([key, value]) => `${key.toLowerCase()}=${value}`).join('&');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * The host a URL is on, for grouping spans.
 *
 * Deliberately not the full URL: a profile of a large scan holds tens of
 * thousands of requests and the useful question is "how much of this run was
 * spent waiting on the GitHub API", not which of four hundred packages was
 * asked about.
 */
function hostOf(url: string): string {
  const start = url.indexOf('://');
  if (start < 0) return 'unknown';
  const rest = url.slice(start + 3);
  const end = rest.search(/[/?#]/);
  return (end < 0 ? rest : rest.slice(0, end)).toLowerCase();
}

/** Path only, no query string — query params can carry tokens/signatures. */
function pathOf(url: string): string {
  const start = url.indexOf('://');
  if (start < 0) return url.split('?')[0]!;
  const rest = url.slice(start + 3);
  const slash = rest.indexOf('/');
  const pathAndQuery = slash < 0 ? '' : rest.slice(slash);
  return pathAndQuery.split('?')[0]!;
}

/** Record one request for the always-on diagnostic run log; a no-op with no active run. */
function recordDiag(args: {
  url: string;
  method: string;
  startMs: number;
  status: number | null;
  cache: 'hit' | 'miss' | 'n/a';
  bytes?: number;
  retries?: number;
  failure?: string;
}): void {
  recordHttpRequest({
    host: hostOf(args.url),
    method: args.method,
    path: pathOf(args.url),
    durationMs: Date.now() - args.startMs,
    status: args.status,
    cache: args.cache,
    bytes: args.bytes,
    retries: args.retries,
    failure: args.failure,
  });
}

interface DiskEntry {
  /** The in-memory cache key — the URL plus whichever headers change the response. */
  key: string;
  body: string | null;
  etag?: string;
  fetchedAt: number;
  immutable?: boolean;
  /**
   * The server said this resource is not there, and meant it.
   *
   * Distinct from a `null` body with no flag, which is what an older cache
   * layout wrote for anything that failed. Requiring the flag means entries
   * written before this existed are re-fetched rather than read as confirmed
   * absences they were never checked to be.
   */
  absent?: boolean;
}

export function configureHttpDiskCache(path: string | null): void {
  diskCacheDir = path;
}

/**
 * Where disk-cached responses live, for the one caller that caches something
 * other than a response: the Arduino index, which is reduced from 57 MB to a
 * few hundred kilobytes before it is worth keeping.
 */
export function httpCacheDir(): string | null {
  return diskCacheDir;
}

export function clearHttpCache(): void {
  cache.clear();
  // Anything already in flight would otherwise be joined by the next caller
  // and answer from before the cache was cleared, which is precisely what a
  // caller clearing it has asked not to happen.
  inFlight.clear();
}

export function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T | null> {
  const cacheKey = `json:${variantFingerprint(options.headers)}:${url}`;
  const cached = cacheGet<T | null>(cacheKey);
  if (cached.hit) {
    count('http.cache.memory');
    return Promise.resolve(cached.value);
  }
  if (profiling() && inFlight.has(cacheKey)) count('http.cache.coalesced');
  return coalesce(cacheKey, () => fetchAndParseJson<T>(url, cacheKey, options));
}

async function fetchAndParseJson<T>(
  url: string,
  cacheKey: string,
  options: FetchOptions,
): Promise<T | null> {
  const text = await fetchText(url, {
    ...options,
    headers: { Accept: 'application/json', ...options.headers },
  });
  if (text === null) {
    cacheSet(cacheKey, null);
    return null;
  }

  try {
    const parsed = JSON.parse(text) as T;
    cacheSet(cacheKey, parsed);
    return parsed;
  } catch {
    cacheSet(cacheKey, null);
    return null;
  }
}

export function fetchText(url: string, options: FetchOptions = {}): Promise<string | null> {
  const cacheKey = `text:${variantFingerprint(options.headers)}:${url}`;
  const cached = cacheGet<string | null>(cacheKey);
  if (cached.hit) {
    count('http.cache.memory');
    return Promise.resolve(cached.value);
  }
  if (profiling() && inFlight.has(cacheKey)) count('http.cache.coalesced');
  return coalesce(cacheKey, () => fetchTextUncoalesced(url, cacheKey, options));
}

async function fetchTextUncoalesced(
  url: string,
  cacheKey: string,
  options: FetchOptions,
): Promise<string | null> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, retries = 2 } = options;
  const host = hostOf(url);
  const diskRead = span('disk-cache', profiling() ? host : '');
  const disk = await readDiskEntry(cacheKey);
  diskRead.end({ hit: disk !== null });
  noteCache('http', disk !== null);
  const ttl = options.cacheTtlMs ?? DEFAULT_DISK_TTL_MS;
  const now = Date.now();
  if (disk && disk.body !== null && (disk.immutable || options.immutable || now - disk.fetchedAt < ttl)) {
    count('http.cache.disk');
    cacheSet(cacheKey, disk.body);
    return disk.body;
  }
  // A remembered 404. Only ever written for a definitive absence — see
  // `ABSENCE_DISK_TTL_MS` — so this can never serve a rate limit or a timeout
  // back as though the resource had been confirmed missing. An immutable URL's
  // absence is immutable too: a published version does not grow a file it did
  // not ship with.
  if (
    disk &&
    disk.body === null &&
    disk.absent === true &&
    (disk.immutable || options.immutable || now - disk.fetchedAt < ABSENCE_DISK_TTL_MS)
  ) {
    count('http.cache.disk.absent');
    cacheSet(cacheKey, null);
    return null;
  }
  const conditionalHeaders: Record<string, string> = disk?.etag ? { 'If-None-Match': disk.etag } : {};

  count('http.network');
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const request = span('http', profiling() ? host : '', attempt > 0 ? { attempt } : undefined);
    const attemptStartMs = Date.now();
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, ...conditionalHeaders, ...headers },
        redirect: 'follow',
      });

      if (response.status === 304 && disk) {
        request.end({ status: 304 });
        recordDiag({ url, method: 'GET', startMs: attemptStartMs, status: 304, cache: 'miss', retries: attempt });
        count('http.notModified');
        await writeDiskEntry(cacheKey, { ...disk, fetchedAt: now, immutable: disk.immutable || options.immutable });
        cacheSet(cacheKey, disk.body);
        return disk.body;
      }

      if (response.ok) {
        const body = await response.text();
        // Closed here rather than when the headers landed: for a packument or a
        // declaration tarball the body is most of the wait, and a span that
        // stopped at the status line would attribute that time to nothing.
        request.end({ status: response.status, bytes: body.length });
        recordDiag({
          url,
          method: 'GET',
          startMs: attemptStartMs,
          status: response.status,
          cache: 'miss',
          bytes: body.length,
          retries: attempt,
        });
        cacheSet(cacheKey, body);
        await writeDiskEntry(cacheKey, {
          key: cacheKey,
          body,
          etag: response.headers.get('etag') ?? undefined,
          fetchedAt: now,
          immutable: options.immutable,
        });
        return body;
      }

      request.end({ status: response.status });
      recordDiag({ url, method: 'GET', startMs: attemptStartMs, status: response.status, cache: 'miss', retries: attempt });
      // 404 is a legitimate answer ("no changelog here"), not a failure to retry
      // — and, being an answer rather than a refusal, one worth writing down.
      if (response.status === 404) {
        cacheSet(cacheKey, null);
        await writeDiskEntry(cacheKey, {
          key: cacheKey,
          body: null,
          absent: true,
          fetchedAt: now,
          immutable: options.immutable,
        });
        return null;
      }
      // 403 is usually a refusal, never remembered — but GitHub's own API
      // documentation says both primary and secondary rate limits can
      // surface as 403 as well as 429, signalled by `x-ratelimit-remaining:
      // 0` or a `retry-after` header. Treating every 403 as non-retryable
      // meant the single most common GitHub rate-limit shape got neither a
      // retry nor the "rate limited, retrying" status this PR otherwise
      // added — a 403 without either signal (bad credentials, a private
      // repository) is still a hard refusal and stays non-retryable.
      if (response.status === 403) {
        const rateLimited =
          response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after');
        if (!rateLimited || attempt === retries) break;
        options.onRetry?.(attempt + 1, 'rate-limited');
        await sleep(backoffMs(attempt, response.headers.get('retry-after')));
        continue;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === retries) break;

      options.onRetry?.(attempt + 1, response.status === 429 ? 'rate-limited' : 'server-error');
      await sleep(backoffMs(attempt, response.headers.get('retry-after')));
    } catch (err) {
      request.end({ status: 0 });
      recordDiag({
        url,
        method: 'GET',
        startMs: attemptStartMs,
        status: null,
        cache: 'miss',
        retries: attempt,
        failure: err instanceof Error ? err.name : 'network-error',
      });
      count('http.error');
      if (attempt === retries) break;
      options.onRetry?.(attempt + 1, 'network-error');
      await sleep(backoffMs(attempt, null));
    } finally {
      clearTimeout(timer);
    }
  }

  cacheSet(cacheKey, null);
  if (disk?.body !== undefined) {
    cacheSet(cacheKey, disk.body);
    return disk.body;
  }
  return null;
}

/**
 * Download a binary artifact, once per machine.
 *
 * The surface providers that diff a compiled or packaged API — Python sdists,
 * Maven sources jars, NuGet packages, Hex tarballs — each download an archive
 * and unpack it, and every one of them called `fetch` directly. That put them
 * outside the disk cache entirely: a warm scan of Scrapy's dependencies
 * re-downloaded ninety-four archives it had downloaded an hour before, because
 * the only cache in the process stores text.
 *
 * These are the most cacheable things Drift fetches. A published version's
 * artifact is immutable by every registry's own rules — PyPI and Maven Central
 * refuse re-uploads outright — so there is no TTL to reason about and no
 * revalidation to do. The bytes are written under a content-addressed name and
 * reused until the cache directory is removed.
 *
 * Returns `null` on any failure, like everything else here: an archive that
 * cannot be fetched is a gap in evidence, never an error.
 */
export type ArchiveResult =
  /** The bytes, whether they came from the network or from the cache. */
  | { ok: true; bytes: Buffer }
  /**
   * No bytes. `status` is the HTTP status where there was one and `0` where the
   * request never completed, so a caller can keep saying "Maven Central has no
   * jar for this version" and "Maven Central returned 503" as different things.
   */
  | { ok: false; status: number; error?: string };

export function fetchArchive(
  url: string,
  options: { timeoutMs?: number; retries?: number; maxBytes?: number } = {},
): Promise<ArchiveResult> {
  const cacheKey = `archive:${url}`;
  return coalesce(cacheKey, () => fetchArchiveUncoalesced(url, cacheKey, options));
}

async function fetchArchiveUncoalesced(
  url: string,
  cacheKey: string,
  options: { timeoutMs?: number; retries?: number; maxBytes?: number },
): Promise<ArchiveResult> {
  const host = hostOf(url);
  const path = archivePath(cacheKey);
  const { retries = 2, maxBytes } = options;

  if (path) {
    try {
      const cached = await readFile(path);
      // `maxBytes` bounds this read too: a caller's size ceiling exists to
      // protect what happens *after* this returns (decompression, an
      // in-memory unpack) as much as the download itself, and a disk cache
      // hit from an earlier, looser-limited call must not silently bypass
      // whatever limit the *current* caller actually asked for.
      if (maxBytes === undefined || cached.length <= maxBytes) {
        count('http.cache.archive');
        noteCache('http', true);
        return { ok: true, bytes: cached };
      }
    } catch {
      // Not cached yet, or unreadable. Either way, fetch it.
    }
  }
  noteCache('http', false);

  // `timeoutMs` is the whole wall-clock budget for this call, never a
  // per-attempt allowance re-granted at every retry — a caller passing a 1s
  // timeout with `retries: 2` must not be able to take up to 3s (three
  // independent 1s attempts, each timing out on its own) before this
  // returns. One absolute deadline is computed once; every attempt's fetch
  // timeout and the backoff sleep between attempts both draw down whatever
  // is left of it, and no new attempt starts once nothing meaningful remains.
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => deadline - Date.now();

  count('http.archive');
  for (let attempt = 0; attempt <= retries; attempt++) {
    const budget = remaining();
    if (budget <= 0) {
      return { ok: false, status: 0, error: 'Timed out before this attempt could start.' };
    }

    const request = span('archive', profiling() ? host : '', attempt > 0 ? { attempt } : undefined);
    const attemptStartMs = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        request.end({ status: response.status });
        recordDiag({ url, method: 'GET', startMs: attemptStartMs, status: response.status, cache: 'miss', retries: attempt });
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === retries) return { ok: false, status: response.status };
        const wait = Math.min(backoffMs(attempt, response.headers.get('retry-after')), remaining());
        if (wait <= 0) return { ok: false, status: response.status };
        await sleep(wait);
        continue;
      }
      // Checked against the header before buffering the whole body, and never
      // retried: a server that says up front it is sending more than the
      // caller is willing to hold is not a transient failure to retry past.
      const declaredLength = Number(response.headers.get('content-length'));
      if (maxBytes !== undefined && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        request.end({ status: response.status, bytes: declaredLength, oversized: true });
        return { ok: false, status: response.status, error: `Response of ${declaredLength} bytes exceeds the ${maxBytes}-byte limit for this archive.` };
      }

      // A server can omit or understate Content-Length, so the actual byte
      // count is enforced independently of it — streamed, so an oversized
      // body is abandoned the moment it crosses the limit rather than fully
      // buffered into memory first and only checked afterward.
      const bytes = await readBounded(response, maxBytes, controller);
      if (bytes === 'oversized') {
        request.end({ status: response.status, oversized: true });
        return { ok: false, status: response.status, error: `Response exceeds the ${maxBytes}-byte limit for this archive.` };
      }

      request.end({ status: response.status, bytes: bytes.length });
      recordDiag({
        url,
        method: 'GET',
        startMs: attemptStartMs,
        status: response.status,
        cache: 'miss',
        bytes: bytes.length,
        retries: attempt,
      });
      if (path) {
        try {
          await mkdir(diskCacheDir!, { recursive: true });
          // Written under a temporary name and moved into place, so a scan killed
          // mid-download cannot leave a truncated archive that every later run
          // reads as the real thing.
          const staging = `${path}.${process.pid}.partial`;
          await writeFile(staging, bytes);
          await rename(staging, path);
        } catch {
          // Best-effort, exactly like the text cache.
        }
      }
      return { ok: true, bytes };
    } catch (err) {
      request.end({ status: 0 });
      recordDiag({
        url,
        method: 'GET',
        startMs: attemptStartMs,
        status: null,
        cache: 'miss',
        retries: attempt,
        failure: err instanceof Error ? err.name : 'network-error',
      });
      if (attempt === retries) return { ok: false, status: 0, error: (err as Error).message };
      const wait = Math.min(backoffMs(attempt, null), remaining());
      if (wait <= 0) return { ok: false, status: 0, error: (err as Error).message };
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
  // Unreachable: every loop iteration returns on its final attempt.
  return { ok: false, status: 0 };
}

/**
 * Buffer a response body, aborting the moment it crosses `maxBytes` rather
 * than after the whole thing has already been pulled into memory.
 *
 * `Content-Length` is checked before this runs, but a server can omit or
 * understate it, and `response.arrayBuffer()` has no way to be capped
 * mid-stream — it buffers everything unconditionally and only then hands
 * back a size to check, by which point the memory (and the time spent
 * receiving it) is already spent. Reading the body's own stream in chunks
 * means an unbounded or merely-lying response is abandoned as soon as it is
 * caught, not after.
 */
async function readBounded(
  response: Response,
  maxBytes: number | undefined,
  controller: AbortController,
): Promise<Buffer | 'oversized'> {
  if (maxBytes === undefined || !response.body) {
    return Buffer.from(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      return 'oversized';
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function archivePath(key: string): string | null {
  if (!diskCacheDir) return null;
  return join(diskCacheDir, `${createHash('sha256').update(key).digest('hex')}.bin`);
}

async function readDiskEntry(key: string): Promise<DiskEntry | null> {
  if (!diskCacheDir) return null;
  try {
    const raw = await readFile(cachePath(key), 'utf8');
    const parsed = JSON.parse(raw) as DiskEntry;
    // A hash collision, or an entry written by an older layout that keyed on
    // the URL alone. Either way it is not this response; treat it as a miss
    // rather than answering with someone else's body.
    return parsed.key === key ? parsed : null;
  } catch {
    return null;
  }
}

async function writeDiskEntry(key: string, entry: DiskEntry): Promise<void> {
  if (!diskCacheDir) return;
  try {
    await mkdir(diskCacheDir, { recursive: true });
    await writeFile(cachePath(key), JSON.stringify(entry), 'utf8');
  } catch {
    // Evidence is best-effort; a cache write must never fail a scan.
  }
}

function cachePath(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex');
  return join(diskCacheDir!, `${hash}.json`);
}

/** Exponential backoff, honouring `Retry-After` when the server supplies it. */
function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000);
  }
  const base = 400 * 2 ** attempt;
  return base + Math.random() * 200;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run tasks with bounded concurrency.
 *
 * Evidence gathering fans out across many dependencies; unbounded parallelism
 * gets us rate-limited by npm and GitHub, which costs us evidence.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
}
