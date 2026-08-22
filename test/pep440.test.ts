import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpecifierSet, isSubsetInterval, intersectsInterval } from '../dist/rationale/pep440.js';

describe('parsing a PEP 440 specifier set into an interval', () => {
  test('a bare floor has no ceiling', () => {
    assert.deepEqual(parseSpecifierSet('>=3.8'), {
      min: { value: [3, 8], inclusive: true },
      max: null,
      imprecise: false,
    });
  });

  test('a floor and a ceiling combine', () => {
    assert.deepEqual(parseSpecifierSet('>=3.9,<4'), {
      min: { value: [3, 9], inclusive: true },
      max: { value: [4], inclusive: false },
      imprecise: false,
    });
  });

  test('a compatible-release operator becomes a floor and an exclusive ceiling', () => {
    assert.deepEqual(parseSpecifierSet('~=3.10'), {
      min: { value: [3, 10], inclusive: true },
      max: { value: [4], inclusive: false },
      imprecise: false,
    });
  });

  test('a more precise compatible-release operator only bumps its own precision', () => {
    assert.deepEqual(parseSpecifierSet('~=3.10.2'), {
      min: { value: [3, 10, 2], inclusive: true },
      max: { value: [3, 11], inclusive: false },
      imprecise: false,
    });
  });

  test('an explicit wildcard equality pins the whole minor line', () => {
    assert.deepEqual(parseSpecifierSet('==3.8.*'), {
      min: { value: [3, 8], inclusive: true },
      max: { value: [3, 9], inclusive: false },
      imprecise: false,
    });
  });

  test('an explicit exact equality with no wildcard is a single release, not a whole line', () => {
    assert.deepEqual(parseSpecifierSet('==3.11'), {
      min: { value: [3, 11], inclusive: true },
      max: { value: [3, 11], inclusive: true },
      imprecise: false,
    });
  });

  test('an explicit exact equality at micro precision is just as narrow', () => {
    assert.deepEqual(parseSpecifierSet('==3.11.4'), {
      min: { value: [3, 11, 4], inclusive: true },
      max: { value: [3, 11, 4], inclusive: true },
      imprecise: false,
    });
  });

  test('<=3.11 does not admit 3.11.x patch releases above it', () => {
    const interval = parseSpecifierSet('<=3.11');
    assert.deepEqual(interval, { min: null, max: { value: [3, 11], inclusive: true }, imprecise: false });
    // The bug this guards: 3.11.4 must not satisfy <=3.11.
    assert.equal(
      isSubsetInterval({ min: { value: [3, 11, 4], inclusive: true }, max: { value: [3, 11, 4], inclusive: true }, imprecise: false }, interval),
      false,
    );
  });

  test('a bare version with no operator widens to the whole release line, not an exact pin', () => {
    assert.deepEqual(parseSpecifierSet('3.11'), {
      min: { value: [3, 11], inclusive: true },
      max: { value: [3, 12], inclusive: false },
      imprecise: false,
    });
  });

  test('an exclusion alone cannot be expressed as an interval', () => {
    const parsed = parseSpecifierSet('!=3.9.7');
    assert.equal(parsed.imprecise, true);
  });

  test('an exclusion alongside real bounds still keeps the bounds, marked imprecise', () => {
    const parsed = parseSpecifierSet('>=3.9,!=3.9.7,<4');
    assert.deepEqual(parsed.min, { value: [3, 9], inclusive: true });
    assert.deepEqual(parsed.max, { value: [4], inclusive: false });
    assert.equal(parsed.imprecise, true);
  });

  test('a prerelease suffix is never read as if it were the plain release', () => {
    for (const spec of ['>=3.11.0rc1', '==3.11.0a1', '>=3.11.0b2', '==3.11.0.dev0']) {
      assert.equal(parseSpecifierSet(spec).imprecise, true, `expected ${spec} to be imprecise`);
    }
  });

  test('a post-release suffix is never read as if it were the plain release', () => {
    assert.equal(parseSpecifierSet('>=3.11.0.post1').imprecise, true);
  });

  test('a local version identifier is never read as if it were the plain release', () => {
    assert.equal(parseSpecifierSet('==3.11.0+local.1').imprecise, true);
  });

  test('an epoch is never silently dropped', () => {
    assert.equal(parseSpecifierSet('>=1!3.11').imprecise, true);
  });

  test('unsupported syntax marks the set imprecise rather than being guessed at', () => {
    assert.equal(parseSpecifierSet('not a specifier').imprecise, true);
  });

  test('=== is arbitrary string equality, never read as semantic version equality', () => {
    // PEP 440: `===X` is a literal string comparison with no zero-padding or
    // prefix matching. `===3.11` must not be treated as if it admitted 3.11.0
    // the way `==3.11` legitimately does.
    assert.equal(parseSpecifierSet('===3.11').imprecise, true);
  });

  test('~=X with a single release segment is invalid and marks the set imprecise', () => {
    // PEP 440 requires at least two segments (major.minor) for ~=; there is
    // no defined meaning for ~=1 (nothing to drop to compute the ceiling).
    assert.equal(parseSpecifierSet('~=1').imprecise, true);
  });

  test('~=X.Y with two segments is still valid', () => {
    assert.equal(parseSpecifierSet('~=1.0').imprecise, false);
  });

  test('a wildcard attached to an operator that does not support one is invalid', () => {
    for (const spec of ['>=3.11.*', '<=3.11.*', '>3.11.*', '<3.11.*', '~=3.11.*']) {
      assert.equal(parseSpecifierSet(spec).imprecise, true, `expected ${spec} to be imprecise`);
    }
  });

  test('a self-contradictory range admits no release and is imprecise, not a confident interval', () => {
    const parsed = parseSpecifierSet('>=3.12,<3.11');
    assert.equal(parsed.imprecise, true);
  });

  test('a boundary-contradictory range (exclusive bounds meeting at the same point) is also imprecise', () => {
    assert.equal(parseSpecifierSet('>3.11,<3.11').imprecise, true);
    assert.equal(parseSpecifierSet('>=3.11,<3.11').imprecise, true);
  });

  test('a single-point inclusive range is not empty', () => {
    assert.equal(parseSpecifierSet('>=3.11,<=3.11').imprecise, false);
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

  test('an imprecise required interval is never confirmed as a subset either', () => {
    const declared = parseSpecifierSet('>=3.11');
    const required = parseSpecifierSet('>=3.9,!=3.9.7');
    assert.equal(isSubsetInterval(declared, required), false);
  });

  test('a pinned single version is a subset exactly when it falls inside the required range', () => {
    assert.equal(isSubsetInterval(parseSpecifierSet('3.9'), parseSpecifierSet('>=3.8,<4')), true);
    assert.equal(isSubsetInterval(parseSpecifierSet('3.7'), parseSpecifierSet('>=3.8,<4')), false);
  });

  test('an exact ==3.11 is not a subset of a floor it falls short of', () => {
    assert.equal(isSubsetInterval(parseSpecifierSet('==3.11'), parseSpecifierSet('>=3.11.1')), false);
  });

  test('an exact ==3.11 is a subset of a range that contains it, and only it', () => {
    const declared = parseSpecifierSet('==3.11');
    assert.equal(isSubsetInterval(declared, parseSpecifierSet('>=3.9,<4')), true);
    assert.equal(isSubsetInterval(declared, parseSpecifierSet('>=3.11.1,<4')), false);
  });

  test('a self-contradictory declared range never confirms compatibility, even though its bounds happen to satisfy the required floor', () => {
    // Before the emptiness check, `>=3.12,<3.11` was left `imprecise: false`
    // with min=[3,12] and max=[3,11]. Its min alone happened to satisfy a
    // required floor of >=3.9, so isSubsetInterval confidently answered
    // "compatible" for a declaration that in fact admits no version at all.
    const declared = parseSpecifierSet('>=3.12,<3.11');
    const required = parseSpecifierSet('>=3.9');
    assert.equal(isSubsetInterval(declared, required), false);
    // Nor should the fallback confidently call it incompatible: an
    // unrepresentable/contradictory declaration must land on "cannot tell",
    // not a confident answer in either direction.
    assert.equal(intersectsInterval(declared, required), true);
  });

  test('inclusive and exclusive bounds at the same value are told apart', () => {
    // declared <=3.11 is not a subset of required <3.11 — the boundary point
    // 3.11 itself is allowed by the declared floor but not by the required one.
    assert.equal(isSubsetInterval(parseSpecifierSet('<=3.11'), parseSpecifierSet('<3.11')), false);
    // declared <3.11 is a subset of required <=3.11 — every point declared allows
    // is strictly below 3.11, which required also allows.
    assert.equal(isSubsetInterval(parseSpecifierSet('<3.11'), parseSpecifierSet('<=3.11')), true);
  });
});
