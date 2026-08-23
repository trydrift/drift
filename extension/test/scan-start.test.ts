import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScanStartGate } from '../src/ui/scan-start.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('scan start gate allows one pending choice phase at a time', async () => {
  const gate = new ScanStartGate();
  const first = deferred();
  let starts = 0;

  const running = gate.run(async () => {
    starts += 1;
    await first.promise;
  });

  assert.equal(gate.active, true);
  assert.equal(await gate.run(async () => {
    starts += 1;
  }), 'already-starting');
  assert.equal(starts, 1);

  first.resolve();
  assert.equal(await running, 'started');
  assert.equal(gate.active, false);

  assert.equal(await gate.run(async () => {
    starts += 1;
  }), 'started');
  assert.equal(starts, 2);
});
