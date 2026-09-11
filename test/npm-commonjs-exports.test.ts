import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { diffPackageModuleMetadata } from '../dist/evidence/type-surface.js';
import { clearHttpCache } from '../dist/util/http.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearHttpCache();
});

function mockManifests(before: unknown, after: unknown): void {
  clearHttpCache();
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('@1.0.0/package.json')) return Response.json(before);
    if (url.includes('@2.0.0/package.json')) return Response.json(after);
    return new Response('not found', { status: 404 });
  };
}

for (const packageName of ['lru-cache', 'glob', 'rimraf']) {
  test(`${packageName}: explicit require accepts an ambiguous .js target under type=module`, async () => {
    mockManifests(
      { main: './index.js' },
      {
        type: 'module',
        exports: {
          '.': {
            import: './dist/esm/index.js',
            require: { types: './dist/commonjs/index.d.ts', default: './dist/commonjs/index.js' },
          },
        },
      },
    );

    assert.deepEqual(await diffPackageModuleMetadata(packageName, '1.0.0', '2.0.0'), []);
  });
}

test('explicit require accepts a .cjs target', async () => {
  mockManifests(
    { main: './index.js' },
    { type: 'module', exports: { '.': { require: './index.cjs' } } },
  );

  assert.deepEqual(await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0'), []);
});

test('explicit require does not accept a .mjs target', async () => {
  mockManifests(
    { main: './index.js' },
    { type: 'module', exports: { '.': { require: './index.mjs' } } },
  );

  assert.deepEqual(
    (await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0')).map((change) => change.kind),
    ['commonjs-entry-removed'],
  );
});

test('require: null is unavailable', async () => {
  mockManifests(
    { main: './index.js' },
    { type: 'module', exports: { '.': { require: null } } },
  );

  assert.deepEqual(
    (await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0')).map((change) => change.kind),
    ['commonjs-entry-removed'],
  );
});

test('genuine removal of a require condition remains breaking', async () => {
  mockManifests(
    { type: 'module', exports: { '.': { import: './index.js', require: './index.cjs' } } },
    { type: 'module', exports: { '.': { import: './index.js' } } },
  );

  assert.deepEqual(
    (await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0')).map((change) => change.kind),
    ['exports-require-condition-removed'],
  );
});

test('ordinary main fallback still follows the root package type', async () => {
  mockManifests(
    { main: './index.js' },
    { type: 'module', main: './index.js' },
  );

  assert.deepEqual(
    (await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0')).map((change) => change.kind),
    ['commonjs-entry-removed'],
  );
});
