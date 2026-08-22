import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  matchingTag,
  packageSubtree,
  pythonSurface,
  SURFACE_SCRIPT,
} from '../dist/evidence/surface/python.js';
import { execCommand } from '../dist/util/exec.js';
import { clearHttpCache, configureHttpDiskCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';
import { CONFIDENT_SURFACE_WEIGHT, type SurfaceRequest } from '../dist/evidence/surface/types.js';

/**
 * The Python GitHub-fallback path downloads a whole repository tag archive.
 * In a monorepo that repository hosts more than one PyPI distribution, and
 * two separate correctness gaps let one package's changes get attributed to
 * another:
 *
 *  1. Nothing restricted parsing to the package's own subtree, so every
 *     .py/.pyi in the archive was read -- a sibling package's added/removed
 *     symbols became this package's own surface diff.
 *  2. The parser derived a symbol's module purely from `os.path.basename`,
 *     so `pkg/a/module.py` and `pkg/b/module.py` both produced bare key
 *     `module.<symbol>` -- two distinct modules silently colliding.
 *
 * Both are covered here, plus the tightened `matchingTag`, which used to let
 * a short package name match as a substring of an unrelated tag.
 */

/** A tar entry, built the way tar builds one: a 512-byte header, then bytes. */
function tarEntry(path: string, content: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);

  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  body.write(content, 0, 'utf8');
  return Buffer.concat([header, body]);
}

function tarball(entries: [string, string][]): Buffer {
  const parts = entries.map(([path, content]) => tarEntry(path, content));
  const end = Buffer.alloc(1024);
  return gzipSync(Buffer.concat([...parts, end]));
}

describe('picking the right repository tag: substring matches are no longer good enough', () => {
  test('a short package name is not matched as a substring of an unrelated tag', () => {
    // 'api' must not match a tag like 'capitalize-v1.0.0' just because the
    // letters appear inside it -- 'api' has no word boundary there.
    const tags = [{ name: 'capitalize-v1.0.0' }, { name: 'unrelated-v1.0.0' }];
    assert.equal(matchingTag(tags, 'api', '1.0.0'), null);
  });

  test('a short package name does match as its own token', () => {
    const tags = [{ name: 'api-v1.0.0' }, { name: 'client-v1.0.0' }];
    assert.equal(matchingTag(tags, 'api', '1.0.0'), 'api-v1.0.0');
  });

  test('more than one tag naming the package is ambiguous, not a race the first one wins', () => {
    const tags = [{ name: 'api-server-v1.0.0' }, { name: 'api-client-v1.0.0' }];
    assert.equal(matchingTag(tags, 'api', '1.0.0'), null);
  });
});

describe('packageSubtree: locating a package inside a GitHub-fallback archive', () => {
  test('finds the package under the archive’s own owner-repo-sha wrapper', () => {
    const paths = ['demo-repo-abc123/package_a/__init__.py', 'demo-repo-abc123/package_a/util.py'];
    assert.equal(packageSubtree(paths, 'package-a'), 'demo-repo-abc123/package_a');
  });

  test('finds a src/-nested layout', () => {
    const paths = ['demo-repo-abc123/src/package_a/__init__.py'];
    assert.equal(packageSubtree(paths, 'package-a'), 'demo-repo-abc123/src/package_a');
  });

  test('a monorepo with a sibling package present is still resolved to just this one', () => {
    const paths = [
      'demo-repo-abc123/package_a/__init__.py',
      'demo-repo-abc123/package_b/__init__.py',
      'demo-repo-abc123/README.md',
    ];
    assert.equal(packageSubtree(paths, 'package-a'), 'demo-repo-abc123/package_a');
    assert.equal(packageSubtree(paths, 'package-b'), 'demo-repo-abc123/package_b');
  });

  test('no matching directory at all declines rather than guessing', () => {
    const paths = ['demo-repo-abc123/somethingelse/mod.py'];
    assert.equal(packageSubtree(paths, 'package-a'), null);
  });

  test('the same package name appearing at two different, inconsistent paths is ambiguous', () => {
    const paths = ['demo-repo-abc123/package_a/mod.py', 'demo-repo-abc123/vendor/package_a/mod.py'];
    assert.equal(packageSubtree(paths, 'package-a'), null);
  });
});

const realFetch = globalThis.fetch;
let cacheDir: string;

function stubFetch(respond: (url: string) => Response | null): void {
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    const response = respond(url);
    return Promise.resolve(response ?? new Response('not found', { status: 404 }));
  }) as typeof fetch;
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  clearHttpCache();
  configureHttpDiskCache(null);
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
});

const canningExec: SurfaceRequest['exec'] = async (command, args) => {
  if (command === 'python3' && args[0] === '--version') return { code: 0, stdout: 'Python 3.11.0', stderr: '' };
  if (command === 'python3') {
    return { code: 0, stdout: JSON.stringify([{ name: 'thing', kind: 'function', signature: 'def thing()' }]), stderr: '' };
  }
  return { code: 1, stdout: '', stderr: 'unexpected command' };
};

describe('the GitHub fallback does not diff a sibling package in the same monorepo', () => {
  test('fetching package-a only ever extracts package_a files onto disk, never package_b', async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'drift-python-mono-'));
    configureHttpDiskCache(cacheDir);

    const monorepo = (version: string) =>
      tarball([
        [`demo-repo-abc123/package_a/__init__.py`, `def foo():\n    pass\n`],
        // package_b's own content differs by version -- if it ever leaks into
        // package_a's diff, package_a would wrongly show a change too.
        [`demo-repo-abc123/package_b/__init__.py`, version === '1.0.0' ? `def bar():\n    pass\n` : `def bar():\n    pass\n\ndef baz():\n    pass\n`],
      ]);

    stubFetch((url) => {
      if (url === 'https://pypi.org/pypi/package-a/json') {
        return new Response(
          JSON.stringify({
            info: { project_urls: { Source: 'https://github.com/demo-org/demo-repo' } },
            releases: {
              '1.0.0': [{ url: 'https://files.pythonhosted.org/package-a-1.0.0.tar.gz', filename: 'package-a-1.0.0.tar.gz', packagetype: 'sdist' }],
              '2.0.0': [{ url: 'https://files.pythonhosted.org/package-a-2.0.0.tar.gz', filename: 'package-a-2.0.0.tar.gz', packagetype: 'sdist' }],
            },
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('https://files.pythonhosted.org/')) return new Response('unavailable', { status: 500 });
      if (url.startsWith('https://api.github.com/repos/demo-org/demo-repo'))
        return new Response(JSON.stringify([{ name: 'v1.0.0' }, { name: 'v2.0.0' }]), { status: 200 });
      if (url.startsWith('https://codeload.github.com/demo-org/demo-repo/tar.gz/refs/tags/v1.0.0'))
        return new Response(monorepo('1.0.0'), { status: 200 });
      if (url.startsWith('https://codeload.github.com/demo-org/demo-repo/tar.gz/refs/tags/v2.0.0'))
        return new Response(monorepo('2.0.0'), { status: 200 });
      return null;
    });

    const workdir = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
    const request: SurfaceRequest = {
      name: 'package-a',
      from: '1.0.0',
      to: '2.0.0',
      exec: canningExec,
      workdir,
      logger: createLogger('error'),
      timeoutMs: 20_000,
    };

    const outcome = await pythonSurface.compute(request);

    // Inspect what actually got extracted for the "to" probe before cleanup.
    const probeDir = join(workdir, 'probe-2.0.0');
    const extracted: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else extracted.push(full);
      }
    }
    await walk(probeDir).catch(() => undefined);
    await rm(workdir, { recursive: true, force: true });

    assert.ok(extracted.some((p) => p.includes('package_a')), 'package_a should have been extracted');
    assert.ok(!extracted.some((p) => p.includes('package_b')), 'package_b must not have been extracted for a package-a diff');

    assert.equal(outcome.available, true);
    if (outcome.available) {
      assert.ok(outcome.weight < CONFIDENT_SURFACE_WEIGHT, 'a fallback-derived diff stays below the confident-surface threshold');
      assert.match(outcome.locator, /GitHub tag mirror/);
    }
  });

  test('an archive where the package subtree cannot be identified declines the fallback rather than diffing the whole repo', async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'drift-python-mono-decline-'));
    configureHttpDiskCache(cacheDir);

    // Neither entry's path contains a directory matching the normalized
    // package name, so packageSubtree() cannot establish which part of the
    // repository is this package's own source.
    const unrelatedRepo = () =>
      tarball([[`demo-repo-abc123/somethingelse/mod.py`, `def foo():\n    pass\n`]]);

    stubFetch((url) => {
      if (url === 'https://pypi.org/pypi/package-a/json') {
        return new Response(
          JSON.stringify({
            info: { project_urls: { Source: 'https://github.com/demo-org/demo-repo' } },
            releases: {
              '1.0.0': [{ url: 'https://files.pythonhosted.org/package-a-1.0.0.tar.gz', filename: 'package-a-1.0.0.tar.gz', packagetype: 'sdist' }],
              '2.0.0': [{ url: 'https://files.pythonhosted.org/package-a-2.0.0.tar.gz', filename: 'package-a-2.0.0.tar.gz', packagetype: 'sdist' }],
            },
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('https://files.pythonhosted.org/')) return new Response('unavailable', { status: 500 });
      if (url.startsWith('https://api.github.com/repos/demo-org/demo-repo'))
        return new Response(JSON.stringify([{ name: 'v1.0.0' }, { name: 'v2.0.0' }]), { status: 200 });
      if (url.startsWith('https://codeload.github.com/')) return new Response(unrelatedRepo(), { status: 200 });
      return null;
    });

    const workdir = await mkdtemp(join(tmpdir(), 'drift-python-work-'));
    const outcome = await pythonSurface.compute({
      name: 'package-a',
      from: '1.0.0',
      to: '2.0.0',
      exec: canningExec,
      workdir,
      logger: createLogger('error'),
      timeoutMs: 20_000,
    });
    await rm(workdir, { recursive: true, force: true });

    assert.equal(outcome.available, false);
  });
});

describe('module identity: same basename in different subpackages stays distinct', () => {
  test('a real python3 run reports pkg.a.module and pkg.b.module as separate modules, not one colliding "module"', async (t) => {
    const version = await execCommand('python3', ['--version']).catch(() => null);
    if (!version || version.code !== 0) {
      t.skip('python3 not available in this environment');
      return;
    }

    const root = await mkdtemp(join(tmpdir(), 'drift-python-module-identity-'));
    try {
      await mkdir(join(root, 'pkg', 'a'), { recursive: true });
      await mkdir(join(root, 'pkg', 'b'), { recursive: true });
      await writeFile(join(root, 'pkg', '__init__.py'), '');
      await writeFile(join(root, 'pkg', 'a', '__init__.py'), '');
      await writeFile(join(root, 'pkg', 'b', '__init__.py'), '');
      await writeFile(join(root, 'pkg', 'a', 'module.py'), 'def from_a():\n    pass\n');
      await writeFile(join(root, 'pkg', 'b', 'module.py'), 'def from_b():\n    pass\n');

      const scriptPath = join(root, 'surface.py');
      await writeFile(scriptPath, SURFACE_SCRIPT, 'utf8');

      const result = await execCommand('python3', [scriptPath, root], { timeoutMs: 20_000 });
      assert.equal(result.code, 0, result.stderr);

      const symbols = JSON.parse(result.stdout) as { name: string }[];
      const names = symbols.map((s) => s.name).sort();

      assert.ok(names.includes('pkg.a.module.from_a'), names.join(', '));
      assert.ok(names.includes('pkg.b.module.from_b'), names.join(', '));
      // The bug: both used to collide under the bare basename 'module'.
      assert.ok(!names.includes('module.from_a'));
      assert.ok(!names.includes('module.from_b'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
