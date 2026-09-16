import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAll, findModifiedSince } from '../src/files.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'smoke-glob-hidden-'));
  mkdirSync(join(root, 'lib', 'deep'), { recursive: true });
  mkdirSync(join(root, '.hidden'));
  writeFileSync(join(root, 'lib', 'deep', 'z.ts'), '');
  writeFileSync(join(root, 'lib', 'a.ts'), '');
  writeFileSync(join(root, 'lib', 'a.js'), '');
  writeFileSync(join(root, '.hidden', 'h.ts'), '');
  writeFileSync(join(root, 'top.ts'), '');
  return root;
}

test('findAll returns sorted, root-relative file paths for a recursive pattern and never a directory', () => {
  const root = fixture();
  assert.deepEqual(findAll('**/*.ts', root), ['lib/a.ts', 'lib/deep/z.ts', 'top.ts']);
  assert.deepEqual(findAll('lib/*', root), ['lib/a.js', 'lib/a.ts']);
});

test('findAll matches nothing for a pattern with no hits', () => {
  assert.deepEqual(findAll('**/*.rs', fixture()), []);
});

test('findModifiedSince keeps only files newer than the cut-off and includes dotfiles', () => {
  const root = fixture();
  const old = new Date('2020-01-01T00:00:00Z');
  utimesSync(join(root, 'lib', 'a.ts'), old, old);
  utimesSync(join(root, 'top.ts'), old, old);
  const since = new Date('2021-01-01T00:00:00Z');
  assert.deepEqual(findModifiedSince('**/*.ts', root, since), ['.hidden/h.ts', 'lib/deep/z.ts']);
});
