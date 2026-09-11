import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectChanges, parserFor, isManifestPath, PARSERS } from '../dist/detect/index.js';
import { detectPackageManagers, packageManagerAmbiguities } from '../dist/detect/package-manager.js';
import { detectChecks } from '../dist/detect/checks.js';
import { binaryScalaVersion } from '../dist/detect/ecosystems/sbt.js';
import { packageIdentity } from '../dist/detect/ecosystems/swift.js';
import {
  ECOSYSTEM_CAPABILITIES,
  CAPABILITY_STAGES,
  capabilitiesFor,
  explainStage,
  isUnsupported,
} from '../dist/detect/capabilities.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { OSV_ECOSYSTEM } from '../dist/rationale/osv.js';

/**
 * Every ecosystem Drift claims to read, exercised against the shapes that
 * actually appear in manifests rather than the shape a parser wishes for.
 *
 * The bias throughout is that a *wrong* version is far worse than a missing
 * one. A missing version reports no upgrade; a wrong one sends the fix stage
 * editing something that was never there. So most of these tests are about
 * what the parsers refuse to claim.
 */

/** Parse one manifest directly, without going through the diff machinery. */
const parse = (path: string, content: string) => {
  const parser = parserFor(path);
  assert.ok(parser, `no parser handles ${path}`);
  return parser.parse(content, path);
};

describe('Dart and Flutter', () => {
  const pubspec = `
name: my_app
environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.0
  provider: 6.1.1
  collection: ">=1.17.0 <2.0.0"
  my_local:
    path: ../my_local
  from_git:
    git:
      url: https://github.com/example/pkg.git
      ref: main
  hosted_pkg:
    hosted:
      url: https://my.pub.dev
    version: ^2.0.0

dev_dependencies:
  flutter_test:
    sdk: flutter
  test: ^1.24.0
`;

  test('reads inline and block-form versions', () => {
    const deps = parse('pubspec.yaml', pubspec);
    assert.equal(deps.get('http')?.version, '^1.2.0');
    assert.equal(deps.get('provider')?.version, '6.1.1');
    assert.equal(deps.get('collection')?.version, '>=1.17.0 <2.0.0');
    assert.equal(deps.get('hosted_pkg')?.version, '^2.0.0');
  });

  test('a dependency sourced from an SDK, a path, or git pins no version', () => {
    // Each of these is a real dependency with nothing Drift could upgrade.
    // Reporting a version here would manufacture an upgrade that cannot exist.
    const deps = parse('pubspec.yaml', pubspec);
    assert.equal(deps.get('flutter')?.version, null);
    assert.equal(deps.get('my_local')?.version, null);
    assert.equal(deps.get('from_git')?.version, null);
  });

  test('never mistakes a nested config key for a dependency', () => {
    // `url:` under `hosted:` and `ref:` under `git:` are one level deeper than
    // the entries. A parser that ignored indentation would invent packages
    // called "url" and "ref".
    const deps = parse('pubspec.yaml', pubspec);
    assert.ok(!deps.has('url'), 'the hosted url is not a package');
    assert.ok(!deps.has('ref'), 'a git ref is not a package');
    assert.ok(!deps.has('sdk'), 'an sdk constraint is not a package');
  });

  test('separates dev dependencies from runtime ones', () => {
    const deps = parse('pubspec.yaml', pubspec);
    assert.equal(deps.get('http')?.kind, 'runtime');
    assert.equal(deps.get('test')?.kind, 'dev');
  });

  test('the lockfile keeps the direct/transitive distinction it records', () => {
    // pubspec.lock states provenance per package, which is better than most
    // lockfiles offer — so it is honoured rather than flattened to transitive.
    const lock = parse(
      'pubspec.lock',
      `
packages:
  http:
    dependency: "direct main"
    description:
      name: http
      url: "https://pub.dev"
    source: hosted
    version: "1.2.1"
  test:
    dependency: "direct dev"
    source: hosted
    version: "1.24.9"
  async:
    dependency: transitive
    source: hosted
    version: "2.11.0"
sdks:
  dart: ">=3.0.0 <4.0.0"
`,
    );

    assert.equal(lock.get('http')?.kind, 'runtime');
    assert.equal(lock.get('test')?.kind, 'dev');
    assert.equal(lock.get('async')?.kind, 'transitive');
    assert.equal(lock.get('http')?.version, '1.2.1');
    // `sdks:` is a sibling of `packages:`, not part of it.
    assert.ok(!lock.has('dart'));
  });

  test('a Flutter project is driven by flutter, a plain Dart one by dart', () => {
    // Both managers claim pubspec.yaml, so without this a Dart project would
    // report a spurious ambiguity and a Flutter project might be run with
    // `dart pub` — wrong in ways that only surface at build time.
    const flutter = detectPackageManagers({
      entries: ['pubspec.yaml', 'pubspec.lock'],
      read: () => 'dependencies:\n  flutter:\n    sdk: flutter\n',
    });
    assert.deepEqual(
      flutter.map((d) => d.manager.id),
      ['flutter'],
    );

    const dart = detectPackageManagers({
      entries: ['pubspec.yaml', 'pubspec.lock'],
      read: () => 'dependencies:\n  http: ^1.0.0\n',
    });
    assert.deepEqual(
      dart.map((d) => d.manager.id),
      ['dart'],
    );
  });
});

describe('Cargo parser', () => {
  test('preserves dependency placement for root and target-specific tables', () => {
    const deps = parse(
      'Cargo.toml',
      `
[dependencies]
a = "1"

[dev-dependencies]
b = "1"

[build-dependencies]
c = "1"

[target.'cfg(not(target_arch = "wasm32"))'.dependencies]
d = "1"

[target.'cfg(unix)'.dev-dependencies]
e = "1"

[target.'cfg(windows)'.build-dependencies]
f = "1"
`,
    );

    assert.deepEqual(deps.get('a'), {
      version: '1',
      kind: 'runtime',
      cargo: { section: 'dependencies' },
    });
    assert.deepEqual(deps.get('b'), {
      version: '1',
      kind: 'dev',
      cargo: { section: 'dev-dependencies' },
    });
    assert.deepEqual(deps.get('c'), {
      version: '1',
      kind: 'dev',
      cargo: { section: 'build-dependencies' },
    });
    assert.deepEqual(deps.get('d'), {
      version: '1',
      kind: 'runtime',
      cargo: { section: 'dependencies', target: 'cfg(not(target_arch = "wasm32"))' },
    });
    assert.deepEqual(deps.get('e'), {
      version: '1',
      kind: 'dev',
      cargo: { section: 'dev-dependencies', target: 'cfg(unix)' },
    });
    assert.deepEqual(deps.get('f'), {
      version: '1',
      kind: 'dev',
      cargo: { section: 'build-dependencies', target: 'cfg(windows)' },
    });
  });

  test('preserves placement for nested dependency tables', () => {
    const deps = parse(
      'Cargo.toml',
      `
[dependencies.a]
version = "1"

[target.'cfg(unix)'.dev-dependencies.b]
version = "2"
`,
    );

    assert.deepEqual(deps.get('a'), {
      version: '1',
      kind: 'runtime',
      cargo: { section: 'dependencies' },
    });
    assert.deepEqual(deps.get('b'), {
      version: '2',
      kind: 'dev',
      cargo: { section: 'dev-dependencies', target: 'cfg(unix)' },
    });
  });
});

describe('Bun', () => {
  // Bun 1.2 replaced the binary `bun.lockb` with a JSONC `bun.lock`. Until it
  // was parsed, a Bun project's resolved versions were invisible.
  const lock = `{
  // Generated by Bun
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "app", "dependencies": { "zod": "^3.24.1" } },
  },
  "packages": {
    "zod": ["zod@3.24.1", "", {}, "sha512-abc"],
    "@octokit/rest": ["@octokit/rest@22.0.1", "", {}, "sha512-def"],
    "local-pkg": ["local-pkg@workspace:packages/local", "", {}, ""],
  },
}`;

  test('reads resolved versions through the comments and trailing commas', () => {
    const deps = parse('bun.lock', lock);
    assert.equal(deps.get('zod')?.version, '3.24.1');
  });

  test('splits a scoped package at the last @, not the first', () => {
    const deps = parse('bun.lock', lock);
    assert.equal(deps.get('@octokit/rest')?.version, '22.0.1');
  });

  test('a workspace descriptor is not a version', () => {
    const deps = parse('bun.lock', lock);
    assert.ok(!deps.has('local-pkg'));
  });

  test('a `//` inside a URL is not a comment', () => {
    // Stripping it would corrupt every registry field in the file.
    const deps = parse(
      'bun.lock',
      '{"packages":{"a":["a@1.0.0","https://registry.npmjs.org/a",{},"sha512-x"]}}',
    );
    assert.equal(deps.get('a')?.version, '1.0.0');
  });
});

describe('Swift Package Manager', () => {
  const manifest = `
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "MyApp",
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.60.0"),
        .package(url: "https://github.com/vapor/vapor", exact: "4.89.0"),
        .package(url: "https://github.com/apple/swift-log.git", .upToNextMajor(from: "1.5.0")),
        .package(url: "https://github.com/apple/swift-algorithms", "1.0.0"..<"2.0.0"),
        .package(url: "https://github.com/example/wip.git", branch: "main"),
        .package(path: "../LocalPackage"),
    ],
    targets: []
)
`;

  test('names a package the way its README does', () => {
    // SwiftPM has no registry: a package is a git URL. Reducing it to
    // owner/repo is both what a human calls it and exactly what the evidence
    // stage needs to find releases.
    const deps = parse('Package.swift', manifest);
    assert.ok(deps.has('apple/swift-nio'));
    assert.ok(deps.has('vapor/vapor'));
    assert.equal(packageIdentity('https://github.com/apple/swift-nio.git'), 'apple/swift-nio');
    assert.equal(packageIdentity('git@github.com:apple/swift-nio.git'), 'apple/swift-nio');
  });

  test('translates every requirement form into a range Drift understands', () => {
    const deps = parse('Package.swift', manifest);
    // `from:` means "up to the next major", which is `^`. Emitting SwiftPM's
    // own spelling would leave version normalisation holding the word "from".
    assert.equal(deps.get('apple/swift-nio')?.version, '^2.60.0');
    assert.equal(deps.get('vapor/vapor')?.version, '4.89.0');
    assert.equal(deps.get('apple/swift-log')?.version, '^1.5.0');
    assert.equal(deps.get('apple/swift-algorithms')?.version, '>=1.0.0 <2.0.0');
  });

  test('a branch pin is not a version, and a path dependency is not a package', () => {
    const deps = parse('Package.swift', manifest);
    assert.equal(deps.get('example/wip')?.version, null);
    assert.ok(!deps.has('LocalPackage'), 'a sibling checkout has no version to compare');
  });

  test('reads Package.resolved in both formats SwiftPM has shipped', () => {
    // v1 nests pins under `object` and calls the URL `repositoryURL`; v2+ puts
    // them at the root as `location`. Reading only one silently skips every
    // project that has not migrated.
    const v2 = parse(
      'Package.resolved',
      JSON.stringify({
        pins: [
          {
            identity: 'swift-nio',
            location: 'https://github.com/apple/swift-nio.git',
            state: { version: '2.62.0' },
          },
        ],
        version: 2,
      }),
    );
    assert.equal(v2.get('apple/swift-nio')?.version, '2.62.0');

    const v1 = parse(
      'Package.resolved',
      JSON.stringify({
        object: {
          pins: [
            {
              package: 'swift-nio',
              repositoryURL: 'https://github.com/apple/swift-nio.git',
              state: { version: '2.62.0' },
            },
          ],
        },
        version: 1,
      }),
    );
    assert.equal(v1.get('apple/swift-nio')?.version, '2.62.0');
  });

  test('a pin resolved to a revision reports no version', () => {
    const pinned = parse(
      'Package.resolved',
      JSON.stringify({
        pins: [
          {
            identity: 'wip',
            location: 'https://github.com/example/wip.git',
            state: { revision: 'abc123', branch: 'main' },
          },
        ],
      }),
    );
    assert.equal(pinned.get('example/wip')?.version, null);
  });

  test('handles a tools-version-pinned manifest name', () => {
    assert.ok(isManifestPath('Package@swift-5.9.swift'));
  });
});

describe('.NET', () => {
  test('reads PackageReference in attribute and element form', () => {
    const deps = parse(
      'App.csproj',
      `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
    <PackageReference Include="Serilog">
      <Version>3.1.1</Version>
    </PackageReference>
    <PackageReference Include="StyleCop.Analyzers" Version="1.1.118" PrivateAssets="all" />
    <PackageReference Include="Computed.Package" Version="$(ComputedVersion)" />
  </ItemGroup>
</Project>
`,
    );

    assert.equal(deps.get('Newtonsoft.Json')?.version, '13.0.3');
    assert.equal(deps.get('Serilog')?.version, '3.1.1');
    // `PrivateAssets="all"` is how .NET spells "build-time only".
    assert.equal(deps.get('StyleCop.Analyzers')?.kind, 'dev');
    // An MSBuild property is resolved at build time. Recording the literal
    // `$(…)` would compare two identical strings forever and report no change.
    assert.equal(deps.get('Computed.Package')?.version, null);
  });

  test('central package management is where the versions actually live', () => {
    // In a repo using CPM the .csproj files carry no versions at all. A parser
    // that read only project files would report no .NET upgrade, ever.
    const deps = parse(
      'Directory.Packages.props',
      `
<Project>
  <PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
    <GlobalPackageReference Include="Microsoft.SourceLink.GitHub" Version="8.0.0" />
  </ItemGroup>
</Project>
`,
    );

    assert.equal(deps.get('Newtonsoft.Json')?.version, '13.0.3');
    assert.equal(deps.get('Microsoft.SourceLink.GitHub')?.version, '8.0.0');
  });

  test('a direct dependency stays direct across target frameworks', () => {
    const deps = parse(
      'packages.lock.json',
      JSON.stringify({
        version: 1,
        dependencies: {
          'net8.0': {
            'Newtonsoft.Json': { type: 'Direct', requested: '[13.0.3, )', resolved: '13.0.3' },
            'System.Buffers': { type: 'Transitive', resolved: '4.5.1' },
          },
          'net6.0': {
            // The same package, transitive here. Direct must win, or the
            // classification would depend on key order.
            'Newtonsoft.Json': { type: 'Transitive', resolved: '13.0.3' },
          },
        },
      }),
    );

    assert.equal(deps.get('Newtonsoft.Json')?.kind, 'runtime');
    assert.equal(deps.get('System.Buffers')?.kind, 'transitive');
  });

  test('still reads the pre-SDK packages.config', () => {
    const deps = parse(
      'packages.config',
      `<?xml version="1.0" encoding="utf-8"?>
<packages>
  <package id="Newtonsoft.Json" version="12.0.3" targetFramework="net472" />
  <package id="NUnit" version="3.13.3" developmentDependency="true" />
</packages>`,
    );
    assert.equal(deps.get('Newtonsoft.Json')?.version, '12.0.3');
    assert.equal(deps.get('NUnit')?.kind, 'dev');
  });

  test('a project file is found by extension, since its name is the project’s', () => {
    const detected = detectPackageManagers({ entries: ['MyApp.csproj', 'Program.cs'] });
    assert.deepEqual(
      detected.map((d) => d.manager.id),
      ['dotnet'],
    );
  });
});

describe('C and C++', () => {
  test('Conan reads both manifest shapes and strips what is not a version', () => {
    const txt = parse(
      'conanfile.txt',
      `[requires]
zlib/1.3.1
openssl/3.2.0@company/stable
boost/[>=1.80 <2]

[tool_requires]
cmake/3.28.1

[generators]
CMakeDeps
`,
    );

    assert.equal(txt.get('zlib')?.version, '1.3.1');
    // A user/channel is identity, not version.
    assert.equal(txt.get('openssl')?.version, '3.2.0');
    // A range is kept verbatim; resolving it here would report a bump that
    // never happened.
    assert.equal(txt.get('boost')?.version, '[>=1.80 <2]');
    assert.equal(txt.get('cmake')?.kind, 'dev');
    // `[generators]` is not a dependency section.
    assert.equal(txt.get('CMakeDeps'), undefined);

    const py = parse(
      'conanfile.py',
      `from conan import ConanFile

class App(ConanFile):
    requires = "zlib/1.3.1", "fmt/10.2.1"
    tool_requires = "cmake/3.28.1"

    def requirements(self):
        self.requires("spdlog/1.12.0")
`,
    );
    assert.equal(py.get('zlib')?.version, '1.3.1');
    assert.equal(py.get('fmt')?.version, '10.2.1');
    assert.equal(py.get('spdlog')?.version, '1.12.0');
    assert.equal(py.get('cmake')?.kind, 'dev');
  });

  test('a Conan lockfile revision moving is not a version change', () => {
    const before = parse('conan.lock', JSON.stringify({ requires: ['zlib/1.3.1#aaa'] }));
    const after = parse('conan.lock', JSON.stringify({ requires: ['zlib/1.3.1#bbb'] }));
    assert.equal(before.get('zlib')?.version, after.get('zlib')?.version);
  });

  test('vcpkg reports a baseline move rather than pretending nothing changed', () => {
    const manifest = (baseline: string) =>
      JSON.stringify({
        name: 'app',
        'builtin-baseline': baseline,
        dependencies: ['fmt', { name: 'zlib', 'version>=': '1.3.0' }, { name: 'vcpkg-cmake', host: true }],
        overrides: [{ name: 'fmt', version: '10.2.1' }],
      });

    const deps = parse('vcpkg.json', manifest('a'.repeat(40)));
    // An override is the last word on a port's version.
    assert.equal(deps.get('fmt')?.version, '10.2.1');
    assert.equal(deps.get('zlib')?.version, '>=1.3.0');
    assert.equal(deps.get('vcpkg-cmake')?.kind, 'dev');

    const changes = detectChanges([
      { path: 'vcpkg.json', before: manifest('a'.repeat(40)), after: manifest('b'.repeat(40)) },
    ]);
    // Silence here would be indistinguishable from "nothing moved", which is
    // the one reading that is definitely wrong when a baseline changes.
    assert.ok(changes.some((c) => c.name === 'vcpkg-baseline'));
  });

  test('an Arduino library name may contain spaces', () => {
    const deps = parse(
      'library.properties',
      `name=MySketch
version=1.0.0
depends=ArduinoJson (>=6.0.0), Adafruit GFX Library, WiFi (^1.2.7)
`,
    );

    assert.equal(deps.get('ArduinoJson')?.version, '>=6.0.0');
    assert.equal(deps.get('Adafruit GFX Library')?.version, null);
    assert.equal(deps.get('WiFi')?.version, '^1.2.7');
  });

  test('PlatformIO lib_deps, in every spelling projects actually use', () => {
    const deps = parse(
      'platformio.ini',
      `[env:esp32]
platform = espressif32
lib_deps =
    bblanchon/ArduinoJson@^6.19.4
    ArduinoJson-Fork
    Wire
    https://github.com/someone/thing.git

[env:uno]
lib_deps = knolleary/PubSubClient@2.8
`,
    );

    // The owner disambiguates a fork in the registry but is not part of the
    // library's identity, and library.properties never carries one.
    assert.equal(deps.get('ArduinoJson')?.version, '^6.19.4');
    assert.equal(deps.get('ArduinoJson-Fork')?.version, null);
    assert.equal(deps.get('Wire')?.version, null);
    assert.equal(deps.get('PubSubClient')?.version, '2.8');
    // No registry stands behind a bare git URL, so an entry for one could only
    // ever report "no versions available".
    assert.equal(deps.size, 4);
  });

  test('the C ecosystems are told apart by their manifests', () => {
    assert.equal(parserFor('conanfile.txt')?.ecosystem, 'conan');
    assert.equal(parserFor('vcpkg.json')?.ecosystem, 'vcpkg');
    assert.equal(parserFor('library.properties')?.ecosystem, 'arduino');
    assert.equal(parserFor('platformio.ini')?.ecosystem, 'arduino');
  });
});

describe('PHP', () => {
  test('platform requirements are not packages', () => {
    // `php: ^8.1 → ^8.2` is a real and important change, but it is not a
    // dependency the fix stage could ever find or edit.
    const deps = parse(
      'composer.json',
      JSON.stringify({
        require: {
          php: '^8.1',
          'ext-mbstring': '*',
          'composer-runtime-api': '^2.0',
          'symfony/console': '^6.3',
        },
        'require-dev': { 'phpunit/phpunit': '^10.0' },
      }),
    );

    assert.deepEqual([...deps.keys()], ['symfony/console', 'phpunit/phpunit']);
    assert.equal(deps.get('phpunit/phpunit')?.kind, 'dev');
  });

  test('the lockfile keeps its own dev section separate', () => {
    const deps = parse(
      'composer.lock',
      JSON.stringify({
        packages: [{ name: 'symfony/console', version: 'v6.3.4' }],
        'packages-dev': [{ name: 'phpunit/phpunit', version: '10.4.2' }],
      }),
    );
    assert.equal(deps.get('symfony/console')?.kind, 'transitive');
    assert.equal(deps.get('phpunit/phpunit')?.kind, 'dev');
  });
});

describe('Elixir and Erlang', () => {
  test('reads dep tuples and their scopes', () => {
    const deps = parse(
      'mix.exs',
      `
defmodule MyApp.MixProject do
  use Mix.Project

  defp deps do
    [
      {:phoenix, "~> 1.7.10"},
      {:ecto_sql, "~> 3.11"},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
      {:my_fork, github: "example/my_fork", branch: "main"},
      {:local, path: "../local"}
    ]
  end
end
`,
    );

    assert.equal(deps.get('phoenix')?.version, '~> 1.7.10');
    assert.equal(deps.get('credo')?.kind, 'dev');
    // A git or path dep has no Hex version to compare.
    assert.equal(deps.get('my_fork')?.version, null);
    assert.equal(deps.get('local')?.version, null);
  });

  test('only :hex entries in mix.lock carry a version', () => {
    const deps = parse(
      'mix.lock',
      `%{
  "phoenix": {:hex, :phoenix, "1.7.10", "02189140a61b2ce85bb633a9b6fd02dff705a5f1", [:mix], [], "hexpm", "cd"},
  "my_fork": {:git, "https://github.com/example/my_fork.git", "abc123", [branch: "main"]},
}`,
    );
    assert.equal(deps.get('phoenix')?.version, '1.7.10');
    // A git ref is not a version.
    assert.ok(!deps.has('my_fork'));
  });

  test('rebar.config deps do not pick up unrelated tuples', () => {
    const deps = parse(
      'rebar.config',
      `
{erl_opts, [debug_info, {parse_transform, lager_transform}]}.
{deps, [
  {cowboy, "2.10.0"},
  {jsx, "3.1.0"},
  ranch
]}.
{profiles, [{test, [{deps, [{meck, "0.9.2"}]}]}]}.
`,
    );

    assert.equal(deps.get('cowboy')?.version, '2.10.0');
    assert.equal(deps.get('jsx')?.version, '3.1.0');
    assert.equal(deps.get('ranch')?.version, null);
    // `erl_opts` is structurally identical to a dep list and is not one.
    assert.ok(!deps.has('debug_info'));
    assert.ok(!deps.has('parse_transform'));
  });
});

describe('CocoaPods', () => {
  test('reads pods and tells test targets from shipping ones', () => {
    const deps = parse(
      'Podfile',
      `
platform :ios, '15.0'

target 'MyApp' do
  use_frameworks!
  pod 'Alamofire', '~> 5.8'
  pod 'SnapKit', '5.6.0'
  pod 'MyFork', :git => 'https://github.com/example/fork.git'
  pod 'Local', :path => '../Local'

  target 'MyAppTests' do
    inherit! :search_paths
    pod 'Quick', '~> 7.0'
  end
end
`,
    );

    assert.equal(deps.get('Alamofire')?.version, '~> 5.8');
    assert.equal(deps.get('SnapKit')?.version, '5.6.0');
    assert.equal(deps.get('Alamofire')?.kind, 'runtime');
    assert.equal(deps.get('Quick')?.kind, 'dev');
  });

  test('an externally sourced pod is present but has no version', () => {
    const deps = parse(
      'Podfile',
      `target 'App' do
  pod 'MyFork', :git => 'https://github.com/example/fork.git'
  pod 'Local', :path => '../Local'
end`,
    );
    assert.ok(deps.has('MyFork'), 'the dependency is real even when its version is not knowable');
    assert.equal(deps.get('MyFork')?.version, null);
    assert.equal(deps.get('Local')?.version, null);
  });

  test('Podfile.lock records only the top level, not each pod’s own deps', () => {
    const deps = parse(
      'Podfile.lock',
      `PODS:
  - Alamofire (5.8.1)
  - AFNetworking (4.0.1):
    - AFNetworking/NSURLSession (= 4.0.1)
  - AFNetworking/NSURLSession (4.0.1)

DEPENDENCIES:
  - Alamofire (~> 5.8)

SPEC CHECKSUMS:
  Alamofire: 3ca42e259043ee0dc5c0cdd76c4bc568b8e42af7
`,
    );

    assert.equal(deps.get('Alamofire')?.version, '5.8.1');
    assert.equal(deps.get('AFNetworking')?.version, '4.0.1');
    // The `DEPENDENCIES:` and `SPEC CHECKSUMS:` sections are not pod versions.
    assert.equal(deps.size, 3);
  });
});

describe('OCaml', () => {
  test('reads depends entries with and without constraints', () => {
    const deps = parse(
      'my_project.opam',
      `
opam-version: "2.0"
synopsis: "An example"
depends: [
  "ocaml" {>= "4.14"}
  "dune" {>= "3.0" & build}
  "lwt" {>= "5.6" & < "6.0"}
  "cmdliner"
  "alcotest" {with-test}
  "odoc" {with-doc}
]
depopts: [ "lwt_ssl" ]
`,
    );

    assert.equal(deps.get('ocaml')?.version, '>= 4.14');
    assert.equal(deps.get('lwt')?.version, '>= 5.6 & < 6.0');
    // A bare entry constrains nothing.
    assert.equal(deps.get('cmdliner')?.version, null);
    // `with-test` and `with-doc` are opam's dev filters, not versions.
    assert.equal(deps.get('alcotest')?.kind, 'dev');
    assert.equal(deps.get('odoc')?.kind, 'dev');
    assert.equal(deps.get('lwt_ssl')?.kind, 'optional');
    // `build` is a filter too, and must not be read as a package.
    assert.ok(!deps.has('build'));
  });

  test('a locked file pins exact versions', () => {
    const deps = parse(
      'my_project.opam.locked',
      `
opam-version: "2.0"
depends: [
  "lwt" {= "5.7.0"}
  "cmdliner" {= "1.2.0"}
]
`,
    );
    assert.equal(deps.get('lwt')?.version, '5.7.0');
    assert.equal(deps.get('cmdliner')?.version, '1.2.0');
    assert.equal(deps.get('lwt')?.kind, 'transitive');
  });

  /**
   * `dune-project` is where a modern OCaml project's dependencies actually
   * live. A project with `(generate_opam_files true)` writes its `.opam` files
   * from it and commits them with a "edit dune-project instead" header, and
   * `dune-project` sorts before every `*.opam` in the manifest search — so
   * reading it as opam syntax found nothing and reported the project as having
   * no dependencies at all. ocaml-cohttp: twelve opam packages, sixty-four
   * dependencies, analysed as a project with one.
   */
  test('reads dependencies from dune syntax, not just opam syntax', () => {
    const deps = parse(
      'dune-project',
      `
(lang dune 3.8)
(name cohttp)
(generate_opam_files true)

(package
 (name cohttp)
 (synopsis "An OCaml library for HTTP clients and servers")
 (depends
  (ocaml (>= 4.08))
  (re (>= 1.9.0))
  uri
  (alcotest :with-test)
  (odoc :with-doc)))

(package
 (name cohttp-lwt)
 (depends
  cohttp
  (lwt (>= 5.3.0))))
`,
    );

    assert.equal(deps.get('ocaml')?.version, '>= 4.08');
    assert.equal(deps.get('re')?.version, '>= 1.9.0');
    assert.equal(deps.get('uri')?.version, null);
    assert.equal(deps.get('alcotest')?.kind, 'dev');
    assert.equal(deps.get('odoc')?.kind, 'dev');
    // Every package stanza in the file counts, not just the first.
    assert.equal(deps.get('lwt')?.version, '>= 5.3.0');
    // `:with-test` is a marker, and markers are not packages.
    assert.ok(!deps.has(':with-test'));
  });
});

describe('Scala', () => {
  test('%% appends the Scala binary version, because the artifact does', () => {
    // `"org" %% "cats-core"` depends on `cats-core_2.13`. Getting this wrong
    // produces a Maven Central lookup for an artifact that never existed.
    const deps = parse(
      'build.sbt',
      `
scalaVersion := "2.13.12"

val catsVersion = "2.10.0"

libraryDependencies ++= Seq(
  "org.typelevel" %% "cats-core" % catsVersion,
  "org.typelevel" %% "cats-effect" % "3.5.2",
  "com.google.guava" % "guava" % "32.1.3-jre",
  "org.scalatest" %% "scalatest" % "3.2.17" % "test"
)
`,
    );

    assert.equal(deps.get('org.typelevel:cats-core_2.13')?.version, '2.10.0');
    assert.equal(deps.get('org.typelevel:cats-effect_2.13')?.version, '3.5.2');
    // A single `%` is a plain Java artifact with no suffix.
    assert.equal(deps.get('com.google.guava:guava')?.version, '32.1.3-jre');
    assert.equal(deps.get('org.scalatest:scalatest_2.13')?.kind, 'dev');
  });

  test('Scala 3 keeps a bare 3, Scala 2 keeps major.minor', () => {
    // sbt's own rule: 2.13 and 2.12 are binary-incompatible, 3.x is not.
    assert.equal(binaryScalaVersion('2.13.12'), '2.13');
    assert.equal(binaryScalaVersion('2.12.18'), '2.12');
    assert.equal(binaryScalaVersion('3.3.1'), '3');
  });

  test('sbt plugins are build-time dependencies', () => {
    const deps = parse('project/plugins.sbt', `addSbtPlugin("org.scalameta" % "sbt-scalafmt" % "2.5.2")`);
    assert.equal(deps.get('org.scalameta:sbt-scalafmt')?.version, '2.5.2');
    assert.equal(deps.get('org.scalameta:sbt-scalafmt')?.kind, 'dev');
  });

  test('Scala reports as maven, so it inherits that ecosystem’s evidence', () => {
    const changes = detectChanges([
      {
        path: 'build.sbt',
        before: 'scalaVersion := "2.13.12"\nlibraryDependencies += "org.typelevel" %% "cats-core" % "2.9.0"',
        after: 'scalaVersion := "2.13.12"\nlibraryDependencies += "org.typelevel" %% "cats-core" % "2.10.0"',
      },
    ]);

    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.ecosystem, 'maven');
    assert.equal(changes[0]?.name, 'org.typelevel:cats-core_2.13');
    assert.equal(changes[0]?.bump, 'minor');
  });
});

describe('every parser is total over malformed input', () => {
  // A syntax error mid-rebase, a truncated file, or a binary blob must never
  // fail a run of forty other packages. Parsers return what they understood.
  const hostile = [
    '',
    '\0\0\0',
    '{',
    '{"require":',
    '<Project><PackageReference Include=',
    'depends: [ "unterminated',
    'PODS:\n  - (',
    'packages:\n  broken',
    '.package(url: "',
    '{:atom, ',
    'libraryDependencies += "a" %% ',
    'x'.repeat(100_000),
  ];

  for (const parser of PARSERS) {
    test(`${parser.name} survives anything`, () => {
      for (const path of samplePaths(parser)) {
        for (const content of hostile) {
          assert.doesNotThrow(() => parser.parse(content, path), `${parser.name} threw on ${path}`);
        }
      }
    });
  }

  /** A path each parser claims, derived from the capability matrix's file list. */
  function samplePaths(parser: (typeof PARSERS)[number]): string[] {
    const candidates = [
      'package.json',
      'pyproject.toml',
      'go.mod',
      'Cargo.toml',
      'pom.xml',
      'build.sbt',
      'Gemfile',
      'App.csproj',
      'composer.json',
      'composer.lock',
      'mix.exs',
      'mix.lock',
      'rebar.config',
      'pubspec.yaml',
      'pubspec.lock',
      'Package.swift',
      'Package.resolved',
      'Podfile',
      'Podfile.lock',
      'project.opam',
      'packages.lock.json',
      'packages.config',
    ];
    return candidates.filter((path) => parser.handles(path));
  }
});

describe('no two parsers fight over the same file', () => {
  test('each manifest path resolves to exactly one parser', () => {
    // `parserFor` takes the first match, so an overlap would silently give a
    // file to whichever parser happened to be registered first.
    const paths = ECOSYSTEM_CAPABILITIES.flatMap((c) => c.files).filter((f) => !f.includes('*'));

    for (const path of paths) {
      const claiming = PARSERS.filter((p) => p.handles(path));
      assert.equal(
        claiming.length,
        1,
        `${path} is claimed by ${claiming.map((p) => p.name).join(', ') || 'nobody'}`,
      );
    }
  });

  test('every file the capability matrix advertises is actually parsed', () => {
    // The matrix is what the docs and the UI render. A file listed there that
    // no parser handles is a promise the code does not keep.
    for (const capability of ECOSYSTEM_CAPABILITIES) {
      for (const file of capability.files) {
        const path = file.replaceAll('*', 'example');
        assert.ok(
          isManifestPath(path),
          `${capability.label} advertises ${file} but no parser handles ${path}`,
        );
      }
    }
  });
});

describe('the capability matrix is the honest one', () => {
  test('every ecosystem is described at every stage', () => {
    for (const capability of ECOSYSTEM_CAPABILITIES) {
      for (const stage of CAPABILITY_STAGES) {
        const support = capability.support[stage];
        assert.ok(support, `${capability.ecosystem} says nothing about ${stage}`);
        // A bare "partial" or "none" with no explanation is exactly the kind of
        // shrug this file exists to prevent.
        if (support.level !== 'full') {
          assert.ok(
            support.note && support.note.length > 20,
            `${capability.ecosystem}/${stage} is ${support.level} without saying what is missing`,
          );
        }
      }
    }
  });

  test('every ecosystem has a parser, and every parser an ecosystem', () => {
    const described = new Set(ECOSYSTEM_CAPABILITIES.map((c) => c.ecosystem));
    const parsed = new Set(PARSERS.map((p) => p.ecosystem));

    for (const ecosystem of described) {
      assert.ok(parsed.has(ecosystem), `${ecosystem} is documented but nothing parses it`);
    }
    for (const ecosystem of parsed) {
      assert.ok(described.has(ecosystem), `${ecosystem} is parsed but undocumented`);
    }
  });

  test('every ecosystem can be named in config', () => {
    const config = DriftConfigSchema.parse({});
    for (const capability of ECOSYSTEM_CAPABILITIES) {
      assert.ok(
        config.ecosystems.includes(capability.ecosystem),
        `${capability.ecosystem} is supported but not enabled by default`,
      );
    }
  });

  test('an ecosystem OSV does not cover is unchecked, not clean', () => {
    // `null` makes the security stage report "not checked here". Mapping it to
    // some near-enough OSV name would report "no advisories" for a query that
    // never ran, which is the single most dangerous thing this tool could say.
    assert.equal(OSV_ECOSYSTEM.cocoapods, null);
    assert.equal(OSV_ECOSYSTEM.opam, null);
    assert.equal(OSV_ECOSYSTEM.pub, 'Pub');
    assert.equal(OSV_ECOSYSTEM.swift, 'SwiftURL');
  });

  test('explains an unsupported stage without implying a clean result', () => {
    assert.ok(isUnsupported('rubygems', 'surface'));
    const explanation = explainStage('rubygems', 'surface');
    assert.match(explanation, /not available/);
    // It must say why, not merely that.
    assert.match(explanation, /no static public API surface/);
  });

  test('names the tool a partial stage depends on', () => {
    assert.match(explainStage('cargo', 'surface'), /cargo-public-api/);
    assert.match(explainStage('go', 'verify'), /Go toolchain/);
  });

  test('a fully supported stage says so plainly', () => {
    assert.equal(capabilitiesFor('npm').support.detect.level, 'full');
    assert.match(explainStage('npm', 'detect'), /fully supported/);
  });
});

describe('native checks, per ecosystem', () => {
  test('each new manager offers the checks its toolchain actually has', () => {
    const cases: [Parameters<typeof detectChecks>[0], string | null, string[]][] = [
      ['dotnet', null, ['dotnet build --nologo', 'dotnet test --nologo']],
      ['mix', null, ['mix compile --warnings-as-errors', 'mix test']],
      ['dart', null, ['dart analyze', 'dart test']],
      ['flutter', null, ['flutter analyze', 'flutter test']],
      ['swiftpm', null, ['swift build', 'swift test']],
      ['opam', null, ['dune build @check', 'dune runtest']],
      ['sbt', null, ['sbt Test/compile', 'sbt test']],
    ];

    for (const [manager, manifest, expected] of cases) {
      const labels = detectChecks(manager, manifest).map((c) => c.label);
      for (const label of expected) {
        assert.ok(labels.includes(label), `${manager} should offer \`${label}\`, got ${labels.join(', ')}`);
      }
    }
  });

  test('CocoaPods offers nothing, because a check that needs Xcode is not a check', () => {
    // A check that fails for setup reasons rather than code reasons teaches
    // people to ignore every check. The matrix says so out loud.
    assert.deepEqual(detectChecks('cocoapods', null), []);
    assert.ok(isUnsupported('cocoapods', 'verify'));
  });

  test('PHP checks come from what composer.json declares', () => {
    const declared = detectChecks(
      'composer',
      JSON.stringify({ 'require-dev': { 'phpunit/phpunit': '^10', 'phpstan/phpstan': '^1' } }),
    );
    assert.deepEqual(
      declared.map((c) => c.label),
      ['vendor/bin/phpstan analyse', 'vendor/bin/phpunit'],
    );

    // A project with no test runner gets no offer, rather than a command that
    // would fail for reasons that mean nothing.
    assert.deepEqual(detectChecks('composer', JSON.stringify({ require: {} })), []);
  });
});

describe('package manager ambiguity', () => {
  test('two lockfiles for one ecosystem is a question, not a guess', () => {
    // A half-finished migration leaves both behind. Guessing picks a loser and
    // writes the wrong lockfile into someone's repository.
    const detected = detectPackageManagers({
      entries: ['package.json', 'package-lock.json', 'pnpm-lock.yaml'],
    });
    const ambiguities = packageManagerAmbiguities(detected);

    assert.equal(ambiguities.length, 1);
    assert.equal(ambiguities[0]?.ecosystem, 'npm');
    assert.deepEqual(
      ambiguities[0]?.candidates.map((c) => c.manager.id).sort(),
      ['npm', 'pnpm'],
    );
  });

  test('a single ecosystem with one lockfile is unambiguous', () => {
    for (const entries of [
      ['composer.json', 'composer.lock'],
      ['mix.exs', 'mix.lock'],
      ['Podfile', 'Podfile.lock'],
      ['Package.swift', 'Package.resolved'],
      ['MyApp.csproj', 'packages.lock.json'],
    ]) {
      const detected = detectPackageManagers({ entries });
      assert.equal(packageManagerAmbiguities(detected).length, 0, entries.join(' + '));
    }
  });

  test('a polyglot repository reports every manager it really has', () => {
    // A React Native project is genuinely two ecosystems, and reporting only
    // the JavaScript half reports half a dependency change as the whole of it.
    const detected = detectPackageManagers({
      entries: ['package.json', 'package-lock.json', 'Podfile', 'Podfile.lock'],
    });

    assert.deepEqual(
      detected.map((d) => d.manager.id).sort(),
      ['cocoapods', 'npm'],
    );
    assert.equal(packageManagerAmbiguities(detected).length, 0);
  });
});

describe('detection end to end, per ecosystem', () => {
  const cases: { label: string; path: string; before: string; after: string; name: string }[] = [
    {
      label: 'Dart',
      path: 'pubspec.yaml',
      before: 'dependencies:\n  http: ^1.1.0\n',
      after: 'dependencies:\n  http: ^1.2.0\n',
      name: 'http',
    },
    {
      label: 'Swift',
      path: 'Package.swift',
      before: 'dependencies: [.package(url: "https://github.com/apple/swift-nio.git", from: "2.60.0"),]',
      after: 'dependencies: [.package(url: "https://github.com/apple/swift-nio.git", from: "2.62.0"),]',
      name: 'apple/swift-nio',
    },
    {
      label: '.NET',
      path: 'App.csproj',
      before: '<Project><PackageReference Include="Serilog" Version="3.0.1" /></Project>',
      after: '<Project><PackageReference Include="Serilog" Version="3.1.1" /></Project>',
      name: 'Serilog',
    },
    {
      label: 'PHP',
      path: 'composer.json',
      before: '{"require":{"symfony/console":"^6.2"}}',
      after: '{"require":{"symfony/console":"^6.3"}}',
      name: 'symfony/console',
    },
    {
      label: 'Elixir',
      path: 'mix.exs',
      before: 'defp deps do [{:phoenix, "~> 1.6.0"}] end',
      after: 'defp deps do [{:phoenix, "~> 1.7.0"}] end',
      name: 'phoenix',
    },
    {
      label: 'CocoaPods',
      path: 'Podfile',
      before: "target 'App' do\n  pod 'Alamofire', '~> 5.7'\nend",
      after: "target 'App' do\n  pod 'Alamofire', '~> 5.8'\nend",
      name: 'Alamofire',
    },
    {
      label: 'OCaml',
      path: 'my.opam',
      before: 'depends: [ "lwt" {>= "5.6"} ]',
      after: 'depends: [ "lwt" {>= "5.7"} ]',
      name: 'lwt',
    },
  ];

  for (const { label, path, before, after, name } of cases) {
    test(`${label} reports a minor bump as one`, () => {
      const changes = detectChanges([{ path, before, after }]);
      assert.equal(changes.length, 1, `expected one change, got ${JSON.stringify(changes)}`);
      assert.equal(changes[0]?.name, name);
      assert.equal(changes[0]?.bump, 'minor');
      assert.equal(changes[0]?.manifestPath, path);
    });
  }

  test('a manifest that did not change reports nothing', () => {
    for (const { path, before } of cases) {
      assert.deepEqual(detectChanges([{ path, before, after: before }]), []);
    }
  });

  test('an unparseable side does not invent a change', () => {
    for (const { path, after } of cases) {
      const changes = detectChanges([{ path, before: '@@@ not a manifest @@@', after }]);
      // Anything reported here must be an addition, never a version move —
      // there was no prior version to move from.
      for (const change of changes) {
        assert.equal(change.from, null, `${path} invented a "from" version`);
      }
    }
  });
});

describe('the support doc cannot outlive the code', () => {
  test('docs/support.md matches what the capability data renders', async () => {
    // A support table maintained by hand is a claim that decays silently, and
    // the decay always runs in the flattering direction — nobody ever forgets
    // to delete a capability they lost. So the file is generated, and this
    // asserts the checked-in copy is current. Run `npm run docs:support`.
    const { renderSupportMatrix } = await import('../dist/report/support.js');
    const { readFile } = await import('node:fs/promises');

    const onDisk = await readFile(new URL('../docs/support.md', import.meta.url), 'utf8');
    assert.equal(
      onDisk,
      renderSupportMatrix(),
      'docs/support.md is stale — run `npm run docs:support`',
    );
  });

  test('the matrix names every ecosystem Drift can detect', async () => {
    const onDisk = await (await import('node:fs/promises')).readFile(
      new URL('../docs/support.md', import.meta.url),
      'utf8',
    );
    for (const capability of ECOSYSTEM_CAPABILITIES) {
      assert.ok(onDisk.includes(capability.label), `${capability.label} is missing from the docs`);
    }
  });
});

describe('an absence must never read as an all-clear', () => {
  test('the report names what could not be checked, and why', async () => {
    // A Ruby upgrade with no findings and a TypeScript upgrade with no findings
    // look identical on the page, and they are not the same claim: one means
    // the API surface was compared and nothing broke, the other means there is
    // no API surface to compare and the verdict rests entirely on prose.
    const { renderPullRequestBody } = await import('../dist/report/markdown.js');
    const { buildPlan } = await import('../dist/plan/index.js');
    const { DEFAULT_CONFIG } = await import('../dist/config/schema.js');

    const plan = buildPlan({
      repo: {
        owner: 'o',
        repo: 'r',
        baseBranch: 'main',
        beforeSha: 'a'.repeat(40),
        afterSha: 'b'.repeat(40),
      },
      config: DEFAULT_CONFIG,
      changes: [
        {
          name: 'rails',
          ecosystem: 'rubygems',
          from: '7.0.0',
          to: '7.1.0',
          kind: 'runtime',
          bump: 'minor',
          manifestPath: 'Gemfile',
        },
      ],
      evidence: [],
      breakingChanges: [],
      impactSites: [],
    });

    const body = renderPullRequestBody(plan, DEFAULT_CONFIG);

    assert.match(body, /What Drift could not check/);
    assert.match(body, /no static public API surface/);
    // And it must not let the reader mistake the limit for a result.
    assert.match(body, /not\s+evidence that nothing is wrong/);
  });

  test('says nothing when every stage actually ran', async () => {
    // A section that reports "nothing to report" on every clean upgrade is a
    // section people stop reading, which costs it its power on the one that
    // matters.
    const { renderPullRequestBody } = await import('../dist/report/markdown.js');
    const { buildPlan } = await import('../dist/plan/index.js');
    const { DEFAULT_CONFIG } = await import('../dist/config/schema.js');

    const plan = buildPlan({
      repo: {
        owner: 'o',
        repo: 'r',
        baseBranch: 'main',
        beforeSha: 'a'.repeat(40),
        afterSha: 'b'.repeat(40),
      },
      config: DEFAULT_CONFIG,
      changes: [
        {
          name: 'zod',
          ecosystem: 'npm',
          from: '3.24.1',
          to: '4.0.0',
          kind: 'runtime',
          bump: 'major',
          manifestPath: 'package.json',
        },
      ],
      // Real evidence, so nothing about this upgrade went unchecked. An empty
      // evidence list is itself a gap now — "we retrieved nothing for this
      // package" is exactly the kind of absence the section exists to report —
      // so a fixture for the clean case has to actually be clean.
      evidence: [
        {
          id: 'ev_1',
          source: 'changelog',
          dependency: 'zod',
          title: 'CHANGELOG',
          content: 'Nothing breaking in this release.',
          weight: 0.65,
        },
      ],
      breakingChanges: [],
      impactSites: [],
    });

    assert.ok(!renderPullRequestBody(plan, DEFAULT_CONFIG).includes('What Drift could not check'));
  });
});
