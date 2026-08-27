import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isValidVersion, updateLockfileText, updateManifestText } from './set-version.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('accepts stable and legitimate prerelease versions', () => {
  assert.equal(isValidVersion('0.1.1'), true);
  assert.equal(isValidVersion('0.1.1-beta.0'), true);
  assert.equal(isValidVersion('0.1.1+build.2'), true);
});

test('rejects malformed semantic versions', () => {
  assert.equal(isValidVersion('0.1'), false);
  assert.equal(isValidVersion('0.1.1-beta..0'), false);
  assert.equal(isValidVersion('v0.1.1'), false);
});

test('updates both package manifests without changing unrelated fields', () => {
  const root = { name: '@usedrift/cli', version: '0.1.0', private: false };
  const extension = { name: 'drift', publisher: 'drift', version: '0.1.0' };
  const rootSource = `${JSON.stringify(root, null, 2)}\n`;
  const extensionSource = `${JSON.stringify(extension, null, 4)}\n`;

  assert.equal(
    updateManifestText(rootSource, '0.1.1'),
    rootSource.replace('"version": "0.1.0"', '"version": "0.1.1"'),
  );
  assert.equal(
    updateManifestText(extensionSource, '0.1.1'),
    extensionSource.replace('"version": "0.1.0"', '"version": "0.1.1"'),
  );
});

test('updates both lockfile version fields without changing unrelated fields', () => {
  const rootLock = {
    name: '@usedrift/cli',
    version: '0.1.0',
    lockfileVersion: 3,
    packages: {
      '': { name: '@usedrift/cli', version: '0.1.0', license: 'MIT' },
      dependency: { version: '2.0.0' },
    },
  };
  const extensionLock = {
    name: 'drift',
    version: '0.1.0',
    lockfileVersion: 3,
    packages: { '': { name: 'drift', version: '0.1.0', publisher: 'drift' } },
  };

  const rootSource = `${JSON.stringify(rootLock, null, 2)}\n`;
  const extensionSource = `${JSON.stringify(extensionLock, null, 4)}\n`;
  const updatedRootSource = updateLockfileText(rootSource, '0.1.1-beta.0');
  const updatedExtensionSource = updateLockfileText(extensionSource, '0.1.1-beta.0');
  const updatedRoot = JSON.parse(updatedRootSource);
  const updatedExtension = JSON.parse(updatedExtensionSource);

  assert.equal(updatedRoot.version, '0.1.1-beta.0');
  assert.equal(updatedRoot.packages[''].version, '0.1.1-beta.0');
  assert.equal(updatedRoot.lockfileVersion, 3);
  assert.equal(updatedRoot.packages.dependency.version, '2.0.0');
  assert.equal(updatedExtension.version, '0.1.1-beta.0');
  assert.equal(updatedExtension.packages[''].version, '0.1.1-beta.0');
  assert.equal(updatedExtension.packages[''].publisher, 'drift');
  assert.equal(updatedRootSource.replaceAll('0.1.1-beta.0', '0.1.0'), rootSource);
  assert.equal(updatedExtensionSource.replaceAll('0.1.1-beta.0', '0.1.0'), extensionSource);
});

test('CLI executes when invoked from a path containing spaces', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'drift setter test '));
  try {
    mkdirSync(join(tempRoot, 'scripts'), { recursive: true });
    mkdirSync(join(tempRoot, 'extension'), { recursive: true });
    symlinkSync(
      join(repoRoot, 'node_modules'),
      join(tempRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    for (const path of [
      'scripts/set-version.mjs',
      'scripts/semver-utils.mjs',
      'package.json',
      'package-lock.json',
      'extension/package.json',
      'extension/package-lock.json',
    ]) {
      cpSync(join(repoRoot, path), join(tempRoot, path));
    }

    execFileSync(process.execPath, [join(tempRoot, 'scripts/set-version.mjs'), '0.1.1'], {
      encoding: 'utf8',
    });

    assert.equal(JSON.parse(readFileSync(join(tempRoot, 'package.json'), 'utf8')).version, '0.1.1');
    assert.equal(JSON.parse(readFileSync(join(tempRoot, 'package-lock.json'), 'utf8')).version, '0.1.1');
    assert.equal(
      JSON.parse(readFileSync(join(tempRoot, 'extension', 'package.json'), 'utf8')).version,
      '0.1.1',
    );
    assert.equal(
      JSON.parse(readFileSync(join(tempRoot, 'extension', 'package-lock.json'), 'utf8')).version,
      '0.1.1',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
