import { basename } from 'node:path';
import type { DependencyKind, Ecosystem } from '../types.js';
import type { CargoDependencyPlacement } from './ecosystems/types.js';
import { isPythonRequirementsFile } from './python-requirements.js';

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
  | 'opam'
  | 'conan'
  | 'vcpkg'
  | 'arduino-cli'
  | 'platformio';

/** A command line, kept as argv so nothing is ever passed through a shell. */
export interface Command {
  command: string;
  args: string[];
}

export interface UpgradeTarget {
  name: string;
  version: string;
  kind: DependencyKind;
  cargo?: CargoDependencyPlacement;
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
   * Bring installed dependencies in line with what the manifest declares,
   * changing no versions.
   *
   * What you run in a fresh checkout before anything will compile. Drift needs
   * it to test an upgrade in a throwaway worktree: git gives it the manifest
   * and the lockfile, and nothing else — no `node_modules`, no virtualenv — so
   * a typecheck there fails on every import until this has run.
   *
   * Absent where the ecosystem's own build resolves dependencies as part of
   * compiling (Go, Cargo, Gradle), which makes a separate restore step
   * redundant rather than missing.
   */
  install?: Command;
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
  /**
   * Does this manager's `upgrade` command take more than one package at a time?
   *
   * `npm install a@1 b@2` is one resolution and one lockfile write; twenty
   * separate `npm install` runs are twenty of each, over a dependency graph
   * that has not meaningfully changed between them. On a manifest with twenty
   * outdated packages that is most of what a verification pass spends its time
   * on — see {@link upgradeMany}, which is where the merge actually happens.
   *
   * Opt-in rather than assumed, because "accepts several" is a fact about each
   * tool's argument parser and there is no way to derive it: `dotnet add
   * package` takes exactly one, `rebar3 upgrade` wants them comma-separated,
   * and `pio pkg install --library` is undocumented on the point. Anything not
   * marked here is installed one at a time, exactly as before.
   */
  batchable?: boolean;
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

/**
 * Which flag keeps an upgrade in the manifest section it was already
 * declared in.
 *
 * Every npm-ecosystem manager defaults to writing `dependencies`, so a
 * `peer` upgrade with no flag at all silently moves the entry Drift was
 * asked to bump out of `peerDependencies` — a different guarantee to the
 * consumers of this package, not a version bump.
 */
const npmFlags = (kind: DependencyKind, dev: string, optional: string, peer?: string): string[] => {
  if (kind === 'dev') return [dev];
  if (kind === 'optional') return [optional];
  if (kind === 'peer' && peer) return [peer];
  return [];
};

const cargoFlags = (placement?: CargoDependencyPlacement): string[] => {
  if (!placement) return [];
  return [
    ...(placement.section === 'dev-dependencies' ? ['--dev'] : []),
    ...(placement.section === 'build-dependencies' ? ['--build'] : []),
    ...(placement.target ? ['--target', placement.target] : []),
  ];
};

const MANAGERS: readonly PackageManager[] = [
  {
    id: 'npm',
    batchable: true,
    ecosystem: 'npm',
    label: 'npm',
    manifests: ['package.json'],
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
    outdated: { command: 'npm', args: ['outdated', '--json'] },
    install: { command: 'npm', args: ['install'] },
    upgrade: ({ name, version, kind }) => ({
      command: 'npm',
      args: ['install', `${name}@${version}`, ...npmFlags(kind, '--save-dev', '--save-optional', '--save-peer')],
    }),
  },
  {
    id: 'pnpm',
    batchable: true,
    ecosystem: 'npm',
    label: 'pnpm',
    manifests: ['package.json'],
    lockfiles: ['pnpm-lock.yaml'],
    outdated: { command: 'pnpm', args: ['outdated'] },
    install: { command: 'pnpm', args: ['install'] },
    // `pnpm add` rather than `pnpm update`: only `add` writes an exact chosen
    // version back into the manifest section it came from.
    upgrade: ({ name, version, kind }) => ({
      command: 'pnpm',
      args: ['add', `${name}@${version}`, ...npmFlags(kind, '--save-dev', '--save-optional', '--save-peer')],
    }),
  },
  {
    id: 'yarn-berry',
    batchable: true,
    ecosystem: 'npm',
    label: 'Yarn (berry)',
    manifests: ['package.json'],
    lockfiles: ['yarn.lock'],
    outdated: null,
    install: { command: 'yarn', args: ['install'] },
    // `yarn add`, not `yarn up`: berry documents `up` as operating across the
    // whole project — every workspace that depends on the package moves
    // together, and it explicitly does not touch `peerDependencies`. That is
    // the right tool for "bump this everywhere", which is not what testing
    // one candidate against one workspace needs. `add`, run with `cwd` set to
    // the member directory (as every caller here does — see
    // `installUpgrade`), resolves to that one workspace the same way `npm
    // install` and `pnpm add` already do, and respects `--peer` like the rest
    // of the family.
    upgrade: ({ name, version, kind }) => ({
      command: 'yarn',
      args: ['add', `${name}@${version}`, ...npmFlags(kind, '--dev', '--optional', '--peer')],
    }),
  },
  {
    id: 'yarn',
    batchable: true,
    ecosystem: 'npm',
    label: 'Yarn (classic)',
    manifests: ['package.json'],
    lockfiles: ['yarn.lock'],
    outdated: { command: 'yarn', args: ['outdated', '--json'] },
    install: { command: 'yarn', args: ['install'] },
    upgrade: ({ name, version }) => ({
      command: 'yarn',
      args: ['upgrade', `${name}@${version}`],
    }),
  },
  {
    id: 'bun',
    batchable: true,
    ecosystem: 'npm',
    label: 'Bun',
    manifests: ['package.json'],
    lockfiles: ['bun.lock', 'bun.lockb'],
    outdated: { command: 'bun', args: ['outdated'] },
    install: { command: 'bun', args: ['install'] },
    upgrade: ({ name, version, kind }) => ({
      command: 'bun',
      args: ['add', `${name}@${version}`, ...npmFlags(kind, '--dev', '--optional', '--peer')],
    }),
  },
  {
    id: 'uv',
    batchable: true,
    ecosystem: 'pypi',
    label: 'uv',
    manifests: ['pyproject.toml'],
    lockfiles: ['uv.lock'],
    outdated: { command: 'uv', args: ['pip', 'list', '--outdated', '--format', 'json'] },
    install: { command: 'uv', args: ['sync'] },
    upgrade: ({ name, version, kind }) => ({
      command: 'uv',
      args: ['add', `${name}==${version}`, ...(kind === 'dev' ? ['--dev'] : [])],
    }),
  },
  {
    id: 'poetry',
    batchable: true,
    ecosystem: 'pypi',
    label: 'Poetry',
    manifests: ['pyproject.toml'],
    lockfiles: ['poetry.lock'],
    outdated: { command: 'poetry', args: ['show', '--outdated'] },
    install: { command: 'poetry', args: ['install'] },
    upgrade: ({ name, version, kind }) => ({
      command: 'poetry',
      args: ['add', `${name}==${version}`, ...(kind === 'dev' ? ['--group', 'dev'] : [])],
    }),
  },
  {
    id: 'pip',
    batchable: true,
    ecosystem: 'pypi',
    label: 'pip',
    // A compiler output is a resolved graph; prefer its source declaration
    // whenever both conventional files exist in a directory.
    manifests: ['requirements.in', 'requirements.txt', 'pyproject.toml', 'setup.py'],
    manifestPattern: /^(?:requirements|constraints)[\w.-]*\.(?:in|txt)$/i,
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
      isPythonRequirementsFile(manifestPath)
        ? rewriteRequirementsTxt(content, name, version)
        : rewritePythonQuotedRequirement(content, name, version),
  },
  {
    id: 'go',
    batchable: true,
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
    batchable: true,
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
    upgrade: ({ name, version, cargo }) => ({
      command: 'cargo',
      args: ['add', `${name}@=${version}`, ...cargoFlags(cargo)],
    }),
  },
  {
    id: 'bundler',
    batchable: true,
    ecosystem: 'rubygems',
    label: 'Bundler',
    manifests: ['Gemfile'],
    lockfiles: ['Gemfile.lock'],
    outdated: { command: 'bundle', args: ['outdated'] },
    install: { command: 'bundle', args: ['install'] },
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
    // The version catalog first, deliberately. A Gradle build that has one
    // keeps its dependency versions there, and `build.gradle` then references
    // them by alias — so picking the build script because it sorted first
    // yielded a manifest with no versions in it.
    manifests: ['gradle/libs.versions.toml', 'build.gradle', 'build.gradle.kts'],
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
    install: { command: 'dotnet', args: ['restore'] },
    upgrade: ({ name, version }) => ({
      command: 'dotnet',
      args: ['add', 'package', name, '--version', version],
    }),
  },
  {
    id: 'composer',
    batchable: true,
    ecosystem: 'packagist',
    label: 'Composer',
    manifests: ['composer.json'],
    lockfiles: ['composer.lock'],
    outdated: { command: 'composer', args: ['outdated', '--format=json'] },
    install: { command: 'composer', args: ['install'] },
    upgrade: ({ name, version, kind }) => ({
      command: 'composer',
      args: ['require', `${name}:${version}`, ...(kind === 'dev' ? ['--dev'] : [])],
    }),
  },
  {
    id: 'mix',
    batchable: true,
    ecosystem: 'hex',
    label: 'Mix',
    manifests: ['mix.exs'],
    lockfiles: ['mix.lock'],
    outdated: { command: 'mix', args: ['hex.outdated'] },
    install: { command: 'mix', args: ['deps.get'] },
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
    install: { command: 'rebar3', args: ['get-deps'] },
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
    install: { command: 'flutter', args: ['pub', 'get'] },
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
    install: { command: 'dart', args: ['pub', 'get'] },
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
    batchable: true,
    ecosystem: 'cocoapods',
    label: 'CocoaPods',
    manifests: ['Podfile'],
    lockfiles: ['Podfile.lock'],
    outdated: { command: 'pod', args: ['outdated'] },
    install: { command: 'pod', args: ['install'] },
    // `pod update` honours the Podfile's constraint, so the constraint is what
    // `rewriteManifest` edits; this then re-resolves the lockfile against it.
    upgrade: ({ name }) => ({ command: 'pod', args: ['update', name] }),
    rewriteManifest: (content, { name, version }) => rewritePodfile(content, name, version),
  },
  {
    id: 'opam',
    batchable: true,
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
  {
    id: 'conan',
    batchable: true,
    ecosystem: 'conan',
    label: 'Conan',
    manifests: ['conanfile.txt', 'conanfile.py'],
    lockfiles: ['conan.lock'],
    outdated: null,
    // Conan has no `add` command: the reference in the conanfile is the
    // declaration, and `install` resolves whatever it finds there. So the
    // rewrite is the upgrade, and this re-resolves against it.
    upgrade: () => ({ command: 'conan', args: ['install', '.', '--build=missing'] }),
    rewriteManifest: (content, { name, version }) => rewriteConanfile(content, name, version),
  },
  {
    id: 'vcpkg',
    batchable: true,
    ecosystem: 'vcpkg',
    label: 'vcpkg',
    manifests: ['vcpkg.json'],
    lockfiles: [],
    outdated: null,
    upgrade: () => ({ command: 'vcpkg', args: ['install'] }),
    // vcpkg's only per-port version control is the `overrides` array — the
    // dependency entry itself takes a floor, not a pin. Writing the override
    // is therefore the whole upgrade, and writing it anywhere else would
    // produce a manifest vcpkg accepts and ignores.
    rewriteManifest: (content, { name, version }) => rewriteVcpkgManifest(content, name, version),
  },
  {
    id: 'arduino-cli',
    batchable: true,
    ecosystem: 'arduino',
    label: 'Arduino CLI',
    manifests: ['library.properties'],
    lockfiles: [],
    outdated: { command: 'arduino-cli', args: ['lib', 'upgrade', '--dry-run'] },
    upgrade: ({ name, version }) => ({
      command: 'arduino-cli',
      args: ['lib', 'install', `${name}@${version}`],
    }),
    rewriteManifest: (content, { name, version }) =>
      rewriteLibraryProperties(content, name, version),
  },
  {
    id: 'platformio',
    ecosystem: 'arduino',
    label: 'PlatformIO',
    manifests: ['platformio.ini'],
    lockfiles: [],
    outdated: { command: 'pio', args: ['pkg', 'outdated'] },
    upgrade: ({ name, version }) => ({
      command: 'pio',
      args: ['pkg', 'install', '--library', `${name}@${version}`],
    }),
    rewriteManifest: (content, { name, version }) => rewriteLibDeps(content, name, version),
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

/**
 * `zlib/1.2.13` -> `zlib/1.3.1`, wherever the reference appears.
 *
 * One expression covers `conanfile.txt`'s bare lines and `conanfile.py`'s
 * quoted literals, because a Conan reference has the same shape in both. The
 * trailing `(?=["'\s]|$)` is what stops `zlib/1.2.13` also rewriting the
 * `zlib-ng/1.2.13` two lines below it.
 */
function rewriteConanfile(content: string, name: string, version: string): string {
  const escaped = escapeRegExp(name);
  const reference = new RegExp(`\\b${escaped}/[^\\s"'#@]+`, 'g');
  return content.replace(reference, `${name}/${version}`);
}

/**
 * Pin a port by writing vcpkg's `overrides` array.
 *
 * JSON in, JSON out, through `JSON.parse`: a manifest is machine-written as
 * often as it is hand-written, and a regex that edited the text would have to
 * guess at the formatting of an array that may not exist yet. Two spaces of
 * indentation is what `vcpkg new` emits.
 *
 * Unparseable input is returned untouched rather than replaced with something
 * well-formed — losing a developer's comments-in-JSON to a "fix" they did not
 * ask for is worse than declining to edit.
 */
function rewriteVcpkgManifest(content: string, name: string, version: string): string {
  let doc: { overrides?: { name?: string; version?: string }[] };
  try {
    doc = JSON.parse(content) as typeof doc;
  } catch {
    return content;
  }

  const overrides = Array.isArray(doc.overrides) ? doc.overrides : [];
  const existing = overrides.find((entry) => entry.name === name);
  if (existing) existing.version = version;
  else overrides.push({ name, version });
  doc.overrides = overrides;

  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** `depends=Foo (>=1.0),Bar` -> the same list with one constraint pinned. */
function rewriteLibraryProperties(content: string, name: string, version: string): string {
  return content
    .split('\n')
    .map((line) => {
      const match = /^(\s*depends\s*=\s*)(.*)$/i.exec(line);
      if (!match) return line;

      const entries = match[2]!.split(',').map((entry) => {
        const withoutConstraint = entry.replace(/\s*\([^)]*\)\s*$/, '').trim();
        if (withoutConstraint !== name) return entry;
        // A leading space is the convention in every published
        // library.properties, and preserving the author's is not worth the
        // parse; normalising to one is.
        return ` ${name} (${version})`;
      });

      return `${match[1]}${entries.join(',').replace(/^\s+/, '')}`;
    })
    .join('\n');
}

/**
 * Pin one entry of PlatformIO's `lib_deps`.
 *
 * The owner prefix is preserved where the author wrote one: `bblanchon/ArduinoJson`
 * and `ArduinoJson` resolve to different registry entries when a fork exists,
 * and dropping the owner during an upgrade would silently switch which library
 * the project builds against.
 */
function rewriteLibDeps(content: string, name: string, version: string): string {
  const escaped = escapeRegExp(name);
  const entry = new RegExp(`^(\\s*)((?:[\\w.-]+/)?${escaped})(@[^\\s;#]*)?\\s*$`, 'gm');
  return content.replace(entry, (line, indent: string, spec: string) =>
    // Only inside a lib_deps block: an `[env:...]` key that happens to share
    // the library's name is not a dependency declaration.
    /^\s+/.test(indent) ? `${indent}${spec}@${version}` : line,
  );
}

export function packageManagerById(id: PackageManagerId): PackageManager | undefined {
  return MANAGERS.find((m) => m.id === id);
}

export const PACKAGE_MANAGERS = MANAGERS;

/**
 * Move several packages in as few commands as the manager allows.
 *
 * Derived from `upgrade` rather than declared a second time, so a manager can
 * never grow a batch form that disagrees with its single form. Each target's
 * own command is computed, the argument carrying its package specifier is
 * located (see {@link specifierPosition}), and targets whose commands are
 * otherwise identical are merged into one invocation with every specifier in
 * that argument's place:
 *
 *   npm install react@19.2 --save-dev  ┐
 *   npm install vite@7.1 --save-dev    ┴→  npm install react@19.2 vite@7.1 --save-dev
 *   npm install zod@4.4                →   npm install zod@4.4
 *
 * The grouping is what keeps it honest. Flags that differ — `--save-dev`, a
 * Poetry group, Composer's `--dev` — put their targets in different groups
 * rather than being dropped, which is what a hand-written batch form would
 * quietly get wrong. A manager whose command names no package at all (Conan,
 * vcpkg, where the manifest rewrite *is* the upgrade) collapses to a single
 * invocation for the same reason: every target's command is identical.
 *
 * `null` where nothing may be merged — the manager is not marked
 * {@link PackageManager.batchable}, or one of its targets has no upgrade
 * command — and the caller installs one at a time.
 */
export function upgradeMany(
  manager: PackageManager,
  targets: readonly UpgradeTarget[],
): Command[] | null {
  if (!manager.batchable || targets.length === 0) return null;

  // Insertion-ordered, so the commands come back in the order the targets were
  // given rather than in whatever order a hash lands them.
  const groups = new Map<string, { command: Command; at: number | null; specs: string[] }>();

  for (const target of targets) {
    const command = manager.upgrade(target);
    if (!command) return null;

    const index = specifierPosition(manager, target, command);
    // `undefined` is "this argument list cannot be read", which is different
    // from `null`'s "it names no package" — decline rather than guess.
    if (index === undefined) return null;
    const skeleton =
      index === null ? command.args : command.args.filter((_, position) => position !== index);
    const key = `${command.command} ${index} ${skeleton.join(' ')}`;

    const existing = groups.get(key);
    if (existing) {
      if (index !== null) existing.specs.push(command.args[index]!);
      continue;
    }
    groups.set(key, {
      command,
      at: index,
      specs: index === null ? [] : [command.args[index]!],
    });
  }

  return [...groups.values()].map(({ command, at, specs }) =>
    at === null
      ? command
      : {
          command: command.command,
          args: [...command.args.slice(0, at), ...specs, ...command.args.slice(at + 1)],
        },
  );
}

/**
 * Which argument carries the package specifier.
 *
 * Found by asking the manager for the same upgrade under a name and version
 * nothing else can equal, and taking the one position that moved. Searching
 * for an argument *containing* the package name is the obvious approach and is
 * wrong: a package genuinely called `install`, `add`, `update` or `package`
 * matches the subcommand first, and the merge would then rewrite the verb
 * rather than the specifier.
 *
 * `null` where nothing moved — the command names no package, as with Conan and
 * vcpkg, where the manifest rewrite is the upgrade. `undefined` where more than
 * one argument moved, which is an argument list this cannot merge safely.
 */
function specifierPosition(
  manager: PackageManager,
  target: UpgradeTarget,
  command: Command,
): number | null | undefined {
  const probe = manager.upgrade({ ...target, name: PROBE_NAME, version: PROBE_VERSION });
  if (!probe || probe.command !== command.command || probe.args.length !== command.args.length) {
    return undefined;
  }

  const moved = command.args.reduce<number[]>(
    (positions, arg, index) => (arg === probe.args[index] ? positions : [...positions, index]),
    [],
  );
  if (moved.length === 0) return null;
  return moved.length === 1 ? moved[0]! : undefined;
}

/** A name and version no real package has, used only to find where they land. */
const PROBE_NAME = ' drift-probe';
const PROBE_VERSION = ' drift-probe-version';

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
