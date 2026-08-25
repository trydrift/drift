import test from 'node:test';
import assert from 'node:assert/strict';

class FakeElement {
  readonly dataset: Record<string, string> = {};
  innerHTML = '';
  constructor(public textContent: string) {
    this.dataset.driftHighlight = 'true';
    this.dataset.language = 'typescript';
  }
  closest(): null { return null; }
}

class FakeDocument {
  readonly currentScript = { dataset: { workerUri: 'worker.js' } };
  readonly elements: FakeElement[] = [];
  querySelectorAll(selector: string): FakeElement[] {
    if (selector.includes('data-highlight-done')) return this.elements.filter((element) => element.dataset.highlightDone !== 'true');
    if (selector.includes(':not(')) return this.elements.filter((element) => !element.dataset.highlightObserved);
    return [...this.elements];
  }
  querySelector(selector: string): FakeElement | null {
    const id = /data-highlight-consumer="([^"]+)"/.exec(selector)?.[1];
    return this.elements.find((element) => element.dataset.highlightConsumer === id) ?? null;
  }
}

class FakeObserver {
  static latest: FakeObserver;
  readonly observed = new Set<FakeElement>();
  constructor(private readonly callback: (entries: { isIntersecting: boolean; target: FakeElement }[]) => void) {
    FakeObserver.latest = this;
  }
  observe(element: FakeElement): void { this.observed.add(element); }
  unobserve(element: FakeElement): void { this.observed.delete(element); }
  disconnect(): void { this.observed.clear(); }
  intersect(...elements: FakeElement[]): void {
    this.callback(elements.map((target) => ({ isIntersecting: true, target })));
  }
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: { key: string; html: string } }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly messages: { key: string; language: string; code: string }[] = [];
  constructor(_url: string) { FakeWorker.instances.push(this); }
  postMessage(message: { key: string; language: string; code: string }): void { this.messages.push(message); }
  terminate(): void { /* no-op */ }
  reply(): void {
    const message = this.messages.shift();
    if (message) this.onmessage?.({ data: { key: message.key, html: `<b>${message.code}</b>` } });
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('highlighting re-observes resets and retries saturation and worker failures', async () => {
  const document = new FakeDocument();
  Object.assign(globalThis, {
    document,
    window: globalThis,
    IntersectionObserver: FakeObserver,
    Worker: FakeWorker,
    CSS: { escape: (value: string) => value },
    fetch: async () => ({ ok: true, blob: async () => new Blob(['worker']) }),
  });

  await import('../src/webview/highlight-client.js');
  const client = (globalThis as unknown as { DriftHighlight: { mount(root: FakeDocument): void; reset(root: FakeDocument): void } }).DriftHighlight;

  const resetTargets = [new FakeElement('first'), new FakeElement('second'), new FakeElement('third')];
  const completed = new FakeElement('already highlighted');
  completed.dataset.highlightDone = 'true';
  document.elements.push(...resetTargets);
  client.mount(document as never);
  assert.equal(FakeObserver.latest.observed.size, 3);
  document.elements.push(completed);
  client.reset(document as never);
  assert.equal(FakeObserver.latest.observed.size, 3, 'marked but unfinished elements must be observed again');
  assert.equal(FakeObserver.latest.observed.has(completed), false, 'completed elements must not be re-observed');

  FakeObserver.latest.intersect(resetTargets[0]!);
  await tick();
  const failedWorker = FakeWorker.instances.at(-1)!;
  assert.equal(failedWorker.messages.length, 1);
  failedWorker.onerror?.();
  await tick();
  const retryWorker = FakeWorker.instances.at(-1)!;
  assert.notEqual(retryWorker, failedWorker);
  assert.equal(retryWorker.messages.length, 1, 'a failed worker job is attempted again');
  retryWorker.reply();
  await tick();
  assert.equal(resetTargets[0]!.dataset.highlightDone, 'true');

  const saturated = Array.from({ length: 258 }, (_, index) => new FakeElement(`snippet ${index}`));
  document.elements.push(...saturated);
  client.mount(document as never);
  FakeObserver.latest.intersect(...saturated);

  const deadline = Date.now() + 5_000;
  while (saturated.some((element) => element.dataset.highlightDone !== 'true') && Date.now() < deadline) {
    await tick();
    FakeWorker.instances.at(-1)?.reply();
  }
  assert.equal(
    saturated.filter((element) => element.dataset.highlightDone === 'true').length,
    saturated.length,
    'jobs rejected at the queue boundary must re-enter after capacity frees',
  );
});
