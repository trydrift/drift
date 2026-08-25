import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SUMMARY_BYTES,
  MAX_SUMMARY_OPERATIONS,
  chunkDetail,
  takeCandidateSummaryBatch,
} from '../src/ui/update-protocol.js';

test('2,500 rapid candidate updates stay coalesced and payload bounded', () => {
  const pending = new Map<string, string>();
  for (let revision = 0; revision < 2_500; revision++) {
    const id = `package-${revision % 57}`;
    pending.set(id, `<details data-candidate-id="${id}">${revision}:${'x'.repeat(900)}</details>`);
  }
  assert.equal(pending.size, 57, 'latest revision wins per candidate');

  let sent = 0;
  while (pending.size > 0) {
    const batch = takeCandidateSummaryBatch(pending);
    assert.ok(batch.operations.length > 0);
    assert.ok(batch.operations.length <= MAX_SUMMARY_OPERATIONS);
    assert.ok(batch.bytes <= MAX_SUMMARY_BYTES);
    sent += batch.operations.length;
  }
  assert.equal(sent, 57);
});

test('detail chunks preserve Unicode and remain below 64KiB', () => {
  const source = `${'🙂'.repeat(20_000)}${'λ'.repeat(20_000)}`;
  const chunks = chunkDetail(source);
  assert.equal(chunks.join(''), source);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 64 * 1024));
});
