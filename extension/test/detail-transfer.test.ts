import test from 'node:test';
import assert from 'node:assert/strict';
import { DriftHomeView } from '../src/ui/home.js';

type Controller = {
  sendDetailChunk(surface: never): void;
  retryDetailChunk(surface: never, transfer: never, index: number, delay?: number): void;
  cancelDetailTransfer(surface: never, startNext?: boolean): void;
  queueDetailRequest(surface: never, request: { id: string; requestId: string; section?: string }): void;
  startDetailTransfer(surface: never, id: string, requestId: string, section?: string): void;
};

function surface(postMessage: (message: unknown) => Promise<boolean>) {
  return {
    webview: { postMessage },
    detailTransfer: {
      id: 'react',
      requestId: 'detail-1',
      chunks: ['first', 'second'],
      next: 0,
      awaitingIndex: null,
      retries: 0,
    },
    pendingDetailRequests: [] as { id: string; requestId: string; section?: string }[],
    detailAckTimer: null,
  };
}

const controller = DriftHomeView.prototype as unknown as Controller;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a missing detail ACK resends the same chunk without advancing', async () => {
  const messages: unknown[] = [];
  const target = surface(async (message) => { messages.push(message); return true; });
  controller.sendDetailChunk(target as never);
  const transfer = target.detailTransfer;
  controller.retryDetailChunk(target as never, transfer as never, 0, 1);
  await wait(10);

  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], messages[1]);
  assert.equal(transfer.next, 0);
  assert.equal(transfer.awaitingIndex, 0);
  controller.cancelDetailTransfer(target as never);
});

test('false and rejected detail posts recover automatically', async () => {
  for (const outcome of ['false', 'reject'] as const) {
    const messages: unknown[] = [];
    let attempts = 0;
    const target = surface(async (message) => {
      messages.push(message);
      attempts += 1;
      if (attempts === 1) {
        if (outcome === 'false') return false;
        throw new Error('renderer unavailable');
      }
      return true;
    });

    controller.sendDetailChunk(target as never);
    await wait(140);
    assert.equal(messages.length, 2, `${outcome} post should retry`);
    controller.cancelDetailTransfer(target as never);
  }
});

test('overflow detail requests are deferred back to the webview instead of dropped', async () => {
  const messages: unknown[] = [];
  const target = surface(async (message) => { messages.push(message); return true; });
  target.pendingDetailRequests.push(...Array.from({ length: 8 }, (_, index) => ({
    id: `package-${index}`,
    requestId: `request-${index}`,
  })));

  controller.queueDetailRequest(target as never, { id: 'overflow', requestId: 'request-overflow', section: 'evidence:1' });
  await wait(0);

  assert.equal(target.pendingDetailRequests.length, 8);
  assert.deepEqual(messages, [{
    type: 'candidateDetailRetry',
    id: 'overflow',
    requestId: 'request-overflow',
    section: 'evidence:1',
    retryAfterMs: 250,
  }]);
  controller.cancelDetailTransfer(target as never);
});

test('reload cancellation clears transfer payloads, pending requests, and timers', () => {
  const target = surface(async () => true);
  target.pendingDetailRequests.push({ id: 'lodash', requestId: 'detail-2' });
  target.detailAckTimer = setTimeout(() => undefined, 10_000) as never;

  controller.cancelDetailTransfer(target as never);

  assert.equal(target.detailTransfer, null);
  assert.equal(target.detailAckTimer, null);
  assert.deepEqual(target.pendingDetailRequests, []);
});

test('a detail opened during a scan is deferred instead of abandoned', async () => {
  const messages: unknown[] = [];
  const target = surface(async (message) => { messages.push(message); return true; });
  target.detailTransfer = null as never;
  const busy = Object.create(DriftHomeView.prototype) as Controller & {
    running: object;
    candidates: Map<string, object>;
  };
  busy.running = {};
  busy.candidates = new Map([['react', { id: 'react' }]]);

  busy.startDetailTransfer(target as never, 'react', 'opened-during-scan', 'evidence:1');
  await wait(0);

  assert.deepEqual(messages, [{
    type: 'candidateDetailRetry',
    id: 'react',
    requestId: 'opened-during-scan',
    section: 'evidence:1',
    retryAfterMs: 1_000,
  }]);
  assert.equal(target.detailTransfer, null);
});
