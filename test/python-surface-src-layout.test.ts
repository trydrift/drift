import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SURFACE_SCRIPT, parsePythonSurface } from '../dist/evidence/surface/python.js';
import { execCommand } from '../dist/util/exec.js';

/**
 * The src-layout sdist.
 *
 * A PyPI sdist unpacks to `<name>-<version>/`, and the reader has to descend
 * into it before anything is a package: `requests-2.32.4` is not an
 * identifier, so nothing under the extraction root reads as importable. The
 * descent picks the project directory by looking for `pyproject.toml`,
 * `setup.cfg`, `setup.py`, or an adjacent `.egg-info`.
 *
 * In a **flat** layout exactly one directory has those, so the answer was
 * unambiguous. In a **src** layout there are two — the project directory has
 * the setup markers and `src/` holds the `.egg-info` — and the tie used to
 * resolve to the extraction root, which has no package under it at all. The
 * whole distribution then read as "declares no public symbols", which is how
 * `requests` 2.32.4 — a package that had simply migrated to src-layout
 * between the two versions being compared — produced an empty surface and
 * took the upgrade with it into `upstream-surface-unavailable`.
 *
 * src-layout is the modern packaging default, so this is not a rare shape.
 */

async function surfaceOf(files: Record<string, string>, distribution: string) {
  const root = await mkdtemp(join(tmpdir(), 'drift-py-src-layout-'));
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
    return parsePythonSurface(result.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const MODULE = 'def get(url, params=None):\n    pass\n\n\nclass Session:\n    def request(self, method, url):\n        pass\n';

describe('a src-layout sdist still yields a surface', () => {
  test('a real python3 run is available', async (t) => {
    const version = await execCommand('python3', ['--version']).catch(() => null);
    if (!version || version.code !== 0) t.skip('python3 not available in this environment');
  });

  test('src-layout: the package under src/ is found, not skipped', async (t) => {
    const python = await execCommand('python3', ['--version']).catch(() => null);
    if (!python || python.code !== 0) return t.skip('python3 not available');

    // Exactly the shape of a real sdist: a versioned top directory, setup
    // markers at the project root, and the `.egg-info` down in `src/` — the
    // second candidate that used to make the choice ambiguous.
    const api = await surfaceOf(
      {
        'demolib-2.0.0/setup.py': 'from setuptools import setup\nsetup()\n',
        'demolib-2.0.0/src/demolib/__init__.py': '',
        'demolib-2.0.0/src/demolib/api.py': MODULE,
        'demolib-2.0.0/src/demolib.egg-info/top_level.txt': 'demolib\n',
      },
      'demolib',
    );

    assert.ok(api, 'the helper output parsed');
    assert.ok(api!.size > 0, 'a src-layout distribution is not an empty surface');
    assert.ok(api!.has('demolib.api.get'), `expected demolib.api.get, got ${[...api!.keys()].join(', ')}`);
    assert.ok(api!.has('demolib.api.Session'), 'the class under src/ is public too');
  });

  test('flat layout keeps working exactly as before', async (t) => {
    const python = await execCommand('python3', ['--version']).catch(() => null);
    if (!python || python.code !== 0) return t.skip('python3 not available');

    const api = await surfaceOf(
      {
        'demolib-1.0.0/setup.py': 'from setuptools import setup\nsetup()\n',
        'demolib-1.0.0/demolib/__init__.py': '',
        'demolib-1.0.0/demolib/api.py': MODULE,
        'demolib-1.0.0/demolib.egg-info/top_level.txt': 'demolib\n',
      },
      'demolib',
    );

    assert.ok(api?.has('demolib.api.get'));
  });

  test('a package that migrated flat → src between versions compares both sides', async (t) => {
    const python = await execCommand('python3', ['--version']).catch(() => null);
    if (!python || python.code !== 0) return t.skip('python3 not available');

    // The regression that mattered: the *diff*, where one side moved. Before
    // the fix the src side was empty, so every symbol read as removed.
    const flat = await surfaceOf(
      {
        'demolib-1.0.0/setup.py': 'from setuptools import setup\nsetup()\n',
        'demolib-1.0.0/demolib/__init__.py': '',
        'demolib-1.0.0/demolib/api.py': MODULE,
      },
      'demolib',
    );
    const src = await surfaceOf(
      {
        'demolib-2.0.0/setup.py': 'from setuptools import setup\nsetup()\n',
        'demolib-2.0.0/src/demolib/__init__.py': '',
        'demolib-2.0.0/src/demolib/api.py': MODULE,
        'demolib-2.0.0/src/demolib.egg-info/top_level.txt': 'demolib\n',
      },
      'demolib',
    );

    assert.ok(flat && src);
    assert.deepEqual(
      [...src!.keys()].sort(),
      [...flat!.keys()].sort(),
      'the same sources laid out two ways are the same surface, so the move alone is not a removal',
    );
  });
});
