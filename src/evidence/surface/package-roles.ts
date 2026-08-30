import type { SurfaceChange } from '../type-surface.js';

/**
 * What kind of package this is, decided *before* deciding what public surface
 * it ought to have.
 *
 * `Microsoft.NET.Test.Sdk` ships no managed assembly and never has: it is
 * MSBuild tooling. `cupertino_icons` ships no meaningful Dart API: it is a font
 * bundle. Reporting either as a missing library artifact says Drift looked for
 * the wrong thing, not that the package is uninspectable — and a first-time
 * user who checks will find the package exactly as its author intended it.
 *
 * The classification is deliberately ecosystem-specific; only the vocabulary
 * and the "removed contract file" diff are shared, because that much genuinely
 * is the same question in each.
 */

export type PackageRole =
  /** The ecosystem's normal code artifact: assemblies, Dart libraries. */
  | 'library'
  /** Roslyn analyzers and source generators. */
  | 'analyzer'
  /** MSBuild props/targets, or anything else consumed by the build. */
  | 'build-tooling'
  /** Executables shipped for a developer to run. */
  | 'tool'
  /** Fonts, icons, images, data — a bundle of files, not an API. */
  | 'assets'
  /** Dependencies and nothing else. */
  | 'meta-package';

/** A human phrase for one role, used verbatim in evidence gaps. */
export function describeRole(role: PackageRole): string {
  switch (role) {
    case 'library':
      return 'a code library';
    case 'analyzer':
      return 'an analyzer package';
    case 'build-tooling':
      return 'a build-tooling package';
    case 'tool':
      return 'a tool package';
    case 'assets':
      return 'an asset package';
    case 'meta-package':
      return 'a meta-package';
  }
}

/**
 * Files a non-library package's consumers depend on by path.
 *
 * A build-tooling package's contract *is* its `build/<id>.targets`; an asset
 * package's is the files it ships under its declared asset roots. Losing one is
 * a real break, and it is the one thing Drift can prove about these roles
 * without interpreting their contents.
 */
export function diffContractFiles(
  before: Iterable<string>,
  after: Iterable<string>,
  describe: (path: string) => string,
): SurfaceChange[] {
  const remaining = new Set(after);
  const changes: SurfaceChange[] = [];
  for (const path of new Set(before)) {
    if (remaining.has(path)) continue;
    changes.push({
      kind: 'package-removed',
      symbol: path,
      detail: describe(path),
      before: path,
      after: '(removed)',
    });
  }
  return changes;
}

/* ---------------- NuGet ---------------- */

/**
 * Every role a `.nupkg`'s layout puts it in. A package can hold several — a
 * library that also ships analyzers is both.
 */
export function classifyNuGetRoles(paths: Iterable<string>): Set<PackageRole> {
  const roles = new Set<PackageRole>();
  for (const raw of paths) {
    const path = raw.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    if (path.startsWith('lib/') || path.startsWith('ref/')) roles.add('library');
    else if (path.startsWith('analyzers/')) roles.add('analyzer');
    else if (path.startsWith('build/') || path.startsWith('buildtransitive/')) roles.add('build-tooling');
    else if (path.startsWith('tools/')) roles.add('tool');
    else if (path.startsWith('contentfiles/') || path.startsWith('content/')) roles.add('assets');
  }
  // Nothing but the nuspec and packaging bookkeeping: the package *is* its
  // dependency list.
  if (roles.size === 0) roles.add('meta-package');
  return roles;
}

/** The paths a non-library NuGet package's consumers reference directly. */
export function nugetContractFiles(paths: Iterable<string>): string[] {
  return [...paths]
    .map((path) => path.replace(/\\/g, '/').replace(/^\/+/, ''))
    .filter((path) =>
      /^(build|buildTransitive|tools|analyzers|contentFiles|content)\//i.test(path),
    )
    .sort();
}

/* ---------------- pub.dev ---------------- */

export interface PubContract {
  role: PackageRole;
  /** Font families the pubspec declares, with the asset paths behind them. */
  fonts: Map<string, string[]>;
  /** Asset paths the pubspec declares. */
  assets: string[];
  /** Executables the pubspec declares. */
  executables: string[];
}

/**
 * Classify a pub package from its archive and its pubspec.
 *
 * A package with a real Dart API is a library whatever else it ships; the other
 * roles only apply when there is no API to compare.
 */
export function classifyPubPackage(
  paths: Iterable<string>,
  pubspec: string | null,
  hasDartApi: boolean,
): PubContract {
  const files = [...paths].map((path) => path.replace(/^\.\//, ''));
  const declared = parsePubspecContract(pubspec ?? '');

  const role: PackageRole = hasDartApi
    ? 'library'
    : declared.fonts.size > 0 || declared.assets.length > 0
      ? 'assets'
      : declared.executables.length > 0 || files.some((path) => /^bin\/.+\.dart$/.test(path))
        ? 'tool'
        : files.some((path) => /^lib\/.+\.dart$/.test(path))
          ? 'library'
          : 'meta-package';

  return { role, ...declared };
}

/**
 * The consumer-facing parts of a pubspec, read line by line.
 *
 * A YAML parser would be a heavier commitment than the three keys read here,
 * and pubspecs write them in a narrow, conventional shape.
 */
export function parsePubspecContract(pubspec: string): Omit<PubContract, 'role'> {
  const fonts = new Map<string, string[]>();
  const assets: string[] = [];
  const executables: string[] = [];

  let section: 'fonts' | 'assets' | 'executables' | null = null;
  let family: string | null = null;

  for (const raw of pubspec.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      section = trimmed.startsWith('executables:') ? 'executables' : null;
      family = null;
      continue;
    }
    if (/^fonts:\s*$/.test(trimmed)) {
      // A family's own nested `fonts:` list opens the assets *for that family*
      // and must not be read as a second top-level font section.
      if (section !== 'fonts' || family === null) family = null;
      section = 'fonts';
      continue;
    }
    if (/^assets:\s*$/.test(trimmed)) {
      section = 'assets';
      continue;
    }
    if (/^[\w-]+:\s*$/.test(trimmed) && section !== 'fonts' && section !== 'executables') {
      section = null;
      continue;
    }

    if (section === 'fonts') {
      const named = /^-\s*family:\s*(.+)$/.exec(trimmed);
      if (named) {
        family = named[1]!.trim().replace(/^["']|["']$/g, '');
        fonts.set(family, fonts.get(family) ?? []);
        continue;
      }
      const asset = /^-?\s*asset:\s*(.+)$/.exec(trimmed);
      if (asset && family) fonts.get(family)!.push(asset[1]!.trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    if (section === 'assets') {
      const item = /^-\s*(.+)$/.exec(trimmed);
      if (item) assets.push(item[1]!.trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    if (section === 'executables') {
      const item = /^([\w-]+):/.exec(trimmed);
      if (item) executables.push(item[1]!);
    }
  }

  return { fonts, assets, executables };
}

/** What an asset or tool package's consumers can no longer rely on. */
export function diffPubContracts(before: PubContract, after: PubContract): SurfaceChange[] {
  const changes: SurfaceChange[] = [];

  for (const [family, files] of before.fonts) {
    if (after.fonts.has(family)) continue;
    changes.push({
      kind: 'package-removed',
      symbol: family,
      detail: `the ${family} font family is no longer declared, so a widget that names it falls back to the default font`,
      before: files.join(', ') || family,
      after: '(removed)',
    });
  }

  changes.push(
    ...diffContractFiles(
      before.assets,
      after.assets,
      (path) => `the declared asset ${path} is no longer published`,
    ),
  );
  changes.push(
    ...diffContractFiles(
      before.executables,
      after.executables,
      (name) => `the ${name} executable is no longer declared`,
    ),
  );

  return changes;
}
