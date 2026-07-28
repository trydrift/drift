import ts from 'typescript';
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
  const source = ts.createSourceFile('f.ts', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const lineOf = (pos: number) => source.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (!isRelative(specifier)) {
        out.push({
          specifier,
          packageName: packageNameFromSpecifier(specifier),
          bindings: bindingsOfImportClause(node.importClause),
          line: lineOf(node.getStart(source)),
        });
      }
    }

    // `require('x')` and dynamic `import('x')`.
    if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const arg = node.arguments[0];
      if ((isRequire || isDynamicImport) && arg && ts.isStringLiteral(arg) && !isRelative(arg.text)) {
        out.push({
          specifier: arg.text,
          packageName: packageNameFromSpecifier(arg.text),
          bindings: bindingsOfRequire(node),
          line: lineOf(node.getStart(source)),
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return out;
}

function bindingsOfImportClause(clause: ts.ImportClause | undefined): string[] {
  if (!clause) return [];
  const names: string[] = [];

  if (clause.name) names.push(clause.name.text);

  const bindings = clause.namedBindings;
  if (bindings) {
    if (ts.isNamespaceImport(bindings)) {
      names.push('*', bindings.name.text);
    } else {
      for (const element of bindings.elements) {
        // `import { a as b }` binds `b` locally but concerns upstream `a`.
        names.push(element.name.text);
        if (element.propertyName) names.push(element.propertyName.text);
      }
    }
  }

  return names;
}

/** Recover destructured names from `const { a, b } = require('x')`. */
function bindingsOfRequire(call: ts.CallExpression): string[] {
  const declaration = findAncestor(call, ts.isVariableDeclaration);
  if (!declaration) return [];

  if (ts.isIdentifier(declaration.name)) return [declaration.name.text];

  if (ts.isObjectBindingPattern(declaration.name)) {
    return declaration.name.elements.flatMap((element) => {
      const names: string[] = [];
      if (ts.isIdentifier(element.name)) names.push(element.name.text);
      if (element.propertyName && ts.isIdentifier(element.propertyName)) {
        names.push(element.propertyName.text);
      }
      return names;
    });
  }

  return [];
}

function findAncestor<T extends ts.Node>(
  node: ts.Node,
  predicate: (n: ts.Node) => n is T,
): T | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return undefined;
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
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const units: CodeUnit[] = [];

  const lineOf = (pos: number) => source.getLineAndCharacterOfPosition(pos).line + 1;

  const push = (
    name: string,
    kind: CodeUnit['kind'],
    node: ts.Node,
    signature: string,
    exported: boolean,
  ): void => {
    units.push({
      name,
      kind,
      startLine: lineOf(node.getStart(source)),
      endLine: lineOf(node.getEnd()),
      summary: collapse(signature),
      exported,
    });
  };

  const visit = (node: ts.Node, className?: string): void => {
    const exported = hasExportModifier(node);

    if (ts.isFunctionDeclaration(node) && node.name) {
      push(node.name.text, 'function', node, signatureText(node, source), exported);
    } else if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      push(name, 'class', node, `class ${name}`, exported);
      for (const member of node.members) visit(member, name);
      return;
    } else if (ts.isInterfaceDeclaration(node)) {
      push(node.name.text, 'interface', node, `interface ${node.name.text}`, exported);
    } else if (ts.isTypeAliasDeclaration(node)) {
      push(node.name.text, 'type', node, `type ${node.name.text}`, exported);
    } else if (ts.isMethodDeclaration(node) && node.name) {
      const name = node.name.getText(source);
      push(
        className ? `${className}.${name}` : name,
        'method',
        node,
        signatureText(node, source),
        exported,
      );
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        // An arrow function assigned to a const is a function in every sense
        // that matters for this index.
        const isFunctionLike =
          declaration.initializer !== undefined &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer));
        push(
          declaration.name.text,
          isFunctionLike ? 'function' : 'variable',
          node,
          `${isFunctionLike ? 'const fn' : 'const'} ${declaration.name.text}`,
          exported,
        );
      }
    }

    ts.forEachChild(node, (child) => visit(child, className));
  };

  source.statements.forEach((statement) => visit(statement));
  return units;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function signatureText(
  node: ts.FunctionDeclaration | ts.MethodDeclaration,
  source: ts.SourceFile,
): string {
  const name = node.name?.getText(source) ?? '(anonymous)';
  const params = node.parameters.map((p) => p.getText(source)).join(', ');
  const returnType = node.type ? `: ${node.type.getText(source)}` : '';
  return `${name}(${params})${returnType}`;
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
