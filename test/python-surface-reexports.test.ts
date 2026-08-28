import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SURFACE_SCRIPT, parsePythonSurface } from '../dist/evidence/surface/python.js';
import { diffSurfaces } from '../dist/evidence/type-surface.js';
import { execCommand } from '../dist/util/exec.js';

/**
 * Python packages routinely relocate an implementation into a private module
 * and keep exporting it from the original public one:
 *
 *   # util.py
 *   from ._impl import Redirect
 *   __all__ = ["Redirect"]
 *
 * A single-file surface pass loses `util.Redirect` and reports a false
 * `export-removed`. The extractor resolves explicit re-exports against a
 * whole-package index instead, so the public symbol survives with the shape
 * of its real declaration — and, when that declaration is in a third-party
 * package it never parsed, as "exists, shape unknown" rather than "removed".
 *
 * These run the real embedded helper under `python3`; the whole point is the
 * AST semantics, which a stub cannot exercise.
 */

async function surfaceOf(files: Record<string, string>, distribution = 'pkg') {
  const root = await mkdtemp(join(tmpdir(), 'drift-py-reexport-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, content);
    }
    const scriptPath = join(root, 'surface.py');
    await writeFile(scriptPath, SURFACE_SCRIPT, 'utf8');
    const result = await execCommand('python3', [scriptPath, root, distribution], { timeoutMs: 20_000 });
    assert.equal(result.code, 0, result.stderr);
    const api = parsePythonSurface(result.stdout);
    assert.ok(api, 'the helper output parsed into a surface');
    return api!;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('Python explicit re-exports are not false removals', () => {
  test('a real python3 run is available', async (t) => {
    const version = await execCommand('python3', ['--version']).catch(() => null);
    if (!version || version.code !== 0) t.skip('python3 not available in this environment');
  });

  test('direct class re-export keeps the public symbol with its real shape', async (t) => {
    const python = await execCommand('python3', ['--version']).catch(() => null);
    if (!python || python.code !== 0) return t.skip('python3 not available');

    const before = await surfaceOf({
      'pkg/__init__.py': '',
      'pkg/util.py': 'class Redirect:\n    def render(self): pass\n',
    });
    const after = await surfaceOf({
      'pkg/__init__.py': '',
      'pkg/util.py': 'from ._impl import Redirect\n__all__ = ["Redirect"]\n',
      'pkg/_impl.py': 'class Redirect:\n    def render(self): pass\n',
    });

    assert.ok(after.has('pkg.util.Redirect'), 'the re-exported class is still on the surface');
    assert.equal(after.get('pkg.util.Redirect')!.kind, 'class');
    const changes = diffSurfaces(before, after);
    assert.equal(
      changes.filter((c) => c.symbol === 'pkg.util.Redirect').length,
      0,
      JSON.stringify(changes),
    );
  });

  test('direct function re-export is not reported removed', async (t) => {
    const python = await execCommand('python3', ['--version']).catch(() => null);
    if (!python || python.code !== 0) return t.skip('python3 not available');

    const before = await surfaceOf({
      'pkg/__init__.py': '',
      'pkg/util.py': 'def redirect_to(url, request):\n    return b""\n',
    });
    const after = await surfaceOf({
      'pkg/__init__.py': '',
      'pkg/util.py': 'from ._impl import redirect_to\n__all__ = ["redirect_to"]\n',
      'pkg/_impl.py': 'def redirect_to(url, request):\n    return b""\n',
    });

    assert.ok(after.has('pkg.util.redirect_to'));
    assert.ok(
      !diffSurfaces(before, after).some(
        (c) => c.kind === 'export-removed' && c.symbol === 'pkg.util.redirect_to',
      ),
    );
  });

  test('aliased re-export exposes the alias, not the imported name', async (t) => {
    const python = await execCommand('python3', ['--version']).catch(() => null);
    if (!python || python.code !== 0) return t.skip('python3 not available');

    const api = await surfaceOf({
      'pkg/__init__.py': '',
      'pkg/api.py': 'from .internal import Foo as PublicFoo\n__all__ = ["PublicFoo"]\n',
      'pkg/internal.py': 'class Foo:\n    pass\n',
    });

    assert.ok(api.has('pkg.api.PublicFoo'), 'the alias is public');
    assert.ok(!api.has('pkg.api.Foo'), 'the imported name is not exposed under the importing module');
  });

  test('a re-export chain a -> b -> __init__ keeps the root export present', async (t) => {
    const python = await execCommand('python3', ['--version']).catch(() => null);
    if (!python || python.code !== 0) return t.skip('python3 not available');

    const api = await surfaceOf({
      'pkg/a.py': 'class Foo:\n    def m(self): pass\n',
      'pkg/b.py': 'from .a import Foo\n__all__ = ["Foo"]\n',
      'pkg/__init__.py': 'from .b import Foo\n__all__ = ["Foo"]\n',
    });

    assert.ok(api.has('pkg.Foo'), 'the package root still exports Foo');
    assert.equal(api.get('pkg.Foo')!.kind, 'class');
    assert.deepEqual(api.get('pkg.Foo')!.members, ['m'], 'with the shape from a.py');
  });

  test('a circular re-export terminates instead of recursing forever', async (t) => {
    const python = await execCommand('python3', ['--version']).catch(() => null);
    if (!python || python.code !== 0) return t.skip('python3 not available');

    const api = await surfaceOf({
      'pkg/__init__.py': '',
      'pkg/a.py': 'from .b import Thing\n__all__ = ["Thing"]\n',
      'pkg/b.py': 'from .a import Thing\n__all__ = ["Thing"]\n',
    });

    // Neither module can resolve a concrete declaration, but both name Thing
    // in __all__ via an import — so it is known-to-exist, shape unknown.
    assert.equal(api.get('pkg.a.Thing')!.shapeUnknown, true);
    assert.equal(api.get('pkg.b.Thing')!.shapeUnknown, true);
  });

  test('an imported name absent from __all__ does not become public', async (t) => {
    const python = await execCommand('python3', ['--version']).catch(() => null);
    if (!python || python.code !== 0) return t.skip('python3 not available');

    const api = await surfaceOf({
      'pkg/__init__.py': '',
      'pkg/api.py': 'from .internal import Hidden\n__all__ = ["Other"]\n\nclass Other:\n    pass\n',
      'pkg/internal.py': 'class Hidden:\n    pass\n',
    });

    assert.ok(api.has('pkg.api.Other'));
    assert.ok(!api.has('pkg.api.Hidden'), 'a plain imported name is not exported from the importing module');
  });

  test('an unresolvable external re-export is exists-but-shape-unknown, never removed', async (t) => {
    const python = await execCommand('python3', ['--version']).catch(() => null);
    if (!python || python.code !== 0) return t.skip('python3 not available');

    const before = await surfaceOf(
      { 'pkg/__init__.py': 'class Foo:\n    def m(self): pass\n' },
      'pkg',
    );
    const after = await surfaceOf(
      { 'pkg/__init__.py': 'from external_dep import Foo\n__all__ = ["Foo"]\n' },
      'pkg',
    );

    const entry = after.get('pkg.Foo');
    assert.ok(entry, 'Foo is still known to exist');
    assert.equal(entry!.shapeUnknown, true);
    assert.equal(entry!.kind, 'unknown');

    const changes = diffSurfaces(before, after);
    assert.equal(changes.length, 0, `known -> shape-unknown is not a change: ${JSON.stringify(changes)}`);
  });

  test('a shape-unknown symbol that then disappears entirely is still a removal', () => {
    const before = parsePythonSurface(
      JSON.stringify([{ name: 'pkg.Foo', kind: 'unknown', shapeUnknown: true }]),
    )!;
    const after = parsePythonSurface(JSON.stringify([{ name: 'pkg.Bar', kind: 'function', signature: 'def Bar()' }]))!;
    const changes = diffSurfaces(before, after);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.kind, 'export-removed');
    assert.equal(changes[0]!.symbol, 'pkg.Foo');
    assert.ok(!changes[0]!.detail.includes('unknown'), 'the placeholder kind is not quoted back');
  });

  test('the Twisted structural case: neither Redirect nor redirectTo is a false removal', async (t) => {
    const python = await execCommand('python3', ['--version']).catch(() => null);
    if (!python || python.code !== 0) return t.skip('python3 not available');

    const before = await surfaceOf({
      'twisted/__init__.py': '',
      'twisted/web/__init__.py': '',
      'twisted/web/util.py':
        'class Redirect:\n    def render(self): pass\n\ndef redirectTo(url, request):\n    return b""\n',
    });
    const after = await surfaceOf({
      'twisted/__init__.py': '',
      'twisted/web/__init__.py': '',
      'twisted/web/util.py': '__all__ = ["Redirect", "redirectTo"]\n\nfrom ._template_util import Redirect, redirectTo\n',
      'twisted/web/_template_util.py':
        'class Redirect:\n    def render(self): pass\n\ndef redirectTo(url, request):\n    return b""\n',
    });

    assert.ok(after.has('twisted.web.util.Redirect'));
    assert.ok(after.has('twisted.web.util.redirectTo'));
    assert.deepEqual(
      diffSurfaces(before, after).filter((c) => c.kind === 'export-removed'),
      [],
    );
  });

  test('the Protego structural case: a package-root re-export stays public', async (t) => {
    const python = await execCommand('python3', ['--version']).catch(() => null);
    if (!python || python.code !== 0) return t.skip('python3 not available');

    const before = await surfaceOf(
      { 'protego/__init__.py': 'class Protego:\n    def can_fetch(self): pass\n' },
      'protego',
    );
    const after = await surfaceOf(
      {
        'protego/__init__.py': 'from ._protego import Protego\n__all__ = ["Protego"]\n',
        'protego/_protego.py': 'class Protego:\n    def can_fetch(self): pass\n',
      },
      'protego',
    );

    assert.ok(after.has('protego.Protego'));
    assert.deepEqual(
      diffSurfaces(before, after).filter((c) => c.symbol === 'protego.Protego'),
      [],
    );
  });
});
