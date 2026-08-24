import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRecordRun } from '../dist/util/run-recording.js';

test('CLI run recording is disabled by default', () => {
  assert.equal(shouldRecordRun({}, {}), false);
});

test('CLI --record-run opts in', () => {
  assert.equal(shouldRecordRun({ 'record-run': true }, {}), true);
});

test('DRIFT_RECORD_RUNS enables persistent machine-level recording', () => {
  assert.equal(shouldRecordRun({}, { DRIFT_RECORD_RUNS: '1' }), true);
  assert.equal(shouldRecordRun({}, { DRIFT_RECORD_RUNS: 'true' }), true);
});

test('CLI --no-record-run overrides the environment opt-in', () => {
  assert.equal(shouldRecordRun({ 'no-record-run': true }, { DRIFT_RECORD_RUNS: '1' }), false);
});
