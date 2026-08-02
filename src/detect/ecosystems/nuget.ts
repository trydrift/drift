import type { DependencyKind } from '../../types.js';
import { basename, tryJson, type DependencyMap, type ManifestParser } from './types.js';

/**
 * .NET — SDK-style project files, central package management, and lockfiles.
 *
 * Four shapes, because .NET has accumulated four and real solutions mix them:
 *
 *   - `*.csproj` / `*.fsproj` / `*.vbproj` — `<PackageReference Include="…" Version="…" />`
 *   - `Directory.Packages.props` — central package management, where the
 *     project files carry names and this file carries every version
 *   - `packages.lock.json` — resolved versions, when locking is switched on
 *   - `packages.config` — the pre-SDK format, still alive in older solutions
 *
 * Central package management is the one that matters most for correctness: in
 * a repository using it, the `.csproj` files have *no* versions at all, so a
 * parser that read only project files would see every dependency as unpinned
 * and report no upgrades ever.
 */
export const nugetParser: ManifestParser = {
  ecosystem: 'nuget',
  name: 'NuGet',

  handles(path) {
    const base = basename(path);
    return (
      /\.(cs|fs|vb)proj$/.test(base) ||
      base === 'directory.packages.props' ||
      base === 'directory.build.props' ||
      base === 'packages.lock.json' ||
      base === 'packages.config' ||
      base.endsWith('.nuspec')
    );
  },

  isLockfile(path) {
    return basename(path) === 'packages.lock.json';
  },

  parse(content, path) {
    const base = basename(path);
    if (base === 'packages.lock.json') return parseLock(content);
    if (base === 'packages.config') return parsePackagesConfig(content);
    if (base.endsWith('.nuspec')) return parseNuspec(content);
    return parseMsBuild(content);
  },
};

/**
 * MSBuild XML: `PackageReference`, `PackageVersion`, and `GlobalPackageReference`.
 *
 * All three carry `Include` and `Version` the same way, in either attribute or
 * child-element form, so one scan covers project files and the central
 * `Directory.Packages.props` alike.
 */
function parseMsBuild(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const tag = /<(PackageReference|PackageVersion|GlobalPackageReference)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;

  for (const match of content.matchAll(tag)) {
    const attrs = match[2] ?? '';
    const body = match[4] ?? '';

    const name = attribute(attrs, 'Include') ?? attribute(attrs, 'Update');
    if (!name) continue;

    // MSBuild properties (`Version="$(FooVersion)"`) are resolved at build
    // time. Recording the literal `$(…)` would compare two identical strings
    // forever and report no change; `null` says "unknown", which is true.
    const raw =
      attribute(attrs, 'Version') ??
      attribute(attrs, 'VersionOverride') ??
      element(body, 'Version');
    const version = raw && !raw.includes('$(') ? raw : null;

    // `PrivateAssets="all"` is how .NET spells "build-time only" — analyzers,
    // source generators, and test SDKs.
    const privateAssets = attribute(attrs, 'PrivateAssets') ?? element(body, 'PrivateAssets');
    const kind: DependencyKind = privateAssets?.toLowerCase() === 'all' ? 'dev' : 'runtime';

    out.set(name, { version, kind });
  }

  return out;
}

interface LockEntry {
  type?: string;
  resolved?: string;
  requested?: string;
}

/** `packages.lock.json` — `dependencies` keyed by target framework. */
function parseLock(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const doc = tryJson<{ dependencies?: Record<string, Record<string, LockEntry>> }>(content);
  if (!doc?.dependencies) return out;

  for (const framework of Object.values(doc.dependencies)) {
    if (!framework || typeof framework !== 'object') continue;

    for (const [name, entry] of Object.entries(framework)) {
      const version = entry?.resolved ?? null;
      if (!version) continue;

      // `Direct` is a dependency the project asked for; `Transitive` and
      // `Project` are not. A later framework must not downgrade a package
      // already seen as direct, so direct always wins.
      const kind: DependencyKind = entry.type === 'Direct' ? 'runtime' : 'transitive';
      const existing = out.get(name);
      if (existing?.kind === 'runtime' && kind === 'transitive') continue;

      out.set(name, { version, kind });
    }
  }

  return out;
}

/** The pre-SDK `packages.config`: `<package id="…" version="…" />`. */
function parsePackagesConfig(content: string): DependencyMap {
  const out: DependencyMap = new Map();

  for (const match of content.matchAll(/<package\b([^>]*?)\/?>/g)) {
    const attrs = match[1] ?? '';
    const name = attribute(attrs, 'id');
    if (!name) continue;

    const developmentDependency = attribute(attrs, 'developmentDependency');
    out.set(name, {
      version: attribute(attrs, 'version'),
      kind: developmentDependency?.toLowerCase() === 'true' ? 'dev' : 'runtime',
    });
  }

  return out;
}

/** `.nuspec` — `<dependency id="…" version="…" />`. */
function parseNuspec(content: string): DependencyMap {
  const out: DependencyMap = new Map();

  for (const match of content.matchAll(/<dependency\b([^>]*?)\/?>/g)) {
    const attrs = match[1] ?? '';
    const name = attribute(attrs, 'id');
    if (name) out.set(name, { version: attribute(attrs, 'version'), kind: 'runtime' });
  }

  return out;
}

/** An XML attribute value, case-insensitively, in single or double quotes. */
function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  const value = match?.[2] ?? match?.[3];
  return value?.trim() || null;
}

/** A child element's text, for the `<PackageReference><Version>…` form. */
function element(body: string, name: string): string | null {
  const match = new RegExp(`<${name}\\s*>([^<]*)</${name}\\s*>`, 'i').exec(body);
  return match?.[1]?.trim() || null;
}
