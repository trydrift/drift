import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduceVerdict } from './end-to-end.ts';

/**
 * The case-level verdict, which is the only thing D4 scores.
 *
 * Production states a verdict per finding and, separately, records what it
 * looked at; it has no repository-level verdict function, so this reduction is
 * the benchmark's one derivation of the user-facing conclusion and has to be
 * pinned. The load-bearing property is that "no findings" is not the same fact
 * as "nothing was checked", and the two must not collapse into one verdict.
 */

const CHECKED = [
  { surface: 'api-surface', dependency: 'fixture-lib', status: 'checked' },
  { surface: 'localization', status: 'checked' },
];

test('no breaking change, surfaces genuinely checked: the honest verdict is a safe one', () => {
  assert.equal(reduceVerdict([], true, CHECKED), 'no-incompatible-change-in-checked-surfaces');
});

test('no breaking change and no computed surface is insufficient evidence, never safe', () => {
  assert.equal(
    reduceVerdict([], true, [
      { surface: 'api-surface', dependency: 'fixture-lib', status: 'unavailable' },
      { surface: 'localization', status: 'checked' },
    ]),
    'insufficient-evidence',
  );
});

test('no breaking change and an unsearched repository is insufficient evidence', () => {
  assert.equal(
    reduceVerdict([], true, [
      { surface: 'api-surface', dependency: 'fixture-lib', status: 'checked' },
      { surface: 'localization', status: 'skipped' },
    ]),
    'insufficient-evidence',
  );
});

test('an empty surface list can never produce a safe verdict', () => {
  assert.equal(reduceVerdict([], true, []), 'insufficient-evidence');
});

test('an inconclusive finding never outranks a positive one', () => {
  assert.equal(
    reduceVerdict(['insufficient-evidence', 'locally-affected'], false, CHECKED),
    'locally-affected',
  );
  assert.equal(
    reduceVerdict(['no-incompatible-change-in-checked-surfaces', 'insufficient-evidence'], false, CHECKED),
    'insufficient-evidence',
  );
});
