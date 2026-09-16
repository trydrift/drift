import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAll } from '../src/files.js';

test('findAll lists matching files, sorted, without directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-glob-'));
  mkdirSync(join(root, 'b'));
  writeFileSync(join(root, 'b', 'two.ts'), '');
  writeFileSync(join(root, 'a.ts'), '');
  writeFileSync(join(root, 'ignore.js'), '');
  assert.deepEqual(findAll('**/*.ts', root), ['a.ts', 'b/two.ts']);
});
