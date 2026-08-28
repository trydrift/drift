import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callableChangeIsBackwardCompatible,
  diffSurfaces,
  type CallableParam,
  type CallableShape,
  type SurfaceApi,
} from '../dist/evidence/type-surface.js';
import { SURFACE_SCRIPT, parsePythonSurface } from '../dist/evidence/surface/python.js';
import { execCommand } from '../dist/util/exec.js';

/**
 * Drift falsely reported backward-compatible Python signature expansions as
 * breaking. `w3lib.safe_url_string(url, encoding='utf8', path_encoding='utf8')`
 * grew an optional `quote_path=True`; every existing call stays valid, but the
 * AST reader flattened both sides to `def …(…) defaults=N` and the
 * TypeScript-oriented `onlyRelaxesCallers` could not read that, so it emitted
 * `signature-changed` and localization then blamed real call sites.
 *
 * The reader now carries a structured `CallableShape`, and `diffSurfaces`
 * decides caller compatibility from it.
 */

/** Terse `CallableShape` builder: `p('url')`, `p('enc', { opt: true })`, `p('args', { kind: 'var-positional' })`. */
function p(
  name: string,
  opts: { opt?: boolean; kind?: CallableParam['kind'] } = {},
): CallableParam {
  const kind = opts.kind ?? 'positional-or-keyword';
  const variadic = kind === 'var-positional' || kind === 'var-keyword';
  return { name, kind, required: variadic ? false : !opts.opt };
}
const shape = (...parameters: CallableParam[]): CallableShape => ({ parameters });

describe('callableChangeIsBackwardCompatible', () => {
  test('1. an added optional positional parameter is not breaking', () => {
    assert.equal(callableChangeIsBackwardCompatible(shape(p('a')), shape(p('a'), p('b', { opt: true }))), true);
  });

  test('2. multiple added optional positional parameters are not breaking', () => {
    assert.equal(
      callableChangeIsBackwardCompatible(
        shape(p('a'), p('b', { opt: true })),
        shape(p('a'), p('b', { opt: true }), p('c', { opt: true }), p('d', { opt: true })),
      ),
      true,
    );
  });

  test('3. an added optional keyword-only parameter is not breaking', () => {
    assert.equal(
      callableChangeIsBackwardCompatible(
        shape(p('a'), p('mode', { kind: 'keyword-only', opt: true })),
        shape(p('a'), p('mode', { kind: 'keyword-only', opt: true }), p('strict', { kind: 'keyword-only', opt: true })),
      ),
      true,
    );
  });

  test('4. an added required positional parameter is breaking', () => {
    assert.equal(callableChangeIsBackwardCompatible(shape(p('a')), shape(p('a'), p('b'))), false);
  });

  test('5. an optional positional becoming required is breaking', () => {
    assert.equal(
      callableChangeIsBackwardCompatible(shape(p('a'), p('b', { opt: true })), shape(p('a'), p('b'))),
      false,
    );
  });

  test('6. an optional keyword-only becoming required is breaking', () => {
    assert.equal(
      callableChangeIsBackwardCompatible(
        shape(p('a'), p('mode', { kind: 'keyword-only', opt: true })),
        shape(p('a'), p('mode', { kind: 'keyword-only' })),
      ),
      false,
    );
  });

  test('7. removing an accepted parameter is breaking', () => {
    assert.equal(callableChangeIsBackwardCompatible(shape(p('a'), p('b')), shape(p('a'))), false);
  });

  test('8. removing **kwargs is breaking', () => {
    assert.equal(
      callableChangeIsBackwardCompatible(shape(p('a'), p('kw', { kind: 'var-keyword' })), shape(p('a'))),
      false,
    );
  });

  test('9. renaming a keyword-addressable parameter is breaking', () => {
    assert.equal(callableChangeIsBackwardCompatible(shape(p('value')), shape(p('item'))), false);
  });

  test('10. renaming a positional-only parameter is safe (callers cannot name it)', () => {
    assert.equal(
      callableChangeIsBackwardCompatible(shape(p('a', { kind: 'positional-only' })), shape(p('b', { kind: 'positional-only' }))),
      true,
    );
  });

  test('11a. *args preservation does not wave through a keyword rename', () => {
    assert.equal(
      callableChangeIsBackwardCompatible(
        shape(p('a'), p('rest', { kind: 'var-positional' })),
        shape(p('b'), p('rest', { kind: 'var-positional' })),
      ),
      false,
    );
  });

  test('11b. dropping *args when the new shape cannot take the extra positionals is breaking', () => {
    assert.equal(
      callableChangeIsBackwardCompatible(shape(p('a'), p('rest', { kind: 'var-positional' })), shape(p('a'))),
      false,
    );
  });

  test('11c. adding *args and **kwargs is not breaking', () => {
    assert.equal(
      callableChangeIsBackwardCompatible(
        shape(p('a')),
        shape(p('a'), p('rest', { kind: 'var-positional' }), p('kw', { kind: 'var-keyword' })),
      ),
      true,
    );
  });

  test('a positional-or-keyword parameter becoming positional-only is breaking', () => {
    assert.equal(
      callableChangeIsBackwardCompatible(shape(p('a')), shape(p('a', { kind: 'positional-only' }))),
      false,
    );
  });

  test('an identical shape is compatible', () => {
    assert.equal(
      callableChangeIsBackwardCompatible(shape(p('a'), p('b', { opt: true })), shape(p('a'), p('b', { opt: true }))),
      true,
    );
  });
});

describe('diffSurfaces suppresses safe Python parameter expansions', () => {
  const fn = (name: string, params: CallableParam[], signature: string): SurfaceApi =>
    new Map([
      [name, { name, kind: 'function' as const, signature, members: [], requiredMembers: [], callable: { parameters: params } }],
    ]);

  test('12. the exact w3lib safe_url_string expansion produces no signature-changed', () => {
    const before = fn(
      'safe_url_string',
      [p('url'), p('encoding', { opt: true }), p('path_encoding', { opt: true })],
      'def safe_url_string(url, encoding, path_encoding) defaults=2',
    );
    const after = fn(
      'safe_url_string',
      [p('url'), p('encoding', { opt: true }), p('path_encoding', { opt: true }), p('quote_path', { opt: true })],
      'def safe_url_string(url, encoding, path_encoding, quote_path) defaults=3',
    );
    const changes = diffSurfaces(before, after);
    assert.deepEqual(changes, [], 'no breaking finding exists, so localization has nothing to localize');
  });

  test('a genuinely incompatible Python change is still reported', () => {
    const before = fn('f', [p('a'), p('b', { opt: true })], 'def f(a, b) defaults=1');
    const after = fn('f', [p('a'), p('b')], 'def f(a, b) defaults=0');
    const changes = diffSurfaces(before, after);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.kind, 'signature-changed');
    assert.equal(changes[0]?.changed, 'parameters');
  });
});

describe('the Python reader emits a structured callable shape', () => {
  async function surfaceOf(source: string): Promise<SurfaceApi> {
    const root = await mkdtemp(join(tmpdir(), 'drift-py-callable-'));
    try {
      await mkdir(join(root, 'w3libish'), { recursive: true });
      await writeFile(join(root, 'w3libish', '__init__.py'), source);
      const scriptPath = join(root, 'surface.py');
      await writeFile(scriptPath, SURFACE_SCRIPT, 'utf8');
      const result = await execCommand('python3', [scriptPath, root, 'w3libish'], { timeoutMs: 20_000 });
      assert.equal(result.code, 0, result.stderr);
      const api = parsePythonSurface(result.stdout);
      assert.ok(api, 'helper output parsed');
      return api!;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test('end to end: adding an optional argument to a real function is not a breaking change', async (t) => {
    const python = await execCommand('python3', ['--version']).catch(() => null);
    if (!python || python.code !== 0) return t.skip('python3 not available');

    const before = await surfaceOf(
      'def safe_url_string(url, encoding="utf8", path_encoding="utf8"):\n    return url\n',
    );
    const after = await surfaceOf(
      'def safe_url_string(url, encoding="utf8", path_encoding="utf8", quote_path=True):\n    return url\n',
    );

    const beforeEntry = before.get('w3libish.safe_url_string');
    assert.ok(beforeEntry?.callable, 'the reader attached a callable shape');
    assert.deepEqual(
      beforeEntry?.callable?.parameters.map((param) => [param.name, param.kind, param.required]),
      [
        ['url', 'positional-or-keyword', true],
        ['encoding', 'positional-or-keyword', false],
        ['path_encoding', 'positional-or-keyword', false],
      ],
    );

    const changes = diffSurfaces(before, after);
    assert.equal(
      changes.filter((c) => c.kind === 'signature-changed').length,
      0,
      'the optional-parameter expansion is not reported',
    );
  });

  test('end to end: a keyword-only required addition is a breaking change', async (t) => {
    const python = await execCommand('python3', ['--version']).catch(() => null);
    if (!python || python.code !== 0) return t.skip('python3 not available');

    const before = await surfaceOf('def f(a):\n    return a\n');
    const after = await surfaceOf('def f(a, *, strict):\n    return a\n');
    const changes = diffSurfaces(before, after);
    assert.ok(
      changes.some((c) => c.kind === 'signature-changed' && c.symbol === 'w3libish.f'),
      'a new required keyword-only parameter is still reported',
    );
  });
});
