import { parse as parseYaml } from 'yaml';
import type { DependencyKind } from '../../types.js';
import { basename, tryJson, type DependencyMap, type ManifestParser } from './types.js';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface PackageLock {
  /** lockfile v1 */
  dependencies?: Record<string, { version?: string; dev?: boolean }>;
  /** lockfile v2/v3 — keys are install paths like `node_modules/foo`. */
  packages?: Record<string, { version?: string; dev?: boolean; optional?: boolean }>;
}

const MANIFESTS = new Set(['package.json']);
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);

export const npmParser: ManifestParser = {
  ecosystem: 'npm',
  name: 'npm/yarn/pnpm',

  handles(path) {
    const base = basename(path);
    if (path.includes('node_modules/')) return false;
    return MANIFESTS.has(base) || LOCKFILES.has(base);
  },

  isLockfile(path) {
    return LOCKFILES.has(basename(path));
  },

  parse(content, path) {
    const base = basename(path);
    if (base === 'package.json') return parsePackageJson(content);
    if (base === 'yarn.lock') return parseYarnLock(content);
    if (base === 'pnpm-lock.yaml') return parsePnpmLock(content);
    return parsePackageLock(content);
  },
};

function parsePackageJson(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const pkg = tryJson<PackageJson>(content);
  if (!pkg) return out;

  const sections: [Record<string, string> | undefined, DependencyKind][] = [
    [pkg.dependencies, 'runtime'],
    [pkg.devDependencies, 'dev'],
    [pkg.peerDependencies, 'peer'],
    [pkg.optionalDependencies, 'optional'],
  ];

  for (const [section, kind] of sections) {
    if (!section) continue;
    for (const [name, version] of Object.entries(section)) {
      // A direct declaration always wins over a weaker one (peer/optional),
      // so we only fill a slot that is still empty.
      if (!out.has(name)) out.set(name, { version, kind });
    }
  }
  return out;
}

function parsePackageLock(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const lock = tryJson<PackageLock>(content);
  if (!lock) return out;

  if (lock.packages) {
    for (const [installPath, entry] of Object.entries(lock.packages)) {
      // The empty key is the root project itself, not a dependency.
      if (!installPath) continue;
      const name = installPathToName(installPath);
      if (!name || !entry?.version) continue;
      out.set(name, { version: entry.version, kind: entry.dev ? 'dev' : 'transitive' });
    }
    return out;
  }

  if (lock.dependencies) {
    for (const [name, entry] of Object.entries(lock.dependencies)) {
      if (!entry?.version) continue;
      out.set(name, { version: entry.version, kind: entry.dev ? 'dev' : 'transitive' });
    }
  }
  return out;
}

/** `node_modules/a/node_modules/@scope/b` -> `@scope/b` (the deepest package). */
function installPathToName(installPath: string): string | null {
  const marker = 'node_modules/';
  const last = installPath.lastIndexOf(marker);
  if (last === -1) return null;
  const name = installPath.slice(last + marker.length);
  return name || null;
}

/**
 * yarn.lock is a bespoke format, but the only two lines we need are the entry
 * header (which carries the name) and its `version` field.
 */
function parseYarnLock(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  let pending: string | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.startsWith('#')) continue;

    if (!/^\s/.test(line)) {
      // Entry header, e.g. `"@scope/pkg@^1.0.0", "@scope/pkg@^1.2.0":`
      const spec = line.replace(/:\s*$/, '').split(',')[0]!.trim().replace(/^"|"$/g, '');
      pending = specToName(spec);
      continue;
    }

    const version = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line)?.[1];
    if (version && pending) {
      out.set(pending, { version, kind: 'transitive' });
      pending = null;
    }
  }
  return out;
}

/** pnpm lockfiles key packages as `/name@version` or `name@version`. */
function parsePnpmLock(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch {
    return out;
  }
  const packages = (doc as { packages?: Record<string, unknown> } | null)?.packages;
  if (!packages || typeof packages !== 'object') return out;

  for (const key of Object.keys(packages)) {
    const spec = key.startsWith('/') ? key.slice(1) : key;
    const name = specToName(spec);
    const version = specToVersion(spec);
    if (name && version) out.set(name, { version, kind: 'transitive' });
  }
  return out;
}

/** Split `@scope/pkg@1.2.3` into its name, respecting the leading scope `@`. */
function specToName(spec: string): string | null {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return spec || null;
  return spec.slice(0, at) || null;
}

function specToVersion(spec: string): string | null {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return null;
  // pnpm appends peer-dep hashes: `1.2.3(react@18.0.0)`.
  return spec.slice(at + 1).split('(')[0] || null;
}
