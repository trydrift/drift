import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { caseOf, classifyUnmatchedRoseau, installMavenFetchStub } from './roseau.ts';

test('Roseau synthetic Maven repository serves POMs and JARs only for its fixture coordinates', async () => {
  const work = await mkdtemp(join(tmpdir(), 'drift-roseau-stub-'));
  const from = join(work, 'from.jar');
  const to = join(work, 'to.jar');
  await writeFile(from, 'from-jar');
  await writeFile(to, 'to-jar');
  const originalFetch = globalThis.fetch;
  const fallenThrough: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    fallenThrough.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const restore = installMavenFetchStub({ from, to });

  try {
    for (const [version, jar] of [
      ['1.0.0', from],
      ['2.0.0', to],
    ] as const) {
      const base = `https://repo1.maven.org/maven2/io/drift/bench/roseau-accuracy/${version}/roseau-accuracy-${version}`;
      const pomResponse = await fetch(`${base}.pom`);
      assert.equal(pomResponse.status, 200);
      assert.match(await pomResponse.text(), new RegExp(`<version>${version}</version>`));
      assert.match(pomResponse.headers.get('content-type') ?? '', /application\/xml/);

      const jarResponse = await fetch(`${base}.jar`);
      assert.equal(jarResponse.status, 200);
      assert.deepEqual(Buffer.from(await jarResponse.arrayBuffer()), await readFile(jar));
    }

    const unrelated = await fetch(
      'https://repo1.maven.org/maven2/org/example/unrelated/1.0.0/unrelated-1.0.0.pom',
    );
    assert.equal(unrelated.status, 404);
    assert.deepEqual(fallenThrough, [
      'https://repo1.maven.org/maven2/org/example/unrelated/1.0.0/unrelated-1.0.0.pom',
    ]);
  } finally {
    restore();
    globalThis.fetch = originalFetch;
    await rm(work, { recursive: true, force: true });
  }
});

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
