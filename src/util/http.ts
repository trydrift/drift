/**
 * HTTP helper for registry and changelog fetches.
 *
 * Evidence gathering is best-effort by design: a registry being slow or a
 * changelog 404ing must degrade Drift's confidence, never fail the run. Every
 * function here returns `null` on failure instead of throwing, and the caller
 * records the absence as reduced evidence weight.
 */

export interface FetchOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Retries on 5xx / network errors. 429 is always retried with backoff. */
  retries?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = 'drift-bot/0.1 (+https://github.com/drift-sh/drift)';

/** Process-lifetime response cache. Runs are short; a Map is the right size. */
const cache = new Map<string, unknown>();

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

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, ...headers },
        redirect: 'follow',
      });

      if (response.ok) {
        const body = await response.text();
        cache.set(cacheKey, body);
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
  return null;
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
