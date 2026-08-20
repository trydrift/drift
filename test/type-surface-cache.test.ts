import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTypeSurface, clearTypeSurfaceCache, diffPackageModuleMetadata } from '../dist/evidence/type-surface.js';
import { clearHttpCache } from '../dist/util/http.js';

/**
 * A published version is immutable, so reading one twice can only ever produce
 * the same answer — and a scan reads the same ones constantly, since every
 * candidate follows its own dependencies and a repository's dependencies
 * overlap heavily. Remembering a surface is therefore free correctness-wise
 * and a large saving in practice.
 *
 * Remembering the *absence* of one is not. Every fetch under this module
 * answers `null` for a package that publishes no declarations and for one
 * whose declarations timed out, so caching `null` would turn a single slow
 * response into "this package has no type surface" for the rest of the scan —
 * silently dropping the strongest evidence Drift has.
 */

const realFetch = globalThis.fetch;

function stubFetch(responder: (url: string) => Response | Promise<Response>): { calls: () => string[] } {
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    calls.push(String(input));
    return Promise.resolve(responder(String(input)));
  }) as typeof fetch;
  return { calls: () => calls };
}

function reset(): void {
  clearHttpCache();
  clearTypeSurfaceCache();
}

afterEach(() => {
  globalThis.fetch = realFetch;
  reset();
});

/**
 * Whether a request went to jsDelivr's metadata API rather than its CDN.
 *
 * The host is parsed out and compared, not searched for in the string: a
 * substring test says yes to `https://evil.example.com/data.jsdelivr.com/…`
 * as readily as to the real thing. That distinction does not matter to a stub
 * answering its own fixtures, but writing the check the loose way here teaches
 * the pattern, and the strict version is no harder to read.
 */
function isMetadataApi(url: string): boolean {
  try {
    return new URL(url).hostname === 'data.jsdelivr.com';
  } catch {
    return false;
  }
}

/** jsDelivr's flat file listing, which is how a version's contents are resolved. */
function listing(...files: string[]): Response {
  return new Response(JSON.stringify({ files: files.map((name) => ({ name: `/${name}` })) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('remembering the type surface of a published version', () => {
  test('a surface is read once, however many callers ask for it', async () => {
    reset();
    const stub = stubFetch((url) => {
      if (isMetadataApi(url)) return listing('package.json', 'index.d.ts');
      if (url.endsWith('/package.json')) return new Response('{"types":"index.d.ts"}', { status: 200 });
      if (url.endsWith('/index.d.ts')) return new Response('export declare function go(a: string): void;', { status: 200 });
      return new Response('', { status: 404 });
    });

    const first = await fetchTypeSurface('demo', '1.0.0');
    const requests = stub.calls().length;
    const second = await fetchTypeSurface('demo', '1.0.0');

    assert.ok(first?.api.has('go'), 'the surface was read');
    assert.equal(second, first, 'the second caller gets the very same surface');
    assert.equal(stub.calls().length, requests, 'and it cost no further requests');
  });

  test('two callers asking at once share one read rather than racing', async () => {
    reset();
    const stub = stubFetch((url) => {
      if (isMetadataApi(url)) return listing('package.json', 'index.d.ts');
      if (url.endsWith('/package.json')) return new Response('{"types":"index.d.ts"}', { status: 200 });
      if (url.endsWith('/index.d.ts')) return new Response('export declare const x: number;', { status: 200 });
      return new Response('', { status: 404 });
    });

    const [a, b] = await Promise.all([fetchTypeSurface('demo', '2.0.0'), fetchTypeSurface('demo', '2.0.0')]);
    assert.equal(a, b);
    assert.equal(
      stub.calls().filter((url) => url.endsWith('/index.d.ts')).length,
      1,
      'the declaration was fetched once for both callers',
    );
  });

  test('a version that could not be read is not remembered as having no surface', async () => {
    // The failure this guards: `null` means "nothing was read", and this module
    // cannot tell a package with no declarations from one whose declarations
    // timed out. Caching it would make one bad minute permanent.
    reset();
    let failing = true;
    stubFetch((url) => {
      if (failing) return new Response('', { status: 503 });
      if (isMetadataApi(url)) return listing('package.json', 'index.d.ts');
      if (url.endsWith('/package.json')) return new Response('{"types":"index.d.ts"}', { status: 200 });
      if (url.endsWith('/index.d.ts')) return new Response('export declare function late(): void;', { status: 200 });
      return new Response('', { status: 404 });
    });

    await assert.rejects(
      () => fetchTypeSurface('demo', '3.0.0'),
      /could not be fetched/,
      'an unreachable version is reported, not silently empty',
    );

    failing = false;
    clearHttpCache();

    const recovered = await fetchTypeSurface('demo', '3.0.0');
    assert.ok(recovered?.api.has('late'), 'the retry reads the surface the first attempt could not');
  });

  test('a package with nothing to compare is asked again rather than pinned as empty', () => {
    // `null` is not a fact worth keeping. The listing for an immutable version
    // is, so the retry is cheap — but it is a retry, and that is the property
    // that stops one bad minute from removing a package's evidence for the
    // rest of the scan.
    reset();
    const stub = stubFetch((url) => {
      if (isMetadataApi(url)) return listing('package.json');
      if (url.endsWith('/package.json')) return new Response('{"main":"index.js"}', { status: 200 });
      return new Response('', { status: 404 });
    });

    return (async () => {
      assert.equal(await fetchTypeSurface('demo', '4.0.0'), null, 'nothing to compare');
      const afterFirst = stub.calls().length;

      clearHttpCache();
      assert.equal(await fetchTypeSurface('demo', '4.0.0'), null);
      assert.ok(
        stub.calls().length > afterFirst,
        'the second ask does the work again instead of answering from a remembered absence',
      );
    })();
  });
});

describe('npm package module metadata diffing', () => {
  test('detects removal of CommonJS export conditions', async () => {
    reset();
    stubFetch((url) => {
      if (url.endsWith('/demo@1.0.0/package.json')) {
        return new Response(JSON.stringify({
          exports: { '.': { import: './index.mjs', require: './index.cjs' } },
        }), { status: 200 });
      }
      if (url.endsWith('/demo@2.0.0/package.json')) {
        return new Response(JSON.stringify({
          type: 'module',
          exports: { '.': { import: './index.js' } },
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const changes = await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0');

    assert.deepEqual(changes.map((change) => change.kind), ['exports-require-condition-removed']);
    assert.deepEqual(changes[0]?.moduleSystem?.affectedSpecifiers, ['demo']);
  });

  test('exports take precedence over a remaining CommonJS main fallback', async () => {
    reset();
    stubFetch((url) => {
      if (url.endsWith('/demo@1.0.0/package.json')) {
        return new Response(JSON.stringify({
          main: './index.cjs',
          exports: {
            '.': './index.cjs',
          },
        }), { status: 200 });
      }
      if (url.endsWith('/demo@2.0.0/package.json')) {
        return new Response(JSON.stringify({
          main: './index.cjs',
          type: 'module',
          exports: {
            '.': {
              import: './index.mjs',
              default: './index.mjs',
            },
          },
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const changes = await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0');

    assert.deepEqual(changes.map((change) => change.kind), ['commonjs-entry-removed']);
    assert.deepEqual(changes[0]?.moduleSystem?.affectedSpecifiers, ['demo']);
    assert.doesNotMatch(changes[0]?.after ?? '', /exports\.commonjs:.*demo/);
  });

  test('keeps removed require export conditions subpath-specific', async () => {
    reset();
    stubFetch((url) => {
      if (url.endsWith('/demo@1.0.0/package.json')) {
        return new Response(JSON.stringify({
          exports: {
            '.': { import: './index.mjs', require: './index.cjs' },
            './foo': { import: './foo.mjs', require: './foo.cjs' },
            './bar': { import: './bar.mjs', require: './bar.cjs' },
          },
        }), { status: 200 });
      }
      if (url.endsWith('/demo@2.0.0/package.json')) {
        return new Response(JSON.stringify({
          exports: {
            '.': { import: './index.mjs', require: './index.cjs' },
            './foo': { import: './foo.mjs' },
            './bar': { import: './bar.mjs', require: './bar.cjs' },
          },
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const changes = await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0');
    const moduleChanges = changes.filter((change) => change.kind === 'exports-require-condition-removed');

    assert.deepEqual(moduleChanges.map((change) => change.moduleSystem?.affectedSpecifiers), [['demo/foo']]);
    assert.equal(changes.some((change) => change.kind === 'commonjs-entry-removed'), false);
  });

  test('associates nested require conditions with their export path', async () => {
    reset();
    stubFetch((url) => {
      if (url.endsWith('/demo@1.0.0/package.json')) {
        return new Response(JSON.stringify({
          exports: {
            './foo': {
              node: {
                require: './foo.cjs',
                import: './foo.mjs',
              },
            },
          },
        }), { status: 200 });
      }
      if (url.endsWith('/demo@2.0.0/package.json')) {
        return new Response(JSON.stringify({
          exports: {
            './foo': {
              node: {
                import: './foo.mjs',
              },
            },
          },
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const changes = await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0');

    assert.deepEqual(
      changes.map((change) => change.moduleSystem?.affectedSpecifiers),
      [['demo/foo']],
    );
  });

  test('represents removed wildcard require export conditions as specifier patterns', async () => {
    reset();
    stubFetch((url) => {
      if (url.endsWith('/demo@1.0.0/package.json')) {
        return new Response(JSON.stringify({
          exports: {
            './features/*': {
              import: './esm/features/*.js',
              require: './cjs/features/*.cjs',
            },
          },
        }), { status: 200 });
      }
      if (url.endsWith('/demo@2.0.0/package.json')) {
        return new Response(JSON.stringify({
          exports: {
            './features/*': {
              import: './esm/features/*.js',
            },
          },
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const changes = await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0');

    assert.deepEqual(changes.map((change) => change.moduleSystem?.affectedSpecifierPatterns), [['demo/features/*']]);
    assert.deepEqual(changes.map((change) => change.moduleSystem?.affectedSpecifiers), [undefined]);
  });

  test('represents scoped wildcard require export conditions as scoped specifier patterns', async () => {
    reset();
    stubFetch((url) => {
      if (url.endsWith('/@scope/demo@1.0.0/package.json')) {
        return new Response(JSON.stringify({
          exports: {
            './features/*': {
              node: {
                require: './cjs/features/*.cjs',
                import: './esm/features/*.js',
              },
            },
          },
        }), { status: 200 });
      }
      if (url.endsWith('/@scope/demo@2.0.0/package.json')) {
        return new Response(JSON.stringify({
          exports: {
            './features/*': {
              node: {
                import: './esm/features/*.js',
              },
            },
          },
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const changes = await diffPackageModuleMetadata('@scope/demo', '1.0.0', '2.0.0');

    assert.deepEqual(changes.map((change) => change.moduleSystem?.affectedSpecifierPatterns), [['@scope/demo/features/*']]);
  });

  test('treats export arrays as alternatives when detecting CommonJS compatibility', async () => {
    reset();
    stubFetch((url) => {
      if (url.endsWith('/demo@1.0.0/package.json')) {
        return new Response(JSON.stringify({
          exports: {
            '.': [{ import: './index.mjs' }, { require: './index.cjs' }],
          },
        }), { status: 200 });
      }
      if (url.endsWith('/demo@2.0.0/package.json')) {
        return new Response(JSON.stringify({
          exports: {
            '.': [{ import: './index.mjs' }],
          },
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const changes = await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0');

    assert.deepEqual(changes.map((change) => change.kind), ['exports-require-condition-removed']);
  });

  test('does not report require removal when a CommonJS default branch remains', async () => {
    reset();
    stubFetch((url) => {
      if (url.endsWith('/demo@1.0.0/package.json')) {
        return new Response(JSON.stringify({
          exports: {
            '.': { import: './index.mjs', require: './index.cjs' },
          },
        }), { status: 200 });
      }
      if (url.endsWith('/demo@2.0.0/package.json')) {
        return new Response(JSON.stringify({
          exports: {
            '.': { import: './index.mjs', default: './index.cjs' },
          },
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const changes = await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0');

    assert.deepEqual(changes, []);
  });

  test('does not treat type module alone as loss of CommonJS support', async () => {
    reset();
    stubFetch((url) => {
      if (url.endsWith('/demo@1.0.0/package.json')) {
        return new Response(JSON.stringify({ main: './index.js' }), { status: 200 });
      }
      if (url.endsWith('/demo@2.0.0/package.json')) {
        return new Response(JSON.stringify({
          type: 'module',
          exports: { '.': { import: './index.js', require: './index.cjs' } },
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const changes = await diffPackageModuleMetadata('demo', '1.0.0', '2.0.0');

    assert.equal(
      changes.some((change) => change.kind === 'commonjs-entry-removed' || change.kind === 'package-type-changed'),
      false,
    );
  });
});
