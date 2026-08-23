import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../dist/runners/action.js';

/**
 * `verify-mode` is how a workflow chooses Quick Scan vs Deep Verification —
 * it has to default to quick (the input unset) and only switch to deep on an
 * exact, deliberate `deep`, the same discipline `scan-mode` already follows.
 */

const ENV_KEYS = [
  'INPUT_SCAN-MODE',
  'INPUT_VERIFY-MODE',
  'INPUT_DEPENDENCY-SCOPE',
  'INPUT_MODE',
  'INPUT_REPO-TOKEN',
];

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

/**
 * `dependency-scope` is the Action's equivalent of the extension's
 * `drift.analysis.dependencyScope` and the CLI's `--no-dev` — it must default
 * to unset (deferring to `triggerOn.dev` in drift.yml, unchanged from before
 * this input existed) and never accept anything but its two literal values,
 * the same discipline `verify-mode` follows above. There is deliberately no
 * "ask" here: the Action is non-interactive, so that choice exists only in
 * the extension, which has someone to ask.
 */
describe('dependency-scope input', () => {
  test('unset defers to drift.yml (undefined, not a literal default)', () => {
    assert.equal(readInputs().dependencyScope, undefined);
  });

  test('"runtime" is read as runtime', () => {
    process.env['INPUT_DEPENDENCY-SCOPE'] = 'runtime';
    assert.equal(readInputs().dependencyScope, 'runtime');
  });

  test('"runtime+dev" is read as runtime+dev', () => {
    process.env['INPUT_DEPENDENCY-SCOPE'] = 'runtime+dev';
    assert.equal(readInputs().dependencyScope, 'runtime+dev');
  });

  test('an unrecognised value is not silently accepted', () => {
    process.env['INPUT_DEPENDENCY-SCOPE'] = 'everything';
    assert.equal(readInputs().dependencyScope, undefined);
  });
});
