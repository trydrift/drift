import test from 'node:test';
import assert from 'node:assert/strict';
import { DriftHomeView } from '../src/ui/home.js';

type Controller = {
  sendBody(surface: never, body: string): void;
};

const controller = DriftHomeView.prototype as unknown as Controller;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function surface(postMessage: (message: unknown) => Promise<boolean>) {
  return {
    webview: { postMessage },
    nextSequence: 0,
    awaitingSequence: null,
    pendingBody: null,
    pendingCandidates: new Map<string, string>(),
    detailTransfer: null,
    pendingDetailRequests: [],
    detailAckTimer: null,
    ackTimer: null,
    resyncAttempted: false,
    postFailures: 0,
    stalled: false,
  };
}

test('a rejected full render retries once while newer state stays coalesced', async () => {
  const messages: unknown[] = [];
  let attempts = 0;
  const target = surface(async (message) => {
    messages.push(message);
    attempts += 1;
    return attempts > 1;
  });

  controller.sendBody(target as never, 'revision one');
  // A state change during the recovery delay replaces the pending body but
  // must not create a second in-flight message.
  controller.sendBody(target as never, 'revision two');
  assert.equal(messages.length, 1);

  await wait(300);
  assert.equal(messages.length, 2);
  assert.match(JSON.stringify(messages[1]), /revision two/);
  assert.equal(target.awaitingSequence, 2);
  if (target.ackTimer) clearTimeout(target.ackTimer);
});

test('a renderer that repeatedly rejects stays bounded with one latest body', async () => {
  const messages: unknown[] = [];
  const target = surface(async (message) => { messages.push(message); throw new Error('closed'); });

  controller.sendBody(target as never, 'revision one');
  await wait(300);
  controller.sendBody(target as never, 'revision final');
  await wait(20);

  assert.equal(messages.length, 2);
  assert.equal(target.stalled, true);
  assert.equal(target.pendingBody, 'revision final');
  assert.equal(target.awaitingSequence, null);
});
