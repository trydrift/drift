import assert from 'node:assert/strict';
import { test } from 'node:test';

import { probeEnvironment, readsAsVersion, probeVersionString } from './environment.ts';

test('readsAsVersion accepts a line with a number, rejects a usage banner', () => {
  assert.equal(readsAsVersion('git version 2.39.5 (Apple Git-154)'), true);
  assert.equal(readsAsVersion('openjdk version "19" 2022-09-20'), true);
  assert.equal(readsAsVersion('Docker version 29.7.2, build a7dcaa6'), true);
  assert.equal(readsAsVersion('japicmp 0.23.1'), true);

  // The exact string this change exists to keep out of the version field.
  assert.equal(readsAsVersion('SYNOPSIS'), false);
  assert.equal(readsAsVersion('Usage: japicmp [options]'), false);
  assert.equal(readsAsVersion('NAME'), false);
  assert.equal(readsAsVersion(''), false);
});

test('probeVersionString returns a fallback line that already reads as a version, untouched', async () => {
  assert.equal(
    await probeVersionString('does-not-matter', undefined, 'git version 2.39.5'),
    'git version 2.39.5',
  );
});

test('probeVersionString falls back to versionArgs when the first line is a banner', async () => {
  // `node --version` prints `vXX.Y.Z`, which reads as a version.
  const version = await probeVersionString('node', ['--version'], 'SYNOPSIS');
  assert.match(version, /^v\d+\./);
});

test('probeVersionString reports "version unknown" — never a banner token — when nothing answers', async () => {
  assert.equal(
    await probeVersionString('node', ['--definitely-not-a-flag'], 'SYNOPSIS'),
    'installed (version unknown)',
  );
  assert.equal(
    await probeVersionString('some-tool', undefined, 'SYNOPSIS'),
    'installed (version unknown)',
  );
});

test('probeEnvironment never leaves a banner token in a present tool\'s version field', async () => {
  const env = await probeEnvironment();
  for (const tool of env.tools) {
    if (!tool.available) {
      assert.equal(tool.version, 'unavailable');
      continue;
    }
    assert.ok(
      readsAsVersion(tool.version) || tool.version === 'installed (version unknown)',
      `${tool.tool} recorded a non-version, non-"unknown" string: ${JSON.stringify(tool.version)}`,
    );
  }
});
