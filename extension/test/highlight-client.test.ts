import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { HighlightClient, HighlightJsAdapter, type HighlightScheduler, type SyntaxHighlighter } from '../src/webview/highlight-client-core.js';

class ManualScheduler implements HighlightScheduler {
  callbacks: Array<() => void> = [];
  schedule(callback: () => void): void { this.callbacks.push(callback); }
  runNext(): void { this.callbacks.shift()?.(); }
  runAll(): void { while (this.callbacks.length) this.runNext(); }
}

function setup() {
  const window = new Window();
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement });
  return window.document;
}

function code(document: any, source: string, language = 'typescript'): any {
  const element = document.createElement('code');
  element.dataset.driftHighlight = 'true';
  element.dataset.lang = language;
  element.textContent = source;
  document.body.append(element);
  return element;
}

test('highlights real TypeScript and Python syntax in the browser client', () => {
  const document = setup();
  const scheduler = new ManualScheduler();
  const client = new HighlightClient({ scheduler });
  const ts = code(document, 'export const x = 1;');
  const py = code(document, 'def greet(name):\n    return name', 'python');
  client.mount(document.body as any);
  assert.equal(scheduler.callbacks.length, 1);
  scheduler.runNext();
  scheduler.runNext();
  assert.match(ts.innerHTML, /hljs-/);
  assert.match(py.innerHTML, /hljs-/);
});

test('preserves source text safely and marks unknown languages complete', () => {
  const document = setup();
  const scheduler = new ManualScheduler();
  const client = new HighlightClient({ scheduler });
  const source = '</code><script>alert(1)</script> & < > "\'';
  const unknown = code(document, source, 'not-a-language');
  client.mount(document.body as any);
  assert.equal(unknown.dataset.driftHighlighted, 'true');
  assert.equal(unknown.textContent, source);
  assert.equal(unknown.querySelector('script'), null);
  assert.equal(scheduler.callbacks.length, 0);
});

test('deduplicates pending work and skips stale consumers before tokenization', () => {
  const document = setup();
  const scheduler = new ManualScheduler();
  let calls = 0;
  const highlighter: SyntaxHighlighter = {
    hasLanguage: () => true,
    highlight: (source) => { calls += 1; return `<span>${source}</span>`; },
  };
  const client = new HighlightClient({ scheduler, highlighter });
  const first = code(document, 'same');
  const second = code(document, 'same');
  client.mount(document.body as any);
  assert.equal(scheduler.callbacks.length, 1);
  first.remove();
  scheduler.runNext();
  assert.equal(calls, 1);
  assert.equal(second.dataset.driftHighlighted, 'true');

  const stale = code(document, 'stale');
  client.mount(stale as any);
  stale.remove();
  scheduler.runNext();
  assert.equal(calls, 1);
});

test('changed source and language are rejected as stale jobs', () => {
  const document = setup();
  const scheduler = new ManualScheduler();
  let calls = 0;
  const client = new HighlightClient({ scheduler, highlighter: {
    hasLanguage: () => true,
    highlight: () => { calls += 1; return 'highlighted'; },
  } });
  const element = code(document, 'before');
  client.mount(element as any);
  element.textContent = 'after';
  scheduler.runNext();
  assert.equal(calls, 0);
  client.mount(element as any);
  element.dataset.lang = 'python';
  scheduler.runNext();
  assert.equal(calls, 0);
});

test('deferred code is ignored until defer is removed, and reset invalidates old jobs', () => {
  const document = setup();
  const scheduler = new ManualScheduler();
  const client = new HighlightClient({ scheduler, highlighter: {
    hasLanguage: () => true,
    highlight: () => 'highlighted',
  } });
  const wrapper = document.createElement('div');
  wrapper.dataset.highlightDefer = 'true';
  const element = code(document, 'deferred');
  wrapper.append(element);
  document.body.append(wrapper);
  client.mount(wrapper as any);
  assert.equal(scheduler.callbacks.length, 0);
  delete wrapper.dataset.highlightDefer;
  client.mount(wrapper as any);
  assert.equal(scheduler.callbacks.length, 1);
  client.reset(document.body as any);
  scheduler.runAll();
  assert.equal(element.dataset.driftHighlighted, 'true');
});

test('production adapter does not use highlightAuto', () => {
  const adapter = new HighlightJsAdapter();
  assert.match(adapter.highlight('const value = 1;', 'typescript'), /hljs-/);
});
