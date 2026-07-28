import type { DependencyKind, Ecosystem } from '../../types.js';

export interface ParsedDependency {
  /** Version or range exactly as written in the manifest. */
  version: string | null;
  kind: DependencyKind;
}

/** Package name -> parsed entry. */
export type DependencyMap = Map<string, ParsedDependency>;

/**
 * A manifest parser for one ecosystem.
 *
 * Parsers are total functions over file content: they never throw on malformed
 * input, they return what they could understand. A syntax error in a lockfile
 * mid-rebase must not fail the whole Drift run.
 */
export interface ManifestParser {
  ecosystem: Ecosystem;
  /** Human name for logs. */
  name: string;
  /** Does this parser handle the given repo-relative path? */
  handles(path: string): boolean;
  /** True when the path is a lockfile, so entries default to `transitive`. */
  isLockfile(path: string): boolean;
  parse(content: string, path: string): DependencyMap;
}

/** Last path segment, lowercased. */
export function basename(path: string): string {
  const parts = path.split('/');
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

/** JSON.parse that yields `null` instead of throwing. */
export function tryJson<T = unknown>(content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}
