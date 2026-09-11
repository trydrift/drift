import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerificationDiagnostics, subtractBaseline } from '../dist/verification/diagnostics.js';

/**
 * The parser turns a compiler or build tool's output into structured
 * diagnostics so a measured regression can point at a line, not a filename.
 * `subtractBaseline` keeps only the ones a change introduced.
 */
describe('parseVerificationDiagnostics', () => {
  test('reads the two tsc layouts, keeping code, 1-indexed line and 0-indexed column', () => {
    const pretty = parseVerificationDiagnostics(
      "src/client.ts:42:18 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    );
    assert.deepEqual(pretty, [
      {
        file: 'src/client.ts',
        line: 42,
        column: 17,
        code: 'TS2345',
        message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
        severity: 'error',
      },
    ]);

    const paren = parseVerificationDiagnostics('src/client.ts(42,18): error TS2345: Argument of type ...');
    assert.equal(paren[0]?.file, 'src/client.ts');
    assert.equal(paren[0]?.line, 42);
    assert.equal(paren[0]?.column, 17);
    assert.equal(paren[0]?.code, 'TS2345');
  });

  test('reads javac / Maven bracket and colon forms, with the [ERROR] prefix optional', () => {
    const bracket = parseVerificationDiagnostics(
      '[ERROR] /ws/src/main/java/com/acme/Client.java:[73,21] cannot find symbol\n  symbol:   method getLog()',
    );
    assert.equal(bracket[0]?.file, '/ws/src/main/java/com/acme/Client.java');
    assert.equal(bracket[0]?.line, 73);
    assert.equal(bracket[0]?.column, 20);
    assert.equal(bracket[0]?.message, 'cannot find symbol');
    assert.equal(bracket[0]?.severity, 'error');

    const colon = parseVerificationDiagnostics('Client.java:12: error: incompatible types: String cannot be converted to int');
    assert.equal(colon[0]?.file, 'Client.java');
    assert.equal(colon[0]?.line, 12);
    assert.equal(colon[0]?.message, 'incompatible types: String cannot be converted to int');
  });

  test('strips the worktree root from an absolute path so a site is repo-relative', () => {
    const parsed = parseVerificationDiagnostics(
      '[ERROR] /private/var/folders/xx/drift-worktree-abc123/src/main/java/Foo.java:[9,4] incompatible types',
      '/private/var/folders/xx/drift-worktree-abc123',
    );
    assert.equal(parsed[0]?.file, 'src/main/java/Foo.java');
  });

  test('ignores lines that are not diagnostics and de-duplicates identical ones', () => {
    const parsed = parseVerificationDiagnostics(
      [
        'npm error code ELIFECYCLE',
        '> tsc --noEmit',
        'src/a.ts(1,1): error TS1005: ; expected.',
        'src/a.ts(1,1): error TS1005: ; expected.',
        'Found 1 error.',
      ].join('\n'),
    );
    assert.equal(parsed.length, 1);
  });

  test('strips ANSI colour before matching', () => {
    const parsed = parseVerificationDiagnostics('\x1b[96msrc/a.ts\x1b[0m:\x1b[93m3\x1b[0m:\x1b[93m9\x1b[0m - \x1b[91merror\x1b[0m \x1b[90mTS2551\x1b[0m: nope');
    assert.equal(parsed[0]?.file, 'src/a.ts');
    assert.equal(parsed[0]?.line, 3);
    assert.equal(parsed[0]?.code, 'TS2551');
  });
});

describe('subtractBaseline', () => {
  test('keeps only errors that were not present before, ignoring line drift', () => {
    const before = parseVerificationDiagnostics('src/a.ts(10,3): error TS2304: Cannot find name "foo".');
    const after = parseVerificationDiagnostics(
      [
        'src/a.ts(12,3): error TS2304: Cannot find name "foo".', // same error, moved down 2 lines — not new
        'src/b.ts(4,1): error TS2345: Argument of type X is not assignable to Y.', // genuinely new
      ].join('\n'),
    );
    const introduced = subtractBaseline(after, before);
    assert.equal(introduced.length, 1);
    assert.equal(introduced[0]?.file, 'src/b.ts');
    assert.equal(introduced[0]?.code, 'TS2345');
  });

  test('an empty baseline returns every error in after', () => {
    const after = parseVerificationDiagnostics('src/b.ts(4,1): error TS2345: nope.\nsrc/c.ts(9,2): error TS2322: also nope.');
    assert.equal(subtractBaseline(after, []).length, 2);
  });

  test('drops warnings — only an error is evidence of breakage', () => {
    const after = parseVerificationDiagnostics('src/b.ts:4:1 - warning TS6133: "x" is declared but never used.');
    assert.equal(subtractBaseline(after, []).length, 0);
  });
});
