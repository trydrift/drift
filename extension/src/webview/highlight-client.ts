/// <reference lib="dom" />
export {};

interface WorkerReply { key: string; html: string }
interface Job { key: string; language: string; code: string; consumerIds: Set<string>; attempts: number }

const MAX_PENDING_JOBS = 256;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 2_000;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_SNIPPET_BYTES = 32 * 1024;
const JOB_TIMEOUT_MS = 500;

const script = document.currentScript as HTMLScriptElement | null;
const workerUri = script?.dataset.workerUri;
let worker: Worker | null = null;
let workerBlobUrl: string | null = null;
let creatingWorker: Promise<Worker | null> | null = null;
let observer: IntersectionObserver | null = null;
let nextConsumer = 0;
let inFlight: Job | null = null;
let timeout: number | null = null;
let consumerRetryTimer: number | null = null;
let workerRetryTimer: number | null = null;
let pendingBytes = 0;
let cacheBytes = 0;
const queue: Job[] = [];
const pending = new Map<string, Job>();
const cache = new Map<string, string>();
const retryConsumers = new Set<string>();

async function ensureWorker(): Promise<Worker | null> {
  if (worker) return worker;
  if (!workerUri) return null;
  creatingWorker ??= fetch(workerUri)
    .then((response) => {
      if (!response.ok) throw new Error(`worker ${response.status}`);
      return response.blob();
    })
    .then((blob) => {
      workerBlobUrl = URL.createObjectURL(blob);
      const created = new Worker(workerBlobUrl);
      created.onmessage = onWorkerReply;
      created.onerror = () => failInFlight();
      worker = created;
      return created;
    })
    .catch(() => null)
    .finally(() => { creatingWorker = null; });
  return creatingWorker;
}

function withinOpenDisclosure(element: Element): boolean {
  for (let parent = element.closest('details'); parent; parent = parent.parentElement?.closest('details') ?? null) {
    if (!(parent as HTMLDetailsElement).open) return false;
  }
  return true;
}

function observe(root: ParentNode, includeObserved = false): void {
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && withinOpenDisclosure(entry.target)) enqueue(entry.target as HTMLElement);
    }
  }, { rootMargin: '160px' });
  const selector = includeObserved
    ? '[data-drift-highlight]:not([data-highlight-done="true"])'
    : '[data-drift-highlight]:not([data-highlight-observed])';
  root.querySelectorAll<HTMLElement>(selector).forEach((element) => {
    element.dataset.highlightObserved = 'true';
    element.dataset.highlightConsumer ??= `drift-highlight-${++nextConsumer}`;
    observer?.observe(element);
  });
}

function enqueue(element: HTMLElement): void {
  if (element.dataset.highlightDone === 'true') return;
  const code = element.textContent ?? '';
  const bytes = new TextEncoder().encode(code).byteLength;
  if (bytes > MAX_SNIPPET_BYTES) {
    element.dataset.highlightDone = 'true';
    observer?.unobserve(element);
    return;
  }
  const language = element.dataset.language ?? 'plaintext';
  const key = `${language}:${hash(code)}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    apply(element, cached);
    return;
  }
  const consumerId = element.dataset.highlightConsumer;
  if (!consumerId) return;
  const existing = pending.get(key);
  if (existing) {
    existing.consumerIds.add(consumerId);
    return;
  }
  if (queue.length >= MAX_PENDING_JOBS || pendingBytes + bytes > MAX_PENDING_BYTES) {
    deferConsumer(consumerId);
    return;
  }
  const job: Job = { key, language, code, consumerIds: new Set([consumerId]), attempts: 0 };
  pending.set(key, job);
  queue.push(job);
  pendingBytes += bytes;
  void pump();
}

async function pump(): Promise<void> {
  if (inFlight || queue.length === 0) return;
  const available = await ensureWorker();
  if (!available || inFlight) {
    if (!available) schedulePumpRetry();
    return;
  }
  inFlight = queue.shift() ?? null;
  if (!inFlight) return;
  inFlight.attempts += 1;
  available.postMessage({ key: inFlight.key, language: inFlight.language, code: inFlight.code });
  timeout = window.setTimeout(failInFlight, JOB_TIMEOUT_MS);
}

function onWorkerReply(event: MessageEvent<WorkerReply>): void {
  if (!inFlight || event.data.key !== inFlight.key) return;
  const job = inFlight;
  finishJob();
  addCache(job.key, event.data.html);
  for (const id of job.consumerIds) {
    const element = document.querySelector<HTMLElement>(`[data-highlight-consumer="${id}"]`);
    if (element && `${element.dataset.language ?? 'plaintext'}:${hash(element.textContent ?? '')}` === job.key) {
      apply(element, event.data.html);
    }
  }
  void pump();
}

function apply(element: HTMLElement, html: string): void {
  element.innerHTML = html;
  element.dataset.highlightDone = 'true';
  const consumerId = element.dataset.highlightConsumer;
  if (consumerId) retryConsumers.delete(consumerId);
  observer?.unobserve(element);
}

function finishJob(): void {
  if (!inFlight) return;
  pendingBytes -= new TextEncoder().encode(inFlight.code).byteLength;
  pending.delete(inFlight.key);
  inFlight = null;
  if (timeout !== null) window.clearTimeout(timeout);
  timeout = null;
}

function failInFlight(): void {
  const failed = inFlight;
  finishJob();
  worker?.terminate();
  worker = null;
  if (workerBlobUrl) URL.revokeObjectURL(workerBlobUrl);
  workerBlobUrl = null;
  if (failed) {
    if (failed.attempts < 2 && queue.length < MAX_PENDING_JOBS && pendingBytes + encodedBytes(failed.code) <= MAX_PENDING_BYTES) {
      pending.set(failed.key, failed);
      queue.unshift(failed);
      pendingBytes += encodedBytes(failed.code);
    } else {
      for (const id of failed.consumerIds) deferConsumer(id, 1_000);
    }
  }
  void pump();
}

function deferConsumer(consumerId: string, delay = 50): void {
  retryConsumers.add(consumerId);
  if (consumerRetryTimer !== null) return;
  consumerRetryTimer = window.setTimeout(() => {
    consumerRetryTimer = null;
    const consumers = [...retryConsumers];
    retryConsumers.clear();
    for (const id of consumers) {
      const element = document.querySelector<HTMLElement>(`[data-highlight-consumer="${CSS.escape(id)}"]`);
      if (element && element.dataset.highlightDone !== 'true') enqueue(element);
    }
  }, delay);
}

function schedulePumpRetry(): void {
  if (workerRetryTimer !== null) return;
  workerRetryTimer = window.setTimeout(() => {
    workerRetryTimer = null;
    void pump();
  }, 1_000);
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function addCache(key: string, html: string): void {
  const bytes = new TextEncoder().encode(html).byteLength;
  if (bytes > MAX_CACHE_BYTES) return;
  while (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + bytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const value = cache.get(oldest) ?? '';
    cacheBytes -= new TextEncoder().encode(value).byteLength;
    cache.delete(oldest);
  }
  cache.set(key, html);
  cacheBytes += bytes;
}

function reset(root: ParentNode): void {
  observer?.disconnect();
  // `disconnect()` forgets every target. Keep stable consumer identities for
  // jobs already in flight, but explicitly observe every still-live snippet
  // again — including nodes marked by a previous mount.
  observe(root, true);
}

function hash(value: string): string {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return (result >>> 0).toString(36);
}

declare global {
  interface Window { DriftHighlight?: { mount(root: ParentNode): void; reset(root: ParentNode): void } }
}
window.DriftHighlight = { mount: observe, reset };
