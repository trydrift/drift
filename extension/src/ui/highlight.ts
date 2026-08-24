import * as vscode from 'vscode';
import { createHighlighterCore, type HighlighterCore, type ThemeRegistrationRaw } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import darkPlus from '@shikijs/themes/dark-plus';
import lightPlus from '@shikijs/themes/light-plus';
import langTypeScript from '@shikijs/langs/typescript';
import langPython from '@shikijs/langs/python';
import langGo from '@shikijs/langs/go';
import langRust from '@shikijs/langs/rust';
import langJava from '@shikijs/langs/java';
import langCSharp from '@shikijs/langs/csharp';
import langRuby from '@shikijs/langs/ruby';
import langPhp from '@shikijs/langs/php';
import langDart from '@shikijs/langs/dart';
import langElixir from '@shikijs/langs/elixir';
import langSwift from '@shikijs/langs/swift';
import langCpp from '@shikijs/langs/cpp';
import langJson from '@shikijs/langs/json';
import langYaml from '@shikijs/langs/yaml';
import { readActiveTextMateTheme } from './code-theme.js';
import { countWork } from '../../../src/util/diagnostics.js';

/**
 * Syntax highlighting for every snippet Drift renders — a call site, a
 * before/after declaration, a fenced block quoted out of a changelog.
 *
 * This is the same machinery the editor itself uses: real TextMate grammars,
 * tokenised against the *user's own colour theme*, read off disk by
 * `code-theme.ts`. A snippet in the panel is therefore coloured exactly as the
 * same lines would be coloured in a file two tabs over — not approximated by a
 * hand-written tokeniser, and not painted in colours chosen here.
 *
 * The highlighter is built once, asynchronously, and then used synchronously:
 * every render path in this extension is a synchronous string builder, and
 * making them all async to await a highlighter would be a large change for no
 * behavioural gain. Until it is ready (a few hundred milliseconds at startup)
 * snippets render as plain escaped text and the views re-render when
 * {@link warmCodeHighlighter} resolves.
 */

const THEME_NAME = 'drift-active-theme';

const LANGS = [
  langTypeScript,
  langPython,
  langGo,
  langRust,
  langJava,
  langCSharp,
  langRuby,
  langPhp,
  langDart,
  langElixir,
  langSwift,
  langCpp,
  langJson,
  langYaml,
];

/** Grammar ids that survived registration, so an unknown `lang` never throws. */
let loaded: Set<string> = new Set();
let highlighter: HighlighterCore | null = null;
let warming: Promise<void> | null = null;
let themeGeneration = 0;
const MAX_CACHE_ENTRIES = 2_000;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
interface CacheEntry { html: string; bytes: number }
const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;

/** Small, dependency-free counters consumed by the extension diagnostics sink. */
export const highlightMetrics = { calls: 0, cacheHits: 0, cacheMisses: 0, tokenizeMs: 0 };

function cacheResult(key: string, html: string): void {
  const old = cache.get(key);
  if (old !== undefined) cacheBytes -= old.bytes;
  const entry = { html, bytes: Buffer.byteLength(key, 'utf8') + Buffer.byteLength(html, 'utf8') };
  cache.set(key, entry);
  cacheBytes += entry.bytes;
  while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    const first = cache.entries().next().value as [string, CacheEntry] | undefined;
    if (!first) break;
    cache.delete(first[0]);
    cacheBytes -= first[1].bytes;
  }
}

/** Exposed for deterministic architecture tests. */
export function highlightCacheInfo(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: cacheBytes };
}

const changed = new vscode.EventEmitter<void>();

/**
 * Fires when highlighting becomes available, or when the user switches theme
 * and every rendered snippet is now painted in the wrong palette.
 */
export const onDidChangeCodeTheme = changed.event;

/**
 * Build (or rebuild) the highlighter against the active theme.
 *
 * Safe to call repeatedly: concurrent calls share one build, and a failure
 * leaves the previous highlighter in place rather than dropping highlighting
 * altogether.
 */
export function warmCodeHighlighter(): Promise<void> {
  warming ??= build().finally(() => {
    warming = null;
  });
  return warming;
}

async function build(): Promise<void> {
  const resolved = await readActiveTextMateTheme();
  // `vscode.window.activeColorTheme.kind` is the one signal here that cannot
  // be stale: it is VS Code's own answer to "what is actually painting the
  // window right now", including when the OS is driving a light/dark switch
  // that the plain `workbench.colorTheme` setting does not always keep in
  // step with. A theme read off disk whose own declared `type` disagrees with
  // it is not trustworthy — better to fall back to VS Code's bundled default
  // for the kind that is actually active than to tokenise, say, light text on
  // a light background because the wrong theme file was loaded. This is what
  // "code looks fine in dark mode and is unreadable in light mode" looks like
  // from here: a dark theme's colours, applied while the workbench is light.
  const authoritative =
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
      ? 'light'
      : 'dark';
  const theme = resolved && resolved.type === authoritative ? resolved : fallbackTheme();

  try {
    const created = await createHighlighterCore({
      themes: [{ ...theme, name: THEME_NAME } as ThemeRegistrationRaw],
      langs: LANGS,
      // The JavaScript regex engine rather than the WASM one: it needs no
      // separate binary next to the bundle, which keeps the extension a single
      // packaged file. `forgiving` skips the handful of grammar patterns that
      // only Oniguruma can compile instead of refusing to load the grammar.
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
    // A theme switch builds a second highlighter; the first one holds every
    // compiled grammar, so it has to go rather than accumulate one per switch.
    highlighter?.dispose();
    highlighter = created;
    loaded = new Set(created.getLoadedLanguages());
    themeGeneration += 1;
    cache.clear();
    cacheBytes = 0;
    changed.fire();
  } catch {
    // Highlighting is decoration. A grammar or theme that will not load must
    // not take the panel down with it.
  }
}

/**
 * VS Code's own default theme, for when the active one cannot be read from
 * disk — a theme contributed programmatically, or one whose extension has been
 * uninstalled since the setting was written.
 */
function fallbackTheme(): Record<string, unknown> {
  const kind = vscode.window.activeColorTheme.kind;
  const light =
    kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
  return { ...(light ? lightPlus : darkPlus) } as unknown as Record<string, unknown>;
}

/**
 * Watch for the things that invalidate the current palette.
 *
 * Both signals are needed: `onDidChangeActiveColorTheme` catches a switch
 * between light and dark (including one driven by the OS), while the
 * configuration listener catches a switch between two themes of the same kind,
 * which does not change `activeColorTheme.kind` at all.
 */
export function watchCodeTheme(): vscode.Disposable {
  const rebuild = () => void warmCodeHighlighter();
  return vscode.Disposable.from(
    vscode.window.onDidChangeActiveColorTheme(rebuild),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('workbench.colorTheme')) rebuild();
    }),
    changed,
  );
}

/**
 * A snippet as HTML, ready to drop inside a `<code>` element.
 *
 * Returns escaped plain text — never nothing — when the highlighter is still
 * warming up or the language is unknown, so a caller never has to check.
 */
export function highlightCode(code: string, lang: string = 'typescript'): string {
  highlightMetrics.calls += 1;
  countWork('ui.highlight.calls');
  const grammar = loaded.has(lang) ? lang : loaded.has('typescript') ? 'typescript' : null;
  if (!highlighter || !grammar) return escapeHtml(code);

  const key = `${themeGeneration}\0${grammar}\0${code}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    highlightMetrics.cacheHits += 1;
    countWork('ui.highlight.cache_hits');
    // Map insertion order is the LRU order.
    cache.delete(key);
    cache.set(key, cached);
    return cached.html;
  }
  highlightMetrics.cacheMisses += 1;
  countWork('ui.highlight.cache_misses');

  try {
    const started = performance.now();
    const { tokens } = highlighter.codeToTokens(code, { lang: grammar, theme: THEME_NAME });
    const html = tokens
      .map((line) =>
        line
          .map((token) => {
            const style = [
              token.color ? `color:${token.color}` : '',
              // Shiki's FontStyle bitmask: 1 italic, 2 bold, 4 underline.
              typeof token.fontStyle === 'number' && token.fontStyle & 1 ? 'font-style:italic' : '',
              typeof token.fontStyle === 'number' && token.fontStyle & 2 ? 'font-weight:bold' : '',
              typeof token.fontStyle === 'number' && token.fontStyle & 4
                ? 'text-decoration:underline'
                : '',
            ]
              .filter(Boolean)
              .join(';');
            const text = escapeHtml(token.content);
            return style ? `<span style="${style}">${text}</span>` : text;
          })
          .join(''),
      )
      .join('\n');
    const elapsed = performance.now() - started;
    highlightMetrics.tokenizeMs += elapsed;
    countWork('ui.highlight.tokenize_ms', Math.round(elapsed));
    cacheResult(key, html);
    return html;
  } catch {
    return escapeHtml(code);
  }
}

/**
 * The grammar to tokenise a package's declarations with.
 *
 * A before/after pair for a Go module is Go, not TypeScript — getting this
 * wrong is not fatal (the grammar simply matches less) but it is visible, and
 * the ecosystem is always known at the point a snippet is rendered.
 */
export function languageForEcosystem(ecosystem: string | undefined): string {
  switch (ecosystem) {
    case 'pypi':
      return 'python';
    case 'go':
      return 'go';
    case 'cargo':
      return 'rust';
    case 'maven':
    case 'gradle':
      return 'java';
    case 'nuget':
      return 'csharp';
    case 'rubygems':
      return 'ruby';
    case 'packagist':
      return 'php';
    case 'pub':
      return 'dart';
    case 'hex':
      return 'elixir';
    case 'swiftpm':
    case 'cocoapods':
      return 'swift';
    case 'conan':
    case 'vcpkg':
      return 'cpp';
    default:
      return 'typescript';
  }
}

/** The file extension a snippet of this language should be diffed under. */
export function extensionForLanguage(lang: string): string {
  switch (lang) {
    case 'python':
      return 'py';
    case 'go':
      return 'go';
    case 'rust':
      return 'rs';
    case 'java':
      return 'java';
    case 'csharp':
      return 'cs';
    case 'ruby':
      return 'rb';
    case 'php':
      return 'php';
    case 'dart':
      return 'dart';
    case 'elixir':
      return 'ex';
    case 'swift':
      return 'swift';
    case 'cpp':
      return 'cpp';
    case 'json':
      return 'json';
    case 'yaml':
      return 'yaml';
    default:
      return 'ts';
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
