import { createHash } from 'node:crypto';

import { githubRepoSlug } from '../util/github-url.js';
import { fetchJson } from '../util/http.js';

/**
 * One shared reader for a CocoaPods podspec.
 *
 * The podspec is the only place a pod states its source repository, its
 * `module_name`, and its description — and Drift was fetching it in one place
 * (localization, for `module_name`) while a second place (evidence) asked Trunk
 * for versions only and deliberately returned `githubRepo: null`. So pods whose
 * podspec plainly declares a GitHub `source` (FlexLayout, PinLayout, SwiftLint)
 * lost all release/changelog research.
 *
 * This module fetches the immutable per-version podspec JSON once, keyed by
 * `(name, version)`, and both callers read the typed subset they need from it.
 */

export interface CocoaPodsSpec {
  name: string;
  version: string;
  /** `module_name`, when the podspec overrides the default (the pod name). */
  moduleName: string | null;
  /** The `source` hash, verbatim for the fields Drift reads. */
  source: { git?: string; tag?: string; http?: string; svn?: string } | null;
  homepage: string | null;
  summary: string | null;
  description: string | null;
}

interface RawPodspec {
  name?: string;
  version?: string;
  module_name?: string;
  source?: Record<string, unknown>;
  homepage?: string;
  summary?: string;
  description?: string;
}

const cache = new Map<string, Promise<CocoaPodsSpec | null>>();

/** The CDN shards specs by the first three hex chars of `md5(name)`. */
function specUrl(name: string, version: string): string {
  const hash = createHash('md5').update(name).digest('hex');
  const shard = `${hash[0]}/${hash[1]}/${hash[2]}`;
  const n = encodeURIComponent(name);
  return `https://cdn.cocoapods.org/Specs/${shard}/${n}/${encodeURIComponent(version)}/${n}.podspec.json`;
}

/**
 * The typed subset of a published pod's podspec, or `null` when it cannot be
 * read. Immutable per `(name, version)`, so it is fetched at most once.
 */
export function fetchCocoaPodsSpec(
  name: string,
  version: string,
  options: { timeoutMs?: number } = {},
): Promise<CocoaPodsSpec | null> {
  const key = `${name}@${version}`;
  const existing = cache.get(key);
  if (existing) return existing;

  const pending = load(name, version, options).catch(() => null);
  cache.set(key, pending);
  pending.then((value) => {
    // Only a real answer is worth keeping; a miss should be retryable.
    if (!value) cache.delete(key);
  });
  return pending;
}

/** Test seam. */
export function clearCocoaPodsSpecCache(): void {
  cache.clear();
}

async function load(
  name: string,
  version: string,
  options: { timeoutMs?: number },
): Promise<CocoaPodsSpec | null> {
  const raw = await fetchJson<RawPodspec>(specUrl(name, version), {
    immutable: true,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  if (!raw) return null;

  const source = raw.source && typeof raw.source === 'object' ? sanitizeSource(raw.source) : null;

  return {
    name: raw.name ?? name,
    version: raw.version ?? version,
    moduleName: typeof raw.module_name === 'string' && raw.module_name ? raw.module_name : null,
    source,
    homepage: str(raw.homepage),
    summary: str(raw.summary),
    description: str(raw.description),
  };
}

function sanitizeSource(source: Record<string, unknown>): CocoaPodsSpec['source'] {
  const pick = (key: string): string | undefined => {
    const value = source[key];
    return typeof value === 'string' && value ? value : undefined;
  };
  return { git: pick('git'), tag: pick('tag'), http: pick('http'), svn: pick('svn') };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The `owner/repo` a podspec points at, or `null` — never a guess.
 *
 * Priority: an explicit `source.git`, then `homepage` but only when it is
 * itself a GitHub URL. A non-GitHub source (a private git host, a plain
 * `http` archive) resolves to nothing, and the pod stays on prose evidence
 * Drift can actually reach.
 */
export function githubRepoFromSpec(spec: CocoaPodsSpec): string | null {
  return githubRepoSlug(spec.source?.git) ?? githubRepoSlug(spec.homepage);
}
