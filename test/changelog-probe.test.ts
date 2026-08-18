import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchChangelog, fetchMigrationGuide } from '../dist/evidence/changelog.js';
import { clearHttpCache } from '../dist/util/http.js';

/**
 * There is no API that answers "does this repository have a changelog" without
 * credentials for it, so Drift guesses filenames. That makes the *pacing* of
 * the guessing a real cost — thirty-two sequential round trips per package with
 * no changelog — and the pacing is the only thing these tests are about. Which
 * document wins, and how many requests it took to find out, must both stay put.
 */

const realFetch = globalThis.fetch;

function stubFetch(present: Record<string, string>): { calls: () => string[] } {
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const path = url.replace('https://raw.githubusercontent.com/acme/widget/', '');
    const body = present[path];
    return Promise.resolve(
      body === undefined
        ? new Response('Not Found', { status: 404 })
        : new Response(body, { status: 200 }),
    );
  }) as typeof fetch;
  return { calls: () => calls };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

describe('finding a changelog by guessing its name', () => {
  test('the overwhelmingly likely candidate costs exactly one request', async () => {
    const { calls } = stubFetch({ 'main/CHANGELOG.md': '# 1.0.0\n' });
    const found = await fetchChangelog('acme/widget');

    assert.equal(found?.path, 'CHANGELOG.md');
    assert.equal(found?.branch, 'main');
    // The common case must not have got more expensive to make the rare one cheaper.
    assert.equal(calls().length, 1);
  });

  test('a repository with no changelog answers in a handful of round trips, not one at a time', async () => {
    const { calls } = stubFetch({});
    const found = await fetchChangelog('acme/widget');

    assert.equal(found, null);
    // Every candidate is still asked about — the same coverage as before — but
    // the first is alone and the rest go out in waves.
    assert.equal(calls().length, 30);
  });

  test('the winner is the highest-priority match, not whichever answered first', async () => {
    // Both exist. `CHANGES.md` is earlier in the list than `HISTORY.md`, and
    // that has to decide it however the responses interleave.
    const { calls } = stubFetch({ 'main/HISTORY.md': 'old', 'main/CHANGES.md': 'new' });
    const found = await fetchChangelog('acme/widget');

    assert.equal(found?.path, 'CHANGES.md');
    assert.equal(found?.content, 'new');
    assert.ok(calls().length > 1);
  });

  test('a master-only repository is still found, on the branch it is on', async () => {
    stubFetch({ 'master/CHANGELOG.md': '# 2.0.0\n' });
    const found = await fetchChangelog('acme/widget');

    assert.equal(found?.path, 'CHANGELOG.md');
    assert.equal(found?.branch, 'master');
  });

  test('main wins over master when a repository somehow has both', async () => {
    stubFetch({ 'main/CHANGELOG.md': 'from main', 'master/CHANGELOG.md': 'from master' });
    assert.equal((await fetchChangelog('acme/widget'))?.content, 'from main');
  });

  test('an empty file is not a changelog', async () => {
    stubFetch({ 'main/CHANGELOG.md': '   \n', 'main/CHANGES.md': '# real\n' });
    const found = await fetchChangelog('acme/widget');

    assert.equal(found?.path, 'CHANGES.md');
  });

  test('migration guides are probed the same way', async () => {
    const { calls } = stubFetch({ 'main/UPGRADING.md': '# how to upgrade\n' });
    const found = await fetchMigrationGuide('acme/widget');

    assert.equal(found?.path, 'UPGRADING.md');
    assert.ok(calls().length <= 18);
  });
});
