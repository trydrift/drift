import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchArchive, httpCacheDir } from '../../util/http.js';

/**
 * Provisioning a Drift-owned executable helper (a fat JAR, a downloadable
 * binary) without a system package manager.
 *
 * `brew install japicmp` was neither portable nor reproducible: it is absent on
 * CI, installs whatever version the tap currently points at, and silently costs
 * the Java recording its classfile comparison when it is missing. Instead Drift
 * pins one exact version, downloads the published artifact by URL, verifies its
 * SHA-256 before anything executes it, and keeps it in a Drift-owned cache.
 *
 * Nothing here runs the artifact — that is the caller's job — and nothing here
 * installs a language runtime. A JDK, a Python, a Cargo is a fact about the
 * machine; only the helper analyzer on top of it is Drift's to manage.
 */

/** Why a helper artifact could not be made ready. Kept apart so callers can report each precisely. */
export type HelperArtifactError =
  /** The artifact could not be downloaded (network, 404, non-200). */
  | { kind: 'download-failed'; detail: string }
  /** The bytes downloaded did not match the pinned SHA-256 — refused before use. */
  | { kind: 'checksum-failed'; detail: string };

export type HelperArtifactResult =
  | { ok: true; path: string }
  | { ok: false; error: HelperArtifactError };

export interface HelperArtifactSpec {
  /** Stable helper id, e.g. `japicmp`. */
  id: string;
  /** Exact pinned version — part of the cache filename. */
  version: string;
  /** Absolute URL of the executable artifact. */
  url: string;
  /** Lowercase hex SHA-256 the downloaded bytes must equal before the artifact is used. */
  sha256: string;
  /** Cached-file extension, default `jar`. */
  extension?: string;
}

/**
 * One acquisition per `(id, version, checksum)`, shared by every concurrent
 * caller in this process. Two Maven dependencies in the same scan both find the
 * helper missing at the same moment; without this each downloads its own copy
 * and races the other's atomic rename.
 */
const inFlight = new Map<string, Promise<HelperArtifactResult>>();

/** Test seam: force a helper id to resolve to a local path, skipping download. */
const overrides = new Map<string, string>();
export function setHelperArtifactOverride(id: string, path: string): void {
  overrides.set(id, path);
}
export function clearHelperArtifactOverrides(): void {
  overrides.clear();
}

function helperCacheDir(): string {
  // Prefer the configured Drift disk cache; fall back to a stable temp path so
  // a one-off CLI run with no cache configured still single-downloads.
  const base = httpCacheDir() ?? join(tmpdir(), 'drift-cache');
  return join(base, 'helpers');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Return a filesystem path to the verified helper artifact, downloading and
 * checksum-checking it into the Drift cache on first use.
 */
export function ensureHelperArtifact(spec: HelperArtifactSpec): Promise<HelperArtifactResult> {
  const override = overrides.get(spec.id);
  if (override) return Promise.resolve({ ok: true, path: override });

  const key = `${spec.id}@${spec.version}#${spec.sha256}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const attempt = acquire(spec).finally(() => inFlight.delete(key));
  inFlight.set(key, attempt);
  return attempt;
}

async function acquire(spec: HelperArtifactSpec): Promise<HelperArtifactResult> {
  const dir = helperCacheDir();
  const dest = join(dir, `${spec.id}-${spec.version}.${spec.extension ?? 'jar'}`);

  // A previously cached artifact is reused only if it still matches the pin —
  // a partial write or a changed pin re-downloads rather than trusting it.
  try {
    const bytes = await readFile(dest);
    if (sha256(bytes) === spec.sha256) return { ok: true, path: dest };
  } catch {
    /* not cached yet */
  }

  let downloaded: Awaited<ReturnType<typeof fetchArchive>>;
  try {
    downloaded = await fetchArchive(spec.url, { timeoutMs: 120_000 });
  } catch (err) {
    return { ok: false, error: { kind: 'download-failed', detail: `${spec.url}: ${(err as Error).message}` } };
  }
  if (!downloaded.ok) {
    const why = downloaded.status ? `HTTP ${downloaded.status}` : (downloaded.error ?? 'the request failed');
    return { ok: false, error: { kind: 'download-failed', detail: `${spec.url}: ${why}` } };
  }

  const actual = sha256(downloaded.bytes);
  if (actual !== spec.sha256) {
    return {
      ok: false,
      error: {
        kind: 'checksum-failed',
        detail: `${spec.url}: expected SHA-256 ${spec.sha256}, got ${actual}`,
      },
    };
  }

  // Atomic publish: write a unique temp file, then rename it into place. A
  // concurrent process doing the same lands identical verified bytes, so
  // last-writer-wins is safe.
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${spec.id}-${spec.version}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, downloaded.bytes);
  await rename(tmp, dest);
  return { ok: true, path: dest };
}
