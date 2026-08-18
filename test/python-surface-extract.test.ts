import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { safeRelativePath } from '../dist/evidence/surface/python.js';

/**
 * A Python sdist is a third party's archive, unpacked onto the machine running
 * the scan. Two things decide what may be written out of one: whether the entry
 * can escape the extraction directory, and whether anything will ever read it.
 *
 * The second is the reason this exists at all — the parser opens `.py` and
 * `.pyi` and prunes the same four directory names — but the first is the reason
 * it is a function with tests rather than a filter inline.
 */
describe('deciding where an archive entry may be written', () => {
  test('Python sources keep their path', () => {
    assert.equal(safeRelativePath('scrapy-2.11/scrapy/__init__.py'), 'scrapy-2.11/scrapy/__init__.py');
    assert.equal(safeRelativePath('pkg/typed.pyi'), 'pkg/typed.pyi');
  });

  test('anything the parser will not open is not written', () => {
    assert.equal(safeRelativePath('pkg/README.md'), null);
    assert.equal(safeRelativePath('pkg/_speedups.c'), null);
    assert.equal(safeRelativePath('pkg/data/fixture.json'), null);
    assert.equal(safeRelativePath('pkg/module.pyc'), null);
  });

  test('an entry that escapes the extraction directory is dropped', () => {
    assert.equal(safeRelativePath('../../../etc/cron.d/evil.py'), null);
    assert.equal(safeRelativePath('pkg/../../outside.py'), null);
    assert.equal(safeRelativePath('/etc/absolute.py'), null);
    assert.equal(safeRelativePath('C:/windows/thing.py'), null);
  });

  test('the directories the parser prunes are never written', () => {
    assert.equal(safeRelativePath('pkg/tests/test_client.py'), null);
    assert.equal(safeRelativePath('pkg/test/helpers.py'), null);
    assert.equal(safeRelativePath('pkg/__pycache__/mod.py'), null);
    assert.equal(safeRelativePath('pkg/.git/hook.py'), null);
    // A *file* that merely shares the name is still source.
    assert.equal(safeRelativePath('pkg/tests.py'), 'pkg/tests.py');
  });

  test('redundant path segments are normalised away', () => {
    assert.equal(safeRelativePath('./pkg//mod.py'), 'pkg/mod.py');
  });
});
