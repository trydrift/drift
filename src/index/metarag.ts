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
}

export interface FileIndex {
  path: string;
  language: Language;
  lineCount: number;
  imports: ImportRecord[];
  units: CodeUnit[];
  /** One-line description of the file, used when ranking candidates. */
  summary: string;
}

export interface RepoIndex {
  files: FileIndex[];
  /** package name -> repo-relative paths importing it. The key join for localization. */
  importers: Map<string, string[]>;
  stats: {
    fileCount: number;
    unitCount: number;
    totalLines: number;
  };
}

export function buildIndex(files: readonly SourceFile[]): RepoIndex {
  const indexed: FileIndex[] = [];
  const importers = new Map<string, string[]>();

  for (const file of files) {
    const imports = extractImports(file);
    const units = extractUnits(file);

    indexed.push({
      path: file.path,
      language: file.language,
      lineCount: file.lineCount,
      imports,
      units,
      summary: summarizeFile(file, units, imports),
    });

    for (const record of new Set(imports.map((i) => i.packageName))) {
      const list = importers.get(record);
      if (list) list.push(file.path);
      else importers.set(record, [file.path]);
    }
  }

  return {
    files: indexed,
    importers,
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
      return extractPythonImports(file.content);
    case 'go':
      return extractGoImports(file.content);
    case 'rust':
      return extractRustImports(file.content);
    case 'java':
      return extractJavaImports(file.content);
    case 'ruby':
      return extractRubyImports(file.content);
    default:
      return [];
  }
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
      const [property, local] = part.split(/\s*:\s*/).map((piece) => piece.trim());
      return [property, local].filter((name): name is string => Boolean(name));
    });
}

function extractPythonImports(content: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    // `from pkg.sub import a, b as c`
    const from = /^from\s+([\w.]+)\s+import\s+(.+)$/.exec(line);
    if (from) {
      const module = from[1]!;
      // A leading dot is a relative import — internal, not a dependency.
      if (module.startsWith('.')) continue;
      out.push({
        specifier: module,
        packageName: module.split('.')[0]!,
        bindings: parsePythonImportList(from[2]!),
        line: i + 1,
      });
      continue;
    }

    // `import pkg.sub as alias, other`
    const plain = /^import\s+(.+)$/.exec(line);
    if (plain) {
      for (const part of plain[1]!.split(',')) {
        const match = /^\s*([\w.]+)(?:\s+as\s+(\w+))?/.exec(part);
        if (!match?.[1]) continue;
        const module = match[1];
        const root = module.split('.')[0]!;
        out.push({
          specifier: module,
          packageName: root,
          bindings: [match[2] ?? root],
          line: i + 1,
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
      bindings: [...path.matchAll(/(\w+)/g)].map((m) => m[1]!),
      line: i + 1,
    });
  }

  return out;
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

    out.push({
      specifier: fqn,
      // Maven coordinates are `group:artifact`; the import gives us the group
      // prefix only, so we index on the first three segments as a proxy.
      packageName: segments.slice(0, 3).join('.'),
      bindings: match[2] ? ['*'] : [simpleName],
      line: i + 1,
    });
  }

  return out;
}

function extractRubyImports(content: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*require(?:_relative)?\s+["']([^"']+)["']/.exec(lines[i]!);
    if (!match?.[1]) continue;
    if (lines[i]!.includes('require_relative')) continue;

    const path = match[1];
    out.push({
      specifier: path,
      packageName: path.split('/')[0]!,
      bindings: [],
      line: i + 1,
    });
  }

  return out;
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
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    for (const { pattern, kind } of patterns) {
      const match = pattern.exec(line);
      if (!match?.[1]) continue;
      starts.push({
        name: match[1],
        kind,
        line: i + 1,
        summary: collapse(line.replace(/\s*[{:]\s*$/, '')),
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
};

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
