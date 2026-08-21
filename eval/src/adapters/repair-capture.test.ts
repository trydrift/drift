import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRepairCaptureBuilder, goldPatchMatches, normalizePatch } from './repair-capture.ts';

test('recordCommit only counts a file as changed when its content actually differs', async () => {
  const builder = createRepairCaptureBuilder();
  const before = new Map([
    ['src/a.ts', 'const x = 1;\n'],
    ['src/b.ts', 'const y = 2;\n'],
  ]);
  builder.recordCommit(
    ['src/a.ts', 'src/b.ts'],
    before,
    [
      { path: 'src/a.ts', content: 'const x = 1;\n' }, // identical — not a real change
      { path: 'src/b.ts', content: 'const y = 3;\n' },
    ],
  );
  const capture = await builder.finalize();
  assert.deepEqual(capture.changedFiles, ['src/b.ts']);
});

test('a file changed outside the union of every recorded commit\'s allowedFiles is a production scope escape', async () => {
  const builder = createRepairCaptureBuilder();
  const before = new Map([['src/a.ts', 'old']]);
  builder.recordCommit(['src/a.ts'], before, [
    { path: 'src/a.ts', content: 'new-a' },
    { path: 'src/b.ts', content: 'new-b' }, // never declared allowed
  ]);
  const capture = await builder.finalize();
  assert.deepEqual(capture.changedFiles, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(capture.productionScopeEscapeFiles, ['src/b.ts']);
});

test('a file changed within allowedFiles is never a production scope escape, regardless of ground truth', async () => {
  const builder = createRepairCaptureBuilder();
  const before = new Map([
    ['src/a.ts', 'old-a'],
    ['src/b.ts', 'old-b'],
  ]);
  builder.recordCommit(['src/a.ts', 'src/b.ts'], before, [{ path: 'src/b.ts', content: 'new-b' }]);
  const capture = await builder.finalize();
  assert.deepEqual(capture.productionScopeEscapeFiles, []);
});

test('finalize with no recorded commits produces an empty capture', async () => {
  const capture = await createRepairCaptureBuilder().finalize();
  assert.deepEqual(capture, { changedFiles: [], productionScopeEscapeFiles: [], patch: '' });
});

test('the captured patch reflects the real edit and never contains a temp-directory path', async () => {
  const builder = createRepairCaptureBuilder();
  builder.recordCommit(
    ['src/app.js'],
    new Map([['src/app.js', "import { oldName } from 'lib';\n"]]),
    [{ path: 'src/app.js', content: "import { newName } from 'lib';\n" }],
  );
  const capture = await builder.finalize();
  assert.match(capture.patch, /-import \{ oldName \} from 'lib';/);
  assert.match(capture.patch, /\+import \{ newName \} from 'lib';/);
  assert.doesNotMatch(capture.patch, /drift-eval-repair-patch-/, 'the staging temp-dir name must never leak into the patch text');
});

test('running the same edit twice produces identically-normalized patches across separate temp directories', async () => {
  async function capturePatch(): Promise<string> {
    const builder = createRepairCaptureBuilder();
    builder.recordCommit(
      ['src/app.js'],
      new Map([['src/app.js', 'const value = oldName();\n']]),
      [{ path: 'src/app.js', content: 'const value = newName();\n' }],
    );
    return (await builder.finalize()).patch;
  }
  const [first, second] = await Promise.all([capturePatch(), capturePatch()]);
  assert.equal(normalizePatch(first), normalizePatch(second));
});

test('normalizePatch strips index lines and hunk line-number ranges but preserves +/- content', () => {
  const patch = [
    'diff --git a/src/app.js b/src/app.js',
    'index 1111111..2222222 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -1,3 +1,3 @@',
    ' unchanged line',
    '-const value = oldName();',
    '+const value = newName();',
    '',
  ].join('\n');
  const normalized = normalizePatch(patch);
  assert.doesNotMatch(normalized, /^index /m);
  assert.match(normalized, /^@@ @@$|^@@$/m);
  assert.match(normalized, /-const value = oldName\(\);/);
  assert.match(normalized, /\+const value = newName\(\);/);
});

test('two patches that differ only in index hash / hunk line numbers normalize equal', () => {
  const a = 'diff --git a/f b/f\nindex 111..222 100644\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-old\n+new\n';
  const b = 'diff --git a/f b/f\nindex 333..444 100644\n--- a/f\n+++ b/f\n@@ -5,2 +5,2 @@\n-old\n+new\n';
  assert.equal(normalizePatch(a), normalizePatch(b));
});

test('two patches that differ in actual content normalize unequal', () => {
  const a = 'diff --git a/f b/f\nindex 111..222 100644\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-old\n+new\n';
  const b = 'diff --git a/f b/f\nindex 111..222 100644\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-old\n+different\n';
  assert.notEqual(normalizePatch(a), normalizePatch(b));
});

// --- goldPatchMatches: the actual comparison full-pipeline.ts's computeGoldPatchExact runs ---

const GOLD_PATCH = [
  'diff --git a/src/app.js b/src/app.js',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@',
  "-import { oldName } from 'fixture-lib';",
  "+import { newName } from 'fixture-lib';",
  '',
  "-const value = oldName('Ada');",
  "+const value = newName('Ada');",
  ' if (value !== \'ADA\') {',
  '   throw new Error(`expected ADA, got ${value}`);',
  ' }',
  '',
].join('\n');

test('an actual patch that is a real git diff of the same edit as the gold patch matches exactly', () => {
  const actual = [
    'diff --git a/src/app.js b/src/app.js',
    'index abc1234..def5678 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -1,5 +1,5 @@',
    "-import { oldName } from 'fixture-lib';",
    "+import { newName } from 'fixture-lib';",
    '',
    "-const value = oldName('Ada');",
    "+const value = newName('Ada');",
    ' if (value !== \'ADA\') {',
    '   throw new Error(`expected ADA, got ${value}`);',
    ' }',
    '',
  ].join('\n');
  assert.equal(goldPatchMatches(actual, GOLD_PATCH), true);
});

test('a semantically different actual patch does not match the gold patch', () => {
  const actual = [
    'diff --git a/src/app.js b/src/app.js',
    'index abc1234..def5678 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -1,5 +1,5 @@',
    "-import { oldName } from 'fixture-lib';",
    "+import { newName as oldName } from 'fixture-lib';", // different repair strategy: aliasing, not renaming call sites
    '',
    " const value = oldName('Ada');",
    ' if (value !== \'ADA\') {',
    '   throw new Error(`expected ADA, got ${value}`);',
    ' }',
    '',
  ].join('\n');
  assert.equal(goldPatchMatches(actual, GOLD_PATCH), false);
});

test('a captured patch applies with -p1, like a git diff taken from a real repository', async () => {
  const builder = createRepairCaptureBuilder();
  builder.recordCommit(['src/app.js'], new Map([['src/app.js', 'const a = old();\n']]), [
    { path: 'src/app.js', content: 'const a = neu();\n' },
  ]);
  const capture = await builder.finalize();

  // Without the prefix fix this reads `a/a/src/app.js`, so the harness's two
  // patch sources would need different strip levels -- and only one of them is
  // exercised on any given case, so the mismatch would sit undetected.
  assert.match(capture.patch, /^diff --git a\/src\/app\.js b\/src\/app\.js$/m);
  assert.match(capture.patch, /^--- a\/src\/app\.js$/m);
  assert.match(capture.patch, /^\+\+\+ b\/src\/app\.js$/m);
});
