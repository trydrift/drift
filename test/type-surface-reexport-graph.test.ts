import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchTypeSurface,
  clearTypeSurfaceCache,
  diffSurfaces,
  recursivePublicFollowCount,
} from '../dist/evidence/type-surface.js';
import { clearHttpCache } from '../dist/util/http.js';

/**
 * A wrapper package re-exports another package, which re-exports another, and
 * the symbol a developer actually calls is only declared in the last hop:
 *
 *   vue -> @vue/runtime-dom -> @vue/runtime-core -> @vue/reactivity
 *
 * Following one level saw `ref`, `computed` and `watch` as removed. The
 * traversal now recurses along public re-export edges only, bounded by depth
 * and a shared package budget, and terminates on cycles.
 */

const realFetch = globalThis.fetch;

interface FakePackage {
  manifest: Record<string, unknown>;
  files: Record<string, string>;
}

/** A registry of fake published packages, served through a stubbed `fetch`. */
function stubRegistry(
  packages: Record<string, FakePackage>,
  options: { delay?: (url: string) => number; unresolvable?: readonly string[] } = {},
): { calls: () => string[] } {
  const unresolvable = new Set(options.unresolvable ?? []);
  const calls: string[] = [];
  const base = (input: string | URL | Request): Promise<Response> => {
    const url = String(input);

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return Promise.resolve(new Response('', { status: 404 }));
    }

    // jsDelivr flat file listing.
    if (parsed.hostname === 'data.jsdelivr.com' && parsed.searchParams.get('structure') === 'flat') {
      const key = decodeURIComponent(parsed.pathname.split('/npm/')[1] ?? '');
      const pkg = packages[key];
      if (!pkg) return Promise.resolve(new Response('{}', { status: 404 }));
      const names = ['package.json', ...Object.keys(pkg.files)].map((name) => ({ name: `/${name}` }));
      return Promise.resolve(new Response(JSON.stringify({ files: names }), { status: 200 }));
    }

    // Range resolution. A name in `options.unresolvable` fails the way jsDelivr
    // does for a range it cannot satisfy (no `version` in the body); every
    // other fake dependency resolves to 1.0.0.
    if (parsed.hostname === 'data.jsdelivr.com' && parsed.pathname.endsWith('/resolved')) {
      const name = decodeURIComponent(parsed.pathname.split('/npm/')[1]?.replace(/\/resolved$/, '') ?? '');
      if (unresolvable.has(name)) {
        return Promise.resolve(new Response(JSON.stringify({}), { status: 404 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 }));
    }

    // CDN: package.json or a declaration file.
    if (parsed.hostname === 'cdn.jsdelivr.net') {
      const rest = decodeURIComponent(parsed.pathname.replace('/npm/', ''));
      const at = rest.indexOf('/', rest.indexOf('@') + 1);
      const key = rest.slice(0, at);
      const path = rest.slice(at + 1);
      const pkg = packages[key];
      if (!pkg) return Promise.resolve(new Response('', { status: 404 }));
      if (path === 'package.json') {
        return Promise.resolve(new Response(JSON.stringify(pkg.manifest), { status: 200 }));
      }
      const content = pkg.files[path];
      return Promise.resolve(
        content === undefined ? new Response('', { status: 404 }) : new Response(content, { status: 200 }),
      );
    }

    return Promise.resolve(new Response('', { status: 404 }));
  };

  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const pending = base(input);
    const ms = options.delay?.(url) ?? 0;
    return ms > 0
      ? pending.then(
          (response) => new Promise<Response>((resolve) => setTimeout(() => resolve(response), ms)),
        )
      : pending;
  }) as typeof fetch;
  return { calls: () => calls };
}

function pkg(entry: string, deps: string[] = []): FakePackage {
  return {
    manifest: {
      types: 'index.d.ts',
      ...(deps.length > 0
        ? { dependencies: Object.fromEntries(deps.map((d) => [d, '^1.0.0'])) }
        : {}),
    },
    files: { 'index.d.ts': entry },
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

describe('bounded public re-export graph traversal', () => {
  test('two-hop star re-export reaches the leaf symbol', async () => {
    reset();
    stubRegistry({
      'w@1.0.0': pkg('export * from "mid";', ['mid']),
      'mid@1.0.0': pkg('export * from "leaf";', ['leaf']),
      'leaf@1.0.0': pkg('export declare function deep(a: string): void;'),
    });

    const surface = await fetchTypeSurface('w', '1.0.0');
    assert.ok(names(surface?.api).has('deep'), 'the two-hop leaf symbol is present');
    assert.equal(surface?.incomplete, false);
  });

  test('three-hop star re-export reaches the leaf symbol', async () => {
    reset();
    stubRegistry({
      'w@1.0.0': pkg('export * from "a";', ['a']),
      'a@1.0.0': pkg('export * from "b";', ['b']),
      'b@1.0.0': pkg('export * from "c";', ['c']),
      'c@1.0.0': pkg('export declare function tripleHop(): number;'),
    });

    const surface = await fetchTypeSurface('w', '1.0.0');
    assert.ok(names(surface?.api).has('tripleHop'), 'the three-hop leaf symbol is present');
  });

  test('named multi-hop re-export exposes only the selected name', async () => {
    reset();
    stubRegistry({
      'w@1.0.0': pkg('export { onlyThis } from "a";', ['a']),
      'a@1.0.0': pkg('export * from "b";', ['b']),
      'b@1.0.0': pkg(
        'export declare function onlyThis(): void;\nexport declare function other(): void;',
      ),
    });

    const surface = await fetchTypeSurface('w', '1.0.0');
    const surfaced = names(surface?.api);
    assert.ok(surfaced.has('onlyThis'), 'the selected name crosses both hops');
    assert.ok(!surfaced.has('other'), 'a sibling the parent did not name stays private');
  });

  test('a cyclic re-export terminates and keeps both packages’ symbols', async () => {
    reset();
    stubRegistry({
      'p@1.0.0': pkg('export * from "q";\nexport declare function pSym(): void;', ['q']),
      'q@1.0.0': pkg('export * from "p";\nexport declare function qSym(): void;', ['p']),
    });

    const surface = await fetchTypeSurface('p', '1.0.0');
    const surfaced = names(surface?.api);
    assert.ok(surfaced.has('pSym') && surfaced.has('qSym'), 'the cycle resolved without looping');
  });

  test('an implementation-only import does not leak into the public surface', async () => {
    reset();
    stubRegistry({
      'w@1.0.0': pkg('import { Helper } from "impl";\nexport declare function use(): void;', ['impl']),
      'impl@1.0.0': pkg('export declare class Helper {}'),
    });

    const surface = await fetchTypeSurface('w', '1.0.0');
    const surfaced = names(surface?.api);
    assert.ok(surfaced.has('use'), 'the package’s own export is present');
    assert.ok(!surfaced.has('Helper'), 'an unreferenced implementation import is not re-exported');
  });

  test('a genuine leaf removal propagates through the wrapper', async () => {
    reset();
    stubRegistry({
      'w@1.0.0': pkg('export * from "mid";', ['mid']),
      'mid@1.0.0': pkg('export * from "leaf";', ['leaf']),
      'leaf@1.0.0': pkg('export declare function gone(): void;\nexport declare function stay(): void;'),
    });
    const before = await fetchTypeSurface('w', '1.0.0');

    globalThis.fetch = realFetch;
    reset();
    stubRegistry({
      'w@2.0.0': pkg('export * from "mid";', ['mid']),
      'mid@1.0.0': pkg('export * from "leaf";', ['leaf']),
      'leaf@1.0.0': pkg('export declare function stay(): void;'),
    });
    const after = await fetchTypeSurface('w', '2.0.0');

    const changes = diffSurfaces(before!.api, after!.api, { beforeComplete: true, afterComplete: true });
    assert.ok(
      changes.some((c) => c.kind === 'export-removed' && c.symbol === 'gone'),
      'the leaf removal is reported against the wrapper',
    );
    assert.ok(!changes.some((c) => c.symbol === 'stay'), 'a surviving symbol is not reported');
  });

  test('a traversal limit does not become a false export-removed', async () => {
    // `after` is deliberately truncatable: the missing symbol lives behind an
    // unreachable re-export target, so its absence is Drift’s incompleteness,
    // not a removal.
    reset();
    stubRegistry({
      'w@1.0.0': pkg('export * from "mid";\nexport declare function anchor(): void;', ['mid']),
      'mid@1.0.0': pkg('export * from "leaf";', ['leaf']),
      'leaf@1.0.0': pkg('export declare function present(): void;\nexport declare function fragile(): void;'),
    });
    const before = await fetchTypeSurface('w', '1.0.0');

    globalThis.fetch = realFetch;
    reset();
    stubRegistry({
      'w@2.0.0': pkg('export * from "mid";\nexport declare function anchor(): void;', ['mid']),
      'mid@1.0.0': pkg('export * from "leaf";', ['leaf']),
      // leaf is unfetchable in the "after" world: a re-export hole.
    });
    const after = await fetchTypeSurface('w', '2.0.0');
    assert.equal(after?.incomplete, true, 'the unreachable re-export marks the surface incomplete');

    const changes = diffSurfaces(before!.api, after!.api, {
      beforeComplete: !before?.incomplete,
      afterComplete: !after?.incomplete,
    });
    assert.ok(
      !changes.some((c) => c.kind === 'export-removed'),
      'no confident removal is reported from an incomplete surface',
    );
  });

  /**
   * A star re-export tree `fanout` wide and `depth` deep, every node a distinct
   * package, every leaf symbol unique. Fully expanding it would follow
   * `fanout + fanout^2 + … + fanout^depth` packages — far past the budget — so
   * it is the shape that exposes a bound that only limits each branch.
   */
  function wideDeepGraph(fanout: number, depth: number): Record<string, FakePackage> {
    const packages: Record<string, FakePackage> = {};
    const build = (id: string, level: number): void => {
      if (level === depth) {
        packages[`${id}@1.0.0`] = pkg(`export declare function ${id}leaf(): void;`);
        return;
      }
      const children = Array.from({ length: fanout }, (_, i) => `${id}_${i}`);
      packages[`${id}@1.0.0`] = pkg(
        [
          ...children.map((c) => `export * from "${c}";`),
          `export declare function ${id}own(): void;`,
        ].join('\n'),
        children,
      );
      for (const c of children) build(c, level + 1);
    };
    build('root', 0);
    return packages;
  }

  test('the follow budget bounds the whole traversal tree, not each branch', async () => {
    reset();
    // 4 wide, 5 deep: 4+16+64+256+1024 = 1364 packages if the bound were
    // per-branch instead of global.
    stubRegistry(wideDeepGraph(4, 4));

    const surface = await fetchTypeSurface('root', '1.0.0');

    assert.ok(surface, 'the entry surface still resolves');
    assert.ok(
      recursivePublicFollowCount() <= 24,
      `followed ${recursivePublicFollowCount()} packages recursively, ceiling is 24`,
    );
    // And it did spend the budget rather than stopping early — a per-branch
    // bound would have followed far more; a broken traversal, far fewer.
    assert.equal(recursivePublicFollowCount(), 24, 'the global budget is fully and exactly consumed');
    assert.equal(surface?.incomplete, true, 'an unreachable re-export edge marks the surface incomplete');
  });

  test('an incomplete wide/deep traversal never emits a false export-removed', async () => {
    reset();
    stubRegistry(wideDeepGraph(4, 4));
    const before = await fetchTypeSurface('root', '1.0.0');
    assert.equal(before?.incomplete, true);

    // Same graph, one leaf symbol genuinely gone — but the surface is
    // budget-truncated, so its absence cannot be told apart from the truncation.
    globalThis.fetch = realFetch;
    reset();
    const trimmed = wideDeepGraph(4, 4);
    const aLeaf = Object.keys(trimmed).find((k) => /leaf/.test(trimmed[k]!.files['index.d.ts']!))!;
    trimmed[aLeaf] = pkg('export declare function somethingElse(): void;');
    stubRegistry(trimmed);
    const after = await fetchTypeSurface('root', '1.0.0');

    const changes = diffSurfaces(before!.api, after!.api, {
      beforeComplete: !before?.incomplete,
      afterComplete: !after?.incomplete,
    });
    assert.ok(
      !changes.some((c) => c.kind === 'export-removed'),
      'a truncated traversal suppresses via-dependency removals',
    );
  });

  test('traversal is deterministic when dependency resolution completes in reversed order', async () => {
    const graph = wideDeepGraph(3, 4);
    const urls = Object.keys(graph).map((k) => k.replace('@1.0.0', ''));

    const run = async (delay: (url: string) => number): Promise<{ keys: string[]; incomplete: boolean }> => {
      globalThis.fetch = realFetch;
      reset();
      stubRegistry(graph, { delay });
      const surface = await fetchTypeSurface('root', '1.0.0');
      return {
        keys: [...(surface?.api.keys() ?? [])].sort(),
        incomplete: surface?.incomplete ?? false,
      };
    };

    // Forward: later packages settle later. Reversed: later packages settle first.
    const forward = await run((url) => {
      const i = urls.findIndex((name) => url.includes(`/npm/${name}`));
      return i >= 0 ? 1 + i : 0;
    });
    const reversed = await run((url) => {
      const i = urls.findIndex((name) => url.includes(`/npm/${name}`));
      return i >= 0 ? 1 + (urls.length - i) : 0;
    });

    assert.deepEqual(reversed.keys, forward.keys, 'the merged surface is identical regardless of completion order');
    assert.equal(reversed.incomplete, forward.incomplete, 'the incomplete flag is identical regardless of completion order');
  });

  test('more than eight public re-export edges are all followed, not silently capped at eight', async () => {
    reset();
    const deps = Array.from({ length: 12 }, (_, i) => `edge${i}`);
    stubRegistry({
      'w@1.0.0': pkg(deps.map((d) => `export * from "${d}";`).join('\n'), deps),
      ...Object.fromEntries(
        deps.map((d, i) => [`${d}@1.0.0`, pkg(`export declare function sym${i}(): void;`)]),
      ),
    });

    const surface = await fetchTypeSurface('w', '1.0.0');
    const surfaced = names(surface?.api);
    // The 9th..12th edges used to be dropped by a MAX_FOLLOWED_DEPENDENCIES=8
    // bound with no incompleteness marker — a false `export-removed` waiting to
    // happen. Every public edge is inspected now.
    for (let i = 0; i < 12; i += 1) {
      assert.ok(surfaced.has(`sym${i}`), `edge ${i}'s symbol is present`);
    }
    assert.equal(surface?.incomplete, false, 'every public edge was fully followed');
  });

  test('a public edge left unfollowed when the budget is exhausted marks the surface incomplete', async () => {
    // Twelve public edges, each a four-deep chain: expanding them all would far
    // exceed MAX_TOTAL_FOLLOWED_PACKAGES, so the later edges cannot be inspected.
    reset();
    const edges = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const chain = (id: string): Record<string, FakePackage> => ({
      [`${id}@1.0.0`]: pkg(`export * from "${id}_a";`, [`${id}_a`]),
      [`${id}_a@1.0.0`]: pkg(`export * from "${id}_b";`, [`${id}_b`]),
      [`${id}_b@1.0.0`]: pkg(`export * from "${id}_c";`, [`${id}_c`]),
      [`${id}_c@1.0.0`]: pkg(`export declare function ${id}deep(): void;`),
    });
    stubRegistry({
      'w@1.0.0': pkg(edges.map((e) => `export * from "${e}";`).join('\n'), edges),
      ...Object.assign({}, ...edges.map(chain)),
    });

    const before = await fetchTypeSurface('w', '1.0.0');
    assert.equal(before?.incomplete, true, 'the budget could not cover every public edge');

    // The same graph in an "after" world with one deep leaf symbol genuinely
    // gone. Because the surface is budget-truncated its absence cannot be told
    // apart from the truncation, so no confident removal may be emitted.
    globalThis.fetch = realFetch;
    reset();
    const trimmed = {
      'w@2.0.0': pkg(edges.map((e) => `export * from "${e}";`).join('\n'), edges),
      ...Object.assign({}, ...edges.map(chain)),
    };
    trimmed['c11_c@1.0.0'] = pkg('export declare function somethingElse(): void;');
    stubRegistry(trimmed);
    const after = await fetchTypeSurface('w', '2.0.0');

    const changes = diffSurfaces(before!.api, after!.api, {
      beforeComplete: !before?.incomplete,
      afterComplete: !after?.incomplete,
    });
    assert.ok(
      !changes.some((c) => c.kind === 'export-removed'),
      'an incomplete traversal never yields a confident export-removed',
    );
  });

  test('a public re-export edge whose version cannot be resolved marks the surface incomplete', async () => {
    reset();
    // `unresolvable` IS a published package here — its listing and declarations
    // resolve fine — but jsDelivr cannot satisfy the declared range, so
    // `resolveDependencyVersion` returns null. That is the case under test: a
    // resolution failure, not a fetch failure.
    const stub = stubRegistry(
      {
        'w@1.0.0': pkg('export * from "unresolvable";\nexport declare function own(): void;', ['unresolvable']),
        'unresolvable@1.0.0': pkg('export declare function hidden(): void;'),
      },
      { unresolvable: ['unresolvable'] },
    );

    const surface = await fetchTypeSurface('w', '1.0.0');
    assert.ok(names(surface?.api).has('own'), 'the wrapper’s own symbol is still read');
    assert.ok(!names(surface?.api).has('hidden'), 'the unresolved edge contributed nothing');
    assert.equal(
      surface?.incomplete,
      true,
      'an unresolved public re-export dependency is a hole, not proof it exports nothing',
    );
    assert.ok(
      stub.calls().some((u) => u.includes('/unresolvable/resolved')),
      'resolution was actually attempted',
    );
    assert.ok(
      !stub.calls().some((u) => u.includes('cdn.jsdelivr.net') && u.includes('/unresolvable@')),
      'no surface fetch was attempted for a version that never resolved',
    );
  });

  test('a public re-export edge that resolves but cannot be fetched marks the surface incomplete', async () => {
    reset();
    // Version resolves to 1.0.0, but no `missingpkg@1.0.0` is published, so the
    // surface fetch 404s. A distinct failure mode from the one above, same
    // conservative outcome.
    stubRegistry({
      'w@1.0.0': pkg('export * from "missingpkg";\nexport declare function own(): void;', ['missingpkg']),
    });
    const surface = await fetchTypeSurface('w', '1.0.0');
    assert.ok(names(surface?.api).has('own'));
    assert.equal(surface?.incomplete, true, 'a re-exported package Drift could not fetch is also a hole');
  });

  test('an implementation-only edge whose version cannot be resolved does not mark the surface incomplete', async () => {
    reset();
    stubRegistry(
      {
        'w@1.0.0': pkg('import { Helper } from "missingimpl";\nexport declare function use(): Helper;', ['missingimpl']),
        'missingimpl@1.0.0': pkg('export declare class Helper {}'),
      },
      { unresolvable: ['missingimpl'] },
    );
    const surface = await fetchTypeSurface('w', '1.0.0');
    assert.equal(
      surface?.incomplete,
      false,
      'an implementation reference cannot hide part of the public API, resolved or not',
    );
  });

  test('the followed set is identical regardless of per-dependency resolution delay', async () => {
    const graph = {
      'w@1.0.0': pkg(
        ['a', 'b', 'c', 'd'].map((d) => `export * from "${d}";`).join('\n'),
        ['a', 'b', 'c', 'd'],
      ),
      'a@1.0.0': pkg('export declare function aSym(): void;'),
      'b@1.0.0': pkg('export declare function bSym(): void;'),
      'c@1.0.0': pkg('export declare function cSym(): void;'),
      'd@1.0.0': pkg('export declare function dSym(): void;'),
    };
    const run = async (delay: (url: string) => number) => {
      globalThis.fetch = realFetch;
      reset();
      stubRegistry(graph, { delay });
      const surface = await fetchTypeSurface('w', '1.0.0');
      return {
        keys: [...(surface?.api.keys() ?? [])].sort(),
        via: [...(surface?.viaDependencies ?? [])].sort(),
        incomplete: surface?.incomplete ?? false,
      };
    };
    const forward = await run((url) => (/\/npm\/([abcd])\//.exec(url) ? 'abcd'.indexOf(RegExp.$1) + 1 : 0));
    const reversed = await run((url) => (/\/npm\/([abcd])\//.exec(url) ? 4 - 'abcd'.indexOf(RegExp.$1) : 0));
    assert.deepEqual(reversed, forward);
  });

  test(
    'Vue 3.5.42 surface contains ref, computed and watch',
    { skip: process.env.DRIFT_NETWORK_TESTS === '1' ? false : 'set DRIFT_NETWORK_TESTS=1' },
    async () => {
      reset();
      const surface = await fetchTypeSurface('vue', '3.5.42');
      const surfaced = names(surface?.api);
      for (const symbol of ['ref', 'computed', 'watch']) {
        assert.ok(surfaced.has(symbol), `vue re-exports ${symbol}`);
      }
    },
  );
});
