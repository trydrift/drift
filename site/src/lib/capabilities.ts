/*
 * GENERATED — do not edit.
 *
 * Written by `site/scripts/sync-capabilities.mjs` from
 * `src/detect/capabilities.ts` in the Drift core, before every build and dev
 * start. Edit the original; this file is overwritten.
 */

export type SupportLevel = "full" | "partial" | "none";
export type SupportTier = "deep" | "strong" | "working" | "limited";
export type LocalizationBasis = "declared" | "published" | "convention";

export interface StageSupport {
  level: SupportLevel;
  note?: string;
  requires?: string;
}

export interface EcosystemCapability {
  ecosystem: string;
  label: string;
  tier: SupportTier;
  localizationBasis: LocalizationBasis;
  files: string[];
  managers: string[];
  support: Record<string, StageSupport>;
}

export const CAPABILITY_STAGES = ["detect","evidence","surface","static-analysis","upgrade-discovery","upgrade-install","verify","fix","pull-request"] as const;

export const STAGE_LABEL: Record<string, string> = {
  "detect": "Detect",
  "evidence": "Evidence",
  "surface": "API surface",
  "static-analysis": "Static analysis",
  "upgrade-discovery": "Find upgrades",
  "upgrade-install": "Install a version",
  "verify": "Verify",
  "fix": "Fix",
  "pull-request": "Automated PR"
};

export const TIER_DESCRIPTION: Record<SupportTier, string> = {
  "deep": "Drift computes the API diff from the published artefact, joins it to your code against module names the package itself declares, and can run the ecosystem's own build and tests over the result.",
  "strong": "Two of the three hold. Drift has a real answer here; one of the diff, the name resolution, or the verification is weaker than the others.",
  "working": "One of the three holds. Drift will tell you what moved and research it properly, and leaves more of the judgement with you.",
  "limited": "Detected, versioned, and researched. Whether it breaks your code is a question Drift cannot answer in this ecosystem."
};

export const ECOSYSTEM_CAPABILITIES: EcosystemCapability[] = [
  {
    "ecosystem": "npm",
    "label": "JavaScript / TypeScript",
    "tier": "deep",
    "localizationBasis": "declared",
    "files": [
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "npm-shrinkwrap.json"
    ],
    "managers": [
      "npm",
      "pnpm",
      "Yarn (classic)",
      "Yarn (berry)",
      "Bun"
    ],
    "support": {
      "detect": {
        "level": "full"
      },
      "evidence": {
        "level": "full"
      },
      "surface": {
        "level": "partial",
        "note": "Diffs published TypeScript declarations. A package that ships no declarations of its own falls back to prose evidence rather than reporting a clean comparison."
      },
      "static-analysis": {
        "level": "partial",
        "note": "Resolves imports against the module names the published package declares, follows re-exports inside your repository, and matches references to symbols named in the evidence. Cannot see through reflection, dynamic dispatch, or generated code."
      },
      "upgrade-discovery": {
        "level": "full"
      },
      "upgrade-install": {
        "level": "full"
      },
      "verify": {
        "level": "partial",
        "note": "Runs the typecheck, test, and build scripts the project's package.json actually declares."
      },
      "fix": {
        "level": "full"
      },
      "pull-request": {
        "level": "full"
      }
    }
  },
  {
    "ecosystem": "pypi",
    "label": "Python",
    "tier": "deep",
    "localizationBasis": "published",
    "files": [
      "pyproject.toml",
      "requirements.in",
      "requirements.txt",
      "setup.py",
      "poetry.lock",
      "uv.lock",
      "Pipfile"
    ],
    "managers": [
      "pip",
      "Poetry",
      "uv"
    ],
    "support": {
      "detect": {
        "level": "full"
      },
      "evidence": {
        "level": "full"
      },
      "surface": {
        "level": "partial",
        "note": "Compares the public surface reconstructed from published type stubs. Packages without stubs fall back to prose evidence.",
        "requires": "a local Python interpreter"
      },
      "static-analysis": {
        "level": "partial",
        "note": "Resolves imports against the module names the published package declares, follows re-exports inside your repository, and matches references to symbols named in the evidence. Cannot see through reflection, dynamic dispatch, or generated code."
      },
      "upgrade-discovery": {
        "level": "full"
      },
      "upgrade-install": {
        "level": "full"
      },
      "verify": {
        "level": "partial",
        "note": "Runs mypy/pyright and pytest when the project declares them."
      },
      "fix": {
        "level": "full"
      },
      "pull-request": {
        "level": "full"
      }
    }
  },
  {
    "ecosystem": "go",
    "label": "Go",
    "tier": "deep",
    "localizationBasis": "declared",
    "files": [
      "go.mod",
      "go.sum"
    ],
    "managers": [
      "Go modules"
    ],
    "support": {
      "detect": {
        "level": "full"
      },
      "evidence": {
        "level": "full"
      },
      "surface": {
        "level": "partial",
        "note": "Compares the exported API of both module versions.",
        "requires": "the Go toolchain"
      },
      "static-analysis": {
        "level": "partial",
        "note": "Resolves imports against the module names the published package declares, follows re-exports inside your repository, and matches references to symbols named in the evidence. Cannot see through reflection, dynamic dispatch, or generated code."
      },
      "upgrade-discovery": {
        "level": "full"
      },
      "upgrade-install": {
        "level": "full"
      },
      "verify": {
        "level": "partial",
        "note": "Runs `go vet`, `go test`, and `go build`.",
        "requires": "the Go toolchain"
      },
      "fix": {
        "level": "full"
      },
      "pull-request": {
        "level": "full"
      }
    }
  },
  {
    "ecosystem": "cargo",
    "label": "Rust",
    "tier": "deep",
    "localizationBasis": "declared",
    "files": [
      "Cargo.toml",
      "Cargo.lock"
    ],
    "managers": [
      "Cargo"
    ],
    "support": {
      "detect": {
        "level": "full"
      },
      "evidence": {
        "level": "full"
      },
      "surface": {
        "level": "partial",
        "note": "Compares the public API of both crate versions.",
        "requires": "cargo-public-api"
      },
      "static-analysis": {
        "level": "partial",
        "note": "Resolves imports against the module names the published package declares, follows re-exports inside your repository, and matches references to symbols named in the evidence. Cannot see through reflection, dynamic dispatch, or generated code."
      },
      "upgrade-discovery": {
        "level": "full"
      },
      "upgrade-install": {
        "level": "full"
      },
      "verify": {
        "level": "partial",
        "note": "Runs `cargo check`, `cargo test`, and `cargo build`.",
        "requires": "the Rust toolchain"
      },
      "fix": {
        "level": "full"
      },
      "pull-request": {
        "level": "full"
      }
    }
  },
  {
    "ecosystem": "maven",
    "label": "Java / Kotlin / Scala",
    "tier": "deep",
    "localizationBasis": "published",
    "files": [
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "gradle/libs.versions.toml",
      "build.sbt"
    ],
    "managers": [
      "Maven",
      "Gradle",
      "sbt"
    ],
    "support": {
      "detect": {
        "level": "partial",
        "note": "Reads pom.xml, Gradle build files and version catalogs, and sbt coordinates. Gradle versions computed at configuration time are not visible without running Gradle."
      },
      "evidence": {
        "level": "full"
      },
      "surface": {
        "level": "partial",
        "note": "Compares both published JARs.",
        "requires": "japicmp"
      },
      "static-analysis": {
        "level": "partial",
        "note": "Resolves imports against the module names the published package declares, follows re-exports inside your repository, and matches references to symbols named in the evidence. Cannot see through reflection, dynamic dispatch, or generated code."
      },
      "upgrade-discovery": {
        "level": "full"
      },
      "upgrade-install": {
        "level": "partial",
        "note": "Maven can install a chosen version directly. Gradle, sbt cannot: the version lives in a build file the tool will not rewrite, so Drift tells you what to change instead of running something that silently changes nothing."
      },
      "verify": {
        "level": "partial",
        "note": "Runs Maven or Gradle. sbt projects verify through sbt when it is installed."
      },
      "fix": {
        "level": "partial",
        "note": "Maven and sbt are edited through the build file; Gradle versions declared outside a version catalog may need a manual edit."
      },
      "pull-request": {
        "level": "full"
      }
    }
  },
  {
    "ecosystem": "rubygems",
    "label": "Ruby",
    "tier": "strong",
    "localizationBasis": "published",
    "files": [
      "Gemfile",
      "Gemfile.lock",
      "*.gemspec"
    ],
    "managers": [
      "Bundler"
    ],
    "support": {
      "detect": {
        "level": "full"
      },
      "evidence": {
        "level": "full"
      },
      "surface": {
        "level": "none",
        "note": "Ruby has no static public API surface to compare, so upgrades rest on release notes, changelogs, and advisories."
      },
      "static-analysis": {
        "level": "partial",
        "note": "Resolves imports against the module names the published package declares, follows re-exports inside your repository, and matches references to symbols named in the evidence. Cannot see through reflection, dynamic dispatch, or generated code."
      },
      "upgrade-discovery": {
        "level": "full"
      },
      "upgrade-install": {
        "level": "full"
      },
      "verify": {
        "level": "partial",
        "note": "Runs RSpec or Rake when the Gemfile declares them.",
        "requires": "Bundler"
      },
      "fix": {
        "level": "full"
      },
      "pull-request": {
        "level": "full"
      }
    }
  },
  {
    "ecosystem": "nuget",
    "label": ".NET",
    "tier": "deep",
    "localizationBasis": "published",
    "files": [
      "*.csproj",
      "*.fsproj",
      "*.vbproj",
      "Directory.Packages.props",
      "packages.lock.json"
    ],
    "managers": [
      "NuGet"
    ],
    "support": {
      "detect": {
        "level": "full"
      },
      "evidence": {
        "level": "partial",
        "note": "Registry metadata, published versions, deprecation, and OSV advisories. Release notes depend on the package declaring a GitHub repository."
      },
      "surface": {
        "level": "partial",
        "note": "Compares the public types and member signatures in both versions' published assemblies, preferring the reference assembly and a common target framework. A package that ships only native binaries, analyzers, or nothing at all has no surface to compare."
      },
      "static-analysis": {
        "level": "partial",
        "note": "Resolves imports against the module names the published package declares, follows re-exports inside your repository, and matches references to symbols named in the evidence. Cannot see through reflection, dynamic dispatch, or generated code."
      },
      "upgrade-discovery": {
        "level": "full"
      },
      "upgrade-install": {
        "level": "full"
      },
      "verify": {
        "level": "partial",
        "note": "Runs `dotnet build` and `dotnet test`.",
        "requires": "the .NET SDK"
      },
      "fix": {
        "level": "full"
      },
      "pull-request": {
        "level": "full"
      }
    }
  },
  {
    "ecosystem": "packagist",
    "label": "PHP",
    "tier": "strong",
    "localizationBasis": "published",
    "files": [
      "composer.json",
      "composer.lock"
    ],
    "managers": [
      "Composer"
    ],
    "support": {
      "detect": {
        "level": "full"
      },
      "evidence": {
        "level": "partial",
        "note": "Registry metadata, published versions, abandonment notices, and OSV advisories. Release notes depend on the package declaring a source repository."
      },
      "surface": {
        "level": "none",
        "note": "PHP publishes no machine-comparable API artefact; upgrades rest on release notes, changelogs, and advisories."
      },
      "static-analysis": {
        "level": "partial",
        "note": "Resolves `use` statements against the PSR-4 and PSR-0 roots the package declares in its own composer.json, read from Packagist. A package that autoloads only by classmap declares no namespace root and is not localized."
      },
      "upgrade-discovery": {
        "level": "full"
      },
      "upgrade-install": {
        "level": "full"
      },
      "verify": {
        "level": "partial",
        "note": "Runs PHPUnit when composer.json declares it.",
        "requires": "Composer"
      },
      "fix": {
        "level": "full"
      },
      "pull-request": {
        "level": "full"
      }
    }
  },
  {
    "ecosystem": "hex",
    "label": "Elixir / Erlang",
    "tier": "deep",
    "localizationBasis": "published",
    "files": [
      "mix.exs",
      "mix.lock"
    ],
    "managers": [
      "Mix"
    ],
    "support": {
      "detect": {
        "level": "full"
      },
      "evidence": {
        "level": "partial",
        "note": "Registry metadata, published versions, retirement notices, and OSV advisories."
      },
      "surface": {
        "level": "partial",
        "note": "Compares the public modules and their functions, by name and arity, in both versions' published sources — `def` and `defmacro` in Elixir, `-export` in Erlang. A function a macro generates at compile time is not visible without compiling."
      },
      "static-analysis": {
        "level": "partial",
        "note": "Resolves module references against every module the released tarball defines, so a fully qualified call needs no `alias` to be found. Cannot see through `apply/3` or a module name computed at runtime."
      },
      "upgrade-discovery": {
        "level": "full"
      },
      "upgrade-install": {
        "level": "full"
      },
      "verify": {
        "level": "partial",
        "note": "Runs `mix compile --warnings-as-errors` and `mix test`.",
        "requires": "Elixir and Mix"
      },
      "fix": {
        "level": "full"
      },
      "pull-request": {
        "level": "full"
      }
    }
  },
  {
    "ecosystem": "pub",
    "label": "Dart / Flutter",
    "tier": "deep",
    "localizationBasis": "declared",
    "files": [
      "pubspec.yaml",
      "pubspec.lock"
    ],
    "managers": [
      "Dart pub",
      "Flutter"
    ],
    "support": {
      "detect": {
        "level": "full"
      },
      "evidence": {
        "level": "partial",
        "note": "Registry metadata, published versions, retraction, and OSV advisories. Release notes depend on the package declaring a repository."
      },
      "surface": {
        "level": "partial",
        "note": "Compares the public declarations of both versions' published libraries, following each `export` out of the private `lib/src` tree the way a consumer's import does. Read from source rather than from a compiled artefact."
      },
      "static-analysis": {
        "level": "partial",
        "note": "Resolves imports against the module names the published package declares, follows re-exports inside your repository, and matches references to symbols named in the evidence. Cannot see through reflection, dynamic dispatch, or generated code."
      },
      "upgrade-discovery": {
        "level": "full"
      },
      "upgrade-install": {
        "level": "full"
      },
      "verify": {
        "level": "partial",
        "note": "Runs `dart analyze` and `dart test`, or their Flutter equivalents.",
        "requires": "the Dart or Flutter SDK"
      },
      "fix": {
        "level": "full"
      },
      "pull-request": {
        "level": "full"
      }
    }
  },
  {
    "ecosystem": "swift",
    "label": "Swift",
    "tier": "strong",
    "localizationBasis": "published",
    "files": [
      "Package.swift",
      "Package.resolved"
    ],
    "managers": [
      "Swift Package Manager"
    ],
    "support": {
      "detect": {
        "level": "partial",
        "note": "Reads literal `.package(...)` declarations and Package.resolved. Versions computed by Swift code at manifest-evaluation time are not visible without running SwiftPM."
      },
      "evidence": {
        "level": "partial",
        "note": "Source repository, releases, and changelogs, because SwiftPM identifies packages by git URL. There is no central registry to query for deprecation."
      },
      "surface": {
        "level": "none",
        "note": "Comparing two Swift module interfaces needs a local toolchain and a built artefact Drift does not produce; upgrades rest on prose evidence."
      },
      "static-analysis": {
        "level": "partial",
        "note": "Resolves `import` statements against the library and target names declared in the dependency's own Package.swift at the resolved version. A module name a manifest computes at evaluation time is not visible without running SwiftPM."
      },
      "upgrade-discovery": {
        "level": "partial",
        "note": "Versions are git tags, since SwiftPM has no package registry to ask. Drift lists them for packages hosted on GitHub; anything on another git host is reported as unchecked rather than up to date."
      },
      "upgrade-install": {
        "level": "none",
        "note": "Swift Package Manager has no command that pins a version — the coordinate lives in a build file the tool will not rewrite. Drift reports the version to set and where, and leaves the edit to you."
      },
      "verify": {
        "level": "partial",
        "note": "Runs `swift build` and `swift test`.",
        "requires": "the Swift toolchain"
      },
      "fix": {
        "level": "full"
      },
      "pull-request": {
        "level": "full"
      }
    }
  },
  {
    "ecosystem": "cocoapods",
    "label": "CocoaPods",
    "tier": "working",
    "localizationBasis": "published",
    "files": [
      "Podfile",
      "Podfile.lock",
      "*.podspec"
    ],
    "managers": [
      "CocoaPods"
    ],
    "support": {
      "detect": {
        "level": "full"
      },
      "evidence": {
        "level": "partial",
        "note": "Release notes and changelogs when the pod declares a GitHub source. CocoaPods publishes no queryable metadata API, so there is no deprecation or advisory signal."
      },
      "surface": {
        "level": "none",
        "note": "Drift does not compare compiled iOS frameworks; upgrades rest on prose evidence."
      },
      "static-analysis": {
        "level": "partial",
        "note": "Resolves `import` statements against the `module_name` the pod declares in its podspec, read from the CocoaPods CDN. A pod that builds its module name in Ruby at podspec-evaluation time is not visible without running CocoaPods."
      },
      "upgrade-discovery": {
        "level": "full"
      },
      "upgrade-install": {
        "level": "full"
      },
      "verify": {
        "level": "none",
        "note": "Building an iOS target needs Xcode and a scheme Drift cannot infer; verification stays with the developer."
      },
      "fix": {
        "level": "full"
      },
      "pull-request": {
        "level": "full"
      }
    }
  },
  {
    "ecosystem": "opam",
    "label": "OCaml",
    "tier": "working",
    "localizationBasis": "convention",
    "files": [
      "*.opam",
      "dune-project",
      "*.opam.locked"
    ],
    "managers": [
      "opam"
    ],
    "support": {
      "detect": {
        "level": "full"
      },
      "evidence": {
        "level": "partial",
        "note": "Release notes and changelogs when the package declares a GitHub source. opam has no JSON metadata API, so there is no registry deprecation signal."
      },
      "surface": {
        "level": "none",
        "note": "Comparing two OCaml module interfaces needs a built switch Drift does not create; upgrades rest on prose evidence."
      },
      "static-analysis": {
        "level": "partial",
        "note": "Matches imports and references to symbols named in the evidence, using the ecosystem's own module-naming convention where no published module list exists. Cannot see through reflection, dynamic dispatch, or generated code."
      },
      "upgrade-discovery": {
        "level": "partial",
        "note": "opam publishes no version API, so releases are read from the package directories in the opam-repository index. A package published only in a custom repository is reported as unchecked rather than up to date."
      },
      "upgrade-install": {
        "level": "full"
      },
      "verify": {
        "level": "partial",
        "note": "Runs `dune build` and `dune runtest`.",
        "requires": "opam and dune"
      },
      "fix": {
        "level": "full"
      },
      "pull-request": {
        "level": "full"
      }
    }
  },
  {
    "ecosystem": "conan",
    "label": "C / C++ (Conan)",
    "tier": "strong",
    "localizationBasis": "convention",
    "files": [
      "conanfile.txt",
      "conanfile.py",
      "conan.lock"
    ],
    "managers": [
      "Conan"
    ],
    "support": {
      "detect": {
        "level": "partial",
        "note": "Reads conanfile.txt, conan.lock, and the literal `requires` declarations in conanfile.py. A reference a recipe builds at evaluation time is not visible without running Python."
      },
      "evidence": {
        "level": "partial",
        "note": "Versions from the ConanCenter recipe index, and releases and changelogs from the upstream project the recipe builds — not from the recipe itself. ConanCenter publishes no deprecation signal, and OSV has no Conan ecosystem."
      },
      "surface": {
        "level": "partial",
        "note": "Compares the declarations in both versions' public headers, which is what a consumer compiles against. Declarations behind preprocessor conditionals are read as written, not per build configuration."
      },
      "static-analysis": {
        "level": "partial",
        "note": "Matches `#include` directives and references to symbols named in the evidence, following includes through your own headers so a library reached indirectly still counts. A macro-generated call site is invisible."
      },
      "upgrade-discovery": {
        "level": "partial",
        "note": "Conan version schemes are package-defined, so Drift can analyze exact version changes but does not invent an ordering to select a newer release automatically."
      },
      "upgrade-install": {
        "level": "full"
      },
      "verify": {
        "level": "partial",
        "note": "Runs `conan build`, which is the compiler — in C and C++ an incompatible header change is a build failure rather than a runtime surprise.",
        "requires": "Conan"
      },
      "fix": {
        "level": "full"
      },
      "pull-request": {
        "level": "full"
      }
    }
  },
  {
    "ecosystem": "vcpkg",
    "label": "C / C++ (vcpkg)",
    "tier": "strong",
    "localizationBasis": "convention",
    "files": [
      "vcpkg.json",
      "vcpkg-configuration.json"
    ],
    "managers": [
      "vcpkg"
    ],
    "support": {
      "detect": {
        "level": "partial",
        "note": "Reads declared dependencies, `version>=` floors, and `overrides`. A registry baseline moving changes every unpinned version at once; Drift reports the baseline move rather than resolving it to versions."
      },
      "evidence": {
        "level": "partial",
        "note": "Versions from the vcpkg versions database, and releases and changelogs from the port's upstream project. vcpkg publishes no deprecation signal, and OSV has no vcpkg ecosystem."
      },
      "surface": {
        "level": "partial",
        "note": "Compares the declarations in both versions' public headers, which is what a consumer compiles against. Declarations behind preprocessor conditionals are read as written, not per build configuration."
      },
      "static-analysis": {
        "level": "partial",
        "note": "Matches `#include` directives and references to symbols named in the evidence, following includes through your own headers so a library reached indirectly still counts. A macro-generated call site is invisible."
      },
      "upgrade-discovery": {
        "level": "partial",
        "note": "vcpkg versions are port-defined and baseline resolution can change every dependency, so Drift analyzes exact overrides but does not invent an ordering or resolve baseline moves automatically."
      },
      "upgrade-install": {
        "level": "full"
      },
      "verify": {
        "level": "partial",
        "note": "Runs the project's CMake build, which is where an incompatible header change surfaces.",
        "requires": "CMake"
      },
      "fix": {
        "level": "full"
      },
      "pull-request": {
        "level": "full"
      }
    }
  },
  {
    "ecosystem": "arduino",
    "label": "Arduino / PlatformIO",
    "tier": "strong",
    "localizationBasis": "convention",
    "files": [
      "library.properties",
      "platformio.ini"
    ],
    "managers": [
      "Arduino CLI",
      "PlatformIO"
    ],
    "support": {
      "detect": {
        "level": "full"
      },
      "evidence": {
        "level": "partial",
        "note": "Versions and repositories from the Arduino Library Manager index, plus releases and changelogs from the library's own repository. A library published only to PlatformIO has metadata but no version history, because that registry serves only the current release."
      },
      "surface": {
        "level": "partial",
        "note": "Compares the declarations in both versions' public headers, which is what a consumer compiles against. Declarations behind preprocessor conditionals are read as written, not per build configuration."
      },
      "static-analysis": {
        "level": "partial",
        "note": "Matches `#include` directives and references to symbols named in the evidence, following includes through your own headers so a library reached indirectly still counts. A macro-generated call site is invisible."
      },
      "upgrade-discovery": {
        "level": "full"
      },
      "upgrade-install": {
        "level": "full"
      },
      "verify": {
        "level": "partial",
        "note": "Runs `arduino-cli compile` or `pio run`, and `pio test` where the project has tests.",
        "requires": "Arduino CLI or PlatformIO"
      },
      "fix": {
        "level": "full"
      },
      "pull-request": {
        "level": "full"
      }
    }
  }
];
