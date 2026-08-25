/// <reference lib="webworker" />
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

const languages: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  typescript, python, go, rust, java, csharp, ruby, php, dart, elixir, swift, cpp, json, yaml,
};
for (const [name, grammar] of Object.entries(languages)) hljs.registerLanguage(name, grammar);

interface Request { key: string; language: string; code: string }

self.onmessage = (event: MessageEvent<Request>) => {
  const { key, code } = event.data;
  const language = hljs.getLanguage(event.data.language) ? event.data.language : 'plaintext';
  try {
    const html = language === 'plaintext' ? escapeHtml(code) : hljs.highlight(code, { language }).value;
    self.postMessage({ key, html });
  } catch {
    self.postMessage({ key, html: escapeHtml(code) });
  }
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
