import type { DependencyKind } from '../../types.js';
import { basename, tryJson, type DependencyMap, type ManifestParser } from './types.js';

/**
 * PHP — `composer.json` and `composer.lock`.
 *
 * The one wrinkle worth naming: Composer's `require` block mixes real packages
 * with platform constraints. `php`, `ext-mbstring`, `lib-openssl`, and
 * `composer-runtime-api` are requirements on the *environment*, not packages
 * anyone can upgrade, and reporting `php: ^8.1 → ^8.2` as a dependency change
 * would send the fix stage looking for a package that does not exist.
 */
export const composerParser: ManifestParser = {
  ecosystem: 'packagist',
  name: 'Composer',

  handles(path) {
    const base = basename(path);
    return base === 'composer.json' || base === 'composer.lock';
  },

  isLockfile(path) {
    return basename(path) === 'composer.lock';
  },

  parse(content, path) {
    return basename(path) === 'composer.lock' ? parseLock(content) : parseManifest(content);
  },
};

/**
 * Platform requirements, which are constraints on the runtime rather than
 * packages. `ext-*` and `lib-*` are open-ended families, so they are matched by
 * prefix rather than enumerated.
 */
function isPlatformRequirement(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === 'php' ||
    lower === 'hhvm' ||
    lower === 'composer' ||
    lower.startsWith('php-') ||
    lower.startsWith('ext-') ||
    lower.startsWith('lib-') ||
    lower.startsWith('composer-')
  );
}

function parseManifest(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const doc = tryJson<{
    require?: Record<string, string>;
    'require-dev'?: Record<string, string>;
  }>(content);
  if (!doc) return out;

  const sections: [Record<string, string> | undefined, DependencyKind][] = [
    [doc.require, 'runtime'],
    [doc['require-dev'], 'dev'],
  ];

  for (const [section, kind] of sections) {
    if (!section || typeof section !== 'object') continue;

    for (const [name, constraint] of Object.entries(section)) {
      if (isPlatformRequirement(name)) continue;
      out.set(name, { version: typeof constraint === 'string' ? constraint : null, kind });
    }
  }

  return out;
}

interface LockPackage {
  name?: string;
  version?: string;
}

function parseLock(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const doc = tryJson<{ packages?: LockPackage[]; 'packages-dev'?: LockPackage[] }>(content);
  if (!doc) return out;

  // `packages-dev` is a genuine dev classification the lockfile records, so it
  // is honoured rather than flattened into `transitive` with everything else.
  const sections: [LockPackage[] | undefined, DependencyKind][] = [
    [doc.packages, 'transitive'],
    [doc['packages-dev'], 'dev'],
  ];

  for (const [section, kind] of sections) {
    if (!Array.isArray(section)) continue;

    for (const entry of section) {
      if (!entry?.name || isPlatformRequirement(entry.name)) continue;
      // Composer writes dev-branch versions as `dev-main`, which pins a moving
      // target rather than a version. `normalizeVersion` would reject it
      // anyway; dropping it here keeps the raw range honest too.
      out.set(entry.name, { version: entry.version ?? null, kind });
    }
  }

  return out;
}
