import { languageOf, type Language, type SourceFile } from './walk.js';

/**
 * Meta-RAG: a condensed, AST-aligned index of the repository.
 *
 * This is Drift's adaptation of the mechanism in "LLM Agents for Automated
 * Dependency Upgrades" (arXiv:2510.03480), where a Summary Agent produces
 * one-line natural-language summaries per code unit so the Control Agent can
 * retrieve over metadata instead of raw source — reported there as a ~79.9%
 * token reduction.
 *
 * Drift makes one deliberate change: summaries are **structural, not
 * LLM-generated**. Signature-derived text is free, deterministic, needs no API
 * key, and cannot hallucinate — and for the question Drift actually asks
 * ("which code unit touches this symbol?") a signature is a *better* index
 * than prose. The paper's Summary Agent optimises for semantic recall over a
 * whole codebase; Drift already knows the exact identifiers it is hunting,
 * because the evidence stage extracted them.
 *
 * The index serves two consumers:
 *   1. Localization — narrow the search to files that actually import the
 *      changed dependency, then find the enclosing unit of each match.
 *   2. The Copilot task prompt — hand the agent a compact map of the affected
 *      units instead of dumping whole files into its context.
 */

/** One indexed code unit: a function, class, method, or top-level binding. */
export interface CodeUnit {
  name: string;
  kind: 'function' | 'class' | 'method' | 'variable' | 'interface' | 'type' | 'module';
  /** 1-indexed, inclusive. */
  startLine: number;
  endLine: number;
  /** Single-line structural summary. This is the retrieval surface. */
  summary: string;
  exported: boolean;
}

/** An import of an external module, with the names it brings into scope. */
export interface ImportRecord {
  /** The module specifier exactly as written, e.g. `@scope/pkg/sub`. */
  specifier: string;
  /** Package name the specifier resolves to, e.g. `@scope/pkg`. */
  packageName: string;
  /** Names bound locally by this import. `*` for namespace/wildcard imports. */
  bindings: string[];
  line: number;
  /**
   * Every name this import should be findable under, `packageName` included.
   *
   * One key is enough where a specifier names its package outright — npm, Go,
   * pub. It is not enough where the language imports a *namespace* and the
   * manifest names an *artifact*: `import com.fasterxml.jackson.databind.JsonNode`
   * is shipped by `com.fasterxml.jackson.core:jackson-databind`, and the two
   * strings share only a prefix. Those languages register the full namespace
   * (which an artifact-derived package list matches exactly) alongside the
   * truncated proxy (which a coordinate's group prefix matches approximately),
   * so precision is available when Drift could read the jar and the old
   * approximation still works when it could not.
   */
  keys?: string[];
  /**
   * Does this import make the dependency's names visible to *this* file's own
   * importers?
   *
   * `export { Foo } from 'pkg'` does. `import { Foo } from 'pkg'` does not —
   * the names stop here. The distinction is what lets the local graph be
   * followed without turning every wrapper module into a false positive: a
   * file that wraps `pkg` behind its own interface is the file that breaks,
   * and its callers have nothing to change.
   */
  reExport?: boolean;
  /**
   * Was this record inferred from a *use* rather than read from a declaration?
   *
   * Elixir, Erlang, and Ruby let a file reach into another package with no
   * import line at all — `Jason.encode!(x)`, `ActiveSupport::Inflector`,
   * `crypto:hash(...)` — so the index synthesises an import record at the
   * first such reference to record the dependency edge. That line is a *call
   * site*, not an import, and the localizer's rule about not reporting import
   * lines must not swallow it.
   */
  synthetic?: boolean;
}

/**
 * An import of something inside this repository.
 *
 * Kept apart from `ImportRecord` because it answers a different question. An
 * external import says *which dependency* a file uses; a local one says which
 * other file's names it inherits — and following those edges is how Drift
 * finds the module that imports `axios` three barrel files away from the code
 * that actually calls it.
 */
export interface LocalImport {
  /** The specifier as written, e.g. `./utils` or `"common/log.h"`. */
  specifier: string;
  line: number;
  /** Names bound from it, where the language says them. */
  bindings: string[];
  /** Does this file forward what it imported on to its own importers? */
  reExport: boolean;
}

/** Every name an import is indexed under. */
export function importKeys(record: ImportRecord): string[] {
  return record.keys ?? [record.packageName];
}

export interface FileIndex {
  path: string;
  language: Language;
  lineCount: number;
  imports: ImportRecord[];
  /** Imports of other files in this repository, for the re-export graph. */
  localImports: LocalImport[];
  units: CodeUnit[];
  /** One-line description of the file, used when ranking candidates. */
  summary: string;
}

export interface RepoIndex {
  files: FileIndex[];
  /** package name -> repo-relative paths importing it. The key join for localization. */
  importers: Map<string, string[]>;
  /**
   * Repo-relative path -> the files in this repository that import it.
   *
   * The inverse of `localImports`, resolved to real paths. Localization walks
   * it outward from the direct importers of a changed dependency, so a call
   * site behind a barrel file is still found — see `reachThroughReExports`.
   */
  localImporters: Map<string, LocalEdge[]>;
  stats: {
    fileCount: number;
    unitCount: number;
    totalLines: number;
  };
}

/** One resolved edge: `from` imports the file this edge is keyed under. */
export interface LocalEdge {
  from: string;
  bindings: string[];
  reExport: boolean;
  line: number;
}

export function buildIndex(files: readonly SourceFile[]): RepoIndex {
  const indexed: FileIndex[] = [];
  const importers = new Map<string, string[]>();
  const knownPaths = new Set(files.map((f) => f.path));

  for (const file of files) {
    const imports = extractImports(file);
    const units = extractUnits(file);

    indexed.push({
      path: file.path,
      language: file.language,
      lineCount: file.lineCount,
      imports,
      localImports: extractLocalImports(file),
      units,
      summary: summarizeFile(file, units, imports),
    });

    for (const record of new Set(imports.flatMap(importKeys))) {
      const list = importers.get(record);
      if (list) list.push(file.path);
      else importers.set(record, [file.path]);
    }
  }

  const localImporters = new Map<string, LocalEdge[]>();
  const byStem = pathsByStem(knownPaths);
  for (const file of indexed) {
    for (const local of file.localImports) {
      const target = resolveLocalSpecifier(file.path, local.specifier, knownPaths, byStem);
      if (!target || target === file.path) continue;
      const list = localImporters.get(target);
      const edge: LocalEdge = {
        from: file.path,
        bindings: local.bindings,
        reExport: local.reExport,
        line: local.line,
      };
      if (list) list.push(edge);
      else localImporters.set(target, [edge]);
    }
  }

  return {
    files: indexed,
    importers,
    localImporters,
    stats: {
      fileCount: indexed.length,
      unitCount: indexed.reduce((n, f) => n + f.units.length, 0),
      totalLines: indexed.reduce((n, f) => n + f.lineCount, 0),
    },
  };
}

/** Find the code unit containing a line, preferring the innermost match. */
export function unitAtLine(file: FileIndex, line: number): CodeUnit | undefined {
  let best: CodeUnit | undefined;
  for (const unit of file.units) {
    if (line < unit.startLine || line > unit.endLine) continue;
    if (!best || unit.endLine - unit.startLine < best.endLine - best.startLine) best = unit;
  }
  return best;
}

/* ---------------- imports ---------------- */

function extractImports(file: SourceFile): ImportRecord[] {
  switch (file.language) {
    case 'typescript':
    case 'javascript':
      return extractJsImports(file.content);
    case 'python':
      return extractPythonImports(file.content, file.path);
    case 'go':
      return extractGoImports(file.content);
    case 'rust':
      return extractRustImports(file.content);
    case 'java':
      return extractJavaImports(file.content);
    case 'ruby':
      return extractRubyImports(file.content);
    case 'dotnet':
      return extractDotnetImports(file.content);
    case 'dart':
      return extractDartImports(file.content);
    case 'c':
    case 'cpp':
      return extractIncludes(file.content);
    case 'php':
      return extractPhpImports(file.content);
    case 'elixir':
      return extractElixirImports(file.content);
    case 'erlang':
      return extractErlangImports(file.content);
    case 'swift':
      return extractSwiftImports(file.content);
    case 'ocaml':
      return extractOcamlImports(file.content);
    default:
      return [];
  }
}

/* ---------------- the local graph ---------------- */

/**
 * Imports of other files in this repository.
 *
 * Only the languages where a barrel file is common practice are parsed, and
 * for a reason: the value of a local edge is entirely in whether the file at
 * the far end *forwards* the dependency's names. Languages that have no
 * re-export syntax gain nothing from the graph, and building it for them would
 * be cost with no finding at the end of it.
 */
function extractLocalImports(file: SourceFile): LocalImport[] {
  switch (file.language) {
    case 'typescript':
    case 'javascript':
      return jsLocalImports(file.content);
    case 'python':
      return pythonLocalImports(file.content, file.path);
    case 'c':
    case 'cpp':
      // Every `#include` is a candidate local edge, quoted or angled: an
      // include is a textual splice, so whatever the included header pulled in
      // arrives here too. Which of them actually resolve inside the repository
      // is decided by `resolveLocalSpecifier` against the real path set, not
      // by the punctuation around the specifier.
      return cLocalIncludes(file.content);
    default:
      return [];
  }
}

function jsLocalImports(content: string): LocalImport[] {
  const out: LocalImport[] = [];
  const lineStarts = lineStartOffsets(content);

  const patterns: { re: RegExp; reExport: boolean; names: 1 | 0 }[] = [
    { re: /\bexport\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g, reExport: true, names: 1 },
    { re: /\bexport\s+\*(?:\s+as\s+[\w$]+)?\s+from\s+['"]([^'"]+)['"]/g, reExport: true, names: 0 },
    {
      re: /\bimport\s+(?!\()(?:(?:type\s+)?[\w$]+\s*,\s*)?(?:type\s+)?(?:\{([^}]*)\}|\*\s+as\s+[\w$]+|[\w$]+)?\s+from\s+['"]([^'"]+)['"]/g,
      reExport: false,
      names: 1,
    },
    {
      re: /\b(?:const|let|var)\s+(\{[^}]+\}|[\w$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g,
      reExport: false,
      names: 1,
    },
  ];

  for (const { re, reExport, names } of patterns) {
    for (const match of content.matchAll(re)) {
      const specifier = names === 1 ? match[2] : match[1];
      if (!specifier || !specifier.startsWith('.')) continue;
      const listed = names === 1 ? match[1] : undefined;
      out.push({
        specifier,
        line: lineOfOffset(lineStarts, match.index ?? 0),
        bindings: listed ? importBindings(undefined, listed.replace(/[{}]/g, ''), undefined, undefined) : ['*'],
        reExport,
      });
    }
  }

  return out;
}

/**
 * `from .utils import Foo` and `from . import utils`.
 *
 * A relative import inside `__init__.py` counts as a re-export, because that
 * is what `__init__.py` is for: the package's public name for something
 * defined elsewhere. Anywhere else it is an ordinary use, and the names stop
 * at that module.
 */
function pythonLocalImports(content: string, path: string): LocalImport[] {
  const out: LocalImport[] = [];
  const lines = content.split('\n');
  const isPackageInit = path.endsWith('/__init__.py') || path === '__init__.py';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const from = /^from\s+(\.[\w.]*)\s+import\s(.+)$/.exec(line);
    if (from) {
      out.push({
        specifier: from[1]!,
        line: i + 1,
        bindings: parsePythonImportList(from[2]!.trimStart()),
        reExport: isPackageInit,
      });
    }
  }

  return out;
}

function cLocalIncludes(content: string): LocalImport[] {
  const out: LocalImport[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*#\s*include\s*(?:<([^>]+)>|"([^"]+)")/.exec(lines[i]!);
    const specifier = match?.[1] ?? match?.[2];
    if (!specifier) continue;
    out.push({ specifier, line: i + 1, bindings: [], reExport: true });
  }

  return out;
}

/** Repo paths grouped by their basename and by their extension-less basename. */
function pathsByStem(paths: ReadonlySet<string>): Map<string, string[]> {
  const byStem = new Map<string, string[]>();
  const add = (key: string, path: string): void => {
    const list = byStem.get(key);
    if (list) list.push(path);
    else byStem.set(key, [path]);
  };
  for (const path of paths) {
    const base = path.split('/').pop() ?? path;
    add(base.toLowerCase(), path);
  }
  return byStem;
}

/** Extensions tried, in order, when a specifier omits one. */
const RESOLUTION_EXTENSIONS = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py',
];

/**
 * Turn a relative specifier into a repository path, or nothing.
 *
 * Deliberately not a module resolver. It answers one question — "is there a
 * file in this repository that this specifier plainly names?" — and declines
 * whenever the answer is ambiguous, because a wrong edge here does not widen
 * the search harmlessly: it attributes one module's dependency to another
 * module's importers, which is exactly the wrong answer Drift exists to avoid.
 */
export function resolveLocalSpecifier(
  from: string,
  specifier: string,
  known: ReadonlySet<string>,
  byStem: Map<string, string[]>,
): string | undefined {
  if (specifier.startsWith('.')) {
    const base = from.split('/').slice(0, -1);
    const joined = normalizeSegments([...base, ...specifier.split('/')]);
    if (joined === undefined) return undefined;

    // `from . import x` and `from .pkg import x` name a directory.
    const pythonRelative = /^\.+$/.test(specifier) || (!specifier.includes('/') && specifier.startsWith('.'));
    const candidates = pythonRelative
      ? [`${pythonModulePath(from, specifier)}.py`, `${pythonModulePath(from, specifier)}/__init__.py`]
      : [joined, ...RESOLUTION_EXTENSIONS.map((ext) => joined + ext),
         ...RESOLUTION_EXTENSIONS.map((ext) => `${joined}/index${ext}`),
         `${joined}/__init__.py`];

    for (const candidate of candidates) {
      if (candidate && known.has(candidate)) return candidate;
    }
    return undefined;
  }

  // An include path, which the compiler resolves against a search path Drift
  // does not have. The basename is the only honest join, and it is taken only
  // when exactly one file in the repository carries it — two `config.h` files
  // mean the answer is unknown, and unknown must not become a guess.
  const base = (specifier.split('/').pop() ?? specifier).toLowerCase();
  const matches = (byStem.get(base) ?? []).filter((path) =>
    path.toLowerCase().endsWith(specifier.toLowerCase()),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** `['src','a','..','b']` -> `src/b`; escaping the root returns nothing. */
function normalizeSegments(segments: readonly string[]): string | undefined {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/** `from ..pkg import x` in `a/b/c.py` -> `a/pkg`. */
function pythonModulePath(from: string, specifier: string): string {
  const dots = /^\.+/.exec(specifier)?.[0].length ?? 1;
  const rest = specifier.slice(dots).split('.').filter(Boolean);
  const base = from.split('/').slice(0, -dots);
  return [...base, ...rest].join('/');
}

/**
 * `#include <ArduinoJson.h>` and `#include "zlib.h"`.
 *
 * C has no import statement that binds names — an include is a textual splice,
 * and everything the header declares lands in the translation unit at once. So
 * `bindings` is empty on purpose, and every C impact site is capped at `medium`
 * confidence by `confidenceFor`. That is the correct ceiling: the file
 * provably includes the dependency's header, and nothing weaker than a
 * compiler can prove which of its declarations the file actually used.
 *
 * The package name is the first path segment with its extension dropped, and
 * lowercased, because the two ends of this join disagree about case more often
 * than not — `#include <ArduinoJson.h>` against a `platformio.ini` that says
 * `arduinojson`, `<zlib.h>` against a Conan recipe called `zlib`. Include
 * resolution on the two platforms most C is written on is case-insensitive
 * anyway, so matching case-insensitively is the behaviour, not a shortcut.
 *
 * Quoted includes are kept rather than skipped the way a relative `import` is.
 * The quotes mean "look next to this file first", not "this is mine" — a great
 * deal of published C is included as `"zlib.h"` — so the decision about whether
 * a header belongs to the project is left to the importer join, which answers
 * it by knowing the dependency's actual name.
 */
function extractIncludes(content: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*#\s*include\s*(?:<([^>]+)>|"([^"]+)")/.exec(lines[i]!);
    const specifier = match?.[1] ?? match?.[2];
    if (!specifier) continue;

    // `./foo.h` and `../foo.h` name a path, never a package.
    if (specifier.startsWith('.')) continue;

    out.push({
      specifier,
      packageName: includeRoot(specifier),
      bindings: [],
      line: i + 1,
      // An include is a textual splice, so a header this file includes is a
      // header its own includers get too. Every C include forwards.
      reExport: true,
    });
  }

  return out;
}

/** `boost/asio.hpp` -> `boost`; `ArduinoJson.h` -> `arduinojson`. */
export function includeRoot(specifier: string): string {
  const first = specifier.split('/')[0] ?? specifier;
  return first.replace(/\.(h|hpp|hh|hxx|inl|tpp|h\+\+)$/i, '').toLowerCase();
}

function extractJsImports(content: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const lineStarts = lineStartOffsets(content);
  const lineOf = (offset: number): number => lineOfOffset(lineStarts, offset);
  const staticImport =
    /\bimport\s+(?!\()(?:(?:type\s+)?([\w$]+)\s*,\s*)?(?:type\s+)?(?:\{([^}]+)\}|\*\s+as\s+([\w$]+)|([\w$]+))?\s+from\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g;

  for (const match of content.matchAll(staticImport)) {
    const specifier = match[5] ?? match[6];
    if (!specifier || isRelative(specifier)) continue;
    const bindings = importBindings(match[1], match[2], match[3], match[4]);
    out.push({
      specifier,
      packageName: packageNameFromSpecifier(specifier),
      bindings,
      line: lineOf(match.index ?? 0),
    });
  }

  const requireImport =
    /\b(?:const|let|var)\s+(\{[^}]+\}|[\w$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of content.matchAll(requireImport)) {
    const specifier = match[2]!;
    if (isRelative(specifier)) continue;
    out.push({
      specifier,
      packageName: packageNameFromSpecifier(specifier),
      bindings: requireBindings(match[1]!),
      line: lineOf(match.index ?? 0),
    });
  }

  const dynamicImport = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of content.matchAll(dynamicImport)) {
    const specifier = match[1]!;
    if (isRelative(specifier)) continue;
    out.push({
      specifier,
      packageName: packageNameFromSpecifier(specifier),
      bindings: [],
      line: lineOf(match.index ?? 0),
    });
  }

  // `export { x, y as z } from 'pkg'` — a re-export barrel. The file never
  // binds `x`/`z` locally, but it does depend on `pkg`, and downstream code
  // treats an import edge as evidence of usage regardless of whether the name
  // is bound or merely forwarded.
  const namedReExport = /\bexport\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(namedReExport)) {
    const specifier = match[2]!;
    if (isRelative(specifier)) continue;
    out.push({
      specifier,
      packageName: packageNameFromSpecifier(specifier),
      bindings: importBindings(undefined, match[1], undefined, undefined),
      line: lineOf(match.index ?? 0),
      reExport: true,
    });
  }

  // `export * as ns from 'pkg'`
  const namespaceReExport = /\bexport\s+\*\s+as\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(namespaceReExport)) {
    const specifier = match[2]!;
    if (isRelative(specifier)) continue;
    out.push({
      specifier,
      packageName: packageNameFromSpecifier(specifier),
      bindings: ['*', match[1]!],
      line: lineOf(match.index ?? 0),
      reExport: true,
    });
  }

  // `export * from 'pkg'` — deliberately after the `as` variant so `export *
  // as ns from` (which also starts with `export * `) is never double-counted:
  // the `\s+from` right after `*` only matches when there is no `as ns` in
  // between.
  const starReExport = /\bexport\s+\*\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(starReExport)) {
    const specifier = match[1]!;
    if (isRelative(specifier)) continue;
    out.push({
      specifier,
      packageName: packageNameFromSpecifier(specifier),
      bindings: ['*'],
      line: lineOf(match.index ?? 0),
      reExport: true,
    });
  }

  return out.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
}

function importBindings(
  defaultBinding: string | undefined,
  named: string | undefined,
  namespace: string | undefined,
  bareDefault: string | undefined,
): string[] {
  const names: string[] = [];
  if (defaultBinding) names.push(defaultBinding);
  if (bareDefault) names.push(bareDefault);
  if (namespace) names.push('*', namespace);
  if (named) {
    for (const part of named.split(',')) {
      const cleaned = part.replace(/\btype\s+/g, '').trim();
      if (!cleaned) continue;
      const [imported, local] = cleaned.split(/\s+as\s+/).map((piece) => piece.trim());
      if (imported) names.push(local || imported, imported);
    }
  }
  return [...new Set(names)];
}

function requireBindings(binding: string): string[] {
  const trimmed = binding.trim();
  if (!trimmed.startsWith('{')) return [trimmed];
  return trimmed
    .replace(/[{}]/g, '')
    .split(',')
    .flatMap((part) => {
      const [property, local] = part.split(':').map((piece) => piece.trim());
      return [property, local].filter((name): name is string => Boolean(name));
    });
}

function extractPythonImports(content: string, path: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const lines = content.split('\n');
  // `__init__.py` is Python's barrel: a name it imports is a name the package
  // then offers under its own path, so those imports forward.
  const forwards = path.endsWith('/__init__.py') || path === '__init__.py';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    // `from pkg.sub import a, b as c`
    const from = /^from\s+([\w.]+)\s+import\s(.+)$/.exec(line);
    if (from) {
      const module = from[1]!;
      // A leading dot is a relative import — internal, not a dependency.
      if (module.startsWith('.')) continue;
      out.push({
        specifier: module,
        packageName: module.split('.')[0]!,
        bindings: parsePythonImportList(from[2]!.trimStart()),
        line: i + 1,
        reExport: forwards,
      });
      continue;
    }

    // `import pkg.sub as alias, other`
    const plain = /^import\s(.+)$/.exec(line);
    if (plain) {
      for (const part of plain[1]!.trimStart().split(',')) {
        const match = /^\s*([\w.]+)(?:\s+as\s+(\w+))?/.exec(part);
        if (!match?.[1]) continue;
        const module = match[1];
        const root = module.split('.')[0]!;
        out.push({
          specifier: module,
          packageName: root,
          bindings: [match[2] ?? root],
          line: i + 1,
          reExport: forwards,
        });
      }
    }
  }

  return out;
}

function parsePythonImportList(list: string): string[] {
  if (list.trim() === '*') return ['*'];
  return list
    .replace(/[()]/g, '')
    .split(',')
    .map((part) => {
      const match = /^\s*(\w+)(?:\s+as\s+(\w+))?/.exec(part);
      return match ? [match[1]!, match[2]].filter(Boolean) : [];
    })
    .flat() as string[];
}

function extractGoImports(content: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const lines = content.split('\n');
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    if (/^import\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }

    const entry = inBlock
      ? /^(?:(\w+|\.|_)\s+)?"([^"]+)"/.exec(line)
      : /^import\s+(?:(\w+|\.|_)\s+)?"([^"]+)"/.exec(line);
    if (!entry?.[2]) continue;

    const path = entry[2];
    const alias = entry[1];
    // Go's package name defaults to the last path segment.
    const defaultName = path.split('/').pop() ?? path;

    out.push({
      specifier: path,
      packageName: path,
      bindings: [alias && alias !== '_' && alias !== '.' ? alias : defaultName],
      line: i + 1,
    });
  }

  return out;
}

function extractRustImports(content: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const use = /^(?:pub\s+)?use\s+([\w:{},\s*]+);?/.exec(line);
    if (!use?.[1]) continue;

    const path = use[1].trim();
    const root = path.split('::')[0]!.trim();
    // `crate`, `self`, `super` are internal paths, not dependencies.
    if (root === 'crate' || root === 'self' || root === 'super' || !root) continue;

    // Cargo crate names use hyphens; Rust paths use underscores.
    out.push({
      specifier: path,
      packageName: root.replace(/_/g, '-'),
      bindings: rustBindings(path),
      line: i + 1,
    });
  }

  return out;
}

/**
 * The names a `use` statement actually brings into scope.
 *
 * Every word in the path was the old answer, and it was wrong in the direction
 * that costs the most: `use serde::de::Deserializer` was recorded as binding
 * `serde` and `de` as well as `Deserializer`, so any file with that line was
 * credited with a high-confidence binding of every intermediate module name,
 * and a breaking change to something called `de` landed as `high` in a file
 * that had never named it. What a `use` binds is the leaf of each path in it,
 * or the alias where one is written — nothing else.
 */
export function rustBindings(path: string): string[] {
  const names: string[] = [];

  const walk = (segment: string): void => {
    const trimmed = segment.trim();
    if (!trimmed) return;

    const brace = trimmed.indexOf('{');
    if (brace !== -1) {
      const close = trimmed.lastIndexOf('}');
      const inner = trimmed.slice(brace + 1, close === -1 ? undefined : close);
      for (const part of splitTopLevel(inner)) walk(part);
      return;
    }

    const aliased = /\bas\s+([\w*]+)\s*$/.exec(trimmed);
    if (aliased?.[1]) {
      names.push(aliased[1]);
      return;
    }

    const leaf = trimmed.split('::').pop()?.trim();
    if (!leaf) return;
    // `use foo::bar::*` brings in everything, which is the same claim `*` makes
    // everywhere else in the index.
    names.push(leaf === '*' ? '*' : leaf);
    if (leaf === 'self') {
      const parent = trimmed.split('::').slice(-2, -1)[0]?.trim();
      if (parent) names.push(parent);
    }
  };

  walk(path);
  return [...new Set(names.filter((name) => name !== 'self'))];
}

/** Split on commas that are not inside a nested brace group. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function extractJavaImports(content: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const match = /^import\s+(?:static\s+)?([\w.]+)(\.\*)?\s*;/.exec(lines[i]!.trim());
    if (!match?.[1]) continue;

    const fqn = match[1];
    const segments = fqn.split('.');
    const simpleName = segments[segments.length - 1]!;

    // A static import names a member, not a type: the package is everything
    // above the class, one segment further up than an ordinary import.
    const isStatic = /^import\s+static\b/.test(lines[i]!.trim());
    const packageSegments = segments.slice(0, match[2] ? segments.length : -1);
    const javaPackage = (isStatic ? packageSegments.slice(0, -1) : packageSegments).join('.');
    const proxy = segments.slice(0, 3).join('.');

    out.push({
      specifier: fqn,
      // The truncated proxy stays the primary key so behaviour is unchanged
      // for a coordinate matched by its group prefix; the full package is
      // registered beside it so an artifact-derived package list — read out of
      // the jar Drift already downloads for japicmp — matches exactly instead.
      packageName: proxy,
      bindings: match[2] ? ['*'] : [simpleName],
      line: i + 1,
      keys: [...new Set([javaPackage, proxy].filter(Boolean))],
    });
  }

  return out;
}

/**
 * `require "active_support/core_ext"` — and the constants Bundler required for
 * you.
 *
 * The `require` line alone is not enough in Ruby and never was. Bundler
 * requires every gem in the Gemfile before the application's own code runs, so
 * an enormous amount of real Ruby names another gem's constant with nothing
 * local to say where it came from: `ActiveSupport::Inflector.pluralize` is a
 * complete reference to a gem, on one line, with no `require` above it. A
 * localizer that searched only the files with a matching `require` was blind
 * to most of the Ruby ever written, which is the failure mode that reads as
 * "Drift found nothing" rather than as "Drift could not look".
 *
 * So a scoped constant reference is recorded as an import too, keyed on its
 * root, deduplicated to first use. The root joins against the constant list
 * read out of the published `.gem` — see `src/localize/modules.ts` — which is
 * what makes it a fact rather than a guess.
 */
function extractRubyImports(content: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const seen = new Set<string>();
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const match = /^\s*require(?:_relative)?\s+["']([^"']+)["']/.exec(line);
    if (match?.[1] && !line.includes('require_relative')) {
      const path = match[1];
      const root = path.split('/')[0]!;
      if (!seen.has(path)) {
        seen.add(path);
        out.push({
          specifier: path,
          packageName: root,
          bindings: [],
          line: i + 1,
          // The whole require path as well as its root, because a gem's own
          // file list — which is what the `.gem` archive gives — names paths,
          // not roots.
          keys: [...new Set([path, root])],
        });
      }
      continue;
    }

    if (line.trimStart().startsWith('#')) continue;

    for (const reference of line.matchAll(/\b([A-Z][A-Za-z0-9_]*)::[A-Z]/g)) {
      const root = reference[1]!;
      if (RUBY_CORE_CONSTANTS.has(root) || seen.has(root)) continue;
      seen.add(root);
      out.push({
        specifier: root,
        packageName: root,
        bindings: [root],
        line: i + 1,
        synthetic: true,
      });
    }
  }

  return out;
}

/**
 * Constants Ruby itself defines. Indexing them would join every `Errno::` and
 * `Encoding::` in a codebase to whichever gem happened to share the word.
 */
const RUBY_CORE_CONSTANTS = new Set([
  'Object', 'Kernel', 'Comparable', 'Enumerable', 'String', 'Symbol', 'Numeric',
  'Integer', 'Float', 'Rational', 'Complex', 'Array', 'Hash', 'Range', 'Struct',
  'Time', 'Date', 'DateTime', 'File', 'IO', 'Dir', 'Process', 'Thread', 'Mutex',
  'Exception', 'StandardError', 'RuntimeError', 'ArgumentError', 'TypeError',
  'NameError', 'NoMethodError', 'Errno', 'Encoding', 'Math', 'GC', 'ObjectSpace',
  'Signal', 'Marshal', 'Regexp', 'MatchData', 'Proc', 'Method', 'Module', 'Class',
  'Random', 'Enumerator', 'Fiber', 'Set', 'JSON', 'YAML', 'ENV', 'Data', 'Warning',
]);

/**
 * `using Namespace.Sub;` (and `using static X;`, `global using X;`) in C#/F#/VB.
 *
 * A namespace is not a NuGet package id — `Newtonsoft.Json` the namespace and
 * `Newtonsoft.Json` the package happen to match, but there is no rule that
 * they must. The first two segments are the best available proxy (mirroring
 * `extractJavaImports`'s own segment-count proxy for Maven coordinates), good
 * enough to catch a well-known package's own namespace but not guaranteed for
 * one that publishes under an unrelated root namespace. When Drift can read
 * the `.nupkg`, the namespace list in its ECMA-335 metadata replaces the guess
 * entirely and the join becomes exact.
 */
function extractDotnetImports(content: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    // Excludes `using (...)` resource-disposal statements and `using var x = ...`,
    // neither of which names an external namespace.
    const alias = /^(?:global\s+)?using\s+(\w+)\s*=\s*([\w.]+)\s*;/.exec(line);
    const match = alias ?? /^(?:global\s+)?using\s+(?:static\s+)?([\w.]+)\s*;/.exec(line);
    if (!match?.[1]) continue;
    if (/^using\s*\(/.test(line) || /^using\s+var\b/.test(line)) continue;

    const fqn = alias ? alias[2]! : match[1];
    const segments = fqn.split('.');
    const proxy = segments.slice(0, 2).join('.');

    out.push({
      specifier: fqn,
      packageName: proxy,
      // `using Newtonsoft.Json;` binds every type in that namespace, not a
      // type called `Json`. Recording the last segment as a binding was a
      // quiet false positive generator: a package whose namespace ended in a
      // word the evidence also named scored `high` in a file that never used
      // it. `*` is what the language actually does here, and it is the same
      // claim `from x import *` makes in Python. An alias binds one name, and
      // that name is the alias.
      bindings: alias ? [alias[1]!] : ['*'],
      line: i + 1,
      // Same arrangement as Java: the two-segment proxy for the name-guessing
      // path, the whole namespace for the ECMA-335 metadata Drift reads out of
      // the `.nupkg` when it can, which names the namespace exactly.
      keys: [...new Set([fqn, proxy])],
    });
  }

  return out;
}

/**
 * `import 'package:name/path.dart';` (and `export 'package:...'`) in Dart.
 *
 * Unlike most ecosystems here, the package name is not a proxy — pub encodes
 * it directly in the URI, so this is an exact match, not a heuristic.
 */
function extractDartImports(content: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const match =
      /^\s*(?:import|export)\s+['"]package:([^/'"]+)(\/[^'"]*)?['"]\s*((?:(?:as|show|hide)\s+[\w\s,]+)*)/.exec(
        lines[i]!,
      );
    if (!match?.[1]) continue;

    const packageName = match[1];
    out.push({
      specifier: `package:${packageName}${match[2] ?? ''}`,
      packageName,
      // `import 'package:x/x.dart';` brings every public name in that library
      // into scope, so `*` is the honest binding. `show` narrows it to a list,
      // `as` binds one prefix, and `hide` still brings in everything else.
      bindings: dartBindings(match[3] ?? ''),
      line: i + 1,
    });
  }

  return out;
}

/**
 * `use Symfony\Component\HttpFoundation\Request;` and its grouped form.
 *
 * PHP's namespace separator is a backslash, which is why `identifies` in the
 * localizer treats `\` as a path separator alongside `/`, `.` and `:`. The key
 * registered here is the *namespace* — everything but the final segment —
 * because that is what a Composer package's PSR-4 autoload map declares, and
 * that map is what turns a namespace back into a package name. Every prefix of
 * the namespace is registered too, since a PSR-4 root is usually shorter than
 * the namespace a class actually lives in: `Symfony\Component\HttpFoundation\`
 * is the root, `...\Session\Storage` is where the class is.
 */
function extractPhpImports(content: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    // `use Vendor\Pkg\{A, B as C};`
    const grouped = /^use\s+(?:function\s+|const\s+)?\\?([\w\\]+)\\\{([^}]*)\}\s*;/.exec(line);
    if (grouped) {
      const prefix = grouped[1]!;
      for (const part of grouped[2]!.split(',')) {
        const entry = /^\s*([\w\\]+)(?:\s+as\s+(\w+))?/i.exec(part);
        if (!entry?.[1]) continue;
        out.push(phpImport(`${prefix}\\${entry[1]}`, entry[2], i + 1));
      }
      continue;
    }

    const single = /^use\s+(?:function\s+|const\s+)?\\?([\w\\]+)(?:\s+as\s+(\w+))?\s*;/i.exec(line);
    if (single?.[1]) out.push(phpImport(single[1], single[2], i + 1));
  }

  return out;
}

function phpImport(fqn: string, alias: string | undefined, line: number): ImportRecord {
  const segments = fqn.split('\\').filter(Boolean);
  const simpleName = segments[segments.length - 1] ?? fqn;
  const namespace = segments.slice(0, -1);

  return {
    specifier: fqn,
    packageName: namespace.join('\\'),
    bindings: [alias ?? simpleName],
    line,
    // Every ancestor namespace, longest first, so a PSR-4 root of any depth
    // finds this file.
    keys: namespace.map((_, index) => namespace.slice(0, index + 1).join('\\')).reverse(),
  };
}

/**
 * `alias Ecto.Query`, `import Plug.Conn`, `use GenServer`, and `Jason.decode!/1`.
 *
 * Elixir's problem is that a module needs no declaration at all to be called —
 * `Jason.decode!(body)` is a complete reference to another package's code with
 * nothing at the top of the file to say so. Which is why the fully-qualified
 * call form is extracted alongside the four declaration forms, deduplicated to
 * the first line each module appears on so a file that calls `Jason` forty
 * times contributes one import record rather than forty.
 */
function extractElixirImports(content: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const seen = new Set<string>();
  const lines = content.split('\n');

  const push = (module: string, binding: string, line: number, synthetic = false): void => {
    const root = module.split('.')[0]!;
    if (!/^[A-Z]/.test(root) || ELIXIR_STDLIB.has(root)) return;
    if (seen.has(module)) return;
    seen.add(module);
    const segments = module.split('.');
    out.push({
      specifier: module,
      packageName: root,
      bindings: [...new Set([binding, module])],
      line,
      keys: segments.map((_, index) => segments.slice(0, index + 1).join('.')).reverse(),
      ...(synthetic ? { synthetic: true } : {}),
    });
  };

  // Elixir documents itself in heredocs, and Elixir documentation is full of
  // Elixir. `@moduledoc """ ... alias MyApp.Repo ... """` is prose about an
  // imaginary application, and reading it as an import puts this file in range
  // of any package that happens to define a module called `Repo`. Phoenix's
  // own `controller.ex` contributes four such names.
  let inHeredoc = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    const fences = (line.match(/"""/g) ?? []).length;
    if (inHeredoc) {
      if (fences % 2 === 1) inHeredoc = false;
      continue;
    }
    if (fences % 2 === 1) {
      inHeredoc = true;
      continue;
    }

    if (trimmed.startsWith('#')) continue;

    // `alias Foo.{Bar, Baz}`
    const grouped = /^\s*alias\s+([A-Z][\w.]*)\.\{([^}]*)\}/.exec(line);
    if (grouped) {
      for (const part of grouped[2]!.split(',')) {
        const name = part.trim();
        if (!name) continue;
        push(`${grouped[1]}.${name}`, name.split('.').pop()!, i + 1);
      }
      continue;
    }

    const declared = /^\s*(?:alias|import|use|require)\s+([A-Z][\w.]*)(?:\s*,\s*as:\s*([A-Z][\w.]*))?/.exec(line);
    if (declared) {
      const module = declared[1]!;
      const local = declared[2] ?? module.split('.').pop()!;
      push(module, local.split('.').pop()!, i + 1);
      continue;
    }

    // A remote call written out in full, which needs no declaration.
    for (const match of line.matchAll(/\b([A-Z][\w]*(?:\.[A-Z][\w]*)*)\.[a-z_]\w*[!?]?\s*[({]/g)) {
      push(match[1]!, match[1]!.split('.').pop()!, i + 1, true);
    }
  }

  return out;
}

/**
 * Elixir and Erlang ship a large standard library under ordinary-looking
 * module names. Indexing them would join `String` and `Enum` to whatever
 * dependency happens to share the word, so they are excluded outright.
 */
const ELIXIR_STDLIB = new Set([
  'Kernel', 'Enum', 'String', 'Map', 'List', 'Keyword', 'Atom', 'Integer', 'Float',
  'Process', 'Task', 'Agent', 'GenServer', 'Supervisor', 'Application', 'Registry',
  'IO', 'File', 'Path', 'System', 'Node', 'Port', 'Regex', 'Range', 'Stream',
  'Tuple', 'Access', 'Base', 'Bitwise', 'Code', 'Config', 'Date', 'DateTime',
  'NaiveDateTime', 'Time', 'Calendar', 'Exception', 'Function', 'Macro', 'Module',
  'Protocol', 'Record', 'Set', 'MapSet', 'URI', 'Version', 'Logger', 'Mix', 'ExUnit',
  'Struct', 'Behaviour', 'Inspect', 'Collectable', 'Enumerable',
]);

/**
 * `-include_lib("jose/include/jose.hrl").` and `some_mod:some_fun(...)`.
 *
 * Erlang has no import statement, so the remote-call form does all the work.
 * Module names are bare atoms, which means the join against a Hex package's
 * module list has to be exact — there is no prefix to lean on — and that is
 * precisely why the Hex module map matters more here than anywhere else.
 */
function extractErlangImports(content: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const seen = new Set<string>();
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('%')) continue;

    const includeLib = /^\s*-include_lib\(\s*"([^"]+)"/.exec(line);
    if (includeLib?.[1]) {
      const app = includeLib[1].split('/')[0]!;
      if (!seen.has(app)) {
        seen.add(app);
        out.push({ specifier: includeLib[1], packageName: app, bindings: [], line: i + 1 });
      }
      continue;
    }

    for (const match of line.matchAll(/\b([a-z][\w]*)\s*:\s*([a-z][\w]*)\s*\(/g)) {
      const module = match[1]!;
      if (ERLANG_STDLIB.has(module) || seen.has(module)) continue;
      seen.add(module);
      out.push({
        specifier: module,
        packageName: module,
        bindings: [module],
        line: i + 1,
        synthetic: true,
      });
    }
  }

  return out;
}

const ERLANG_STDLIB = new Set([
  'erlang', 'lists', 'maps', 'dict', 'sets', 'ordsets', 'gb_trees', 'gb_sets',
  'io', 'io_lib', 'file', 'filename', 'filelib', 'os', 'string', 'binary',
  're', 'timer', 'gen_server', 'gen_statem', 'gen_event', 'supervisor',
  'application', 'proplists', 'ets', 'dets', 'mnesia', 'crypto', 'ssl',
  'inet', 'gen_tcp', 'gen_udp', 'httpc', 'rand', 'calendar', 'unicode',
  'code', 'error_logger', 'logger', 'lager', 'math', 'queue', 'array',
]);

/**
 * `import Alamofire` and `@testable import Vapor`.
 *
 * Swift imports a whole module and binds nothing by name, so `bindings` is
 * empty for the same reason C's is — and every Swift impact site is capped at
 * medium confidence as a result. The module name is not the package name and
 * cannot be derived from it, which is why the SwiftPM module map is the piece
 * that makes this ecosystem work at all.
 */
function extractSwiftImports(content: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('//')) continue;
    const match =
      /^\s*(?:@testable\s+)?import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?([\w.]+)/.exec(
        line,
      );
    if (!match?.[1]) continue;

    const module = match[1].split('.')[0]!;
    if (SWIFT_STDLIB.has(module)) continue;
    out.push({ specifier: match[1], packageName: module, bindings: [], line: i + 1 });
  }

  return out;
}

const SWIFT_STDLIB = new Set([
  'Foundation', 'Swift', 'UIKit', 'AppKit', 'SwiftUI', 'Combine', 'CoreData',
  'CoreGraphics', 'CoreLocation', 'AVFoundation', 'XCTest', 'Dispatch', 'os',
  'ObjectiveC', 'Darwin', 'Glibc', 'WebKit', 'MapKit', 'StoreKit', 'Testing',
]);

/**
 * `open Lwt`, `module M = Yojson.Basic`, and `Yojson.Basic.from_string`.
 *
 * An opam package's library module is conventionally its name with the first
 * letter capitalised (`lwt` -> `Lwt`), and a sub-library `pkg.sub` becomes
 * `Pkg_sub`. That convention is what the localizer's key generation relies on,
 * so what has to be recorded here is simply the top-level module of every
 * qualified reference.
 */
function extractOcamlImports(content: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const seen = new Set<string>();
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const push = (module: string, synthetic = false): void => {
      if (OCAML_STDLIB.has(module) || seen.has(module)) return;
      seen.add(module);
      out.push({
        specifier: module,
        packageName: module,
        bindings: [module],
        line: i + 1,
        ...(synthetic ? { synthetic: true } : {}),
      });
    };

    const opened = /^\s*open\s+([A-Z][\w']*)/.exec(line);
    if (opened?.[1]) {
      push(opened[1]);
      continue;
    }

    const aliased = /^\s*module\s+[A-Z][\w']*\s*=\s*([A-Z][\w']*)/.exec(line);
    if (aliased?.[1]) {
      push(aliased[1]);
      continue;
    }

    for (const match of line.matchAll(/\b([A-Z][\w']*)\.[a-z_]/g)) push(match[1]!, true);
  }

  return out;
}

const OCAML_STDLIB = new Set([
  'Stdlib', 'List', 'Array', 'String', 'Bytes', 'Char', 'Int', 'Int32', 'Int64',
  'Float', 'Bool', 'Option', 'Result', 'Hashtbl', 'Map', 'Set', 'Buffer',
  'Printf', 'Format', 'Sys', 'Unix', 'Filename', 'Sort', 'Queue', 'Stack',
  'Lazy', 'Seq', 'Fun', 'Either', 'Printexc', 'Random', 'Digest', 'Obj',
]);

/** The names a Dart `import ... show/as/hide` clause leaves in scope. */
function dartBindings(clauses: string): string[] {
  const trimmed = clauses.trim();
  if (!trimmed) return ['*'];

  const names: string[] = [];
  const shown = /\bshow\s+([\w\s,]+)/.exec(trimmed);
  if (shown?.[1]) names.push(...shown[1].split(',').map((n) => n.trim()).filter(Boolean));

  const prefixed = /\bas\s+(\w+)/.exec(trimmed);
  if (prefixed?.[1]) names.push(prefixed[1]);

  // `hide` alone still leaves the rest of the library visible.
  if (names.length === 0) names.push('*');
  return [...new Set(names)];
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#');
}

/** `@scope/pkg/sub/path` -> `@scope/pkg`; `pkg/sub` -> `pkg`. */
export function packageNameFromSpecifier(specifier: string): string {
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0] ?? specifier;
}

/* ---------------- code units ---------------- */

function extractUnits(file: SourceFile): CodeUnit[] {
  if (file.language === 'typescript' || file.language === 'javascript') {
    return extractJsUnits(file.content, file.path);
  }
  return extractUnitsByPattern(file.content, file.language);
}

/**
 * TypeScript/JavaScript units via the compiler's parser.
 *
 * A real parser matters here because the enclosing-unit lookup is what turns a
 * bare line number into "the `refreshToken` method of `AuthClient`" — which is
 * the difference between a report a reviewer can skim and one they must open
 * every file to understand.
 */
function extractJsUnits(content: string, path: string): CodeUnit[] {
  const units: CodeUnit[] = [];
  const lines = content.split('\n');
  const depths = braceDepthsByLine(lines);

  const push = (name: string, kind: CodeUnit['kind'], startLine: number, endLine: number, signature: string, exported: boolean): void => {
    units.push({
      name,
      kind,
      startLine,
      endLine,
      summary: collapse(signature),
      exported,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    if (depths[i] !== 0) continue;

    const line = lines[i]!;
    const trimmed = line.trim();
    const exported = isExportLine(trimmed);

    const fn = /^(?:export\s+)?(?:async\s+)?function\s+([\w$]+)\s*\(([^)]*)\)\s*([^{};]*)/.exec(trimmed);
    if (fn) {
      const end = blockEndLine(lines, i);
      push(fn[1]!, 'function', i + 1, end + 1, `${fn[1]}(${fn[2] ?? ''})${fn[3] ?? ''}`, exported);
      i = Math.max(i, end);
      continue;
    }

    const cls = /^(?:export\s+)?(?:abstract\s+)?class\s+([\w$]+)/.exec(trimmed);
    if (cls) {
      const end = blockEndLine(lines, i);
      const className = cls[1]!;
      push(className, 'class', i + 1, end + 1, `class ${className}`, exported);
      collectClassMethods(lines, i + 1, end, className, push);
      i = Math.max(i, end);
      continue;
    }

    const iface = /^(?:export\s+)?interface\s+([\w$]+)/.exec(trimmed);
    if (iface) {
      push(iface[1]!, 'interface', i + 1, blockEndLine(lines, i) + 1, `interface ${iface[1]}`, exported);
      continue;
    }

    const typeAlias = /^(?:export\s+)?type\s+([\w$]+)/.exec(trimmed);
    if (typeAlias) {
      push(typeAlias[1]!, 'type', i + 1, declarationEndLine(lines, i) + 1, `type ${typeAlias[1]}`, exported);
      continue;
    }

    const variable = /^(?:export\s+)?(?:const|let|var)\s+([\w$]+)/.exec(trimmed);
    if (variable) {
      const initializer = line.slice(line.indexOf(variable[1]!) + variable[1]!.length);
      const isFunctionLike = /^\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|^\s*=\s*(?:async\s*)?function\b/.test(initializer);
      push(
        variable[1]!,
        isFunctionLike ? 'function' : 'variable',
        i + 1,
        declarationEndLine(lines, i) + 1,
        `${isFunctionLike ? 'const fn' : 'const'} ${variable[1]}`,
        exported,
      );
      continue;
    }

    const mod = /^(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([\w$]+)/.exec(trimmed);
    if (mod) {
      push(mod[1]!, 'module', i + 1, blockEndLine(lines, i) + 1, `module ${mod[1]}`, exported);
    }
  }

  return units;
}

function collectClassMethods(
  lines: readonly string[],
  start: number,
  end: number,
  className: string,
  push: (name: string, kind: CodeUnit['kind'], startLine: number, endLine: number, signature: string, exported: boolean) => void,
): void {
  let depth = 0;
  for (let i = start; i < end; i++) {
    const trimmed = lines[i]!.trim();
    if (depth === 0) {
      const method = /^(?:public\s+|protected\s+|private\s+|static\s+|async\s+|override\s+|readonly\s+)*([\w$]+)\s*\(([^)]*)\)\s*([^{};]*)/.exec(trimmed);
      if (method && method[1] !== 'constructor') {
        const methodEnd = blockEndLine(lines, i);
        push(
          `${className}.${method[1]!}`,
          'method',
          i + 1,
          Math.min(methodEnd, end) + 1,
          `${method[1]}(${method[2] ?? ''})${method[3] ?? ''}`,
          isExportLine(trimmed),
        );
      }
    }
    depth += braceDelta(lines[i]!);
  }
}

function lineStartOffsets(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineOfOffset(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid]! <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return high + 1;
}

function braceDepthsByLine(lines: readonly string[]): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const line of lines) {
    depths.push(depth);
    depth += braceDelta(line);
    if (depth < 0) depth = 0;
  }
  return depths;
}

function braceDelta(line: string): number {
  let delta = 0;
  for (const char of line) {
    if (char === '{') delta += 1;
    else if (char === '}') delta -= 1;
  }
  return delta;
}

function blockEndLine(lines: readonly string[], start: number): number {
  let seenOpen = false;
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const char of lines[i]!) {
      if (char === '{') {
        seenOpen = true;
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (seenOpen && depth <= 0) return i;
      }
    }
    if (!seenOpen && lines[i]!.includes(';')) return i;
  }
  return start;
}

function declarationEndLine(lines: readonly string[], start: number): number {
  for (let i = start; i < lines.length; i++) {
    if (lines[i]!.includes(';') || lines[i]!.includes('{')) return blockEndLine(lines, i);
  }
  return start;
}

function isExportLine(trimmed: string): boolean {
  return /^(?:declare\s+)?export\b|^export\s+/.test(trimmed);
}

/**
 * Pattern-based unit extraction for non-JS languages.
 *
 * Trading a full parser per language for a declaration-line matcher is the
 * right call here: the index only needs unit *boundaries* good enough to
 * attribute a line to a symbol, and end-of-unit is derived from indentation or
 * brace depth. Where it is wrong, the impact site still carries an exact file
 * and line — the enclosing symbol is a convenience, not the finding.
 */
function extractUnitsByPattern(content: string, language: Language): CodeUnit[] {
  const patterns = DECLARATION_PATTERNS[language];
  if (!patterns) return [];

  const lines = content.split('\n');
  const starts: { name: string; kind: CodeUnit['kind']; line: number; summary: string; indent: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    // `#` opens a comment in Python and Ruby and a directive in C, and the one
    // directive that declares something is a function-like macro — which is a
    // real part of a C library's surface and the only unit in some headers.
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('#') && !/^#\s*define\s+\w+\s*\(/.test(line)) continue;

    for (const { pattern, kind } of patterns) {
      const match = pattern.exec(line);
      if (!match?.[1]) continue;
      starts.push({
        name: match[1],
        kind,
        line: i + 1,
        summary: collapse(line.replace(/[{:]\s*$/, '').replace(/\s+$/, '')),
        indent: raw.length - raw.trimStart().length,
      });
      break;
    }
  }

  // A unit ends where the next declaration at the same or shallower indent
  // begins — a good approximation in both brace and indentation languages.
  return starts.map((start, index) => {
    const next = starts.slice(index + 1).find((s) => s.indent <= start.indent);
    return {
      name: start.name,
      kind: start.kind,
      startLine: start.line,
      endLine: next ? next.line - 1 : lines.length,
      summary: start.summary,
      exported: true,
    };
  });
}

const DECLARATION_PATTERNS: Partial<
  Record<Language, { pattern: RegExp; kind: CodeUnit['kind'] }[]>
> = {
  python: [
    { pattern: /^(?:async\s+)?def\s+(\w+)\s*\(/, kind: 'function' },
    { pattern: /^class\s+(\w+)\s*[(:]/, kind: 'class' },
  ],
  go: [
    { pattern: /^func\s+(?:\([^)]*\)\s*)?(\w+)\s*[[(]/, kind: 'function' },
    { pattern: /^type\s+(\w+)\s+(?:struct|interface)\s*\{/, kind: 'type' },
  ],
  rust: [
    { pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, kind: 'function' },
    { pattern: /^(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/, kind: 'class' },
    { pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:enum|trait)\s+(\w+)/, kind: 'type' },
    { pattern: /^impl(?:<[^>]*>)?\s+(?:\w+\s+for\s+)?(\w+)/, kind: 'class' },
  ],
  java: [
    { pattern: /^(?:public|private|protected|abstract|final|static|\s)*(?:class|interface|enum|record)\s+(\w+)/, kind: 'class' },
    { pattern: /^(?:public|private|protected|static|final|synchronized|abstract|\s)+[\w<>[\],.?\s]+\s+(\w+)\s*\(/, kind: 'method' },
  ],
  ruby: [
    { pattern: /^def\s+(?:self\.)?(\w+[?!=]?)/, kind: 'method' },
    { pattern: /^(?:class|module)\s+([\w:]+)/, kind: 'class' },
  ],
  dotnet: [
    { pattern: /^(?:public|private|protected|internal|sealed|abstract|static|partial|\s)*(?:class|interface|struct|record|enum)\s+(\w+)/, kind: 'class' },
    { pattern: /^(?:public|private|protected|internal|static|virtual|override|async|sealed|\s)+[\w<>[\],.?\s]+\s+(\w+)\s*\(/, kind: 'method' },
  ],
  /**
   * These six were parsed for their imports before they were parsed for their
   * declarations, and the gap had a cost. A file with no units has no
   * enclosing symbol to name in the report, and — since a name a file declares
   * itself cannot be the dependency's — no way to rule out a match. Phoenix's
   * `Scope.push` was reported as a use of Plug's `push` for exactly that
   * reason: `scope.ex` defines `def push(module, path)` two lines above the
   * match, and Drift could not see it.
   */
  php: [
    { pattern: /^(?:abstract\s+|final\s+|readonly\s+)*(?:class|interface|trait|enum)\s+(\w+)/, kind: 'class' },
    { pattern: /^(?:public\s+|private\s+|protected\s+|static\s+|abstract\s+|final\s+)*function\s+&?(\w+)\s*\(/, kind: 'function' },
  ],
  elixir: [
    { pattern: /^\s*defmodule\s+([A-Z][\w.]*)/, kind: 'module' },
    { pattern: /^\s*(?:def|defp|defmacro|defmacrop|defguard|defdelegate)\s+([a-z_]\w*[!?]?)/, kind: 'function' },
    { pattern: /^\s*(?:defstruct|defexception|defprotocol|defimpl)\s+([A-Z][\w.]*)?/, kind: 'type' },
  ],
  erlang: [
    { pattern: /^([a-z]\w*)\s*\(.*\)\s*(?:when\b.*)?->/, kind: 'function' },
    { pattern: /^-record\(\s*(\w+)/, kind: 'type' },
  ],
  swift: [
    { pattern: /^(?:public\s+|internal\s+|private\s+|fileprivate\s+|open\s+|final\s+|@\w+\s+)*(?:class|struct|enum|protocol|actor|extension)\s+(\w+)/, kind: 'class' },
    { pattern: /^(?:public\s+|internal\s+|private\s+|fileprivate\s+|open\s+|static\s+|final\s+|override\s+|mutating\s+|@\w+\s+)*func\s+(\w+)/, kind: 'function' },
  ],
  dart: [
    { pattern: /^(?:abstract\s+|base\s+|final\s+|sealed\s+|interface\s+)*(?:class|mixin|enum|extension)\s+(\w+)/, kind: 'class' },
    { pattern: /^typedef\s+(\w+)/, kind: 'type' },
  ],
  ocaml: [
    { pattern: /^let\s+(?:rec\s+)?([a-z_]\w*)/, kind: 'function' },
    { pattern: /^(?:module|module\s+type)\s+([A-Z]\w*)/, kind: 'module' },
    { pattern: /^type\s+(?:'\w+\s+)?([a-z_]\w*)/, kind: 'type' },
  ],
  // Aggregates first, then functions. Order is what keeps `struct Foo {` from
  // being read as a function by the return-type-then-name pattern below it,
  // since `extractUnitsByPattern` takes the first rule that matches a line.
  c: C_DECLARATIONS(),
  cpp: [
    { pattern: /^(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+(?:\w+_API\s+|\w+_EXPORT\s+)?(\w+)\s*(?::|\{|$)/, kind: 'class' },
    { pattern: /^namespace\s+(\w+)/, kind: 'module' },
    ...C_DECLARATIONS(),
  ],
};

/**
 * The declarations C and C++ share.
 *
 * The function rule is the hard one, because C has no keyword introducing a
 * function — a definition is a type, a name, and a parameter list, which is
 * also the shape of a variable declaration with an initialiser call. Requiring
 * the line to end in `{` or `;` after the closing paren is what separates
 * `int read(int fd)` from `int n = read(fd);`, and requiring at least one
 * leading type token is what stops a bare call at file scope matching.
 *
 * Built as a function rather than a shared constant because the patterns carry
 * no `g` flag but the array is spread into two languages, and two languages
 * sharing one mutable array is the kind of thing that stays correct only until
 * someone adds a flag.
 */
function C_DECLARATIONS(): { pattern: RegExp; kind: CodeUnit['kind'] }[] {
  return [
    { pattern: /^typedef\s+(?:struct|union|enum)?\s*[\w\s*]*?(\w+)\s*;/, kind: 'type' },
    { pattern: /^(?:typedef\s+)?(?:struct|union|enum)\s+(\w+)\s*\{?\s*$/, kind: 'class' },
    {
      // The leading exclusion is load-bearing rather than tidy. Without it
      // `return deflateInit2(a, b);` parses as a declaration of a function
      // called `deflateInit2` — a return type of `return` and an argument list
      // — so a C file was recorded as *defining* every library function it
      // called on a one-line return. That mislabelled the enclosing symbol in
      // the report and, once local declarations began shadowing a dependency's
      // symbols, silently suppressed the findings at those exact call sites.
      pattern:
        /^(?!(?:return|if|while|for|switch|case|else|do|sizeof|typeof|delete|throw|catch|assert)\b)(?:(?:static|extern|inline|const|constexpr|virtual|explicit|friend|unsigned|signed|struct|enum|class|\w+_API|\w+_EXPORT)\s+)*[\w:<>,\s]*?[\w>]\s*[*&\s]\s*(\w+)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?[{;]?\s*$/,
      kind: 'function',
    },
    { pattern: /^#\s*define\s+(\w+)\s*\(/, kind: 'function' },
  ];
}

/* ---------------- summaries ---------------- */

function summarizeFile(
  file: SourceFile,
  units: readonly CodeUnit[],
  imports: readonly ImportRecord[],
): string {
  const exported = units.filter((u) => u.exported).map((u) => u.name);
  const shown = exported.slice(0, 8);
  const externals = [...new Set(imports.map((i) => i.packageName))].slice(0, 6);

  const parts = [`${file.path} (${file.language}, ${file.lineCount} lines)`];
  if (shown.length) {
    parts.push(
      `defines ${shown.join(', ')}${exported.length > shown.length ? `, +${exported.length - shown.length} more` : ''}`,
    );
  }
  if (externals.length) parts.push(`imports ${externals.join(', ')}`);

  return parts.join(' — ');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export { languageOf };
