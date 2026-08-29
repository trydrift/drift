import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkSourceFiles, languageOf, isRuntimeConfigPath } from '../dist/index/walk.js';
import { discoverRuntimeDeclarations } from '../dist/rationale/runtime.js';

/**
 * The walk reads directory listings concurrently and then reads the files it
 * picked many at once. Both are timing changes that must not become ordering
 * changes: `maxFiles` genuinely bites on a large repository, so *which* files
 * are dropped is a property of the traversal order, and a reordering here would
 * silently change what a scan analyses without changing anything visible.
 */

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'drift-walk-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return root;
}

describe('walking a repository for source files', () => {
  test('reads source files and skips what is not source', async () => {
    const root = await fixture({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.py': 'a = 1\n',
      'README.md': '# hi',
      'logo.png': 'binary-ish',
    });
    try {
      const files = await walkSourceFiles(root);
      assert.deepEqual(
        files.map((f) => f.path),
        ['src/a.ts', 'src/b.py'],
      );
      assert.equal(files[0]?.content, 'export const a = 1;\n');
      assert.equal(files[0]?.language, 'typescript');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('never descends into vendored or generated trees', async () => {
    const root = await fixture({
      'src/app.ts': 'x',
      'node_modules/dep/index.js': 'x',
      'target/debug/build.rs': 'x',
      '.git/hooks/pre-commit.py': 'x',
    });
    try {
      const files = await walkSourceFiles(root);
      assert.deepEqual(
        files.map((f) => f.path),
        ['src/app.ts'],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a file over the byte ceiling is skipped without consuming the file budget', async () => {
    const root = await fixture({
      'a.ts': 'a'.repeat(200),
      'big.ts': 'b'.repeat(2000),
      'c.ts': 'c'.repeat(200),
    });
    try {
      // Two slots, and the oversized file in the middle must not take one of
      // them — otherwise a repository with one large bundle in it silently
      // analyses one fewer real file.
      const files = await walkSourceFiles(root, { maxFileBytes: 1000, maxFiles: 2 });
      assert.deepEqual(
        files.map((f) => f.path),
        ['a.ts', 'c.ts'],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the file cap keeps depth-first order, so which files are dropped is stable', async () => {
    // A subdirectory that appears before its siblings is expanded where it
    // appears, not appended after them. Listing directories concurrently must
    // not change that: the cap is what makes it observable.
    const root = await fixture({
      'a/1.ts': 'x',
      'a/2.ts': 'x',
      'b/1.ts': 'x',
      'b/2.ts': 'x',
      'c/1.ts': 'x',
    });
    try {
      const capped = await walkSourceFiles(root, { maxFiles: 3 });
      assert.deepEqual(
        capped.map((f) => f.path),
        ['a/1.ts', 'a/2.ts', 'b/1.ts'],
      );

      // And the same run, uncapped, is a superset in the same order.
      const all = await walkSourceFiles(root);
      assert.deepEqual(all.slice(0, 3).map((f) => f.path), capped.map((f) => f.path));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('authoritative runtime config survives a exhausted source budget and reports coverage', async () => {
    const manySources = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [`src/${String(index).padStart(3, '0')}.go`, 'package source\n']),
    );
    const root = await fixture({
      ...manySources,
      'workhorse/go.mod': 'module example.com/workhorse\n\ngo 1.25.10\n',
      '.python-version': '3.14\n',
    });
    try {
      const files = await walkSourceFiles(root, { maxFiles: 5 });
      assert.ok(files.some((file) => file.path === 'workhorse/go.mod'));
      assert.ok(files.some((file) => file.path === '.python-version'));
      assert.equal(files.filter((file) => file.language !== 'config').length, 5);
      assert.deepEqual(files.coverage, {
        sourceFilesDiscovered: 24,
        sourceFilesIndexed: 5,
        sourceTruncated: true,
        runtimeConfigsDiscovered: 2,
        runtimeConfigsIndexed: 2,
      });
      assert.deepEqual(
        discoverRuntimeDeclarations(files, 'go').resolved.map((declaration) => declaration.requirement),
        ['1.25.10'],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the same tree walks to the same answer every time', async () => {
    const files: Record<string, string> = {};
    for (let d = 0; d < 12; d++) for (let f = 0; f < 12; f++) files[`d${d}/f${f}.ts`] = `export const x${f} = ${d};\n`;
    const root = await fixture(files);
    try {
      const runs = await Promise.all([40, 40, 40].map((maxFiles) => walkSourceFiles(root, { maxFiles })));
      const first = JSON.stringify(runs[0]?.map((f) => f.path));
      for (const run of runs) assert.equal(JSON.stringify(run.map((f) => f.path)), first);
      assert.equal(runs[0]?.length, 40);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('an unreadable directory is skipped rather than failing the walk', async () => {
    const root = await fixture({ 'src/a.ts': 'x' });
    try {
      // A path that does not exist stands in for one that cannot be read.
      const files = await walkSourceFiles(join(root, 'nope'));
      assert.deepEqual(files, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('classifying a path', () => {
  test('names the language from the extension', () => {
    assert.equal(languageOf('a.ts'), 'typescript');
    assert.equal(languageOf('a.py'), 'python');
    assert.equal(languageOf('a.rs'), 'rust');
    assert.equal(languageOf('a.md'), 'other');
  });

  test('runtime config is source for these purposes', () => {
    assert.ok(isRuntimeConfigPath('.github/workflows/ci.yml'));
    assert.ok(!isRuntimeConfigPath('src/app.ts'));
  });
});
