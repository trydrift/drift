import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DriftReview } from '../src/review/store.js';

describe('DriftReview keep and undo reconciliation', () => {
  test('keep accepts the current file as the new baseline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-review-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/app.ts'), 'old\n');
      const review = new DriftReview();
      review.begin(root);
      review.snapshot({ order: 1, title: 'fix: app' }, [{ path: 'src/app.ts', content: 'old\n' }]);
      writeFileSync(join(root, 'src/app.ts'), 'new\n');
      await review.settle(1);

      await review.keepFile('src/app.ts');
      assert.equal(review.totals().files, 0);
      assert.equal(readFileSync(join(root, 'src/app.ts'), 'utf8'), 'new\n');
      review.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('undo writes through the workspace edit path and reloads the hunk list', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-review-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/app.ts'), 'old\n');
      const review = new DriftReview();
      review.begin(root);
      review.snapshot({ order: 1, title: 'fix: app' }, [{ path: 'src/app.ts', content: 'old\n' }]);
      writeFileSync(join(root, 'src/app.ts'), 'new\n');
      await review.settle(1);

      await review.undoFile('src/app.ts');
      assert.equal(review.totals().files, 0);
      assert.equal(readFileSync(join(root, 'src/app.ts'), 'utf8'), 'old\n');
      review.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
