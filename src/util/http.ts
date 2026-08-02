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
const USER_AGENT = 'drift-bot/0.1 (+https://github.com/drift-sh/drift)';

/** Process-lifetime response cache. Runs are short; a Map is the right size. */
const cache = new Map<string, unknown>();
let diskCacheDir: string | null = null;

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

export function clearHttpCache(): void {
  cache.clear();
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T | null> {
  const cacheKey = `json:${url}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) as T | null;

  const text = await fetchText(url, {
    ...options,
    headers: { Accept: 'application/json', ...options.headers },
  });
  if (text === null) {
    cache.set(cacheKey, null);
    return null;
  }

  try {
    const parsed = JSON.parse(text) as T;
    cache.set(cacheKey, parsed);
    return parsed;
  } catch {
    cache.set(cacheKey, null);
    return null;
  }
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string | null> {
  const cacheKey = `text:${url}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) as string | null;

  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, retries = 2 } = options;
  const disk = await readDiskEntry(url);
  const ttl = options.cacheTtlMs ?? DEFAULT_DISK_TTL_MS;
  const now = Date.now();
  if (disk && disk.body !== null && (disk.immutable || options.immutable || now - disk.fetchedAt < ttl)) {
    cache.set(cacheKey, disk.body);
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
        cache.set(cacheKey, disk.body);
        return disk.body;
      }

      if (response.ok) {
        const body = await response.text();
        cache.set(cacheKey, body);
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

  cache.set(cacheKey, null);
  if (disk?.body !== undefined) {
    cache.set(cacheKey, disk.body);
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
