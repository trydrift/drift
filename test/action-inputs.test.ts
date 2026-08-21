import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../dist/runners/action.js';

/**
 * `verify-mode` is how a workflow chooses Quick Scan vs Deep Verification —
 * it has to default to quick (the input unset) and only switch to deep on an
 * exact, deliberate `deep`, the same discipline `scan-mode` already follows.
 */

const ENV_KEYS = ['INPUT_SCAN-MODE', 'INPUT_VERIFY-MODE', 'INPUT_MODE', 'INPUT_REPO-TOKEN'];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('verify-mode input', () => {
  test('unset defaults to quick', () => {
    assert.equal(readInputs().verifyMode, undefined);
  });

  test('"deep" is read as deep', () => {
    process.env['INPUT_VERIFY-MODE'] = 'deep';
    assert.equal(readInputs().verifyMode, 'deep');
  });

  test('"quick" is read as quick, explicitly', () => {
    process.env['INPUT_VERIFY-MODE'] = 'quick';
    assert.equal(readInputs().verifyMode, 'quick');
  });

  test('an unrecognised value is not silently accepted as deep', () => {
    process.env['INPUT_VERIFY-MODE'] = 'both';
    assert.equal(readInputs().verifyMode, undefined);
  });
});
