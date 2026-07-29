import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature } from '../dist/runners/webhook.js';
import { matchGlob, matchesAny } from '../dist/util/glob.js';
import { stableId, slugify } from '../dist/util/id.js';

describe('webhook signature verification', () => {
  const secret = 'a-test-secret';
  const body = Buffer.from(JSON.stringify({ action: 'created' }));
  const valid = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  test('accepts a correct signature', () => {
    assert.equal(verifySignature(body, valid, secret), true);
  });

  test('rejects a tampered body', () => {
    assert.equal(verifySignature(Buffer.from('{"action":"deleted"}'), valid, secret), false);
  });

  test('rejects a wrong secret', () => {
    assert.equal(verifySignature(body, valid, 'other-secret'), false);
  });

  test('fails closed on missing or malformed input', () => {
    assert.equal(verifySignature(body, undefined, secret), false);
    assert.equal(verifySignature(body, 'garbage', secret), false);
    assert.equal(verifySignature(body, 'sha1=abc', secret), false);
    assert.equal(verifySignature(body, valid, ''), false, 'an empty secret must never pass');
  });
});

describe('glob matching', () => {
  test('single star does not cross path separators', () => {
    assert.ok(matchGlob('src/*.ts', 'src/a.ts'));
    assert.ok(!matchGlob('src/*.ts', 'src/nested/a.ts'));
  });

  test('double star crosses separators and may match zero segments', () => {
    assert.ok(matchGlob('src/**/*.ts', 'src/a.ts'));
    assert.ok(matchGlob('src/**/*.ts', 'src/deep/nested/a.ts'));
    assert.ok(matchGlob('**/*.lock', 'a/b/c.lock'));
  });

  test('matches package names', () => {
    assert.ok(matchGlob('@types/*', '@types/node'));
    assert.ok(!matchGlob('@types/*', 'typescript'));
    assert.ok(matchesAny(['express', 'acme-*'], 'acme-sdk'));
  });

  test('escapes regex metacharacters in literals', () => {
    assert.ok(matchGlob('a.b.c', 'a.b.c'));
    assert.ok(!matchGlob('a.b.c', 'axbxc'), 'a dot is a literal dot, not "any character"');
  });
});

describe('identifiers', () => {
  test('ids are deterministic across calls', () => {
    assert.equal(stableId('bc', 'pkg', '1.0.0'), stableId('bc', 'pkg', '1.0.0'));
    assert.notEqual(stableId('bc', 'pkg', '1.0.0'), stableId('bc', 'pkg', '2.0.0'));
  });

  test('slugs are safe for git refs', () => {
    assert.equal(slugify('@scope/Package Name!'), 'scope-package-name');
    assert.equal(slugify('...'), 'change', 'never produces an empty ref component');
  });
});
