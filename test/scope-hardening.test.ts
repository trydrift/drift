import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isProtectedPath, testWeakeningFindings, upgradedDependencyFindings, workaroundFindings } from '../dist/agents/scope.js';

/**
 * What an agent's diff is not allowed to do, beyond staying in scope. Each of
 * these was found by watching real upgrade sessions: they are the edits that
 * make a check pass without fixing anything.
 */

const patch = (file: string, ...lines: string[]) => [`diff --git a/${file} b/${file}`, ...lines].join('\n');

describe('protected paths', () => {
  test('a `dir/**` pattern guards every depth', () => {
    // This converted `**` to `.*` and then rewrote that `*` again, so
    // `node_modules/**` matched one level only and an agent could edit
    // `node_modules/logform/index.d.ts`.
    assert.equal(isProtectedPath('node_modules/logform/index.d.ts'), true);
    assert.equal(isProtectedPath('node_modules/x'), true);
    assert.equal(isProtectedPath('.github/workflows/nested/ci.yml'), true);
    assert.equal(isProtectedPath('packages/a/secrets/key.pem'), true);
    assert.equal(isProtectedPath('src/node_modules_helper.ts'), false);
    assert.equal(isProtectedPath('src/app.ts'), false);
  });
});

describe('edits that make a check pass without fixing anything', () => {
  test('lowered or removed coverage thresholds', () => {
    assert.match(workaroundFindings(patch('jest.config.js', '-      lines: 81.93,', '+      lines: 73,'), []).join(), /lowered the lines coverage threshold/);
    assert.deepEqual(workaroundFindings(patch('jest.config.js', '-      lines: 70,', '+      lines: 80,'), []), []);
  });

  test('relaxed compiler strictness, but not skipLibCheck', () => {
    assert.match(workaroundFindings(patch('tsconfig.json', '-    "strict": true,', '+    "strict": false,'), []).join(), /relaxed `strict`/);
    assert.deepEqual(workaroundFindings(patch('tsconfig.json', '+    "skipLibCheck": true,'), []), []);
  });

  test('a deleted test file', () => {
    assert.match(workaroundFindings('', [{ path: 'src/a.test.ts', status: 'deleted' }] as never).join(), /deleted test file/);
  });

  test('a new or reworded type-check suppression in source, but not a rename inside an existing lint comment', () => {
    assert.match(workaroundFindings(patch('src/keyring.ts', '-  // @ts-expect-error legacy', '+  // @ts-expect-error legacy,'), []).join(), /type-check suppression/);
    assert.deepEqual(workaroundFindings(patch('src/keyring.ts', '-  // @ts-expect-error legacy', '+  // @ts-expect-error legacy'), []), []);
    assert.deepEqual(workaroundFindings(patch('src/cli.ts', '-  // eslint-disable-next-line rulesdir/no-unsafe-execa', '+  // eslint-disable-next-line local/no-unsafe-execa'), []), []);
    assert.match(workaroundFindings(patch('src/cli.ts', '+  // eslint-disable-next-line no-undef'), []).join(), /lint or coverage suppression/);
  });

  test('assertions may be rewritten for a new API, but not dropped', () => {
    const changed = [{ path: 'src/a.test.ts', status: 'modified' }] as never;
    assert.deepEqual(testWeakeningFindings(patch('src/a.test.ts', '-    expect(tx.getMessageToSign(false)).toBe(x);', '+    expect(tx.getMessageToSign()).toBe(x);'), changed).errors, []);
    assert.match(testWeakeningFindings(patch('src/a.test.ts', '-    expect(a).toBe(1);', '-    expect(b).toBe(2);', '+    expect(a).toBe(1);'), changed).errors.join(), /removed an assertion/);
  });

  test('the upgraded dependency itself is never re-declared', () => {
    const bump = patch('package.json', '-    "@ethereumjs/common": "^3.1.1",', '+    "@ethereumjs/common": "^4.3.0",');
    assert.equal(upgradedDependencyFindings(bump, ['@ethereumjs/tx']).length, 0, 'a companion package may move');
    assert.match(upgradedDependencyFindings(bump, ['@ethereumjs/common']).join(), /upgraded dependency/);
  });
});
