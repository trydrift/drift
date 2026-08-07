import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { attemptCodemod } from '../dist/codemod/index.js';

const breaking = (overrides: Record<string, unknown> = {}) => ({
  id: 'bc_1',
  dependency: 'acme-sdk',
  kind: 'renamed-export' as const,
  summary: '`oldName` was renamed to `newName`.',
  remediation: 'Replace every usage of `oldName` with `newName`.',
  symbols: ['oldName'],
  replacementSymbols: ['newName'],
  confidence: 'high' as const,
  citations: ['ev_1'],
  ...overrides,
});

const site = (file: string, line = 1) => ({
  breakingChangeId: 'bc_1',
  file,
  line,
  excerpt: 'oldName()',
  matchedSymbol: 'oldName',
  confidence: 'high' as const,
});

describe('attemptCodemod: a clean rename', () => {
  test('renames only the lines named by impact sites', () => {
    const files = new Map([
      ['src/app.ts', "import { oldName } from 'acme-sdk';\n\noldName();\n"],
    ]);

    const result = attemptCodemod(breaking(), [site('src/app.ts', 1), site('src/app.ts', 3)], files);

    assert.ok(result);
    assert.equal(result!.transform.ruleId, 'rename-identifier');
    assert.equal(result!.transform.from, 'oldName');
    assert.equal(result!.transform.to, 'newName');
    assert.equal(result!.edits.length, 1);
    assert.equal(
      result!.edits[0]!.after,
      "import { newName } from 'acme-sdk';\n\nnewName();\n",
    );
    assert.equal(result!.sitesResolved, 2);
    assert.deepEqual(result!.transform.anchors, [
      { file: 'src/app.ts', line: "import { oldName } from 'acme-sdk';" },
      { file: 'src/app.ts', line: 'oldName();' },
    ]);
  });

  test('does not touch a substring match — word boundaries hold', () => {
    const files = new Map([['src/app.ts', 'const oldNameWithSuffix = 1;\noldName();\n']]);

    const result = attemptCodemod(breaking(), [site('src/app.ts', 2)], files);

    assert.ok(result);
    assert.equal(
      result!.edits[0]!.after,
      'const oldNameWithSuffix = 1;\nnewName();\n',
    );
  });

  test('leaves an occurrence on a line that is not a declared impact site untouched', () => {
    // The exact flaw that got the previous whole-file implementation disabled:
    // a same-named identifier elsewhere in the file, with nothing to do with
    // this finding, must not be rewritten just because the word appears.
    const files = new Map([
      ['src/app.ts', 'oldName();\n// unrelated: someone else also called their local oldName\nconst oldName = 2;\n'],
    ]);

    const result = attemptCodemod(breaking(), [site('src/app.ts', 1)], files);

    assert.ok(result);
    assert.equal(result!.edits.length, 1);
    assert.equal(
      result!.edits[0]!.after,
      'newName();\n// unrelated: someone else also called their local oldName\nconst oldName = 2;\n',
    );
    assert.equal(result!.sitesResolved, 1);
  });

  test('does not rewrite an occurrence that only exists inside a string literal on the site line', () => {
    const files = new Map([['src/app.ts', "oldName(); // logs 'oldName' for debugging\n"]]);

    const result = attemptCodemod(breaking(), [site('src/app.ts', 1)], files);

    assert.ok(result);
    assert.equal(result!.edits[0]!.after, "newName(); // logs 'oldName' for debugging\n");
  });

  test('skips a comment-only site line, matching what localize would have reported', () => {
    const files = new Map([['src/app.ts', '// oldName is deprecated\noldName();\n']]);

    const result = attemptCodemod(breaking(), [site('src/app.ts', 1), site('src/app.ts', 2)], files);

    assert.ok(result);
    assert.equal(result!.edits[0]!.after, '// oldName is deprecated\nnewName();\n');
    assert.equal(result!.sitesResolved, 1);
  });

  test('spans multiple files named by the impact sites', () => {
    const files = new Map([
      ['src/a.ts', 'oldName();\n'],
      ['src/b.ts', 'oldName();\n'],
    ]);

    const result = attemptCodemod(breaking(), [site('src/a.ts'), site('src/b.ts', 1)], files);

    assert.ok(result);
    assert.equal(result!.edits.length, 2);
    assert.equal(result!.sitesResolved, 2);
  });
});

describe('attemptCodemod: declines outside its proven-safe scope', () => {
  test('declines a kind other than renamed-export', () => {
    const files = new Map([['src/app.ts', 'oldName();\n']]);
    const result = attemptCodemod(breaking({ kind: 'removed-export' }), [site('src/app.ts')], files);
    assert.equal(result, null);
  });

  test('declines when there is more than one symbol', () => {
    const files = new Map([['src/app.ts', 'oldName();\n']]);
    const result = attemptCodemod(
      breaking({ symbols: ['oldName', 'otherName'] }),
      [site('src/app.ts')],
      files,
    );
    assert.equal(result, null);
  });

  test('declines when there is no replacement symbol', () => {
    const files = new Map([['src/app.ts', 'oldName();\n']]);
    const result = attemptCodemod(breaking({ replacementSymbols: undefined }), [site('src/app.ts')], files);
    assert.equal(result, null);
  });

  test('declines a dotted member rename — not a plain identifier', () => {
    const files = new Map([['src/app.ts', 'client.oldName();\n']]);
    const result = attemptCodemod(
      breaking({ symbols: ['Client.oldName'], replacementSymbols: ['Client.newName'] }),
      [site('src/app.ts')],
      files,
    );
    assert.equal(result, null);
  });

  test('declines an import-path move — the replacement is not a bare identifier', () => {
    const files = new Map([['src/app.ts', "import { oldName } from 'acme-sdk/old';\n"]]);
    const result = attemptCodemod(
      breaking({ replacementSymbols: ['acme-sdk/new'] }),
      [site('src/app.ts')],
      files,
    );
    assert.equal(result, null);
  });

  test('declines when the named file has no content available', () => {
    const result = attemptCodemod(breaking(), [site('src/missing.ts')], new Map());
    assert.equal(result, null);
  });

  test('declines when nothing at the named site actually matches', () => {
    const files = new Map([['src/app.ts', 'somethingElse();\n']]);
    const result = attemptCodemod(breaking(), [site('src/app.ts')], files);
    assert.equal(result, null);
  });
});
