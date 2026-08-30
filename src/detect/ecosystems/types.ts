import type { DependencyKind, Ecosystem } from '../../types.js';

export type CargoDependencySection = 'dependencies' | 'dev-dependencies' | 'build-dependencies';

export interface CargoDependencyPlacement {
  section: CargoDependencySection;
  target?: string;
}

/** A dependency resolved from somewhere other than its registry. */
export interface DependencyResolution {
  kind: 'local-replace';
  /** The path or module the `replace` directive redirects to. */
  target: string;
}

export interface ParsedDependency {
  /** Version or range exactly as written in the manifest. */
  version: string | null;
  kind: DependencyKind;
  /** Cargo.toml dependency table this entry was declared in. */
  cargo?: CargoDependencyPlacement;
  /**
   * Artifact platform when the ecosystem separates it from the version
   * (a RubyGems `Gem::Platform`). Platform selects an artifact; it never
   * participates in version ordering.
   */
  platform?: string;
  /**
   * Where this dependency actually comes from, when it is not the registry.
   *
   * Kubernetes' staging modules require `k8s.io/api v0.0.0` and then redirect
   * it to `../api` with a `replace` directive: the version is a placeholder
   * for a module that lives in the workspace, not an outdated release. Sending
   * it through ordinary latest-version selection proposed upgrading a
   * directory to v0.37.0.
   */
  resolution?: DependencyResolution;
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
