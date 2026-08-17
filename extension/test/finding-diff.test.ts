import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorFor,
  DECLARATION_TEXT,
  DECLARATION_SITE,
  MENTION,
  type ChangeDiffRequest,
} from '../src/version-diff.js';

/**
 * "View diff" under a before/after pair asks one question — show me *that*
 * change, properly — and used to answer it by finding the symbol anywhere in
 * any changed file. A finding about a `coverage` property landed on a hunk of
 * import statements, because one of them read
 * `from './chunks/coverage.d.BZtK59WP.js'`.
 *
 * These are about how a hunk is scored, which is where that question is
 * actually decided.
 */

const request = (over: Partial<ChangeDiffRequest> = {}): ChangeDiffRequest => ({
  before: 'type S = [project: { name: string | undefined; root: string; }, file: string];',
  after: 'type S = [project: { name: string | undefined; root: string; }, file: string, options: { pool: string; }];',
  title: 'S',
  symbol: 'S',
  ...over,
});

describe('scoring a hunk against the change the panel is showing', () => {
  test('the declaration the panel is showing outranks everything else', () => {
    const anchor = anchorFor(request(), 'S');
    const score = anchor.score(
      ['type S = [project: { name: string | undefined; root: string; }, file: string];'],
      [
        'type S = [project: { name: string | undefined; root: string; },',
        '  file: string, options: { pool: string; }];',
      ],
    );
    assert.equal(score, DECLARATION_TEXT, 'the pair itself is the strongest possible anchor');
  });

  test('an import whose specifier happens to contain the symbol is not the change', () => {
    // The exact regression. `coverage` appears in the path, in a hunk that has
    // nothing to do with the property that was removed.
    const anchor = anchorFor(
      request({ symbol: 'coverage', before: undefined, after: undefined, title: 'A.coverage' }),
      'A.coverage',
    );
    const imports = [
      "import { R as RuntimeCoverageModuleLoader } from './chunks/coverage.d.BZtK59WP.js';",
      "export { collectTests, startTests } from '@vitest/runner';",
    ];
    assert.equal(anchor.score(imports, imports), 0, 'a re-export names what it does not declare');
  });

  test('a member declaration beats a bare mention', () => {
    const anchor = anchorFor(
      request({ before: undefined, after: undefined, symbol: 'coverage', title: 'A.coverage' }),
      'A.coverage',
    );
    assert.equal(anchor.score(['  coverage?: SerializedCoverageConfig;'], []), DECLARATION_SITE);
    assert.equal(anchor.score(['  return this.coverage;'], []), MENTION);
  });

  test('a pair the panel is showing is only satisfied by a real match', () => {
    // When the panel handed over a declaration and it is nowhere in the diff,
    // the honest answer is the declaration itself — not the nearest hunk that
    // happens to say the word. `exact` is what `locateInSource` reads to
    // decide that.
    assert.equal(anchorFor(request(), 'S').exact, true);
    assert.equal(anchorFor(request({ before: undefined, after: undefined }), 'S').exact, false);
  });

  test('a whole word, so Drop never matches Dropdown', () => {
    const anchor = anchorFor(request({ before: undefined, after: undefined, symbol: 'Drop' }), 'Drop');
    assert.equal(anchor.score(['declare class Dropdown {}'], []), 0);
    assert.equal(anchor.score(['declare class Drop {}'], []), DECLARATION_SITE);
  });

  test('a declaration too short to be distinctive is not used as an anchor', () => {
    // `x: T` would match half the file. Falling back to the symbol rules is
    // better than anchoring on a fragment that means nothing.
    const anchor = anchorFor(request({ before: 'x: T', after: 'x: U', symbol: 'x' }), 'x');
    assert.equal(anchor.score(['x: T'], ['x: U']), DECLARATION_SITE);
  });

  test('the pair is matched whitespace-collapsed, since the panel normalises it', () => {
    const anchor = anchorFor(
      request({
        before: 'declare function run(a: string, b: number): void;',
        after: 'declare function run(a: string, b: number, c: boolean): void;',
        symbol: 'run',
      }),
      'run',
    );
    const score = anchor.score(
      ['declare function run(', '  a: string,', '  b: number,', '): void;'],
      ['declare function run(', '  a: string,', '  b: number,', '  c: boolean,', '): void;'],
    );
    assert.equal(score, DECLARATION_TEXT);
  });
});
