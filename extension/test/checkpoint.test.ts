import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Checkpoints } from '../src/checkpoint.js';

describe('Checkpoints', () => {
  test('restores the captured working tree and forgets later checkpoints', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-checkpoint-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'drift@example.test'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Drift Test'], { cwd: root });
      writeFileSync(join(root, 'file.txt'), 'one\n');
      execFileSync('git', ['add', 'file.txt'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });

      const checkpoints = new Checkpoints(root);
      const first = await checkpoints.capture('before edit');
      writeFileSync(join(root, 'file.txt'), 'two\n');
      const second = await checkpoints.capture('after edit');
      writeFileSync(join(root, 'file.txt'), 'three\n');

      assert.ok(first);
      assert.ok(second);
      assert.equal(checkpoints.size, 2);

      const restored = await checkpoints.restore(first!.id);
      assert.deepEqual(restored.files, ['file.txt']);
      assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'one\n');
      assert.equal(checkpoints.size, 1);
      assert.equal(checkpoints.get(second!.id), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
