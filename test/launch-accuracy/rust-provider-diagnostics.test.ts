import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCargoFailure, isCargoLockContention } from '../../dist/evidence/surface/rust.js';

/**
 * Provider infrastructure must never masquerade as a fact about the package.
 *
 * Two ways it did. Cargo narrates progress before it says anything useful, so
 * the first line of a failed run is almost always `Updating crates.io index`
 * — which Drift showed as the reason a crate could not be analysed. And a
 * package-cache lock race that Drift created by running its own probes
 * concurrently became an unresolved result for the user's dependency.
 */

const LOCKED_TRIPWIRE = `    Updating crates.io index
 Downloading crates ...
  Downloaded anyhow v1.0.86
   Compiling anyhow v1.0.86
error: failed to run custom build command for \`anyhow v1.0.86\`

Caused by:
  process didn't exit successfully: \`build-script-build\` (exit status: 1)
`;

describe('cargo failures are summarised by cause, not by first line', () => {
  test('a build-script failure is named, not the index update', () => {
    const summary = summarizeCargoFailure(LOCKED_TRIPWIRE);
    assert.match(summary, /failed to run custom build command/);
    assert.doesNotMatch(summary, /Updating crates\.io index/);
    assert.doesNotMatch(summary, /Downloading/);
  });

  test('a concrete compiler error outranks the trailing summary', () => {
    const summary = summarizeCargoFailure(`   Compiling demo v0.1.0
error[E0433]: failed to resolve: use of undeclared crate or module \`missing\`
 --> src/lib.rs:1:5
error: could not compile \`demo\` (lib) due to 1 previous error
`);
    assert.match(summary, /error\[E0433\]/);
    assert.match(summary, /--> src\/lib\.rs/);
  });

  test('version resolution failures are named', () => {
    for (const [stderr, expected] of [
      ['    Updating crates.io index\nerror: failed to select a version for the requirement `serde = "^9"`', /failed to select a version/],
      ['    Updating crates.io index\nerror: no matching package named `nope` found', /no matching package/],
      ['    Updating crates.io index\nerror: package `demo v1.0.0` cannot be built because it requires rustc 1.80.0 or newer', /requires rustc/],
      ['   Compiling demo v0.1.0\nerror: linking with `cc` failed: exit status: 1', /linking with/],
      ['    Updating crates.io index\nerror: feature `nightly` not found for package `demo`', /feature `nightly` not found/],
    ] as const) {
      const summary = summarizeCargoFailure(stderr);
      assert.match(summary, expected);
      assert.doesNotMatch(summary, /^Updating|^\s*Compiling/);
    }
  });

  test('progress-only output is reported as itself, since there is nothing better', () => {
    const summary = summarizeCargoFailure('    Updating crates.io index\n    Blocking waiting for file lock on package cache\n');
    assert.match(summary, /Updating crates\.io index/);
  });

  test('a non-progress line is preferred when no diagnostic marker is present', () => {
    const summary = summarizeCargoFailure('    Updating crates.io index\n   Compiling demo v0.1.0\nthread \'main\' panicked at src/main.rs:3:5\n');
    assert.match(summary, /panicked/);
  });

  test('empty output stays honest', () => {
    assert.equal(summarizeCargoFailure(''), 'no output');
  });
});

describe('cargo lock contention is infrastructure, not a package fact', () => {
  test('a bare package-cache lock race is contention', () => {
    assert.equal(
      isCargoLockContention('    Blocking waiting for file lock on package cache\n'),
      true,
    );
  });

  test('a lock message alongside a real error is not contention', () => {
    assert.equal(
      isCargoLockContention(`    Blocking waiting for file lock on package cache
error[E0432]: unresolved import
`),
      false,
    );
    assert.equal(
      isCargoLockContention(`    Blocking waiting for file lock on package cache
error: failed to run custom build command for \`anyhow v1.0.86\`
`),
      false,
    );
  });
});
