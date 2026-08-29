import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { diffPackageModuleMetadata, clearTypeSurfaceCache } from '../../dist/evidence/type-surface.js';
import { clearHttpCache } from '../../dist/util/http.js';

/**
 * Dual ESM/CommonJS packages must not be reported as having dropped
 * CommonJS support.
 *
 * Drift emitted a **high-confidence** `commonjs-entry-removed` for
 * `lru-cache` 7→10, `glob` 7→10, and `rimraf` 3→5 — packages that `require()`
 * perfectly well, whose own `exports` map Drift printed in the same finding
 * and which explicitly names a `require` condition. A confident claim that
 * contradicted the evidence beside it.
 *
 * Each case below asserts what Drift must NOT say as well as what it should.
 */

const realFetch = globalThis.fetch;

function reset(): void {
  clearHttpCache();
  clearTypeSurfaceCache();
}

function stubManifests(manifests: Record<string, unknown>): void {
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    for (const [suffix, body] of Object.entries(manifests)) {
      if (url.endsWith(suffix)) return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }
    return Promise.resolve(new Response('', { status: 404 }));
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  reset();
});

/** The `tshy` dual-build output shape these three packages all ship. */
function tshyExports(): unknown {
  return {
    './package.json': './package.json',
    '.': {
      import: { types: './dist/esm/index.d.ts', default: './dist/esm/index.js' },
      require: { types: './dist/commonjs/index.d.ts', default: './dist/commonjs/index.js' },
    },
  };
}

const FORBIDDEN = 'The package no longer exposes a CommonJS-compatible entry point';

function assertNoCommonJsRemovalClaim(changes: readonly { kind: string; detail?: string }[]): void {
  assert.equal(
    changes.some((change) => change.kind === 'commonjs-entry-removed'),
    false,
    'must not claim the CommonJS entry point was removed',
  );
  assert.equal(
    changes.some((change) => change.kind === 'package-type-changed'),
    false,
    'must not claim the package became ESM without a CommonJS entry point',
  );
  assert.equal(changes.some((change) => change.detail === FORBIDDEN), false, FORBIDDEN);
}

describe('dual ESM/CommonJS packages keep their require() path', () => {
  test('lru-cache 7.18.3 -> 10.4.3', async () => {
    reset();
    stubManifests({
      '/lru-cache@7.18.3/package.json': {
        name: 'lru-cache',
        main: 'index.js',
        module: './index.mjs',
        exports: { './package.json': './package.json', '.': { import: './index.mjs', require: './index.js' } },
      },
      '/lru-cache@10.4.3/package.json': {
        name: 'lru-cache',
        type: 'module',
        exports: {
          ...(tshyExports() as Record<string, unknown>),
          './min': {
            import: { types: './dist/esm/index.d.ts', default: './dist/esm/index.min.js' },
            require: { types: './dist/commonjs/index.d.ts', default: './dist/commonjs/index.min.js' },
          },
        },
      },
    });

    const changes = await diffPackageModuleMetadata('lru-cache', '7.18.3', '10.4.3');
    assertNoCommonJsRemovalClaim(changes);
    assert.deepEqual(changes, []);
  });

  test('glob 7.2.3 -> 10.4.5', async () => {
    reset();
    stubManifests({
      '/glob@7.2.3/package.json': { name: 'glob', main: 'glob.js' },
      '/glob@10.4.5/package.json': { name: 'glob', type: 'module', exports: tshyExports() },
    });

    const changes = await diffPackageModuleMetadata('glob', '7.2.3', '10.4.5');
    assertNoCommonJsRemovalClaim(changes);
  });

  test('rimraf 3.0.2 -> 5.0.10', async () => {
    reset();
    stubManifests({
      '/rimraf@3.0.2/package.json': { name: 'rimraf', main: 'rimraf.js' },
      '/rimraf@5.0.10/package.json': { name: 'rimraf', type: 'module', exports: tshyExports() },
    });

    const changes = await diffPackageModuleMetadata('rimraf', '3.0.2', '5.0.10');
    assertNoCommonJsRemovalClaim(changes);
  });

  test('a root "type": "module" alone cannot override an explicit require condition', async () => {
    reset();
    stubManifests({
      '/demo@1.0.0/package.json': { main: './index.js' },
      '/demo@2.0.0/package.json': {
        type: 'module',
        // The require target is a plain `.js` under a directory Drift has not
        // inspected. That is unknown, and unknown is not removal.
        exports: { '.': { import: './dist/esm/index.js', require: './dist/commonjs/index.js' } },
      },
    });

    const changes = await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0');
    assertNoCommonJsRemovalClaim(changes);
  });

  test('a nested "type": "commonjs" marker is honoured', async () => {
    reset();
    stubManifests({
      '/demo@1.0.0/package.json': { main: './index.js' },
      '/demo@2.0.0/package.json': {
        type: 'module',
        main: './dist/commonjs/index.js',
      },
      '/demo@2.0.0/dist/commonjs/package.json': { type: 'commonjs' },
    });

    const changes = await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0');
    assertNoCommonJsRemovalClaim(changes);
  });

  test('a nested "type": "module" marker is honoured too', async () => {
    reset();
    stubManifests({
      '/demo@1.0.0/package.json': { main: './index.js' },
      '/demo@2.0.0/package.json': { main: './dist/esm/index.js' },
      '/demo@2.0.0/dist/esm/package.json': { type: 'module' },
    });

    const changes = await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0');
    assert.deepEqual(changes.map((change) => change.kind), ['commonjs-entry-removed']);
  });
});

describe('genuine CommonJS removals are still detected', () => {
  test('a removed root require condition is reported', async () => {
    reset();
    stubManifests({
      '/demo@1.0.0/package.json': { exports: { '.': { import: './index.mjs', require: './index.cjs' } } },
      '/demo@2.0.0/package.json': { type: 'module', exports: { '.': { import: './index.mjs' } } },
    });

    const changes = await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0');
    assert.deepEqual(changes.map((change) => change.kind), ['exports-require-condition-removed']);
  });

  test('a root CommonJS main replaced by an ESM entry is reported', async () => {
    reset();
    stubManifests({
      '/demo@1.0.0/package.json': { main: './index.js' },
      '/demo@2.0.0/package.json': { type: 'module', main: './index.mjs' },
    });

    const changes = await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0');
    assert.deepEqual(changes.map((change) => change.kind), ['commonjs-entry-removed']);
  });

  test('a require condition retargeted at ESM is reported', async () => {
    reset();
    stubManifests({
      '/demo@1.0.0/package.json': { exports: { '.': { require: './index.cjs' } } },
      '/demo@2.0.0/package.json': { type: 'module', exports: { '.': { require: './index.mjs' } } },
    });

    const changes = await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0');
    assert.deepEqual(changes.map((change) => change.kind), ['commonjs-entry-removed']);
  });

  test('a removed subpath require condition is reported even when the root survives', async () => {
    reset();
    stubManifests({
      '/demo@1.0.0/package.json': {
        type: 'module',
        exports: {
          '.': { import: './dist/esm/index.js', require: './dist/commonjs/index.js' },
          './helpers': { import: './dist/esm/helpers.js', require: './dist/commonjs/helpers.js' },
        },
      },
      '/demo@2.0.0/package.json': {
        type: 'module',
        exports: {
          '.': { import: './dist/esm/index.js', require: './dist/commonjs/index.js' },
          './helpers': { import: './dist/esm/helpers.js' },
        },
      },
    });

    const changes = await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0');
    assert.deepEqual(changes.map((change) => change.kind), ['exports-require-condition-removed']);
    assert.deepEqual(changes[0]?.moduleSystem?.affectedSpecifiers, ['demo/helpers']);
    assertNoCommonJsRemovalClaim(changes);
  });
});
