import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// A plain .mjs script with no type declarations; the shapes are asserted below.
import { analyzerPinMismatches, describeAnalyzerPinMismatch } from '../../scripts/analyzer-environment.mjs';

/**
 * The failure this guards against cost two full re-captures to diagnose.
 *
 * The engine fingerprint folds in the analyzer's version, so recording under
 * an interpreter this repository does not pin produces artifacts CI rejects
 * as stale — and the rejection names the *recording*, not the interpreter
 * that made it stale, so nothing in the error points at the cause. The check
 * belongs at capture time, where an artifact is produced, and not in
 * `engineFingerprint()`, where it would hard-fail every context that merely
 * reads a fingerprint on a machine that has not pinned the tool.
 */

const manifest = {
  python: {
    declared: '3.12',
    executable: 'python3',
    versionArgs: ['--version'],
    normalize(raw: string) {
      const match = /Python\s+(\d+)\.(\d+)/.exec(raw);
      return match ? `${match[1]}.${match[2]}` : null;
    },
  },
};

const answering = (stdout: string) => async () => ({ stdout, stderr: '' });

describe('refusing to record under an unpinned analyzer', () => {
  test('the pinned version is not a mismatch', async () => {
    assert.deepEqual(await analyzerPinMismatches(manifest, answering('Python 3.12.14')), []);
  });

  test('a patch difference is not a mismatch', async () => {
    // Only major.minor is semantically relevant — a patch bump on a runner
    // image must not invalidate every recording.
    assert.deepEqual(await analyzerPinMismatches(manifest, answering('Python 3.12.0')), []);
  });

  test('a minor difference is a mismatch, and names both versions', async () => {
    const [only] = await analyzerPinMismatches(manifest, answering('Python 3.14.3'));
    assert.deepEqual(only, { tool: 'python', executable: 'python3', declared: '3.12', actual: '3.14' });
    const message = describeAnalyzerPinMismatch(only);
    assert.match(message, /records with 3\.12/);
    assert.match(message, /`python3` here is 3\.14/);
    // The message has to carry the fix, not just the complaint.
    assert.match(message, /PATH/);
  });

  test('an interpreter that cannot be run at all is a mismatch, not a crash', async () => {
    const failing = async () => {
      throw new Error('ENOENT');
    };
    const [only] = await analyzerPinMismatches(manifest, failing);
    assert.equal(only.actual, null);
    assert.match(describeAnalyzerPinMismatch(only), /not runnable/);
  });

  test('version output on stderr still counts', async () => {
    // Older CPython builds print `--version` to stderr.
    const onStderr = async () => ({ stdout: '', stderr: 'Python 3.12.14' });
    assert.deepEqual(await analyzerPinMismatches(manifest, onStderr), []);
  });
});
