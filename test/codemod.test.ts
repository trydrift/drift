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
  test('renames every whole-word occurrence across the affected files', () => {
    const files = new Map([
      ['src/app.ts', "import { oldName } from 'acme-sdk';\n\noldName();\n"],
    ]);

    const result = attemptCodemod(breaking(), [site('src/app.ts')], files);

    assert.ok(result);
    assert.equal(result!.transform.ruleId, 'rename-identifier');
    assert.equal(result!.transform.from, 'oldName');
    assert.equal(result!.transform.to, 'newName');
    assert.equal(result!.edits.length, 1);
    assert.equal(
      result!.edits[0]!.after,
      "import { newName } from 'acme-sdk';\n\nnewName();\n",
    );
    assert.equal(result!.sitesResolved, 1);
  });

  test('does not touch a substring match — word boundaries hold', () => {
    const files = new Map([['src/app.ts', 'const oldNameWithSuffix = 1;\noldName();\n']]);

    const result = attemptCodemod(breaking(), [site('src/app.ts')], files);

    assert.ok(result);
    assert.equal(
      result!.edits[0]!.after,
      'const oldNameWithSuffix = 1;\nnewName();\n',
    );
  });

  test('skips comment-only lines, matching what localize would have reported as a site', () => {
    const files = new Map([['src/app.ts', '// oldName is deprecated\noldName();\n']]);

    const result = attemptCodemod(breaking(), [site('src/app.ts')], files);

    assert.ok(result);
    assert.equal(result!.edits[0]!.after, '// oldName is deprecated\nnewName();\n');
  });

  test('spans multiple files named by the impact sites', () => {
    const files = new Map([
      ['src/a.ts', 'oldName();\n'],
      ['src/b.ts', 'oldName();\n'],
    ]);

    const result = attemptCodemod(breaking(), [site('src/a.ts'), site('src/b.ts', 2)], files);

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

  test('declines when nothing in the file actually matches', () => {
    const files = new Map([['src/app.ts', 'somethingElse();\n']]);
    const result = attemptCodemod(breaking(), [site('src/app.ts')], files);
    assert.equal(result, null);
  });
});
