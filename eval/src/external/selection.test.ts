import assert from 'node:assert/strict';
import { test } from 'node:test';
import { select, type Selectable } from './selection.ts';

const candidates: Selectable[] = [
  ...Array.from({ length: 30 }, (_, index) => ({ id: `big-${index}`, strata: ['compile', 'monorepo'] })),
  ...Array.from({ length: 8 }, (_, index) => ({ id: `mid-${index}`, strata: ['test', 'library'] })),
  ...Array.from({ length: 2 }, (_, index) => ({ id: `rare-${index}`, strata: ['enforcer', 'tiny'] })),
];

test('the same seed selects the same cases', () => {
  const first = select(candidates, { limit: 12, seed: 7 });
  const second = select(candidates, { limit: 12, seed: 7 });
  assert.deepEqual(first.ids, second.ids);
  assert.equal(first.ids.length, 12);
});

test('a different seed selects a different subset', () => {
  const a = select(candidates, { limit: 12, seed: 7 });
  const b = select(candidates, { limit: 12, seed: 8 });
  assert.notDeepEqual(a.ids, b.ids);
});

/**
 * The reason selection is stratified at all. A subset drawn uniformly from a
 * corpus that one project dominates measures that project, and the small strata
 * — often the interesting ones — vanish into rounding.
 */
test('a small stratum is not wiped out by a large one', () => {
  const selection = select(candidates, { limit: 12, seed: 7 });
  const rare = selection.ids.filter((id) => id.startsWith('rare-'));
  assert.ok(rare.length > 0, `the two-case stratum must be represented, got ${JSON.stringify(selection.ids)}`);
});

test('the selection is independent of the order the dataset was read in', () => {
  const reversed = [...candidates].reverse();
  assert.deepEqual(select(candidates, { limit: 12, seed: 7 }).ids, select(reversed, { limit: 12, seed: 7 }).ids);
});

test('a limit at or above the corpus size selects everything and says so', () => {
  const selection = select(candidates, { limit: 500, seed: 7 });
  assert.equal(selection.mode, 'all');
  assert.equal(selection.ids.length, candidates.length);
});

test('no limit selects everything', () => {
  assert.equal(select(candidates).ids.length, candidates.length);
});

test('explicit ids override sampling entirely', () => {
  const selection = select(candidates, { ids: ['rare-0', 'big-3'], limit: 1, seed: 7 });
  assert.equal(selection.mode, 'explicit');
  assert.deepEqual(selection.ids, ['big-3', 'rare-0']);
});

test('an unknown explicit id is dropped rather than invented', () => {
  const selection = select(candidates, { ids: ['rare-0', 'does-not-exist'] });
  assert.deepEqual(selection.ids, ['rare-0']);
});

/**
 * The manifest is what lets a published number say "the 40-case subset listed
 * here" instead of implying the corpus. It has to carry the denominator.
 */
test('the selection records how many cases it chose from, per stratum', () => {
  const selection = select(candidates, { limit: 12, seed: 7 });
  assert.equal(selection.available, 40);
  assert.equal(selection.strata['compile · monorepo']!.available, 30);
  assert.equal(selection.strata['enforcer · tiny']!.available, 2);
  const selected = Object.values(selection.strata).reduce((total, entry) => total + entry.selected, 0);
  assert.equal(selected, 12, 'the per-stratum selected counts must sum to the limit');
});
