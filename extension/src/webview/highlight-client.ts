import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import csharp from 'highlight.js/lib/languages/csharp';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import dart from 'highlight.js/lib/languages/dart';
import elixir from 'highlight.js/lib/languages/elixir';
import swift from 'highlight.js/lib/languages/swift';
import cpp from 'highlight.js/lib/languages/cpp';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';

for (const [name, language] of Object.entries({ typescript, python, go, rust, java, csharp, ruby, php, dart, elixir, swift, cpp, json, yaml })) {
  hljs.registerLanguage(name, language);
}

const MAX_CACHE_ENTRIES = 2_000;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const cache = new Map<string, { html: string; bytes: number }>();
let cacheBytes = 0;
let generation = 0;

type Job = { key: string; code: string; language: string; elements: Set<HTMLElement>; generation: number };
const pending = new Map<string, Job>();
const queue: Job[] = [];
let scheduled = false;

function key(language: string, code: string): string { return `${language}\0${code}`; }
function remember(key: string, html: string): void {
  const bytes = encoder.encode(key).byteLength + encoder.encode(html).byteLength;
  const previous = cache.get(key);
  if (previous) cacheBytes -= previous.bytes;
  cache.set(key, { html, bytes }); cacheBytes += bytes;
  while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    const first = cache.entries().next().value as [string, { html: string; bytes: number }] | undefined;
    if (!first) break;
    cache.delete(first[0]); cacheBytes -= first[1].bytes;
  }
}
function cached(key: string): string | undefined {
  const value = cache.get(key);
  if (!value) return undefined;
  cache.delete(key); cache.set(key, value);
  return value.html;
}
function apply(element: HTMLElement, code: string, language: string, html: string): void {
  if (!element.isConnected || !element.hasAttribute('data-drift-highlight') || element.textContent !== code || element.dataset.lang !== language) return;
  element.innerHTML = html;
  element.dataset.driftHighlighted = 'true';
}
function schedule(): void {
  if (scheduled || queue.length === 0) return;
  scheduled = true;
  const run = () => {
    scheduled = false;
    const job = queue.shift();
    if (!job) return;
    pending.delete(job.key);
    if (job.generation === generation) {
      try {
        const html = hljs.highlight(job.code, { language: job.language, ignoreIllegals: true }).value;
        remember(job.key, html);
        for (const element of job.elements) apply(element, job.code, job.language, html);
      } catch { /* Decoration must never break raw source. */ }
    }
    schedule();
  };
  if ('requestIdleCallback' in window) (window as Window & { requestIdleCallback: (cb: () => void, options: { timeout: number }) => void }).requestIdleCallback(run, { timeout: 100 });
  else setTimeout(run, 0);
}
function candidates(root: ParentNode): HTMLElement[] {
  const output: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.matches('code[data-drift-highlight]')) output.push(root);
  if ('querySelectorAll' in root) output.push(...Array.from(root.querySelectorAll<HTMLElement>('code[data-drift-highlight]')));
  return output;
}
function mount(root: ParentNode): void {
  for (const element of candidates(root)) {
    if (element.dataset.driftHighlighted === 'true' || element.closest('[data-highlight-defer="true"]')) continue;
    const code = element.textContent ?? '';
    const language = element.dataset.lang || 'typescript';
    if (!hljs.getLanguage(language)) { element.dataset.driftHighlighted = 'true'; continue; }
    const jobKey = key(language, code);
    const hit = cached(jobKey);
    if (hit !== undefined) { apply(element, code, language, hit); continue; }
    const existing = pending.get(jobKey);
    if (existing) { existing.elements.add(element); continue; }
    const job: Job = { key: jobKey, code, language, elements: new Set([element]), generation };
    pending.set(jobKey, job); queue.push(job); schedule();
  }
}
function reset(root: ParentNode): void {
  generation += 1;
  pending.clear();
  queue.length = 0;
  mount(root);
}
function dispose(): void { generation += 1; pending.clear(); queue.length = 0; cache.clear(); cacheBytes = 0; }

declare global { interface Window { DriftHighlight?: { mount(root: ParentNode): void; reset(root: ParentNode): void; dispose(): void } } }
window.DriftHighlight = { mount, reset, dispose };
