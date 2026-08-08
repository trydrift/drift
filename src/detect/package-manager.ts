import { basename } from 'node:path';
import type { DependencyKind, Ecosystem } from '../types.js';

/**
 * Which tool actually owns the dependencies in a directory.
 *
 * Detection is a separate question from parsing. `src/detect/ecosystems/` knows
 * how to read a `package.json`; it does not know whether running `npm install`
 * or `pnpm add` in that directory is the right thing to do — and getting that
 * wrong writes a second lockfile into someone's repository.
 *
 * Everything here is a pure function over a directory listing so it can be
 * tested without a filesystem, and so the extension and the CLI can share it.
 */

export type PackageManagerId =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'yarn-berry'
  | 'bun'
  | 'pip'
  | 'poetry'
  | 'uv'
  | 'go'
  | 'cargo'
  | 'bundler'
  | 'maven'
  | 'gradle'
  | 'sbt'
  | 'dotnet'
  | 'composer'
  | 'mix'
  | 'rebar'
  | 'dart'
  | 'flutter'
  | 'swiftpm'
  | 'cocoapods'
  | 'opam';

/** A command line, kept as argv so nothing is ever passed through a shell. */
export interface Command {
  command: string;
  args: string[];
}

export interface UpgradeTarget {
  name: string;
  version: string;
  kind: DependencyKind;
}

export interface PackageManager {
  id: PackageManagerId;
  ecosystem: Ecosystem;
  /** What a human calls it. */
  label: string;
  /** Manifest that records direct dependencies, relative to the member dir. */
  manifests: readonly string[];
  /**
   * Manifests whose names a project chooses, not the ecosystem.
   *
   * `.csproj` and `.opam` files are named after the project, so they cannot be
   * listed literally. Matched against each directory entry. Kept separate from
   * `manifests` because that list is also what the UI shows a user as "the
   * files that identify this manager", and a regex is not that.
   */
  manifestPattern?: RegExp;
  /** Lockfiles that record resolved versions, most authoritative first. */
  lockfiles: readonly string[];
  /**
   * The tool's own "what is out of date" command.
   *
   * Drift derives outdated-ness from the registry rather than from this, so it
   * is not on the scan path — but it is what the user would run by hand, and
   * showing it is how the UI explains what Drift is about to do.
   */
  outdated: Command | null;
  /**
   * Move one package to one version.
   *
   * `null` where the ecosystem has no command that pins a specific version —
   * Gradle being the honest example. Callers must tell the user to edit the
   * build file rather than pretending an upgrade ran.
   */
  upgrade(target: UpgradeTarget): Command | null;
  /**
   * Rewrite a manifest's text so it declares `target`'s exact version.
   *
   * Present only where `upgrade`'s command resolves against whatever
   * constraint is already on disk rather than accepting a version on the
   * command line — Bundler, Mix, Rebar3, CocoaPods, and pip's
   * `requirements.txt` convention are all in this position, and their
   * `upgrade` command does nothing useful until this has run first. Pure text
   * in, text out, like everything else here: no filesystem access, so a
   * caller reads the manifest, calls this, writes the result back, then runs
   * `upgrade`'s command. Absent where `upgrade` already takes the version
   * directly (npm, cargo add, ...) or where there is no command at all.
   */
  rewriteManifest?: (content: string, target: UpgradeTarget, manifestPath: string) => string;
}

/** A package manager found in a directory, with the files that proved it. */
export interface DetectedPackageManager {
  manager: PackageManager;
  /** File names in the directory that indicated this manager. */
  evidence: string[];
  /** True when a lockfile (not just a manifest) named this manager. */
  fromLockfile: boolean;
}

/** Two managers claiming the same ecosystem in the same directory. */
export interface PackageManagerAmbiguity {
  ecosystem: Ecosystem;
  candidates: DetectedPackageManager[];
}

/** The directory Drift is looking at, as data. */
export interface DirectoryListing {
  /** File and directory names present, without any path prefix. */
  entries: readonly string[];
  /** Optional content reader, used only to tell yarn classic from berry. */
  read?: (name: string) => string | null;
}

const npmFlags = (kind: DependencyKind, dev: string, optional: string): string[] => {
  if (kind === 'dev') return [dev];
  if (kind === 'optional') return [optional];
  return [];
};

const MANAGERS: readonly PackageManager[] = [
  {
    id: 'npm',
    ecosystem: 'npm',
    label: 'npm',
    manifests: ['package.json'],
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
    outdated: { command: 'npm', args: ['outdated', '--json'] },
    upgrade: ({ name, version, kind }) => ({
      command: 'npm',
      args: ['install', `${name}@${version}`, ...npmFlags(kind, '--save-dev', '--save-optional')],
    }),
  },
  {
    id: 'pnpm',
    ecosystem: 'npm',
    label: 'pnpm',
    manifests: ['package.json'],
    lockfiles: ['pnpm-lock.yaml'],
    outdated: { command: 'pnpm', args: ['outdated'] },
    // `pnpm add` rather than `pnpm update`: only `add` writes an exact chosen
    // version back into the manifest section it came from.
    upgrade: ({ name, version, kind }) => ({
      command: 'pnpm',
      args: ['add', `${name}@${version}`, ...npmFlags(kind, '--save-dev', '--save-optional')],
    }),
  },
  {
    id: 'yarn-berry',
    ecosystem: 'npm',
    label: 'Yarn (berry)',
    manifests: ['package.json'],
    lockfiles: ['yarn.lock'],
    outdated: null,
    upgrade: ({ name, version }) => ({ command: 'yarn', args: ['up', `${name}@${version}`] }),
  },
  {
    id: 'yarn',
    ecosystem: 'npm',
    label: 'Yarn (classic)',
    manifests: ['package.json'],
    lockfiles: ['yarn.lock'],
    outdated: { command: 'yarn', args: ['outdated', '--json'] },
    upgrade: ({ name, version }) => ({
      command: 'yarn',
      args: ['upgrade', `${name}@${version}`],
    }),
  },
  {
    id: 'bun',
    ecosystem: 'npm',
    label: 'Bun',
    manifests: ['package.json'],
    lockfiles: ['bun.lock', 'bun.lockb'],
    outdated: { command: 'bun', args: ['outdated'] },
    upgrade: ({ name, version, kind }) => ({
      command: 'bun',
      args: ['add', `${name}@${version}`, ...npmFlags(kind, '--dev', '--optional')],
    }),
  },
  {
    id: 'uv',
    ecosystem: 'pypi',
    label: 'uv',
    manifests: ['pyproject.toml'],
    lockfiles: ['uv.lock'],
    outdated: { command: 'uv', args: ['pip', 'list', '--outdated', '--format', 'json'] },
    upgrade: ({ name, version, kind }) => ({
      command: 'uv',
      args: ['add', `${name}==${version}`, ...(kind === 'dev' ? ['--dev'] : [])],
    }),
  },
  {
    id: 'poetry',
    ecosystem: 'pypi',
    label: 'Poetry',
    manifests: ['pyproject.toml'],
    lockfiles: ['poetry.lock'],
    outdated: { command: 'poetry', args: ['show', '--outdated'] },
    upgrade: ({ name, version, kind }) => ({
      command: 'poetry',
      args: ['add', `${name}==${version}`, ...(kind === 'dev' ? ['--group', 'dev'] : [])],
    }),
  },
  {
    id: 'pip',
    ecosystem: 'pypi',
    label: 'pip',
    manifests: ['requirements.txt', 'pyproject.toml', 'setup.py'],
    lockfiles: [],
    outdated: { command: 'pip', args: ['list', '--outdated', '--format=json'] },
    // pip installs into the environment; it does not rewrite requirements.txt.
    // `rewriteManifest` is how that gap gets closed — a caller applies it to
    // the manifest text before (or after) running this command.
    upgrade: ({ name, version }) => ({
      command: 'pip',
      args: ['install', '--upgrade', `${name}==${version}`],
    }),
    rewriteManifest: (content, { name, version }, manifestPath) =>
      basename(manifestPath).toLowerCase().endsWith('.txt')
        ? rewriteRequirementsTxt(content, name, version)
        : rewritePythonQuotedRequirement(content, name, version),
  },
  {
    id: 'go',
    ecosystem: 'go',
    label: 'Go modules',
    manifests: ['go.mod'],
    lockfiles: ['go.sum'],
    outdated: { command: 'go', args: ['list', '-u', '-m', 'all'] },
    upgrade: ({ name, version }) => ({
      command: 'go',
      args: ['get', `${name}@${version.startsWith('v') ? version : `v${version}`}`],
    }),
  },
  {
    id: 'cargo',
    ecosystem: 'cargo',
    label: 'Cargo',
    manifests: ['Cargo.toml'],
    lockfiles: ['Cargo.lock'],
    outdated: { command: 'cargo', args: ['update', '--dry-run'] },
    // `cargo update --precise` only rewrites Cargo.lock's resolved version; it
    // leaves Cargo.toml's declared requirement untouched, so a target outside
    // that requirement fails (or a looser requirement silently stays looser
    // than what was actually asked for). `cargo add` is the one cargo command
    // that writes the requirement into Cargo.toml itself, the same way `npm
    // install name@version` writes package.json. A bare `name@1.2.3` writes a
    // caret requirement, which lets the resolver pick a newer compatible
    // release later — `=1.2.3` pins the exact version Drift selected.
    upgrade: ({ name, version }) => ({
      command: 'cargo',
      args: ['add', `${name}@=${version}`],
    }),
  },
  {
    id: 'bundler',
    ecosystem: 'rubygems',
    label: 'Bundler',
    manifests: ['Gemfile'],
    lockfiles: ['Gemfile.lock'],
    outdated: { command: 'bundle', args: ['outdated'] },
    // Bundler resolves against the Gemfile's constraint; it has no flag that
    // pins a version without editing the Gemfile first, so `rewriteManifest`
    // does that and this then re-resolves the lockfile against it.
    upgrade: ({ name }) => ({ command: 'bundle', args: ['update', name, '--conservative'] }),
    rewriteManifest: (content, { name, version }) => rewriteGemfile(content, name, version),
  },
  {
    id: 'maven',
    ecosystem: 'maven',
    label: 'Maven',
    manifests: ['pom.xml'],
    lockfiles: [],
    outdated: { command: 'mvn', args: ['versions:display-dependency-updates'] },
    upgrade: ({ name, version }) => ({
      command: 'mvn',
      args: [
        'versions:use-dep-version',
        `-Dincludes=${name}`,
        `-DdepVersion=${version}`,
        '-DforceVersion=true',
      ],
    }),
  },
  {
    id: 'gradle',
    ecosystem: 'maven',
    label: 'Gradle',
    manifests: ['build.gradle', 'build.gradle.kts', 'gradle/libs.versions.toml'],
    lockfiles: ['gradle.lockfile'],
    outdated: { command: 'gradle', args: ['dependencyUpdates'] },
    // Versions live in build scripts Gradle will not rewrite for us. Saying so
    // is better than running something that silently changes nothing.
    upgrade: () => null,
  },
  {
    id: 'sbt',
    ecosystem: 'maven',
    label: 'sbt',
    manifests: ['build.sbt'],
    lockfiles: [],
    outdated: { command: 'sbt', args: ['dependencyUpdates'] },
    // Like Gradle, sbt has no command that pins a dependency version: the
    // coordinate lives in build.sbt as source. Drift edits the build file.
    upgrade: () => null,
  },
  {
    id: 'dotnet',
    ecosystem: 'nuget',
    label: 'NuGet',
    manifests: ['Directory.Packages.props'],
    manifestPattern: /\.(cs|fs|vb)proj$/i,
    lockfiles: ['packages.lock.json'],
    outdated: { command: 'dotnet', args: ['list', 'package', '--outdated'] },
    upgrade: ({ name, version }) => ({
      command: 'dotnet',
      args: ['add', 'package', name, '--version', version],
    }),
  },
  {
    id: 'composer',
    ecosystem: 'packagist',
    label: 'Composer',
    manifests: ['composer.json'],
    lockfiles: ['composer.lock'],
    outdated: { command: 'composer', args: ['outdated', '--format=json'] },
    upgrade: ({ name, version, kind }) => ({
      command: 'composer',
      args: ['require', `${name}:${version}`, ...(kind === 'dev' ? ['--dev'] : [])],
    }),
  },
  {
    id: 'mix',
    ecosystem: 'hex',
    label: 'Mix',
    manifests: ['mix.exs'],
    lockfiles: ['mix.lock'],
    outdated: { command: 'mix', args: ['hex.outdated'] },
    // `mix deps.update` resolves against the constraint in mix.exs rather than
    // taking a version, so `rewriteManifest` edits that constraint first.
    upgrade: ({ name }) => ({ command: 'mix', args: ['deps.update', name] }),
    rewriteManifest: (content, { name, version }) => rewriteMixExs(content, name, version),
  },
  {
    id: 'rebar',
    ecosystem: 'hex',
    label: 'Rebar3',
    manifests: ['rebar.config'],
    lockfiles: ['rebar.lock'],
    outdated: null,
    // Like Mix, `rebar3 upgrade` resolves against rebar.config's own
    // requirement rather than taking one on the command line.
    upgrade: ({ name }) => ({ command: 'rebar3', args: ['upgrade', name] }),
    rewriteManifest: (content, { name, version }) => rewriteRebarConfig(content, name, version),
  },
  {
    id: 'flutter',
    ecosystem: 'pub',
    label: 'Flutter',
    manifests: ['pubspec.yaml'],
    lockfiles: ['pubspec.lock'],
    outdated: { command: 'flutter', args: ['pub', 'outdated'] },
    upgrade: ({ name, version }) => ({
      command: 'flutter',
      args: ['pub', 'add', `${name}:${version}`],
    }),
  },
  {
    id: 'dart',
    ecosystem: 'pub',
    label: 'Dart pub',
    manifests: ['pubspec.yaml'],
    lockfiles: ['pubspec.lock'],
    outdated: { command: 'dart', args: ['pub', 'outdated'] },
    upgrade: ({ name, version, kind }) => ({
      command: 'dart',
      args: ['pub', 'add', ...(kind === 'dev' ? ['dev:'] : []), `${name}:${version}`],
    }),
  },
  {
    id: 'swiftpm',
    ecosystem: 'swift',
    label: 'Swift Package Manager',
    manifests: ['Package.swift'],
    lockfiles: ['Package.resolved'],
    outdated: null,
    // SwiftPM resolves against the requirement written in Package.swift; there
    // is no command that pins a version without editing the manifest first.
    upgrade: () => null,
  },
  {
    id: 'cocoapods',
    ecosystem: 'cocoapods',
    label: 'CocoaPods',
    manifests: ['Podfile'],
    lockfiles: ['Podfile.lock'],
    outdated: { command: 'pod', args: ['outdated'] },
    // `pod update` honours the Podfile's constraint, so the constraint is what
    // `rewriteManifest` edits; this then re-resolves the lockfile against it.
    upgrade: ({ name }) => ({ command: 'pod', args: ['update', name] }),
    rewriteManifest: (content, { name, version }) => rewritePodfile(content, name, version),
  },
  {
    id: 'opam',
    ecosystem: 'opam',
    label: 'opam',
    manifests: ['dune-project'],
    manifestPattern: /\.opam$/,
    lockfiles: [],
    outdated: null,
    upgrade: ({ name, version }) => ({
      command: 'opam',
      args: ['install', `${name}.${version}`, '--yes'],
    }),
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `name==1.2.3` (or `>=`, `~=`, a bare `name`, ...) in `requirements.txt`.
 *
 * PEP 503 treats `-`, `_`, and `.` as equivalent in a package name, so the
 * match tolerates any of them where the declaration used one. Extras
 * (`name[extra]==1.2.3`) are preserved; everything after the name up to the
 * end of the specifier list is replaced with an exact pin.
 */
function rewriteRequirementsTxt(content: string, name: string, version: string): string {
  const namePattern = escapeRegExp(name).replace(/[-_.]/g, '[-_.]');
  const pattern = new RegExp(
    `^([ \\t]*${namePattern})(\\[[^\\]]*\\])?[ \\t]*(?:[=<>!~]=?\\s*[^\\s;#,]+(?:\\s*,\\s*[=<>!~]=?\\s*[^\\s;#,]+)*)?`,
    'im',
  );
  if (!pattern.test(content)) return content;
  return content.replace(pattern, (_match, base: string, extra: string | undefined) => `${base}${extra ?? ''}==${version}`);
}

/**
 * `"name==1.2.3"` (or `>=`, a bare `"name"`, ...) inside a quoted-string
 * dependency list — PEP 621's `dependencies = [...]` in `pyproject.toml`, or
 * `install_requires = [...]` in `setup.py`. Both declare requirements the
 * same way pip's own requirement specifiers do, just quoted as list entries
 * rather than one per line.
 */
function rewritePythonQuotedRequirement(content: string, name: string, version: string): string {
  const namePattern = escapeRegExp(name).replace(/[-_.]/g, '[-_.]');
  const pattern = new RegExp(
    `(["'])${namePattern}(\\[[^\\]]*\\])?(?:\\s*[=<>!~]=?\\s*[^"',;]+(?:\\s*,\\s*[=<>!~]=?\\s*[^"',;]+)*)?\\1`,
    'i',
  );
  if (!pattern.test(content)) return content;
  return content.replace(pattern, (_match, quote: string, extra: string | undefined) => `${quote}${name}${extra ?? ''}==${version}${quote}`);
}

/** `gem "name", "~> 1.2"` (or a bare `gem "name"`) in a Gemfile. */
function rewriteGemfile(content: string, name: string, version: string): string {
  const escaped = escapeRegExp(name);
  const withConstraint = new RegExp(`(gem\\s+["']${escaped}["'])\\s*,\\s*["'][^"']*["']`);
  if (withConstraint.test(content)) return content.replace(withConstraint, `$1, '${version}'`);
  const bare = new RegExp(`(gem\\s+["']${escaped}["'])(?!\\s*,\\s*["'])`);
  return content.replace(bare, `$1, '${version}'`);
}

/** `{:name, "~> 1.7"}` dependency tuples in `mix.exs`. */
function rewriteMixExs(content: string, name: string, version: string): string {
  const escaped = escapeRegExp(name);
  const pattern = new RegExp(`(\\{\\s*:${escaped}\\s*,\\s*)"[^"]*"`);
  if (!pattern.test(content)) return content;
  return content.replace(pattern, `$1"== ${version}"`);
}

/** `{name, "1.2.3"}` dependency tuples in `rebar.config`. */
function rewriteRebarConfig(content: string, name: string, version: string): string {
  const escaped = escapeRegExp(name);
  const pattern = new RegExp(`(\\{\\s*${escaped}\\s*,\\s*)"[^"]*"`);
  if (!pattern.test(content)) return content;
  return content.replace(pattern, `$1"${version}"`);
}

/** `pod "Name", "~> 1.2"` (or a bare `pod "Name"`) in a Podfile. */
function rewritePodfile(content: string, name: string, version: string): string {
  const escaped = escapeRegExp(name);
  const withConstraint = new RegExp(`(pod\\s+["']${escaped}["'])\\s*,\\s*["'][^"']*["']`);
  if (withConstraint.test(content)) return content.replace(withConstraint, `$1, '${version}'`);
  const bare = new RegExp(`(pod\\s+["']${escaped}["'])(?!\\s*,\\s*["'])`);
  return content.replace(bare, `$1, '${version}'`);
}

export function packageManagerById(id: PackageManagerId): PackageManager | undefined {
  return MANAGERS.find((m) => m.id === id);
}

export const PACKAGE_MANAGERS = MANAGERS;

/**
 * Which package managers own this directory.
 *
 * Lockfiles win over manifests, because a lockfile is a fact about what was
 * last installed while a manifest is shared by five different tools. When a
 * lockfile for an ecosystem is present, manifest-only managers for that same
 * ecosystem are dropped — otherwise every pnpm project would also report npm.
 */
export function detectPackageManagers(listing: DirectoryListing): DetectedPackageManager[] {
  const present = new Set(listing.entries);
  const found: DetectedPackageManager[] = [];

  for (const manager of MANAGERS) {
    const lockEvidence = manager.lockfiles.filter((f) => present.has(f));
    const manifestEvidence = [
      ...manager.manifests.filter((f) => present.has(f)),
      ...(manager.manifestPattern
        ? listing.entries.filter((entry) => manager.manifestPattern!.test(entry))
        : []),
    ];
    if (lockEvidence.length === 0 && manifestEvidence.length === 0) continue;

    if (!flavourMatches(manager, listing, present)) continue;

    found.push({
      manager,
      evidence: [...lockEvidence, ...manifestEvidence],
      fromLockfile: lockEvidence.length > 0,
    });
  }

  const ecosystemsWithLock = new Set(found.filter((f) => f.fromLockfile).map((f) => f.manager.ecosystem));
  return found.filter((f) => f.fromLockfile || !ecosystemsWithLock.has(f.manager.ecosystem));
}

/**
 * Two managers that share a manifest but are not really alternatives.
 *
 * This is distinct from the ambiguity below. An ambiguity is a genuine question
 * for the user ("you have both a pnpm and an npm lockfile — which is real?").
 * These are cases where the files themselves already answer it, and asking
 * would be noise: a Flutter app is not a Dart project that *might* want
 * `flutter pub`, and a berry lockfile is not a v1 lockfile.
 */
function flavourMatches(
  manager: PackageManager,
  listing: DirectoryListing,
  present: Set<string>,
): boolean {
  // Yarn's two incompatible generations share a lockfile name. `.yarnrc.yml`
  // only exists under berry, and berry lockfiles carry a `__metadata` block.
  // Either signal is enough; without one we assume classic, which is what a
  // bare `yarn.lock` from a v1 project looks like.
  if (manager.id === 'yarn' || manager.id === 'yarn-berry') {
    const berry =
      present.has('.yarnrc.yml') || (listing.read?.('yarn.lock') ?? '').includes('__metadata');
    return manager.id === 'yarn-berry' ? berry : !berry;
  }

  // Every Flutter project is a pub project, so both would always match. The
  // pubspec says which: a Flutter app depends on the `flutter` SDK, and
  // running `dart pub` in one is wrong in ways that are not obvious until a
  // build fails much later.
  if (manager.id === 'dart' || manager.id === 'flutter') {
    const pubspec = listing.read?.('pubspec.yaml') ?? '';
    const isFlutter = /^\s*(flutter|flutter_test)\s*:/m.test(pubspec) || /sdk:\s*flutter/.test(pubspec);
    return manager.id === 'flutter' ? isFlutter : !isFlutter;
  }

  return true;
}

/**
 * Where two managers claim the same ecosystem.
 *
 * This happens for real — a half-finished migration leaves both
 * `package-lock.json` and `pnpm-lock.yaml` behind. Guessing picks a loser and
 * writes the wrong lockfile, so callers are expected to ask.
 */
export function packageManagerAmbiguities(
  detected: readonly DetectedPackageManager[],
): PackageManagerAmbiguity[] {
  const byEcosystem = new Map<Ecosystem, DetectedPackageManager[]>();
  for (const entry of detected) {
    const list = byEcosystem.get(entry.manager.ecosystem) ?? [];
    list.push(entry);
    byEcosystem.set(entry.manager.ecosystem, list);
  }

  return [...byEcosystem.entries()]
    .filter(([, candidates]) => candidates.length > 1)
    .map(([ecosystem, candidates]) => ({ ecosystem, candidates }));
}

/** Render a command the way a user would type it, for display only. */
export function describeCommand(command: Command): string {
  return [command.command, ...command.args].join(' ');
}
