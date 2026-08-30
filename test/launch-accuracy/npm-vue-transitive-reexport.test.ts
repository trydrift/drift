import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTypeSurface, clearTypeSurfaceCache, diffSurfaces } from '../../dist/evidence/type-surface.js';
import { clearHttpCache } from '../../dist/util/http.js';

/**
 * The exact shape of issue #144, kept as a named regression.
 *
 * Vue's public surface is three packages deep:
 *
 *   vue -> @vue/runtime-dom -> @vue/runtime-core -> ref / computed / watch
 *
 * Following one dependency hop saw those three as removed, and reported it
 * with high confidence — the single most damaging kind of wrong answer Drift
 * can give, because it is exactly the question it exists to answer.
 *
 * The generic traversal behaviour (depth, budget, cycles, named edges,
 * implementation isolation) is covered in `test/type-surface-reexport-graph.test.ts`.
 * This file pins the named reproduction and, importantly, what Drift must
 * never say about it.
 */

const realFetch = globalThis.fetch;

interface FakePackage {
  manifest: Record<string, unknown>;
  files: Record<string, string>;
}

function stubRegistry(packages: Record<string, FakePackage>): void {
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return Promise.resolve(new Response('', { status: 404 }));
    }

    if (parsed.hostname === 'data.jsdelivr.com' && parsed.searchParams.get('structure') === 'flat') {
      const key = decodeURIComponent(parsed.pathname.split('/npm/')[1] ?? '');
      const found = packages[key];
      if (!found) return Promise.resolve(new Response('{}', { status: 404 }));
      const names = ['package.json', ...Object.keys(found.files)].map((name) => ({ name: `/${name}` }));
      return Promise.resolve(new Response(JSON.stringify({ files: names }), { status: 200 }));
    }

    if (parsed.hostname === 'data.jsdelivr.com' && parsed.pathname.endsWith('/resolved')) {
      const name = decodeURIComponent(parsed.pathname.split('/npm/')[1]?.replace(/\/resolved$/, '') ?? '');
      const version = name.startsWith('@vue/') ? RESOLVED[name] : undefined;
      return Promise.resolve(
        version
          ? new Response(JSON.stringify({ version }), { status: 200 })
          : new Response(JSON.stringify({}), { status: 404 }),
      );
    }

    if (parsed.hostname === 'cdn.jsdelivr.net') {
      const rest = decodeURIComponent(parsed.pathname.replace('/npm/', ''));
      const at = rest.indexOf('/', rest.indexOf('@', 1) + 1);
      const key = rest.slice(0, at);
      const path = rest.slice(at + 1);
      const found = packages[key];
      if (!found) return Promise.resolve(new Response('', { status: 404 }));
      if (path === 'package.json') {
        return Promise.resolve(new Response(JSON.stringify(found.manifest), { status: 200 }));
      }
      const content = found.files[path];
      return Promise.resolve(
        content === undefined ? new Response('', { status: 404 }) : new Response(content, { status: 200 }),
      );
    }

    return Promise.resolve(new Response('', { status: 404 }));
  }) as typeof fetch;
}

/** Every `@vue/*` dependency in this fixture resolves to the same line. */
let RESOLVED: Record<string, string> = {};

function vueGraph(version: string): Record<string, FakePackage> {
  RESOLVED = { '@vue/runtime-dom': version, '@vue/runtime-core': version, '@vue/reactivity': version };
  const dep = (name: string): Record<string, unknown> => ({ [name]: `^${version}` });
  return {
    [`vue@${version}`]: {
      manifest: { types: 'index.d.ts', dependencies: dep('@vue/runtime-dom') },
      files: { 'index.d.ts': 'export * from "@vue/runtime-dom";' },
    },
    [`@vue/runtime-dom@${version}`]: {
      manifest: { types: 'index.d.ts', dependencies: dep('@vue/runtime-core') },
      files: {
        'index.d.ts':
          'export * from "@vue/runtime-core";\nexport declare function render(): void;',
      },
    },
    [`@vue/runtime-core@${version}`]: {
      manifest: { types: 'index.d.ts', dependencies: dep('@vue/reactivity') },
      files: {
        'index.d.ts':
          'export * from "@vue/reactivity";\nexport declare function watch(source: unknown, cb: () => void): void;\nexport declare function defineComponent(options: unknown): unknown;',
      },
    },
    [`@vue/reactivity@${version}`]: {
      manifest: { types: 'index.d.ts' },
      files: {
        'index.d.ts':
          'export declare function ref<T>(value: T): { value: T };\nexport declare function computed<T>(getter: () => T): { value: T };',
      },
    },
  };
}

function reset(): void {
  clearHttpCache();
  clearTypeSurfaceCache();
}

afterEach(() => {
  globalThis.fetch = realFetch;
  reset();
});

const names = (api: Map<string, { name: string }> | undefined): Set<string> =>
  new Set([...(api?.values() ?? [])].map((entry) => entry.name));

describe('Vue transitive public re-exports', () => {
  test('ref, computed and watch are part of vue’s public surface', async () => {
    reset();
    stubRegistry(vueGraph('3.5.13'));

    const surface = await fetchTypeSurface('vue', '3.5.13');
    const surfaced = names(surface?.api);

    for (const symbol of ['ref', 'computed', 'watch', 'defineComponent', 'render']) {
      assert.ok(surfaced.has(symbol), `vue exposes ${symbol}`);
    }
    assert.equal(surface?.incomplete, false, 'the whole public graph was traversed');
  });

  test('an ordinary vue upgrade reports no removed exports', async () => {
    reset();
    stubRegistry({ ...vueGraph('3.5.13'), ...vueGraph('3.5.14') });
    // `vueGraph` resets the shared resolution table, so re-point it at the
    // version each surface is fetched for.
    RESOLVED = { '@vue/runtime-dom': '3.5.13', '@vue/runtime-core': '3.5.13', '@vue/reactivity': '3.5.13' };
    const before = await fetchTypeSurface('vue', '3.5.13');
    RESOLVED = { '@vue/runtime-dom': '3.5.14', '@vue/runtime-core': '3.5.14', '@vue/reactivity': '3.5.14' };
    const after = await fetchTypeSurface('vue', '3.5.14');

    const changes = diffSurfaces(before!.api, after!.api, { beforeComplete: true, afterComplete: true });
    const removed = changes.filter((change) => change.kind === 'export-removed');

    assert.deepEqual(
      removed.map((change) => change.symbol),
      [],
      'no export may be reported as removed merely because it lives further down the graph',
    );
    for (const symbol of ['ref', 'computed', 'watch']) {
      assert.ok(!removed.some((change) => change.symbol === symbol), `must not claim ${symbol} was removed`);
    }
  });

  test('a genuine removal deep in the graph is still reported', async () => {
    reset();
    const after = vueGraph('3.5.14');
    after['@vue/reactivity@3.5.14']!.files['index.d.ts'] =
      'export declare function computed<T>(getter: () => T): { value: T };';
    stubRegistry({ ...vueGraph('3.5.13'), ...after });

    RESOLVED = { '@vue/runtime-dom': '3.5.13', '@vue/runtime-core': '3.5.13', '@vue/reactivity': '3.5.13' };
    const before = await fetchTypeSurface('vue', '3.5.13');
    RESOLVED = { '@vue/runtime-dom': '3.5.14', '@vue/runtime-core': '3.5.14', '@vue/reactivity': '3.5.14' };
    const upgraded = await fetchTypeSurface('vue', '3.5.14');

    const removed = diffSurfaces(before!.api, upgraded!.api, { beforeComplete: true, afterComplete: true })
      .filter((change) => change.kind === 'export-removed')
      .map((change) => change.symbol);

    assert.deepEqual(removed, ['ref']);
  });
});
