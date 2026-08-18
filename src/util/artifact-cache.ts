/**
 * Remembering something expensive that was computed about an immutable input.
 *
 * The HTTP cache remembers *responses*. This remembers *conclusions* — and for
 * the surface providers that is where the money is. Reading Scrapy's
 * dependencies means downloading ninety-four source archives, unpacking them,
 * and parsing every Python file in each with `ast`. Caching the download saved
 * the network half; the parse is the other half, and it produces the same
 * answer every time because its input is a published version, which no registry
 * permits anyone to change after the fact.
 *
 * # What a key has to cover
 *
 * Everything that could change the answer. For a computed surface that is the
 * package and version — immutable — *and the analyzer*, which is not. A cache
 * keyed on the artifact alone would keep serving last week's answer after a
 * bundled script was fixed or a local toolchain upgraded, which is a silent
 * accuracy regression rather than a stale timestamp.
 *
 * So callers pass an analyzer fingerprint and it goes in the key. Where the
 * analyzer is Drift's own script, hashing the script itself makes the key
 * exact: a fixed parser invalidates every entry it could have got wrong, with
 * no TTL to reason about and no window in which the old answer is still served.
 *
 * Nothing is cached when no cache directory is configured, which is the default
 * outside the CLI and the capture harness.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { count } from './profile.js';
import { httpCacheDir } from './http.js';

interface Envelope<T> {
  /** Bumped when the stored shape changes, so old entries are ignored, not misread. */
  format: 1;
  /** The full key, re-checked on read: a hash collision must not answer for someone else. */
  key: string;
  value: T;
}

function pathFor(key: string): string | null {
  const dir = httpCacheDir();
  if (!dir) return null;
  return join(dir, `artifact-${createHash('sha256').update(key).digest('hex')}.json`);
}

/**
 * The remembered conclusion for `key`, or `null`.
 *
 * `null` on anything unexpected — a missing file, a truncated write, an entry
 * from an older format, a key that does not match. Every one of those means
 * "compute it again", which is always safe and never wrong.
 */
export async function readComputed<T>(key: string): Promise<T | null> {
  const path = pathFor(key);
  if (!path) return null;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Envelope<T>;
    if (parsed.format !== 1 || parsed.key !== key) return null;
    count('artifact.cache.hit');
    return parsed.value;
  } catch {
    count('artifact.cache.miss');
    return null;
  }
}

/**
 * Remember `value` under `key`.
 *
 * Best-effort in every direction: a cache that cannot be written must never
 * fail the scan that was trying to fill it. Written to a temporary name and
 * renamed into place, so a process killed mid-write leaves nothing that a later
 * run would read as a complete answer.
 */
export async function writeComputed<T>(key: string, value: T): Promise<void> {
  const path = pathFor(key);
  if (!path) return;
  try {
    await mkdir(httpCacheDir()!, { recursive: true });
    const staging = `${path}.${process.pid}.partial`;
    await writeFile(staging, JSON.stringify({ format: 1, key, value } satisfies Envelope<T>), 'utf8');
    await rename(staging, path);
  } catch {
    // See above.
  }
}
