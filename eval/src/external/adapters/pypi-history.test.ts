import assert from 'node:assert/strict';
import test from 'node:test';
import { comparePep440, parsePep440, resolveVersionAsOfDate, satisfiesPep440 } from './pypi-history.ts';

test('parsePep440 orders dev < pre-release < final < post, and refuses epochs/local versions', () => {
  const order = ['1.0.dev1', '1.0a1', '1.0b1', '1.0rc1', '1.0', '1.0.post1'].map((v) => parsePep440(v)!);
  for (let i = 0; i < order.length - 1; i += 1) {
    assert.equal(comparePep440(order[i]!, order[i + 1]!), -1, `${i} should sort before ${i + 1}`);
  }
  assert.equal(parsePep440('1!2.0'), null, 'an epoch is out of scope, not guessed at');
  assert.equal(parsePep440('2.0+local.1'), null, 'a local version is out of scope, not guessed at');
});

test('comparePep440 pads a shorter release with zeros', () => {
  assert.equal(comparePep440(parsePep440('1.2')!, parsePep440('1.2.0')!), 0);
  assert.equal(comparePep440(parsePep440('1.2.1')!, parsePep440('1.2')!), 1);
});

test('satisfiesPep440 covers every operator this module claims to support', () => {
  assert.equal(satisfiesPep440('3.2.1', '>=3.2,<4.0'), true);
  assert.equal(satisfiesPep440('4.0.0', '>=3.2,<4.0'), false);
  assert.equal(satisfiesPep440('3.2.1', '!=3.2.1'), false);
  assert.equal(satisfiesPep440('3.2.2', '!=3.2.1'), true);
  assert.equal(satisfiesPep440('2.5.9', '~=2.5.0'), true, '~= is a compatible-release clause');
  assert.equal(satisfiesPep440('2.6.0', '~=2.5.0'), false);
  assert.equal(satisfiesPep440('3.5.2', '!=3.5.*'), false, 'a wildcard clause matches by release prefix');
  assert.equal(satisfiesPep440('3.6.0', '!=3.5.*'), true);
});

test('satisfiesPep440 returns null — unknown, not rejected — for a clause it cannot parse', () => {
  assert.equal(satisfiesPep440('1.0', '=== 1.0'), null);
  assert.equal(satisfiesPep440('1.0', '>=1!2.0'), null, 'an epoch bound is unparseable, not a silent pass');
});

function fakeFetch(releases: Record<string, { version: string; date: string; yanked?: boolean }[]>) {
  return async (_url: string) => ({
    ok: true,
    json: async () => ({
      releases: Object.fromEntries(
        Object.entries(releases).map(([version, files]) => [
          version,
          files.map((f) => ({ upload_time_iso_8601: f.date, yanked: f.yanked ?? false })),
        ]),
      ),
    }),
  });
}

test('resolveVersionAsOfDate picks the newest release published by the cutoff that satisfies the specifier', async () => {
  const fetchImpl = fakeFetch({
    '3.1.0': [{ version: '3.1.0', date: '2019-06-01T00:00:00Z' }],
    '3.2.0': [{ version: '3.2.0', date: '2020-01-15T00:00:00Z' }],
    '3.3.0': [{ version: '3.3.0', date: '2020-06-01T00:00:00Z' }], // published after the cutoff
  });
  const pin = await resolveVersionAsOfDate('django', '2020-03-01', null, fetchImpl);
  assert.deepEqual(pin, { version: '3.2.0', source: 'pypi-date-filtered' });
});

test('resolveVersionAsOfDate respects the declared specifier', async () => {
  const fetchImpl = fakeFetch({
    '3.1.0': [{ version: '3.1.0', date: '2019-06-01T00:00:00Z' }],
    '3.2.0': [{ version: '3.2.0', date: '2020-01-15T00:00:00Z' }],
  });
  const pin = await resolveVersionAsOfDate('django', '2020-03-01', '<3.2', fetchImpl);
  assert.deepEqual(pin, { version: '3.1.0', source: 'pypi-date-filtered' });
});

test('resolveVersionAsOfDate skips a yanked release even if it is otherwise the best match', async () => {
  const fetchImpl = fakeFetch({
    '3.1.0': [{ version: '3.1.0', date: '2019-06-01T00:00:00Z' }],
    '3.2.0': [{ version: '3.2.0', date: '2020-01-15T00:00:00Z', yanked: true }],
  });
  const pin = await resolveVersionAsOfDate('django', '2020-03-01', null, fetchImpl);
  assert.deepEqual(pin, { version: '3.1.0', source: 'pypi-date-filtered' });
});

test('resolveVersionAsOfDate prefers a final release over a pre-release published later, when both qualify', async () => {
  const fetchImpl = fakeFetch({
    '3.2.0': [{ version: '3.2.0', date: '2020-01-01T00:00:00Z' }],
    '3.3.0rc1': [{ version: '3.3.0rc1', date: '2020-02-01T00:00:00Z' }],
  });
  const pin = await resolveVersionAsOfDate('django', '2020-03-01', null, fetchImpl);
  assert.deepEqual(pin, { version: '3.2.0', source: 'pypi-date-filtered' });
});

test('resolveVersionAsOfDate returns null when nothing qualifies, the package is unknown, or the network fails', async () => {
  assert.equal(
    await resolveVersionAsOfDate('nope', '2020-03-01', null, async () => ({ ok: false, json: async () => ({}) })),
    null,
  );
  assert.equal(
    await resolveVersionAsOfDate('nope', '2020-03-01', null, async () => {
      throw new Error('network down');
    }),
    null,
  );
  const fetchImpl = fakeFetch({ '3.9.0': [{ version: '3.9.0', date: '2021-01-01T00:00:00Z' }] });
  assert.equal(await resolveVersionAsOfDate('django', '2020-03-01', null, fetchImpl), null, 'nothing was published yet');
});
