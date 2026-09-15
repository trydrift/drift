import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderInstalledCheck } from '../dist/upgrade/run-installed-check.js';

/**
 * What the four surfaces actually say.
 *
 * The CLI, the MCP tool, the Action and the extension all render through this
 * one function, so the sentence that is easiest to drop — what was *not*
 * checked — cannot be dropped by one of them and kept by the others. These
 * tests exist mostly to pin that.
 */

const run = (over: Record<string, unknown> = {}) => ({
  packages: [],
  missing: [],
  checkedPackages: 0,
  uncheckedPackages: 0,
  assumedSkipped: 0,
  filesRead: 0,
  sourceComplete: true,
  ...over,
});

describe('a clean result says how much it covered', () => {
  test('names the number of packages checked', () => {
    const text = renderInstalledCheck(run({ checkedPackages: 12, filesRead: 340 }) as never);

    assert.match(text, /Every name imported from 12 packages exists in the version installed\./);
    assert.match(text, /Checked 12 packages against 340 files\./);
  });

  test('a truncated walk qualifies the clean result rather than asserting it', () => {
    const text = renderInstalledCheck(
      run({ checkedPackages: 3, filesRead: 5000, sourceComplete: false }) as never,
    );

    assert.match(text, /Some source was not read, so this is not a complete answer\./);
  });

  test('a complete walk makes no such caveat', () => {
    const text = renderInstalledCheck(run({ checkedPackages: 3, filesRead: 10 }) as never);

    assert.doesNotMatch(text, /not a complete answer/);
  });

  test('nothing checkable is stated plainly, not as a pass', () => {
    const text = renderInstalledCheck(run({ checkedPackages: 0 }) as never);

    assert.match(text, /Nothing could be checked against its installed version\./);
    assert.doesNotMatch(text, /Every name/);
  });
});

describe('a finding names the place and the version', () => {
  const missing = [
    {
      symbol: 'gone',
      file: 'src/a.ts',
      line: 12,
      specifier: 'pkg',
      packageName: 'pkg',
      installedVersion: '3.1.0',
    },
    {
      symbol: 'alsoGone',
      file: 'src/b.ts',
      line: 4,
      specifier: 'pkg',
      packageName: 'pkg',
      installedVersion: '3.1.0',
    },
  ];

  test('counts imports and files, and lists each with its version', () => {
    const text = renderInstalledCheck(run({ missing, checkedPackages: 1, filesRead: 20 }) as never);

    assert.match(text, /2 imports in 2 files name something the installed version does not export\./);
    assert.match(text, /src\/a\.ts:12\s+gone\s+—\s+not exported by pkg@3\.1\.0/);
    assert.match(text, /src\/b\.ts:4\s+alsoGone\s+—\s+not exported by pkg@3\.1\.0/);
  });

  test('one finding reads as one, not as a plural', () => {
    const text = renderInstalledCheck(run({ missing: missing.slice(0, 1), checkedPackages: 1 }) as never);

    assert.match(text, /1 import in 1 file names something/);
  });
});

describe('what could not be checked is always said', () => {
  test('unchecked packages are listed with their stated reason', () => {
    const text = renderInstalledCheck(
      run({
        checkedPackages: 1,
        uncheckedPackages: 2,
        packages: [
          {
            packageName: 'vue',
            installedVersion: '3.4.0',
            checked: 0,
            missing: [],
            unchecked: { reason: 'incomplete-surface', detail: 'The public re-export graph could not be fully expanded.' },
          },
          {
            packageName: 'left-pad',
            installedVersion: '1.3.0',
            checked: 0,
            missing: [],
            unchecked: { reason: 'no-surface', detail: 'No type declarations were readable.' },
          },
        ],
      }) as never,
    );

    assert.match(text, /2 could not be checked\./);
    assert.match(text, /vue\s+—\s+The public re-export graph could not be fully expanded\./);
    assert.match(text, /left-pad\s+—\s+No type declarations were readable\./);
  });

  test('a package nothing imports is not paraded as a gap', () => {
    // `no-imports` is not a limitation, it is an absence of a question.
    const text = renderInstalledCheck(
      run({
        checkedPackages: 1,
        uncheckedPackages: 1,
        packages: [
          {
            packageName: 'unused',
            installedVersion: '1.0.0',
            checked: 0,
            missing: [],
            unchecked: { reason: 'no-imports', detail: 'Nothing in this repository imports it.' },
          },
        ],
      }) as never,
    );

    assert.doesNotMatch(text, /Not checked:/);
  });

  test('dependencies with no pinned version are reported as skipped, with the reason', () => {
    const text = renderInstalledCheck(run({ checkedPackages: 2, assumedSkipped: 7 }) as never);

    assert.match(text, /7 dependencies were skipped: no lockfile pins what is installed/);
  });

  test('one skipped dependency reads as one', () => {
    const text = renderInstalledCheck(run({ checkedPackages: 2, assumedSkipped: 1 }) as never);

    assert.match(text, /1 dependency was skipped/);
  });
});

describe('the limit is stated every time', () => {
  test('member access is named as out of scope, on a clean run', () => {
    const text = renderInstalledCheck(run({ checkedPackages: 4 }) as never);

    assert.match(text, /does not follow member access/);
    assert.match(text, /not that your use of the package is correct/);
  });

  test('and on a run with findings', () => {
    const text = renderInstalledCheck(
      run({
        checkedPackages: 1,
        missing: [
          { symbol: 'x', file: 'a.ts', line: 1, specifier: 'p', packageName: 'p', installedVersion: '1.0.0' },
        ],
      }) as never,
    );

    assert.match(text, /does not follow member access/);
  });
});
