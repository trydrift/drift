/**
 * HTTP helper for registry and changelog fetches.
 *
 * Evidence gathering is best-effort by design: a registry being slow or a
 * changelog 404ing must degrade Drift's confidence, never fail the run. Every
 * function here returns `null` on failure instead of throwing, and the caller
 * records the absence as reduced evidence weight.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface FetchOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Retries on 5xx / network errors. 429 is always retried with backoff. */
  retries?: number;
  /** How long a disk-backed response stays fresh. Defaults to 24 hours. */
  cacheTtlMs?: number;
  /** A content-addressed fact that should not change once published. */
  immutable?: boolean;
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
 * Fold the caller's auth into the cache key so two callers hitting the same
 * URL with different credentials (or none) never share a cached response —
 * e.g. an unauthenticated rate-limited 403 must not be served back to a call
 * that supplies a token, or vice versa.
 */
function authFingerprint(headers?: Record<string, string>): string {
  if (!headers) return 'noauth';
  const authHeaders = Object.entries(headers)
    .filter(([key]) => /auth|token/i.test(key))
    .sort(([a], [b]) => a.localeCompare(b));
  if (authHeaders.length === 0) return 'noauth';
  const raw = authHeaders.map(([key, value]) => `${key.toLowerCase()}=${value}`).join('&');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

interface DiskEntry {
  url: string;
  body: string | null;
  etag?: string;
  fetchedAt: number;
  immutable?: boolean;
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
  const cacheKey = `json:${authFingerprint(options.headers)}:${url}`;
  const cached = cacheGet<T | null>(cacheKey);
  if (cached.hit) return Promise.resolve(cached.value);
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
  const cacheKey = `text:${authFingerprint(options.headers)}:${url}`;
  const cached = cacheGet<string | null>(cacheKey);
  if (cached.hit) return Promise.resolve(cached.value);
  return coalesce(cacheKey, () => fetchTextUncoalesced(url, cacheKey, options));
}

async function fetchTextUncoalesced(
  url: string,
  cacheKey: string,
  options: FetchOptions,
): Promise<string | null> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, retries = 2 } = options;
  const disk = await readDiskEntry(url);
  const ttl = options.cacheTtlMs ?? DEFAULT_DISK_TTL_MS;
  const now = Date.now();
  if (disk && disk.body !== null && (disk.immutable || options.immutable || now - disk.fetchedAt < ttl)) {
    cacheSet(cacheKey, disk.body);
    return disk.body;
  }
  const conditionalHeaders: Record<string, string> = disk?.etag ? { 'If-None-Match': disk.etag } : {};

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, ...conditionalHeaders, ...headers },
        redirect: 'follow',
      });

      if (response.status === 304 && disk) {
        await writeDiskEntry(url, { ...disk, fetchedAt: now, immutable: disk.immutable || options.immutable });
        cacheSet(cacheKey, disk.body);
        return disk.body;
      }

      if (response.ok) {
        const body = await response.text();
        cacheSet(cacheKey, body);
        await writeDiskEntry(url, {
          url,
          body,
          etag: response.headers.get('etag') ?? undefined,
          fetchedAt: now,
          immutable: options.immutable,
        });
        return body;
      }

      // 404 is a legitimate answer ("no changelog here"), not a failure to retry.
      if (response.status === 404 || response.status === 403) break;

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === retries) break;

      await sleep(backoffMs(attempt, response.headers.get('retry-after')));
    } catch {
      if (attempt === retries) break;
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

async function readDiskEntry(url: string): Promise<DiskEntry | null> {
  if (!diskCacheDir) return null;
  try {
    const raw = await readFile(cachePath(url), 'utf8');
    const parsed = JSON.parse(raw) as DiskEntry;
    return parsed.url === url ? parsed : null;
  } catch {
    return null;
  }
}

async function writeDiskEntry(url: string, entry: DiskEntry): Promise<void> {
  if (!diskCacheDir) return;
  try {
    await mkdir(diskCacheDir, { recursive: true });
    await writeFile(cachePath(url), JSON.stringify(entry), 'utf8');
  } catch {
    // Evidence is best-effort; a cache write must never fail a scan.
  }
}

function cachePath(url: string): string {
  const hash = createHash('sha256').update(url).digest('hex');
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
