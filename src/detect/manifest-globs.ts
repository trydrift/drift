/**
 * The one list of dependency files, in glob form.
 *
 * Drift knew which files it could parse — `isManifestPath` has always been
 * authoritative — but every surface that needed the same knowledge as a *glob*
 * kept its own hand-written copy: the GitHub Action's `on.push.paths`, the VS
 * Code file watcher, the CLI's git pathspecs, and the "open a manifest to get
 * started" message. They disagreed, and they disagreed in the direction that
 * silently does nothing.
 *
 * The Action was the worst case. Its trigger list omitted `npm-shrinkwrap.json`,
 * `bun.lock`, several Python lock and constraint files, Gradle's version
 * catalog and lockfile, `*.gemspec`, and more. Drift's runtime supports every
 * one of them — but a workflow that never starts makes runtime support
 * irrelevant, and nothing anywhere reports the miss. The repository just goes
 * quiet.
 *
 * So the list lives here once, and `test/manifest-globs.test.ts` asserts that
 * every pattern is a file `isManifestPath` recognises *and* that every file
 * `isManifestPath` recognises is matched by a pattern. Adding a parser without
 * adding its trigger is a failing test rather than a repository that stops
 * hearing from Drift.
 */

/**
 * Dependency file patterns, relative to a repository root, `**`-prefixed so
 * they match at any depth.
 *
 * Written as GitHub Actions path filters, which is also valid glob syntax for
 * VS Code's `createFileSystemWatcher` and for git pathspecs.
 */
export const DEPENDENCY_FILE_GLOBS: readonly string[] = [
  // npm and friends
  '**/package.json',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lock',

  // Python
  '**/requirements*.txt',
  '**/constraints*.txt',
  '**/pyproject.toml',
  '**/poetry.lock',
  '**/uv.lock',
  '**/Pipfile',
  '**/Pipfile.lock',
  '**/setup.py',

  // Go
  '**/go.mod',
  '**/go.sum',

  // Rust
  '**/Cargo.toml',
  '**/Cargo.lock',

  // JVM
  '**/pom.xml',
  '**/build.gradle',
  '**/build.gradle.kts',
  '**/gradle/libs.versions.toml',
  '**/gradle.lockfile',
  '**/build.sbt',
  '**/project/*.scala',

  // Ruby
  '**/Gemfile',
  '**/Gemfile.lock',
  '**/*.gemspec',

  // .NET
  '**/*.csproj',
  '**/*.fsproj',
  '**/*.vbproj',
  '**/Directory.Packages.props',
  '**/packages.config',
  '**/packages.lock.json',

  // PHP
  '**/composer.json',
  '**/composer.lock',

  // Elixir / Erlang
  '**/mix.exs',
  '**/mix.lock',
  '**/rebar.config',

  // Dart / Flutter
  '**/pubspec.yaml',
  '**/pubspec.yml',
  '**/pubspec.lock',

  // Swift
  '**/Package.swift',
  '**/Package@swift-*.swift',
  '**/Package.resolved',

  // CocoaPods
  '**/Podfile',
  '**/Podfile.lock',

  // OCaml
  '**/dune-project',
  '**/*.opam',
  '**/*.opam.locked',

  // C / C++
  '**/conanfile.txt',
  '**/conanfile.py',
  '**/conan.lock',
  '**/vcpkg.json',
  '**/vcpkg-configuration.json',

  // Embedded
  '**/library.properties',
  '**/platformio.ini',
];

/**
 * A representative filename for each glob, for tests and for anything that
 * needs a concrete path rather than a pattern.
 *
 * `**​/x` becomes `x`; a `*` inside the basename is filled with a plausible
 * token so the result is a real filename a parser can be asked about.
 */
export function exampleFileFor(glob: string): string {
  const withoutDepth = glob.replace(/^\*\*\//, '');
  return withoutDepth
    .replace(/^\*(?=\.)/, 'example')
    .replace(/\*/g, (match, offset: number, whole: string) =>
      // `requirements*.txt` -> `requirements-dev.txt`; `Package@swift-*.swift`
      // -> `Package@swift-5.9.swift`. Any remaining star is a directory
      // wildcard, which becomes an ordinary name.
      whole.slice(0, offset).endsWith('-') ? '5.9' : offset === 0 ? 'example' : '-dev',
    );
}

/**
 * The globs as a single brace-expanded pattern, for VS Code's file watcher,
 * which takes one pattern rather than a list.
 */
export function dependencyWatcherGlob(): string {
  const names = DEPENDENCY_FILE_GLOBS.map((glob) => glob.replace(/^\*\*\//, ''));
  return `**/{${names.join(',')}}`;
}
