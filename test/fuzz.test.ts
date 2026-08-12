import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { PARSERS } from '../dist/detect/index.js';
import { parseRequirementLine } from '../dist/detect/ecosystems/python.js';
import { parseConanReference } from '../dist/detect/ecosystems/conan.js';
import { parseTomlArray, parseTomlVersionValue, scanTomlTables } from '../dist/detect/ecosystems/toml.js';

/**
 * Property-based fuzzing over the hand-written string parsers that read
 * untrusted manifest/lockfile content straight out of a scanned repository.
 * `ManifestParser.parse` is documented as a total function — it must never
 * throw on malformed input, since a syntax error in one manifest must not
 * fail the whole Drift run (see `src/detect/ecosystems/types.ts`). These
 * tests hold every parser to that invariant against randomly generated
 * input rather than only the handful of fixtures the unit tests cover.
 */

// One representative path per parser, exercising its primary `parse`
// branch — `handles()` for the full branch list lives in each ecosystems/*.ts.
const REPRESENTATIVE_PATHS: Record<string, string[]> = {
  'pip/poetry/uv': ['pyproject.toml', 'requirements.txt', 'poetry.lock', 'setup.py', 'pipfile'],
  'npm/yarn/pnpm': ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
  'go modules': ['go.mod', 'go.sum'],
  cargo: ['cargo.toml', 'cargo.lock'],
  sbt: ['build.sbt'],
  'maven/gradle': ['pom.xml', 'build.gradle', 'build.gradle.kts', 'libs.versions.toml'],
  bundler: ['gemfile', 'gemfile.lock', 'foo.gemspec'],
  NuGet: ['app.csproj', 'packages.lock.json', 'packages.config'],
  Composer: ['composer.json', 'composer.lock'],
  Mix: ['mix.exs', 'mix.lock', 'rebar.config'],
  pub: ['pubspec.yaml', 'pubspec.lock'],
  'Swift Package Manager': ['package.swift', 'package.resolved'],
  CocoaPods: ['podfile', 'podfile.lock', 'foo.podspec'],
  opam: ['dune-project', 'foo.opam'],
  conan: ['conanfile.txt', 'conanfile.py', 'conan.lock'],
  vcpkg: ['vcpkg.json'],
  arduino: ['library.properties', 'platformio.ini'],
};

describe('manifest parsers never throw on malformed input', () => {
  for (const parser of PARSERS) {
    const paths = REPRESENTATIVE_PATHS[parser.name] ?? [];
    assert.ok(paths.length > 0, `no representative path registered for parser ${parser.name}`);

    for (const path of paths) {
      test(`${parser.name}: parse(${path}) is total`, () => {
        fc.assert(
          fc.property(fc.string({ maxLength: 2000 }), (content) => {
            parser.parse(content, path);
          }),
          { numRuns: 200 },
        );
      });
    }
  }
});

describe('standalone string parsers never throw on malformed input', () => {
  test('parseRequirementLine', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (line) => {
        parseRequirementLine(line);
      }),
    );
  });

  test('parseConanReference', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (reference) => {
        parseConanReference(reference);
      }),
    );
  });

  test('parseTomlArray', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (value) => {
        parseTomlArray(value);
      }),
    );
  });

  test('parseTomlVersionValue', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (value) => {
        parseTomlVersionValue(value);
      }),
    );
  });

  test('scanTomlTables', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (content) => {
        scanTomlTables(content);
      }),
    );
  });
});
