import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveManifestRanges } from '../dist/detect/resolve-ranges.js';

const base = {
  ecosystem: 'npm' as const,
  kind: 'runtime' as const,
  bump: 'unknown' as const,
  manifestPath: 'package.json',
  source: 'manifest' as const,
};

const registry = async (name: string) =>
  name === 'execa'
    ? { versions: ['5.0.0', '5.1.1', '7.0.0', '7.2.0', '8.0.0', '8.0.1', '8.4.2', '9.0.0-beta.1'] }
    : null;

describe('resolveManifestRanges', () => {
  test('resolves a range→range manifest bump to concrete point versions', async () => {
    const [change] = await resolveManifestRanges(
      [{ ...base, name: 'execa', from: null, to: null, rawFrom: '^5.1.1', rawTo: '^8.0.1' }],
      { lookup: registry },
    );
    assert.equal(change.from, '5.1.1');
    assert.equal(change.to, '8.4.2'); // max satisfying `^8.0.1`, prereleases excluded
    assert.equal(change.bump, 'major');
  });

  test('leaves an already-resolved change untouched and makes no lookup', async () => {
    let called = false;
    const [change] = await resolveManifestRanges(
      [{ ...base, name: 'execa', from: '5.1.1', to: '8.0.1', rawFrom: '^5.1.1', rawTo: '^8.0.1' }],
      {
        lookup: async () => {
          called = true;
          return null;
        },
      },
    );
    assert.equal(called, false);
    assert.equal(change.to, '8.0.1');
  });

  test('lockfile-sourced changes are never touched', async () => {
    let called = false;
    await resolveManifestRanges(
      [{ ...base, source: 'lockfile', name: 'execa', from: null, to: null, rawFrom: '^5', rawTo: '^8' }],
      { lookup: async () => ((called = true), null) },
    );
    assert.equal(called, false);
  });

  test('a registry miss leaves the change exactly as it was — no guess', async () => {
    const input = { ...base, name: 'nonesuch', from: null, to: null, rawFrom: '^1', rawTo: '^2' };
    const [change] = await resolveManifestRanges([input], { lookup: async () => null });
    assert.equal(change.from, null);
    assert.equal(change.to, null);
  });

  test('non-semver ecosystems (maven) are left alone', async () => {
    let called = false;
    const [change] = await resolveManifestRanges(
      [{ ...base, ecosystem: 'maven', name: 'com.google.guava:guava', from: null, to: null, rawFrom: '[30,)', rawTo: '[33,)' }],
      { lookup: async () => ((called = true), null) },
    );
    assert.equal(called, false);
    assert.equal(change.to, null);
  });

  test('only the unresolved side is looked up when the other is already pinned', async () => {
    const [change] = await resolveManifestRanges(
      [{ ...base, name: 'execa', from: '7.2.0', to: null, rawFrom: '7.2.0', rawTo: '^8' }],
      { lookup: registry },
    );
    assert.equal(change.from, '7.2.0');
    assert.equal(change.to, '8.4.2');
    assert.equal(change.bump, 'major');
  });
});
