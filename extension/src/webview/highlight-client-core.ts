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

export interface HighlightScheduler { schedule(callback: () => void): void; }

export interface SyntaxHighlighter {
  hasLanguage(language: string): boolean;
  highlight(code: string, language: string): string;
}

export class HighlightJsAdapter implements SyntaxHighlighter {
  hasLanguage(language: string): boolean { return hljs.getLanguage(language) !== undefined; }
  highlight(code: string, language: string): string {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  }
}

class BrowserScheduler implements HighlightScheduler {
  schedule(callback: () => void): void {
    if ('requestIdleCallback' in window) {
      (window as Window & { requestIdleCallback: (cb: () => void, options: { timeout: number }) => void })
        .requestIdleCallback(callback, { timeout: 100 });
    } else setTimeout(callback, 0);
  }
}

const MAX_CACHE_ENTRIES = 2_000;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
type CacheEntry = { html: string; bytes: number };
type Job = { key: string; code: string; language: string; elements: Set<HTMLElement>; generation: number };

function cacheKey(language: string, code: string): string { return `${language}\0${code}`; }

export class HighlightClient {
  private readonly scheduler: HighlightScheduler;
  private readonly highlighter: SyntaxHighlighter;
  private readonly encoder = new TextEncoder();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private cacheBytes = 0;
  private generation = 0;
  private scheduled = false;

  constructor(options: { scheduler?: HighlightScheduler; highlighter?: SyntaxHighlighter } = {}) {
    this.scheduler = options.scheduler ?? new BrowserScheduler();
    this.highlighter = options.highlighter ?? new HighlightJsAdapter();
  }

  private remember(key: string, html: string): void {
    const bytes = this.encoder.encode(key).byteLength + this.encoder.encode(html).byteLength;
    const previous = this.cache.get(key);
    if (previous) this.cacheBytes -= previous.bytes;
    this.cache.set(key, { html, bytes });
    this.cacheBytes += bytes;
    while (this.cache.size > MAX_CACHE_ENTRIES || this.cacheBytes > MAX_CACHE_BYTES) {
      const first = this.cache.entries().next().value as [string, CacheEntry] | undefined;
      if (!first) break;
      this.cache.delete(first[0]);
      this.cacheBytes -= first[1].bytes;
    }
  }

  private cached(key: string): string | undefined {
    const value = this.cache.get(key);
    if (!value) return undefined;
    this.cache.delete(key); this.cache.set(key, value);
    return value.html;
  }

  private isElementCurrent(element: HTMLElement, code: string, language: string): boolean {
    return element.isConnected && element.hasAttribute('data-drift-highlight') &&
      element.textContent === code && element.dataset.lang === language &&
      element.dataset.driftHighlighted !== 'true';
  }

  private apply(element: HTMLElement, code: string, language: string, html: string): void {
    if (!this.isElementCurrent(element, code, language)) return;
    element.innerHTML = html;
    element.dataset.driftHighlighted = 'true';
  }

  private schedule(): void {
    if (this.scheduled || this.queue.length === 0) return;
    this.scheduled = true;
    this.scheduler.schedule(() => {
      this.scheduled = false;
      const job = this.queue.shift();
      if (!job) return;
      this.pending.delete(job.key);
      if (job.generation === this.generation) {
        const liveElements = [...job.elements].filter((element) => this.isElementCurrent(element, job.code, job.language));
        if (liveElements.length > 0) {
          try {
            const html = this.highlighter.highlight(job.code, job.language);
            this.remember(job.key, html);
            for (const element of liveElements) this.apply(element, job.code, job.language, html);
          } catch { /* Decoration must never break raw source. */ }
        }
      }
      this.schedule();
    });
  }

  private candidates(root: ParentNode): HTMLElement[] {
    const output: HTMLElement[] = [];
    if (root instanceof HTMLElement && root.matches('code[data-drift-highlight]')) output.push(root);
    if ('querySelectorAll' in root) output.push(...Array.from(root.querySelectorAll<HTMLElement>('code[data-drift-highlight]')));
    return output;
  }

  mount(root: ParentNode): void {
    for (const element of this.candidates(root)) {
      if (element.dataset.driftHighlighted === 'true' || element.closest('[data-highlight-defer="true"]')) continue;
      const code = element.textContent ?? '';
      const language = element.dataset.lang || 'typescript';
      if (!this.highlighter.hasLanguage(language)) { element.dataset.driftHighlighted = 'true'; continue; }
      const jobKey = cacheKey(language, code);
      const hit = this.cached(jobKey);
      if (hit !== undefined) { this.apply(element, code, language, hit); continue; }
      const existing = this.pending.get(jobKey);
      if (existing) { existing.elements.add(element); continue; }
      const job: Job = { key: jobKey, code, language, elements: new Set([element]), generation: this.generation };
      this.pending.set(jobKey, job); this.queue.push(job); this.schedule();
    }
  }

  reset(root: ParentNode): void {
    this.generation += 1;
    this.pending.clear(); this.queue.length = 0;
    this.mount(root);
  }

  dispose(): void {
    this.generation += 1;
    this.pending.clear(); this.queue.length = 0;
    this.cache.clear(); this.cacheBytes = 0;
  }
}
