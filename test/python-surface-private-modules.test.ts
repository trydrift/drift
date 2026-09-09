import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SURFACE_SCRIPT } from '../dist/evidence/surface/python.js';

const run = promisify(execFile);

/**
 * A symbol's module path decides whether anyone can import it, and Python says
 * so by convention: one leading underscore on any component means private.
 *
 * Left unfiltered these dominated the output — 13.5% of every finding on the
 * TimeMachine corpus sat inside a private module (`_pytest` 3,459 of them,
 * `_vendor` 1,111, `_distutils_hack`), which is a report nobody can act on and
 * a numpy bump reported as 2,657 breaking changes. They can never be localized
 * either, because no consumer can name them.
 *
 * The thing that must not break: a public module re-exporting from a private
 * one is the single most common way a Python package is laid out, so the
 * public name has to survive.
 */

let root: string;
let script: string;

async function surface(dir: string): Promise<string[]> {
  const { stdout } = await run('python3', [script, dir], { maxBuffer: 32 * 1024 * 1024 });
  return (JSON.parse(stdout) as { name: string }[]).map((entry) => entry.name).sort();
}

describe('symbols inside a private module', () => {
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'drift-pysurface-'));
    script = join(root, 'surface.py');
    await writeFile(script, SURFACE_SCRIPT, 'utf8');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('are dropped, while the public re-export of one survives', async () => {
    const pkg = join(root, 'project', 'pkg');
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, '__init__.py'), "from ._impl import PublicThing\n__all__ = ['PublicThing']\n");
    await writeFile(join(pkg, '_impl.py'), 'class PublicThing:\n    def go(self): pass\nclass Hidden:\n    def secret(self): pass\n');
    await writeFile(join(pkg, 'util.py'), 'def helper(a, b): pass\n');

    assert.deepEqual(await surface(join(root, 'project')), ['pkg.PublicThing', 'pkg.util.helper']);
  });

  test('a nested private package is private all the way down', async () => {
    const vendored = join(root, 'nested', 'pkg', '_vendor', 'appdirs');
    await mkdir(vendored, { recursive: true });
    await writeFile(join(root, 'nested', 'pkg', '__init__.py'), '');
    await writeFile(join(root, 'nested', 'pkg', '_vendor', '__init__.py'), '');
    await writeFile(join(vendored, '__init__.py'), 'class AppDirs:\n    pass\n');
    await writeFile(join(root, 'nested', 'pkg', 'api.py'), 'def use(): pass\n');

    // `pkg._vendor.appdirs.AppDirs` has a public leaf and a public parent
    // directory name; the private component in the middle is what settles it.
    assert.deepEqual(await surface(join(root, 'nested')), ['pkg.api.use']);
  });

  test('a dunder module name is not private', async () => {
    const pkg = join(root, 'dunder', 'pkg');
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, '__init__.py'), 'def top(): pass\n');
    assert.deepEqual(await surface(join(root, 'dunder')), ['pkg.top']);
  });
});
