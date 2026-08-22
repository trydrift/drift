import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpecifierSet, isSubsetInterval, intersectsInterval } from '../dist/rationale/pep440.js';

describe('parsing a PEP 440 specifier set into an interval', () => {
  test('a bare floor has no ceiling', () => {
    assert.deepEqual(parseSpecifierSet('>=3.8'), { min: [3, 8], maxExclusive: null, imprecise: false });
  });

  test('a floor and a ceiling combine', () => {
    assert.deepEqual(parseSpecifierSet('>=3.9,<4'), { min: [3, 9], maxExclusive: [4], imprecise: false });
  });

  test('a compatible-release operator becomes a floor and an exclusive ceiling', () => {
    assert.deepEqual(parseSpecifierSet('~=3.10'), { min: [3, 10], maxExclusive: [4], imprecise: false });
  });

  test('a more precise compatible-release operator only bumps its own precision', () => {
    assert.deepEqual(parseSpecifierSet('~=3.10.2'), { min: [3, 10, 2], maxExclusive: [3, 11], imprecise: false });
  });

  test('a wildcard equality pins the whole minor line', () => {
    assert.deepEqual(parseSpecifierSet('==3.8.*'), { min: [3, 8], maxExclusive: [3, 9], imprecise: false });
  });

  test('a bare version with no operator is a pin, not a floor', () => {
    assert.deepEqual(parseSpecifierSet('3.11'), { min: [3, 11], maxExclusive: [3, 12], imprecise: false });
  });

  test('an exclusion alone cannot be expressed as an interval', () => {
    const parsed = parseSpecifierSet('!=3.9.7');
    assert.equal(parsed.imprecise, true);
  });

  test('an exclusion alongside real bounds still keeps the bounds, marked imprecise', () => {
    const parsed = parseSpecifierSet('>=3.9,!=3.9.7,<4');
    assert.deepEqual(parsed.min, [3, 9]);
    assert.deepEqual(parsed.maxExclusive, [4]);
    assert.equal(parsed.imprecise, true);
  });
});

describe('deciding whether one interval satisfies another', () => {
  test('a tighter floor and no ceiling is a subset of a lower floor', () => {
    const declared = parseSpecifierSet('>=3.10');
    const required = parseSpecifierSet('>=3.8');
    assert.equal(isSubsetInterval(declared, required), true);
  });

  test('a lower floor is not a subset of a raised one', () => {
    const declared = parseSpecifierSet('>=3.7');
    const required = parseSpecifierSet('>=3.9');
    assert.equal(isSubsetInterval(declared, required), false);
    assert.equal(intersectsInterval(declared, required), true);
  });

  test('non-overlapping intervals neither intersect nor form a subset', () => {
    const declared = parseSpecifierSet('>=3.6,<3.8');
    const required = parseSpecifierSet('>=3.9');
    assert.equal(isSubsetInterval(declared, required), false);
    assert.equal(intersectsInterval(declared, required), false);
  });

  test('an imprecise declared interval is never confirmed as a subset', () => {
    const declared = parseSpecifierSet('>=3.9,!=3.9.7');
    const required = parseSpecifierSet('>=3.8');
    assert.equal(isSubsetInterval(declared, required), false);
  });

  test('a pinned single version is a subset exactly when it falls inside the required range', () => {
    assert.equal(isSubsetInterval(parseSpecifierSet('3.9'), parseSpecifierSet('>=3.8,<4')), true);
    assert.equal(isSubsetInterval(parseSpecifierSet('3.7'), parseSpecifierSet('>=3.8,<4')), false);
  });
});
