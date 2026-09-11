import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  definitelyTypedTarget,
  resolveDefinitelyTypedEntry,
} from '../dist/evidence/type-surface.js';
import { clearHttpCache } from '../dist/util/http.js';

/**
 * Packages whose declarations ship separately.
 *
 * express, lodash and a large share of npm publish no `.d.ts` of their own —
 * their types live in `@types/<pkg>`, versioned on DefinitelyTyped's own
 * schedule. Drift already fell back to that package, but resolved `@latest`
 * for *both* sides of an upgrade, so before and after were the same bytes by
 * construction: zero differences, every time, for every such package. The
 * upgrade then reported "nothing was compared" no matter how much had changed.
 *
 * DefinitelyTyped versions its majors to match what they describe, so
 * `@types/express@4` is express 4's API and `@types/express@5` is express 5's.
 * Resolving each side to its own major is what makes the comparison mean
 * anything. When both sides land on the same `@types` release there is still
 * genuinely nothing to compare, and the equal entry paths are what tell
 * `computeTypeSurface` to keep saying so.
 */

const realFetch = globalThis.fetch;

/** Serves `index.d.ts` for exactly the `@types` ranges named, 404s the rest. */
function servePublished(ranges: readonly string[]): { calls: () => string[] } {
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const match = /@types\/[^@]+@([^/]+)\/index\.d\.ts$/.exec(url);
    const ok = match !== null && ranges.includes(match[1]!);
    return Promise.resolve(
      ok ? new Response('export declare function noop(): void;\n') : new Response('nope', { status: 404 }),
    );
  }) as typeof fetch;
  return { calls: () => calls };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

describe('resolving the @types release that documents a version', () => {
  test('each side of an upgrade resolves to its own major', async () => {
    servePublished(['4', '5', 'latest']);

    assert.equal(await resolveDefinitelyTypedEntry('express', '4.17.1'), '@types:@types/express@4');
    assert.equal(await resolveDefinitelyTypedEntry('express', '5.2.1'), '@types:@types/express@5');
  });

  test('two versions on one major resolve to the same release, so nothing is compared', async () => {
    servePublished(['4', 'latest']);

    const before = await resolveDefinitelyTypedEntry('lodash', '4.17.20');
    const after = await resolveDefinitelyTypedEntry('lodash', '4.18.1');
    assert.equal(before, after, 'equal entry paths are what decline the comparison');
    assert.equal(before, '@types:@types/lodash@4');
  });

  test('a major DefinitelyTyped has no release for falls back to latest', async () => {
    servePublished(['latest']);
    assert.equal(await resolveDefinitelyTypedEntry('express', '9.0.0'), '@types:@types/express@latest');
  });

  test('a single-segment version still yields its major', async () => {
    servePublished(['7', 'latest']);
    assert.equal(await resolveDefinitelyTypedEntry('pkg', '7'), '@types:@types/pkg@7');
  });

  test('a scoped package uses DefinitelyTyped’s flattened name', async () => {
    const stub = servePublished(['3', 'latest']);
    assert.equal(await resolveDefinitelyTypedEntry('@scope/pkg', '3.1.0'), '@types:@types/scope__pkg@3');
    assert.ok(stub.calls().some((url) => url.includes('@types/scope__pkg@3/index.d.ts')));
  });

  test('no @types package at all resolves to nothing, never to an empty surface', async () => {
    servePublished([]);
    assert.equal(await resolveDefinitelyTypedEntry('nothing-here', '1.0.0'), null);
  });
});

describe('reading the resolved entry path back', () => {
  test('splits the package from the range it was pinned to', () => {
    assert.deepEqual(definitelyTypedTarget('@types:@types/express@4'), {
      name: '@types/express',
      range: '4',
    });
    assert.deepEqual(definitelyTypedTarget('@types:@types/scope__pkg@latest'), {
      name: '@types/scope__pkg',
      range: 'latest',
    });
  });

  test('an unpinned path is read as latest rather than mis-split on the scope', () => {
    assert.deepEqual(definitelyTypedTarget('@types:@types/express'), {
      name: '@types/express',
      range: 'latest',
    });
  });
});
