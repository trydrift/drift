import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDirectExecution, canonicalPath } from './direct-execution.mjs';

/**
 * A script that doubles as an importable module has to know whether it is the
 * entry point, and the obvious string comparison gets that wrong whenever the
 * path Node was given and the path Node resolved differ.
 *
 * On macOS every temporary directory is under `/var`, which is a symlink to
 * `/private/var`, so `npm run test:release` failed there while passing
 * everywhere else. These tests reproduce the mechanism — a symlinked
 * directory — rather than the platform, and cover a path with spaces in it at
 * the same time.
 */

function withTree(run) {
  const root = mkdtempSync(join(tmpdir(), 'drift direct exec '));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SELF_REPORTING_SCRIPT = `import { isDirectExecution } from './direct-execution.mjs';
console.log(isDirectExecution(import.meta.url) ? 'direct' : 'imported');
`;

function plantScript(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'direct-execution.mjs'),
    execFileSync('cat', [new URL('direct-execution.mjs', import.meta.url).pathname], { encoding: 'utf8' }),
  );
  const script = join(dir, 'entry.mjs');
  writeFileSync(script, SELF_REPORTING_SCRIPT);
  return script;
}

test('an ordinary path is direct execution', () => {
  withTree((root) => {
    const script = plantScript(join(root, 'plain'));
    const output = execFileSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(output.trim(), 'direct');
  });
});

test('a path containing spaces is direct execution', () => {
  withTree((root) => {
    const script = plantScript(join(root, 'a dir with spaces'));
    const output = execFileSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(output.trim(), 'direct');
  });
});

test('a path reached through a symlinked directory is direct execution', () => {
  // The `/var` -> `/private/var` shape, without depending on macOS.
  withTree((root) => {
    const real = join(root, 'real dir');
    const script = plantScript(real);
    const link = join(root, 'linked');
    symlinkSync(real, link, 'dir');

    const output = execFileSync(process.execPath, [join(link, 'entry.mjs')], { encoding: 'utf8' });
    assert.equal(output.trim(), 'direct');
  });
});

test('a symlinked script file is direct execution', () => {
  // npm installs binaries as symlinks in node_modules/.bin.
  withTree((root) => {
    const script = plantScript(join(root, 'pkg'));
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const linked = join(bin, 'entry');
    symlinkSync(script, linked, 'file');

    const output = execFileSync(process.execPath, [linked], { encoding: 'utf8' });
    assert.equal(output.trim(), 'direct');
  });
});

test('an imported module is not direct execution', () => {
  withTree((root) => {
    const script = plantScript(join(root, 'pkg'));
    const importer = join(root, 'pkg', 'importer.mjs');
    writeFileSync(importer, `await import('./entry.mjs');\n`);

    const output = execFileSync(process.execPath, [importer], { encoding: 'utf8' });
    assert.equal(output.trim(), 'imported');
  });
});

test('a module with no entry point at all is not direct execution', () => {
  // `node -e`, a worker, an embedder: there is no `argv[1]` to compare against.
  assert.equal(isDirectExecution(import.meta.url, ''), false);
  // A different file is a different file, however it is spelled.
  assert.equal(isDirectExecution(import.meta.url, join(tmpdir(), 'something-else.mjs')), false);
});

test('a path that cannot be resolved falls back to its absolute form', () => {
  const missing = join(tmpdir(), 'drift-does-not-exist', 'entry.mjs');
  assert.equal(canonicalPath(missing), missing);
});

test('the same file named two ways canonicalises identically', () => {
  withTree((root) => {
    const real = join(root, 'real');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'file.txt'), 'x');
    symlinkSync(real, join(root, 'link'), 'dir');

    assert.equal(canonicalPath(join(root, 'link', 'file.txt')), canonicalPath(join(real, 'file.txt')));
    assert.equal(
      isDirectExecution(pathToFileURL(join(real, 'file.txt')).href, join(root, 'link', 'file.txt')),
      true,
    );
  });
});
