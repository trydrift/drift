import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveShellPath, resetShellPathCache } from '../src/shell-path.js';

/**
 * `spawn npm ENOENT` from inside the extension host is almost always a
 * version manager problem: npm was installed by nvm/volta/fnm/asdf, and the
 * GUI-launched process never sourced the shell profile that put it on PATH.
 * These directories are probed directly — with no dependency on shell
 * startup behaviour succeeding — as the fix for that case.
 */

let home = '';
const originalHome = process.env.HOME;
const originalShell = process.env.SHELL;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'drift-shell-path-'));
});

after(() => {
  rmSync(home, { recursive: true, force: true });
  process.env.HOME = originalHome;
  process.env.SHELL = originalShell;
});

beforeEach(() => {
  resetShellPathCache();
  process.env.HOME = home;
  // A shell that cannot start non-interactively — this is what the shell-
  // derived half of resolution looks like when it fails, and version-manager
  // probing must not depend on it succeeding.
  process.env.SHELL = '/nonexistent/shell';
});

function fakeNpm(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const npmPath = join(binDir, 'npm');
  writeFileSync(npmPath, '#!/bin/sh\necho fake npm\n');
  chmodSync(npmPath, 0o755);
}

describe('version manager install directories', () => {
  test('finds the highest installed nvm version', async () => {
    fakeNpm(join(home, '.nvm', 'versions', 'node', 'v18.20.0', 'bin'));
    fakeNpm(join(home, '.nvm', 'versions', 'node', 'v20.11.0', 'bin'));
    fakeNpm(join(home, '.nvm', 'versions', 'node', 'v20.2.0', 'bin'));

    const path = await resolveShellPath();
    const dirs = path.split(delimiter);
    assert.ok(dirs.includes(join(home, '.nvm', 'versions', 'node', 'v20.11.0', 'bin')));
    assert.ok(!dirs.includes(join(home, '.nvm', 'versions', 'node', 'v18.20.0', 'bin')));
  });

  test('finds volta at its stable path', async () => {
    fakeNpm(join(home, '.volta', 'bin'));

    const path = await resolveShellPath();
    assert.ok(path.split(delimiter).includes(join(home, '.volta', 'bin')));
  });

  test('finds fnm\'s versioned installation directory', async () => {
    fakeNpm(join(home, '.local', 'share', 'fnm', 'node-versions', 'v22.1.0', 'installation', 'bin'));

    const path = await resolveShellPath();
    assert.ok(
      path.split(delimiter).includes(join(home, '.local', 'share', 'fnm', 'node-versions', 'v22.1.0', 'installation', 'bin')),
    );
  });

  test('an empty HOME with no version manager installed resolves without throwing', async () => {
    const path = await resolveShellPath();
    assert.equal(typeof path, 'string');
  });
});
