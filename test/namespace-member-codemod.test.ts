import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyCodemodTransform, attemptCodemod } from '../dist/codemod/index.js';

/**
 * The shape of a modern npm major: the package stops exporting a namespace and
 * exports flat functions, so the call site and the import have to move
 * together. A plain rename can never fix one — renaming the member alone
 * leaves `glob.globSync` on a default export that no longer exists.
 */

const change = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'bc_1',
    dependency: 'glob',
    kind: 'renamed-export',
    summary: '`glob.sync` is no longer exported. The new version exports `globSync` in its place.',
    remediation: '',
    symbols: ['default.sync', 'sync'],
    replacementSymbols: ['globSync'],
    confidence: 'high',
    citations: [],
    ...overrides,
  }) as never;

const site = (line: number, file = 'src/files.js') => ({ breakingChangeId: 'bc_1', file, line, excerpt: '', matchedSymbol: 'sync', confidence: 'high' }) as never;

const ESM = `import { statSync } from 'node:fs';
import glob from 'glob';

export function findAll(pattern, root) {
  return glob.sync(pattern, { cwd: root, nodir: true }).sort();
}

export function findModifiedSince(pattern, root, since) {
  const matches = glob.sync(pattern, { cwd: root, nodir: true, dot: true });
  return matches.filter((path) => statSync(path).mtime > since).sort();
}
`;

describe('namespace member to named import', () => {
  test('rewrites both the import and every localized call site', () => {
    const result = attemptCodemod(change(), [site(5), site(9)], new Map([['src/files.js', ESM]]));
    assert.ok(result, 'the codemod applies');
    assert.equal(result!.transform.ruleId, 'namespace-member-to-named-import');
    assert.equal(result!.sitesResolved, 2);
    const after = result!.edits[0]!.after;
    assert.match(after, /^import \{ globSync \} from 'glob';$/m);
    assert.doesNotMatch(after, /import glob from/);
    assert.equal((after.match(/globSync\(pattern/g) ?? []).length, 2);
    assert.doesNotMatch(after, /glob\.sync/);
    // Re-applied against the live file, not replayed.
    assert.equal(applyCodemodTransform(ESM, result!.transform, 'src/files.js'), after);
  });

  test('CommonJS require is rewritten the same way', () => {
    const cjs = "const glob = require('glob');\n\nmodule.exports = () => glob.sync('*.ts');\n";
    const result = attemptCodemod(change(), [site(3)], new Map([['src/files.js', cjs]]));
    assert.match(result!.edits[0]!.after, /^const \{ globSync \} = require\('glob'\);$/m);
    assert.match(result!.edits[0]!.after, /globSync\('\*\.ts'\)/);
  });

  test('declines when the binding is used for anything else', () => {
    const mixed = "import glob from 'glob';\n\nexport const a = glob.sync('*');\nexport const b = glob.hasMagic('*');\n";
    assert.equal(attemptCodemod(change(), [site(3)], new Map([['src/files.js', mixed]])), null);
    const passed = "import glob from 'glob';\n\nregister(glob);\nexport const a = glob.sync('*');\n";
    assert.equal(attemptCodemod(change(), [site(4)], new Map([['src/files.js', passed]])), null);
  });

  test('declines without a replacement, and when the import is not the package', () => {
    assert.equal(attemptCodemod(change({ replacementSymbols: undefined }), [site(5)], new Map([['src/files.js', ESM]])), null);
    const other = "import glob from 'other-glob';\n\nexport const a = glob.sync('*');\n";
    assert.equal(attemptCodemod(change(), [site(3)], new Map([['src/files.js', other]])), null);
  });

  test('a string that merely mentions the member is not rewritten', () => {
    const withString = "import glob from 'glob';\n\nexport const a = glob.sync('glob.sync');\n";
    const after = attemptCodemod(change(), [site(3)], new Map([['src/files.js', withString]]))!.edits[0]!.after;
    assert.match(after, /globSync\('glob\.sync'\)/);
  });
});
