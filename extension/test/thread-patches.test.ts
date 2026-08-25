import assert from 'node:assert/strict';
import test from 'node:test';
import { transcriptScrollAdjustment } from '../src/webview/thread-patches.js';

const base = { threadTop: 0, threadBottom: 500, previousTop: -700, previousBottom: -600, previousHeight: 100, nextHeight: 250 };

test('adjusts scroll by height delta for an item entirely above the viewport', () => {
  assert.equal(transcriptScrollAdjustment({ ...base, atBottom: false }), 150);
  assert.equal(transcriptScrollAdjustment({ ...base, atBottom: false, previousHeight: 250, nextHeight: 100 }), -150);
});

test('does not adjust items below or intersecting the viewport', () => {
  assert.equal(transcriptScrollAdjustment({ ...base, atBottom: false, previousTop: 700, previousBottom: 800 }), null);
  assert.equal(transcriptScrollAdjustment({ ...base, atBottom: false, previousTop: -20, previousBottom: 80 }), null);
});

test('bottom following wins regardless of replacement size', () => {
  assert.equal(transcriptScrollAdjustment({ ...base, atBottom: true }), 'bottom');
});
