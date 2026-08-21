import assert from 'node:assert/strict';
import test from 'node:test';
import { caseOf, classifyUnmatchedRoseau } from './roseau.ts';

test('Roseau attribution uses exact dataset package segments', () => {
  const known = new Set([
    'membersClazzNestedClazzDelete',
    'accessModifierClazzConstructorAccessDecreaseProtectedToNon',
    'genericsWildcardsClazzMethodParamUpperBoundsToLowerBounds',
  ]);

  assert.equal(
    caseOf(
      'testing_lib.membersClazzNestedClazzDelete.MembersClazzNestedClazzDelete$NestedClazz#removed()',
      known,
    ),
    'membersClazzNestedClazzDelete',
  );
  assert.equal(
    caseOf(
      'testing_lib.accessModifierClazzConstructorAccessDecreaseProtectedToNon.AccessModifierClazzConstructorAccessDecreaseProtectedToNon.PACKAGE_PROTECTED',
      known,
    ),
    'accessModifierClazzConstructorAccessDecreaseProtectedToNon',
  );
  assert.equal(
    caseOf(
      'testing_lib.genericsWildcardsClazzMethodParamUpperBoundsToLowerBounds.GenericsWildcardsClazzMethodParamUpperBoundsToLowerBounds#method(java.util.List)',
      known,
    ),
    'genericsWildcardsClazzMethodParamUpperBoundsToLowerBounds',
  );
});

test('Roseau attribution does not fuzzy-match helper or unrelated packages', () => {
  const known = new Set(['membersClazzNestedClazzDelete']);
  assert.equal(caseOf('testing_lib.membersClazzNestedClazzDeleteHelper.Helper#x()', known), null);
  assert.equal(caseOf('testing_lib.shared.Helper#x()', known), null);
  assert.equal(caseOf('java.lang.Object#toString()', known), null);
});

test('Roseau classifies source packages absent from the 267-case truth table', () => {
  const known = new Set(['accessModifierClazzNestedClazzAccessDecreasePublicToNon']);
  const sourcePackages = new Set([
    'accessModifierClazzNestedClazzAccessDecreaseProtectedToNon',
    'accessModifierClazzNestedClazzAccessDecreaseProtectedToPrivate',
    'accessModifierClazzNestedClazzAccessDecreasePublicToNon',
  ]);

  for (const symbol of [
    'testing_lib.accessModifierClazzNestedClazzAccessDecreaseProtectedToNon.AccessModifierClazzNestedClazzAccessDecreaseProtectedToNon$Clazz.AccessModifierClazzNestedClazzAccessDecreaseProtectedToNon$Clazz',
    'testing_lib.accessModifierClazzNestedClazzAccessDecreaseProtectedToPrivate.AccessModifierClazzNestedClazzAccessDecreaseProtectedToPrivate$Clazz.AccessModifierClazzNestedClazzAccessDecreaseProtectedToPrivate$Clazz',
  ]) {
    const classified = classifyUnmatchedRoseau(
      { kind: 'signature-changed', symbol, detail: `The signature of \`${symbol}\` changed.` },
      known,
      sourcePackages,
    );
    assert.equal(classified.classification, 'non-benchmark-source-package');
    assert.match(classified.reason, /absent from results\/bench\/jezek_dietrich\.json/);
  }
});
