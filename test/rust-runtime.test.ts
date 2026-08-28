import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRustToolchain,
  resolveDatedNightly,
  rustComparisonVersion,
  rustcVersionFromManifest,
  warmRustDatedNightlies,
  clearRustRuntimeMemo,
} from '../dist/rationale/rust-runtime.js';
import { checkRuntimeCompatibility } from '../dist/rationale/runtime.js';
import { clearHttpCache, configureHttpDiskCache } from '../dist/util/http.js';

/**
 * `rustup` channel syntax — `nightly-2025-11-12`, `stable`, `beta`,
 * `1.75.0` — is not semver, and the generic comparator produced
 * `runtimeCompatibility: unknown` for all but the exact form, contaminating
 * the whole Rust recording. A dated nightly is resolved from that day's
 * *immutable* distribution manifest, never approximated from the date.
 */

const realFetch = globalThis.fetch;

const MANIFEST = (version: string): string =>
  `[pkg.cargo]\nversion = "1.86.0"\n\n[pkg.rust]\nversion = "${version}"\n\n[pkg.rustfmt]\nversion = "1.8.0"\n`;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
  configureHttpDiskCache(null);
  clearRustRuntimeMemo();
});

describe('classifyRustToolchain', () => {
  test('a plain stable version', () => {
    assert.deepEqual(classifyRustToolchain('1.75.0'), { kind: 'exact', version: '1.75.0' });
    assert.deepEqual(classifyRustToolchain('1.75'), { kind: 'exact', version: '1.75.0' });
  });
  test('a dated nightly', () => {
    assert.deepEqual(classifyRustToolchain('nightly-2025-11-12'), {
      kind: 'dated-nightly',
      date: '2025-11-12',
    });
  });
  test('a rust-toolchain.toml channel value', () => {
    assert.equal(classifyRustToolchain('nightly').kind, 'moving-nightly');
    assert.equal(classifyRustToolchain('stable').kind, 'moving-stable');
    assert.equal(classifyRustToolchain('beta').kind, 'moving-beta');
  });
  test('a dated nightly with a host triple suffix', () => {
    assert.deepEqual(classifyRustToolchain('nightly-2025-11-12-x86_64-unknown-linux-gnu'), {
      kind: 'dated-nightly',
      date: '2025-11-12',
    });
  });
});

describe('rustcVersionFromManifest', () => {
  test('reads [pkg.rust] version, not a sibling table', () => {
    assert.equal(
      rustcVersionFromManifest(MANIFEST('1.86.0-nightly (bef3c3b01 2025-01-16)')),
      '1.86.0',
    );
  });
  test('null when the table is absent', () => {
    assert.equal(rustcVersionFromManifest('[pkg.cargo]\nversion = "1.0.0"\n'), null);
  });
});

describe('resolveDatedNightly', () => {
  test('resolves the compiler version from the frozen manifest', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      assert.match(String(input), /\/dist\/2025-11-12\/channel-rust-nightly\.toml$/);
      return new Response(MANIFEST('1.86.0-nightly (abc 2025-11-12)'), { status: 200 });
    }) as typeof fetch;

    assert.equal(await resolveDatedNightly('2025-11-12'), '1.86.0');
  });

  test('a repeated lookup is served from cache without re-fetching', async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(MANIFEST('1.90.0-nightly (x 2026-01-01)'), { status: 200 });
    }) as typeof fetch;

    assert.equal(await resolveDatedNightly('2026-01-01'), '1.90.0');
    assert.equal(await resolveDatedNightly('2026-01-01'), '1.90.0');
    assert.equal(fetches, 1);
  });

  test('a failed manifest request stays unknown', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    assert.equal(await resolveDatedNightly('2020-01-01'), null);
  });
});

describe('rust runtime compatibility', () => {
  const decl = (requirement: string) => [{ file: 'rust-toolchain.toml', line: 3, requirement }];

  test('a dated nightly newer than the dependency MSRV is compatible', async () => {
    globalThis.fetch = (async () =>
      new Response(MANIFEST('1.86.0-nightly (x 2025-11-12)'), { status: 200 })) as typeof fetch;
    await warmRustDatedNightlies(['nightly-2025-11-12']);

    const [result] = checkRuntimeCompatibility('rust', decl('nightly-2025-11-12'), '>=1.70');
    assert.equal(result.verdict, 'compatible');
    assert.equal(result.requirement, 'nightly-2025-11-12', 'original text is preserved');
    assert.equal(result.resolvedRequirement, '1.86.0', 'the resolved version is kept apart');
  });

  test('a dated nightly older than the dependency MSRV is incompatible', async () => {
    globalThis.fetch = (async () =>
      new Response(MANIFEST('1.60.0-nightly (x 2022-01-01)'), { status: 200 })) as typeof fetch;
    await warmRustDatedNightlies(['nightly-2022-01-01']);

    const [result] = checkRuntimeCompatibility('rust', decl('nightly-2022-01-01'), '>=1.75');
    assert.equal(result.verdict, 'incompatible');
  });

  test('an unresolved dated nightly is unknown, not a guess', async () => {
    globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof fetch;
    await warmRustDatedNightlies(['nightly-2019-09-09']);

    const [result] = checkRuntimeCompatibility('rust', decl('nightly-2019-09-09'), '>=1.75');
    assert.equal(result.verdict, 'unknown');
    assert.equal(rustComparisonVersion('nightly-2019-09-09').reason, 'unresolved-nightly');
  });

  test('a bare moving channel stays honestly unknown', () => {
    assert.deepEqual(rustComparisonVersion('nightly'), { version: null, reason: 'moving-channel' });
    const [result] = checkRuntimeCompatibility('rust', decl('nightly'), '>=1.75');
    assert.equal(result.verdict, 'unknown');
  });

  test('a plain version compares directly', () => {
    const [result] = checkRuntimeCompatibility('rust', decl('1.80.0'), '>=1.75');
    assert.equal(result.verdict, 'compatible');
  });
});
