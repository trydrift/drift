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

  test('a commit that throws keeps the group instead of dropping the accepted edits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-review-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/app.ts'), 'old\n');
      const review = new DriftReview();
      review.begin(root);
      review.setCommitHandler(async () => {
        throw new Error('pre-commit hook rejected the change');
      });
      review.snapshot({ order: 1, title: 'fix: app' }, [{ path: 'src/app.ts', content: 'old\n' }]);
      writeFileSync(join(root, 'src/app.ts'), 'new\n');
      await review.settle(1);

      await review.keepFile('src/app.ts');

      // The group survives with its commit error recorded, not silently
      // dropped from `groups()` the way an emptied `files` array would.
      const group = review.group(1);
      assert.equal(group?.committed, undefined);
      assert.equal(group?.commitError, 'pre-commit hook rejected the change');
      assert.equal(review.groups().length, 1);
      assert.equal(review.groups()[0]?.files.length, 1);
      review.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('retryCommit succeeds after a prior failure without redoing keep/undo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-review-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/app.ts'), 'old\n');
      const review = new DriftReview();
      review.begin(root);

      let attempts = 0;
      review.setCommitHandler(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient failure');
        return { sha: 'abc1234', branch: 'drift/fix' };
      });

      review.snapshot({ order: 1, title: 'fix: app' }, [{ path: 'src/app.ts', content: 'old\n' }]);
      writeFileSync(join(root, 'src/app.ts'), 'new\n');
      await review.settle(1);
      await review.keepFile('src/app.ts');
      assert.equal(review.group(1)?.commitError, 'transient failure');

      await review.retryCommit(1);

      const group = review.group(1);
      assert.equal(group?.commitError, undefined);
      assert.deepEqual(group?.committed, { sha: 'abc1234', branch: 'drift/fix' });
      assert.equal(attempts, 2);
      review.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a handler that legitimately returns null (nothing to commit) clears the group without an error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-review-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/app.ts'), 'old\n');
      const review = new DriftReview();
      review.begin(root);
      review.setCommitHandler(async () => null);
      review.snapshot({ order: 1, title: 'fix: app' }, [{ path: 'src/app.ts', content: 'old\n' }]);
      writeFileSync(join(root, 'src/app.ts'), 'new\n');
      await review.settle(1);

      await review.keepFile('src/app.ts');

      const group = review.group(1);
      assert.equal(group?.commitError, undefined);
      assert.equal(group?.committed, undefined);
      assert.equal(review.groups().length, 0);
      review.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
