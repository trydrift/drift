import type { Ecosystem } from '../types.js';

/**
 * What Drift can actually do, per ecosystem, per stage.
 *
 * This file exists because the alternative is a README table. A README table
 * is a promise nobody re-reads after the code changes underneath it, and the
 * failure mode is specific and bad: a developer runs Drift against a Dart
 * project, gets no findings, and concludes the upgrade is safe — when what
 * really happened is that Drift never had a way to look.
 *
 * So support is data. Every stage consults it before running, the report and
 * the panel render "not supported here" from it rather than from an absence,
 * and `docs/support.md` is generated from it. There is exactly one place to
 * change when an ecosystem gains a capability, and it is the same place the
 * user-facing claim comes from.
 *
 * The levels are deliberately ordered but *not* cumulative — an ecosystem can
 * have a native verify story with no computed API surface (Ruby), or a
 * computed surface with no way to pin a version (Gradle). Each is answered
 * independently and honestly.
 */

/** One stage of the pipeline, as a user would describe it. */
export type CapabilityStage =
  /** Find manifests, lockfiles, and the versions that moved. */
  | 'detect'
  /** Retrieve and normalise registry, release, and advisory evidence. */
  | 'evidence'
  /** Compare the published API surface of the two versions. */
  | 'surface'
  /** Find likely affected source references in this repository. */
  | 'static-analysis'
  /** Run the ecosystem's own typecheck / test / build. */
  | 'verify'
  /** Produce a scoped edit that moves the version. */
  | 'fix'
  /** Branch, validate, commit, push, and open a pull request. */
  | 'pull-request';

export const CAPABILITY_STAGES: readonly CapabilityStage[] = [
  'detect',
  'evidence',
  'surface',
  'static-analysis',
  'verify',
  'fix',
  'pull-request',
];

export const STAGE_LABEL: Record<CapabilityStage, string> = {
  detect: 'Detect',
  evidence: 'Evidence',
  surface: 'API surface',
  'static-analysis': 'Static analysis',
  verify: 'Verify',
  fix: 'Fix',
  'pull-request': 'Automated PR',
};

/**
 * How well a stage is supported.
 *
 * `partial` is the important one and the reason this is not a boolean. Most
 * real coverage is partial, and collapsing it into "supported" is how a tool
 * ends up claiming things a user can disprove in thirty seconds. Every
 * `partial` and `none` carries a `note` saying exactly what is missing.
 */
export type SupportLevel = 'full' | 'partial' | 'none';

export interface StageSupport {
  level: SupportLevel;
  /**
   * What is or is not covered, in one sentence, written for a developer who
   * is deciding whether to trust the result. Required unless the level is
   * `full`, where the stage label already says it.
   */
  note?: string;
  /** An external tool the stage needs, which Drift does not ship. */
  requires?: string;
}

export interface EcosystemCapability {
  ecosystem: Ecosystem;
  /** What a developer calls this ecosystem. */
  label: string;
  /** Manifests and lockfiles that identify it, for the docs table. */
  files: readonly string[];
  /** Package managers Drift knows how to drive here, by label. */
  managers: readonly string[];
  support: Record<CapabilityStage, StageSupport>;
}

const full = (): StageSupport => ({ level: 'full' });
const partial = (note: string, requires?: string): StageSupport => ({
  level: 'partial',
  note,
  ...(requires ? { requires } : {}),
});
const none = (note: string): StageSupport => ({ level: 'none', note });

/**
 * Static analysis is text-and-import matching against symbols named in the
 * evidence, not a compiler frontend. It is genuinely good at "you import the
 * thing that was removed" and genuinely cannot see through reflection, dynamic
 * dispatch, or code generation. Saying so once, here, keeps every ecosystem's
 * row from re-inventing the same caveat in slightly different words.
 */
const LOCALIZE_NOTE =
  'Matches imports and references to symbols named in the evidence; cannot see through reflection, dynamic dispatch, or generated code.';

/**
 * C and C++ share a surface diff and a localizer across three package
 * managers, so their caveats are written once here rather than three times
 * below in slightly different words.
 *
 * The surface diff is the strongest one Drift has outside npm, and for a
 * reason worth stating: in C and C++ the published header *is* the public API,
 * not a reconstruction of it the way a Python stub is. What it cannot see is
 * the preprocessor — a declaration behind `#ifdef` exists for some builds and
 * not others, and Drift reads the text rather than configuring and running
 * cpp. That is also why the weight sits one notch below a compiled diff.
 */
const C_SURFACE_NOTE =
  'Compares the declarations in both versions\' public headers, which is what a consumer compiles against. Declarations behind preprocessor conditionals are read as written, not per build configuration.';

const C_LOCALIZE_NOTE =
  'Matches `#include` directives and references to symbols named in the evidence. A macro-generated call site is invisible, as is a header reached through another header.';

/**
 * Keyed by ecosystem rather than held as an array, so that adding a member to
 * the `Ecosystem` union without describing it here is a *compile* error at this
 * declaration. An array plus a runtime lookup would let the omission ship.
 */
const CAPABILITY_BY_ECOSYSTEM: Record<Ecosystem, EcosystemCapability> = {
  npm: {
    ecosystem: 'npm',
    label: 'JavaScript / TypeScript',
    files: [
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lock',
      'npm-shrinkwrap.json',
    ],
    managers: ['npm', 'pnpm', 'Yarn (classic)', 'Yarn (berry)', 'Bun'],
    support: {
      detect: full(),
      evidence: full(),
      // The one ecosystem where the surface diff needs nothing installed:
      // jsDelivr serves `.d.ts` for both versions directly.
      surface: partial(
        'Diffs published TypeScript declarations. A package that ships no declarations of its own falls back to prose evidence rather than reporting a clean comparison.',
      ),
      'static-analysis': partial(LOCALIZE_NOTE),
      verify: partial("Runs the typecheck, test, and build scripts the project's package.json actually declares."),
      fix: full(),
      'pull-request': full(),
    },
  },
  pypi: {
    ecosystem: 'pypi',
    label: 'Python',
    files: ['pyproject.toml', 'requirements.txt', 'setup.py', 'poetry.lock', 'uv.lock', 'Pipfile'],
    managers: ['pip', 'Poetry', 'uv'],
    support: {
      detect: full(),
      evidence: full(),
      surface: partial(
        'Compares the public surface reconstructed from published type stubs. Packages without stubs fall back to prose evidence.',
        'a local Python interpreter',
      ),
      'static-analysis': partial(LOCALIZE_NOTE),
      verify: partial('Runs mypy/pyright and pytest when the project declares them.'),
      fix: full(),
      'pull-request': full(),
    },
  },
  go: {
    ecosystem: 'go',
    label: 'Go',
    files: ['go.mod', 'go.sum'],
    managers: ['Go modules'],
    support: {
      detect: full(),
      evidence: full(),
      surface: partial('Compares the exported API of both module versions.', 'the Go toolchain'),
      'static-analysis': partial(LOCALIZE_NOTE),
      verify: partial('Runs `go vet`, `go test`, and `go build`.', 'the Go toolchain'),
      fix: full(),
      'pull-request': full(),
    },
  },
  cargo: {
    ecosystem: 'cargo',
    label: 'Rust',
    files: ['Cargo.toml', 'Cargo.lock'],
    managers: ['Cargo'],
    support: {
      detect: full(),
      evidence: full(),
      surface: partial('Compares the public API of both crate versions.', 'cargo-public-api'),
      'static-analysis': partial(LOCALIZE_NOTE),
      verify: partial('Runs `cargo check`, `cargo test`, and `cargo build`.', 'the Rust toolchain'),
      fix: full(),
      'pull-request': full(),
    },
  },
  maven: {
    ecosystem: 'maven',
    label: 'Java / Kotlin / Scala',
    files: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'gradle/libs.versions.toml', 'build.sbt'],
    managers: ['Maven', 'Gradle', 'sbt'],
    support: {
      detect: partial(
        'Reads pom.xml, Gradle build files and version catalogs, and sbt coordinates. Gradle versions computed at configuration time are not visible without running Gradle.',
      ),
      evidence: full(),
      surface: partial('Compares both published JARs.', 'japicmp'),
      'static-analysis': partial(LOCALIZE_NOTE),
      verify: partial('Runs Maven or Gradle. sbt projects verify through sbt when it is installed.'),
      // Gradle is the honest hole: there is no Gradle command that pins a
      // dependency to a version, so Drift edits the build file as text.
      fix: partial(
        'Maven and sbt are edited through the build file; Gradle versions declared outside a version catalog may need a manual edit.',
      ),
      'pull-request': full(),
    },
  },
  rubygems: {
    ecosystem: 'rubygems',
    label: 'Ruby',
    files: ['Gemfile', 'Gemfile.lock', '*.gemspec'],
    managers: ['Bundler'],
    support: {
      detect: full(),
      evidence: full(),
      // Not an oversight. Ruby has no static public surface worth diffing, and
      // forcing a low-confidence signal into the highest-weight evidence slot
      // would be a lie told by a number.
      surface: none(
        'Ruby has no static public API surface to compare, so upgrades rest on release notes, changelogs, and advisories.',
      ),
      'static-analysis': partial(LOCALIZE_NOTE),
      verify: partial('Runs RSpec or Rake when the Gemfile declares them.', 'Bundler'),
      fix: full(),
      'pull-request': full(),
    },
  },
  nuget: {
    ecosystem: 'nuget',
    label: '.NET',
    files: ['*.csproj', '*.fsproj', '*.vbproj', 'Directory.Packages.props', 'packages.lock.json'],
    managers: ['NuGet'],
    support: {
      detect: full(),
      evidence: partial(
        'Registry metadata, published versions, deprecation, and OSV advisories. Release notes depend on the package declaring a GitHub repository.',
      ),
      // No SDK, no decompiler, nothing installed. A .NET assembly carries a
      // complete description of its own public surface in a documented format,
      // and Drift reads it out of the published .nupkg directly.
      surface: partial(
        'Compares the public types and member signatures in both versions\' published assemblies, preferring the reference assembly and a common target framework. A package that ships only native binaries, analyzers, or nothing at all has no surface to compare.',
      ),
      'static-analysis': partial(LOCALIZE_NOTE),
      verify: partial('Runs `dotnet build` and `dotnet test`.', 'the .NET SDK'),
      fix: full(),
      'pull-request': full(),
    },
  },
  packagist: {
    ecosystem: 'packagist',
    label: 'PHP',
    files: ['composer.json', 'composer.lock'],
    managers: ['Composer'],
    support: {
      detect: full(),
      evidence: partial(
        'Registry metadata, published versions, abandonment notices, and OSV advisories. Release notes depend on the package declaring a source repository.',
      ),
      surface: none(
        'PHP publishes no machine-comparable API artefact; upgrades rest on release notes, changelogs, and advisories.',
      ),
      'static-analysis': none(
        'PHP namespaces do not map deterministically to a Composer package name (a PSR-4 root can belong to any vendor); Drift does not localize usages in this ecosystem yet.',
      ),
      verify: partial('Runs PHPUnit when composer.json declares it.', 'Composer'),
      fix: full(),
      'pull-request': full(),
    },
  },
  hex: {
    ecosystem: 'hex',
    label: 'Elixir / Erlang',
    files: ['mix.exs', 'mix.lock'],
    managers: ['Mix'],
    support: {
      detect: full(),
      evidence: partial(
        'Registry metadata, published versions, retirement notices, and OSV advisories.',
      ),
      surface: none(
        'Hex publishes no machine-comparable API artefact; upgrades rest on release notes, changelogs, and advisories.',
      ),
      'static-analysis': none(
        'Elixir and Erlang code can call a module without any import statement naming its package; Drift does not localize usages in this ecosystem yet.',
      ),
      verify: partial('Runs `mix compile --warnings-as-errors` and `mix test`.', 'Elixir and Mix'),
      fix: full(),
      'pull-request': full(),
    },
  },
  pub: {
    ecosystem: 'pub',
    label: 'Dart / Flutter',
    files: ['pubspec.yaml', 'pubspec.lock'],
    managers: ['Dart pub', 'Flutter'],
    support: {
      detect: full(),
      evidence: partial(
        'Registry metadata, published versions, retraction, and OSV advisories. Release notes depend on the package declaring a repository.',
      ),
      surface: none(
        'Drift does not compare published Dart APIs; upgrades rest on release notes, changelogs, and advisories.',
      ),
      'static-analysis': partial(LOCALIZE_NOTE),
      verify: partial('Runs `dart analyze` and `dart test`, or their Flutter equivalents.', 'the Dart or Flutter SDK'),
      fix: full(),
      'pull-request': full(),
    },
  },
  swift: {
    ecosystem: 'swift',
    label: 'Swift',
    files: ['Package.swift', 'Package.resolved'],
    managers: ['Swift Package Manager'],
    support: {
      // SwiftPM identifies packages by git URL, and `Package.swift` is a
      // program rather than a data file. Drift reads the literal `.package(...)`
      // declarations, which is what almost every real manifest contains, and
      // says so rather than pretending to evaluate Swift.
      detect: partial(
        'Reads literal `.package(...)` declarations and Package.resolved. Versions computed by Swift code at manifest-evaluation time are not visible without running SwiftPM.',
      ),
      evidence: partial(
        'Source repository, releases, and changelogs, because SwiftPM identifies packages by git URL. There is no central registry to query for deprecation.',
      ),
      surface: none(
        'Comparing two Swift module interfaces needs a local toolchain and a built artefact Drift does not produce; upgrades rest on prose evidence.',
      ),
      'static-analysis': none(
        'A Swift package can vend module names unrelated to the package name in Package.swift; Drift does not localize usages in this ecosystem yet.',
      ),
      verify: partial('Runs `swift build` and `swift test`.', 'the Swift toolchain'),
      fix: full(),
      'pull-request': full(),
    },
  },
  cocoapods: {
    ecosystem: 'cocoapods',
    label: 'CocoaPods',
    files: ['Podfile', 'Podfile.lock', '*.podspec'],
    managers: ['CocoaPods'],
    support: {
      detect: full(),
      evidence: partial(
        'Release notes and changelogs when the pod declares a GitHub source. CocoaPods publishes no queryable metadata API, so there is no deprecation or advisory signal.',
      ),
      surface: none('Drift does not compare compiled iOS frameworks; upgrades rest on prose evidence.'),
      'static-analysis': none(
        'A pod\'s Swift or Objective-C module name is not derivable from its podspec name; Drift does not localize usages in this ecosystem yet.',
      ),
      verify: none(
        'Building an iOS target needs Xcode and a scheme Drift cannot infer; verification stays with the developer.',
      ),
      fix: full(),
      'pull-request': full(),
    },
  },
  opam: {
    ecosystem: 'opam',
    label: 'OCaml',
    files: ['*.opam', 'dune-project', '*.opam.locked'],
    managers: ['opam'],
    support: {
      detect: full(),
      evidence: partial(
        'Release notes and changelogs when the package declares a GitHub source. opam has no JSON metadata API, so there is no registry deprecation signal.',
      ),
      surface: none(
        'Comparing two OCaml module interfaces needs a built switch Drift does not create; upgrades rest on prose evidence.',
      ),
      'static-analysis': none(
        'An OCaml library\'s top-level module name is not derivable from its opam package name without reading its dune build rules; Drift does not localize usages in this ecosystem yet.',
      ),
      verify: partial('Runs `dune build` and `dune runtest`.', 'opam and dune'),
      fix: full(),
      'pull-request': full(),
    },
  },
  conan: {
    ecosystem: 'conan',
    label: 'C / C++ (Conan)',
    files: ['conanfile.txt', 'conanfile.py', 'conan.lock'],
    managers: ['Conan'],
    support: {
      detect: partial(
        'Reads conanfile.txt, conan.lock, and the literal `requires` declarations in conanfile.py. A reference a recipe builds at evaluation time is not visible without running Python.',
      ),
      evidence: partial(
        'Versions from the ConanCenter recipe index, and releases and changelogs from the upstream project the recipe builds — not from the recipe itself. ConanCenter publishes no deprecation signal, and OSV has no Conan ecosystem.',
      ),
      surface: partial(C_SURFACE_NOTE),
      'static-analysis': partial(C_LOCALIZE_NOTE),
      verify: partial(
        'Runs `conan build`, which is the compiler — in C and C++ an incompatible header change is a build failure rather than a runtime surprise.',
        'Conan',
      ),
      fix: full(),
      'pull-request': full(),
    },
  },
  vcpkg: {
    ecosystem: 'vcpkg',
    label: 'C / C++ (vcpkg)',
    files: ['vcpkg.json', 'vcpkg-configuration.json'],
    managers: ['vcpkg'],
    support: {
      // The baseline is the honest hole and it is a large one: vcpkg's model
      // is that one commit of the ports tree decides every version at once,
      // so a manifest that pins nothing has moved every dependency when that
      // commit moves. Drift reports the baseline move rather than resolving
      // it, which would mean cloning the ports tree at both commits.
      detect: partial(
        'Reads declared dependencies, `version>=` floors, and `overrides`. A registry baseline moving changes every unpinned version at once; Drift reports the baseline move rather than resolving it to versions.',
      ),
      evidence: partial(
        'Versions from the vcpkg versions database, and releases and changelogs from the port\'s upstream project. vcpkg publishes no deprecation signal, and OSV has no vcpkg ecosystem.',
      ),
      surface: partial(C_SURFACE_NOTE),
      'static-analysis': partial(C_LOCALIZE_NOTE),
      verify: partial('Runs the project\'s CMake build, which is where an incompatible header change surfaces.', 'CMake'),
      fix: full(),
      'pull-request': full(),
    },
  },
  arduino: {
    ecosystem: 'arduino',
    label: 'Arduino / PlatformIO',
    files: ['library.properties', 'platformio.ini'],
    managers: ['Arduino CLI', 'PlatformIO'],
    support: {
      detect: full(),
      evidence: partial(
        'Versions and repositories from the Arduino Library Manager index, plus releases and changelogs from the library\'s own repository. A library published only to PlatformIO has metadata but no version history, because that registry serves only the current release.',
      ),
      surface: partial(C_SURFACE_NOTE),
      'static-analysis': partial(C_LOCALIZE_NOTE),
      verify: partial(
        'Runs `arduino-cli compile` or `pio run`, and `pio test` where the project has tests.',
        'Arduino CLI or PlatformIO',
      ),
      fix: full(),
      'pull-request': full(),
    },
  },
};

/** Every ecosystem, in declaration order, for the docs table and the UI. */
export const ECOSYSTEM_CAPABILITIES: readonly EcosystemCapability[] =
  Object.values(CAPABILITY_BY_ECOSYSTEM);

/**
 * What Drift can do for one ecosystem.
 *
 * Total by construction — the record above is typed by the `Ecosystem` union,
 * so this cannot miss. No runtime fallback, because there is no case to fall
 * back from.
 */
export function capabilitiesFor(ecosystem: Ecosystem): EcosystemCapability {
  return CAPABILITY_BY_ECOSYSTEM[ecosystem];
}

export function supportFor(ecosystem: Ecosystem, stage: CapabilityStage): StageSupport {
  return capabilitiesFor(ecosystem).support[stage];
}

/** True when this stage produces nothing at all for this ecosystem. */
export function isUnsupported(ecosystem: Ecosystem, stage: CapabilityStage): boolean {
  return supportFor(ecosystem, stage).level === 'none';
}

/**
 * One sentence a reader can act on, for a stage that produced no result.
 *
 * The distinction this preserves is the entire point of the file: "Drift cannot
 * do this here" and "Drift did this and found nothing" are different facts, and
 * only one of them is reassuring.
 */
export function explainStage(ecosystem: Ecosystem, stage: CapabilityStage): string {
  const capability = capabilitiesFor(ecosystem);
  const support = capability.support[stage];
  const label = STAGE_LABEL[stage];

  if (support.level === 'full') return `${label} is fully supported for ${capability.label}.`;

  const requires = support.requires ? ` Requires ${support.requires}.` : '';
  const prefix =
    support.level === 'none'
      ? `${label} is not available for ${capability.label}.`
      : `${label} is partial for ${capability.label}.`;
  return `${prefix} ${support.note ?? ''}${requires}`.trim();
}
