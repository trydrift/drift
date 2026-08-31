import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCargoFailure } from '../dist/evidence/surface/rust.js';

describe('Cargo causal failure summaries', () => {
  const cases = [
    {
      name: 'compile error after progress',
      stderr: [
        '    Updating crates.io index',
        ' Downloading crates ...',
        '   Compiling locked-tripwire v0.1.1002',
        'error[E0432]: unresolved import `std::missing`',
        'error: could not compile `locked-tripwire` (lib) due to 1 previous error',
      ].join('\n'),
      causal: /error\[E0432\]: unresolved import/,
    },
    {
      name: 'MSRV failure',
      stderr: [
        '    Updating crates.io index',
        'error: package `demo v2.0.0` cannot be built because it requires rustc 1.82 or newer',
      ].join('\n'),
      causal: /requires rustc 1\.82/,
    },
    {
      name: 'package resolution failure',
      stderr: [
        '    Updating crates.io index',
        'error: failed to select a version for the requirement `missing = "=9.9.9"`',
        'candidate versions found which did not match: 1.0.0',
      ].join('\n'),
      causal: /failed to select a version/,
    },
    {
      name: 'no matching package',
      stderr: [
        '    Updating crates.io index',
        'error: no matching package named `missing` found',
      ].join('\n'),
      causal: /no matching package/,
    },
    {
      name: 'custom build failure',
      stderr: [
        '   Compiling native-sys v1.0.0',
        'error: failed to run custom build command for `native-sys v1.0.0`',
      ].join('\n'),
      causal: /failed to run custom build command/,
    },
    {
      name: 'linker failure',
      stderr: [
        '    Checking demo v1.0.0',
        'error: linking with `cc` failed: exit status: 1',
        'note: /usr/bin/ld: cannot find -lssl',
      ].join('\n'),
      causal: /linking with `cc` failed/,
    },
    {
      name: 'missing feature',
      stderr: [
        '   Compiling demo v1.0.0',
        'error: package `demo` depends on `dep` with feature `tls` but `dep` does not have that feature',
      ].join('\n'),
      causal: /does not have that feature/,
    },
  ] as const;

  for (const fixture of cases) {
    test(fixture.name, () => {
      const summary = summarizeCargoFailure(fixture.stderr);
      assert.match(summary, fixture.causal);
      assert.doesNotMatch(summary, /^(?:Updating|Downloading|Compiling|Checking|Blocking)\b/);
      assert.ok(summary.split('\n').length <= 2);
    });
  }

  test('cache-lock-only output remains visible for contention handling', () => {
    assert.equal(
      summarizeCargoFailure('Blocking waiting for file lock on package cache'),
      'Blocking waiting for file lock on package cache',
    );
  });

  test('unknown stderr falls back to the first non-progress diagnostic', () => {
    assert.equal(
      summarizeCargoFailure('Updating crates.io index\npermission denied while reading registry'),
      'permission denied while reading registry',
    );
  });

  test('empty stderr has an explicit fallback', () => {
    assert.equal(summarizeCargoFailure(''), 'unknown Cargo failure');
  });
});
