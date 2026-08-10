import { basename, tryJson, type DependencyMap, type ManifestParser } from './types.js';

/**
 * vcpkg, in manifest mode.
 *
 * `vcpkg.json` is where a project declares what it needs; it usually declares
 * *no* version at all, because vcpkg's model is a repository-wide baseline —
 * one git commit of the ports tree — that decides every version at once.
 *
 * That model shapes what Drift can honestly report here. Three places carry a
 * version, and they are read in order of how specific they are:
 *
 *   1. `overrides` — an exact pin for one port. The strongest statement.
 *   2. `version>=` on a dependency — a floor, kept verbatim as a range.
 *   3. `builtin-baseline` — a commit sha that pins everything else.
 *
 * A baseline move is a real dependency change and one Drift cannot resolve to
 * versions without cloning the ports tree at both commits, so it is reported as
 * a change to a synthetic `vcpkg-baseline` entry rather than being dropped.
 * Silence would be indistinguishable from "nothing moved", which is the one
 * reading that is definitely wrong when a baseline changes.
 */
export const vcpkgParser: ManifestParser = {
  ecosystem: 'vcpkg',
  name: 'vcpkg',

  handles(path) {
    const base = basename(path);
    return base === 'vcpkg.json' || base === 'vcpkg-configuration.json';
  },

  // vcpkg has no lockfile. The baseline commit is the lock, and it lives in
  // the manifest a human edits.
  isLockfile() {
    return false;
  },

  parse(content) {
    const out: DependencyMap = new Map();
    const doc = tryJson<VcpkgManifest>(content);
    if (!doc) return out;

    for (const entry of doc.dependencies ?? []) {
      if (typeof entry === 'string') {
        out.set(entry, { version: null, kind: 'runtime' });
        continue;
      }
      if (!entry.name) continue;
      // `host: true` is a build-time tool (cmake, pkgconf), not something the
      // shipped binary links against.
      out.set(entry.name, {
        version: entry['version>='] ?? null,
        kind: entry.host ? 'dev' : 'runtime',
      });
    }

    // An override is the last word on a port's version, so it replaces
    // whatever the dependency entry said.
    for (const override of doc.overrides ?? []) {
      if (!override.name) continue;
      const version = override.version ?? override['version-string'] ?? override['version-semver'] ?? null;
      const existing = out.get(override.name);
      out.set(override.name, { version, kind: existing?.kind ?? 'runtime' });
    }

    const baseline = doc['builtin-baseline'] ?? doc.registries?.find((r) => r.baseline)?.baseline;
    if (baseline) out.set(BASELINE, { version: baseline, kind: 'transitive' });

    return out;
  },
};

/**
 * The name a baseline move is reported under.
 *
 * Exported so the surface and evidence stages can recognise it and say what it
 * is, rather than trying to look up a port by this name and finding nothing.
 */
export const BASELINE = 'vcpkg-baseline';

interface VcpkgManifest {
  dependencies?: (string | { name?: string; host?: boolean; 'version>='?: string })[];
  overrides?: {
    name?: string;
    version?: string;
    'version-string'?: string;
    'version-semver'?: string;
  }[];
  'builtin-baseline'?: string;
  registries?: { baseline?: string }[];
}
