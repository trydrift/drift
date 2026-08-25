import type { SurfaceApi, SurfaceEntry, SurfaceKind } from '../type-surface.js';

/**
 * The public API of a C or C++ library, read from its headers.
 *
 * This is the part of the C surface diff worth arguing about, so the reasoning
 * is here rather than spread through the code.
 *
 * **Why headers are enough.** In every other ecosystem Drift has to reconstruct
 * a public API from something that is not it — type stubs, rustdoc JSON,
 * classfiles. In C and C++ the header *is* the interface. It is the file the
 * consumer includes, the declarations it compiles against, and the thing the
 * library author edits when they change the API. There is nothing closer to
 * read.
 *
 * **Why it is still not a compiler.** Three things a preprocessor knows that
 * this does not:
 *
 *   - `#ifdef`. A declaration guarded by a platform or feature macro exists in
 *     some builds and not others. Both branches are read, because a symbol that
 *     exists on one platform is not a removal, and pretending to pick a
 *     configuration would mean picking the wrong one for somebody.
 *   - Macro-generated declarations. A library that declares its API through
 *     `DECLARE_HANDLE(x)` expansions is invisible here, and reported as having
 *     no surface rather than as having none left.
 *   - Included headers. Only files reachable under the library's own include
 *     roots are read. A public API re-exported from a bundled dependency is
 *     attributed to that dependency, not to the library — the same rule the
 *     TypeScript provider applies with `via`.
 *
 * That gap is why the weight is 0.9 rather than 1.0: it is a true reading of
 * what shipped, not a complete one.
 *
 * **What counts as public.** Everything under an include root that the library
 * ships — `include/`, `src/` for header-only libraries, the archive root for
 * Arduino, where the convention is a single header beside the sources. A path
 * containing `detail`, `internal`, `impl`, `private`, or `test` is excluded,
 * because those directories are the C++ ecosystem's version of an underscore
 * prefix and treating a change in one as a breaking change is how a report
 * fills with findings no consumer can be affected by.
 */

/** Directory names whose contents a consumer is not expected to include. */
const PRIVATE_SEGMENTS =
  /(^|\/)(detail|details|internal|impl|private|priv|test|tests|examples?|demos?|sketch(es)?|dev|sandbox|tools?|scripts?|fuzz|contrib|bench|benchmarks?|docs?|third[_-]?party|extern(al)?|deps?)(\/|$)/i;

/**
 * Header *files* that are implementation rather than interface.
 *
 * `-inl.h` is the near-universal convention for a header holding definitions
 * the public header includes at the bottom, and `guts` is zlib's spelling of
 * the same idea. Both are included transitively and neither is written by a
 * consumer, so a change in one cannot break code that does not name it.
 */
const PRIVATE_FILENAMES = /(^|\/)(_|.*[-_](inl|impl|internal|private|guts)\.)|(^|\/)[\w-]*guts\.h$/i;

const HEADER_EXTENSION = /\.(h|hpp|hh|hxx|h\+\+|inl|tpp)$/i;

const VERSION_MACRO =
  /(^|_)(VERSION|VERNUM|VER)(_?(MAJOR|MINOR|PATCH|REVISION|SUBREVISION|BUILD|STRING|NUM|TEXT|CODE))?$/i;

/** Where a library's public headers live, most conventional first. */
const INCLUDE_ROOTS = ['include/', 'inc/', 'src/', ''];

export interface HeaderFile {
  /** Path relative to the archive root. */
  path: string;
  content: string;
}

/**
 * Public headers of an unpacked archive, with the release's own top directory
 * stripped.
 *
 * Every source tarball and every Arduino zip wraps its contents in one
 * directory named after the release (`zlib-1.3.1/`, `ArduinoJson-7.0.4/`),
 * which is version text inside a path — so a header at `zlib-1.3.1/zlib.h`
 * and the same header at `zlib-1.3.2/zlib.h` would compare as two different
 * symbols and every single one would report as removed-and-added. Stripping it
 * is not tidiness; without it the diff is pure noise.
 */
export function publicHeaders(paths: readonly string[]): { path: string; original: string }[] {
  const prefix = commonPrefix(paths);

  return paths
    .map((original) => ({ path: original.slice(prefix.length), original }))
    .filter((file) => HEADER_EXTENSION.test(file.path))
    .filter((file) => !PRIVATE_SEGMENTS.test(file.path))
    .filter((file) => !PRIVATE_FILENAMES.test(file.path))
    .filter((file) => INCLUDE_ROOTS.some((root) => file.path.startsWith(root)));
}

/*
 * A rule that was tried here and removed, because the next person to look at
 * an ArduinoJson diff will think of it too.
 *
 * `src/ArduinoJson.h` beside `src/ArduinoJson/` looks like an umbrella header
 * and its private implementation, and treating the directory as private cuts a
 * 6.20 → 6.21 comparison from two hundred findings to a handful. It is also
 * wrong: the umbrella header in a header-only library contains nothing but
 * `#include` lines, so the rule leaves *no declarations at all* and the
 * comparison reports `no-public-surface`.
 *
 * Between over-reporting that localization then filters against real usage,
 * and reporting nothing at all, the first is recoverable and the second is a
 * silent miss. So the noise stays, and the capability matrix says where it
 * comes from.
 */

/** The single leading directory every path shares, or `''` if they do not. */
function commonPrefix(paths: readonly string[]): string {
  const first = paths[0];
  if (!first) return '';
  const slash = first.indexOf('/');
  if (slash === -1) return '';

  const candidate = first.slice(0, slash + 1);
  return paths.every((path) => path.startsWith(candidate)) ? candidate : '';
}

/**
 * Parse a library's headers into the surface `diffSurfaces` compares.
 *
 * Keyed by symbol name alone rather than by header path. A library that moves
 * a declaration between headers has not removed it — the consumer who included
 * the umbrella header notices nothing — and keying by path would report every
 * such move as a removal plus an addition.
 */
export function parseHeaderSurface(files: readonly HeaderFile[]): SurfaceApi {
  const api: SurfaceApi = new Map();

  for (const file of files) {
    for (const entry of parseHeader(file.content)) {
      const existing = api.get(entry.name);
      // A declaration and its later definition are the same symbol. Keep
      // whichever carries more: the definition names the members.
      if (existing && existing.members.length >= entry.members.length) continue;
      api.set(entry.name, entry);
    }
  }

  return api;
}

/**
 * Read one header's declarations.
 *
 * The brace depth is tracked across every line, consumed or skipped, for one
 * reason: C++ libraries put their internals in `namespace detail` inside the
 * *public* header rather than in a private directory. fmt, Boost, Abseil and
 * most of the modern ecosystem work this way, and without this the diff of a
 * routine fmt release is a hundred findings about symbols no consumer has ever
 * been able to name.
 */
export function parseHeader(content: string): SurfaceEntry[] {
  const entries: SurfaceEntry[] = [];
  const source = stripComments(content);
  const lines = source.split('\n');

  let depth = 0;
  const namespaceScopes: { path: string[]; depth: number }[] = [];
  /** Brace depth at which a private namespace opened, or `null` outside one. */
  let privateAt: number | null = null;
  /**
   * Inside a macro-delimited private namespace.
   *
   * Tracked separately from `privateAt` because these macros expand to a brace
   * this parser never sees — `FMT_BEGIN_DETAIL_NAMESPACE` *is* `namespace
   * detail {` — so depth bookkeeping cannot close them. The matching END macro
   * does.
   *
   * This is not an edge case. fmt, ArduinoJson, Abseil and most large C++
   * libraries mark their internals exactly this way, and without it a routine
   * patch release of ArduinoJson reports seventy removals of symbols no
   * consumer was ever able to name.
   */
  let macroPrivate = false;

  const syncNamespaces = (): void => {
    while (namespaceScopes.length > 0 && depth <= namespaceScopes.at(-1)!.depth) namespaceScopes.pop();
  };

  /** Advance the depth over every line a declaration consumed. */
  const advance = (from: number, to: number): void => {
    for (let i = from; i <= to && i < lines.length; i++) depth += braceDelta(lines[i]!);
    if (privateAt !== null && depth <= privateAt) privateAt = null;
    syncNamespaces();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (PRIVATE_NAMESPACE_MACRO.test(trimmed)) {
      macroPrivate = true;
      advance(i, i);
      continue;
    }
    if (PUBLIC_NAMESPACE_MACRO.test(trimmed)) {
      macroPrivate = false;
      advance(i, i);
      continue;
    }

    const namespace = /^(?:inline\s+)?namespace\s+([\w:]+)?/.exec(trimmed);
    if (namespace) {
      if (namespace[1] && PRIVATE_NAMESPACE.test(namespace[1]) && privateAt === null) {
        privateAt = depth;
      } else if (namespace[1]) {
        namespaceScopes.push({ path: namespace[1].split('::').filter(Boolean), depth });
      }
      advance(i, i);
      continue;
    }

    if (privateAt !== null || macroPrivate) {
      advance(i, i);
      continue;
    }

    const macro = parseMacro(trimmed);
    if (macro) {
      entries.push(macro);
      advance(i, i);
      continue;
    }

    const aggregate = parseAggregate(lines, i, namespaceScopes.flatMap((scope) => scope.path));
    if (aggregate) {
      entries.push(aggregate.entry);
      advance(i, aggregate.endLine);
      i = aggregate.endLine;
      continue;
    }

    // A declaration can wrap across lines, and a function's parameter list is
    // exactly what a signature diff is about — so the statement is joined back
    // together before it is read.
    const statement = joinStatement(lines, i);
    if (!statement) {
      advance(i, i);
      continue;
    }

    const declaration = parseDeclaration(statement.text, namespaceScopes.flatMap((scope) => scope.path));
    if (declaration) entries.push(declaration);
    advance(i, statement.endLine);
    i = statement.endLine;
  }

  return entries;
}

/** Namespaces whose contents are documented as not being API. */
const PRIVATE_NAMESPACE = /^(detail|details|internal|impl|private|_\w+)$/i;

/** `FMT_BEGIN_DETAIL_NAMESPACE`, `ARDUINOJSON_BEGIN_PRIVATE_NAMESPACE`, … */
const PRIVATE_NAMESPACE_MACRO = /^\w*BEGIN_(DETAIL|PRIVATE|INTERNAL|IMPL)_NAMESPACE\b/;

/**
 * Their closers, and the public openers that also end a private region.
 *
 * ArduinoJson does not write an END for its private namespace — it writes
 * `ARDUINOJSON_BEGIN_PUBLIC_NAMESPACE`, which closes one and opens the other —
 * so treating a public opener as a closer is what makes that library's
 * headers read correctly rather than being swallowed from the first private
 * marker to the end of the file.
 */
const PUBLIC_NAMESPACE_MACRO =
  /^\w*(END_(DETAIL|PRIVATE|INTERNAL|IMPL)_NAMESPACE|BEGIN_PUBLIC_NAMESPACE)\b/;

function braceDelta(line: string): number {
  let delta = 0;
  for (const ch of line) {
    if (ch === '{') delta++;
    else if (ch === '}') delta--;
  }
  return delta;
}

/**
 * `#define NAME` and `#define NAME(args)`.
 *
 * Object-like macros carry their replacement text as the signature, because a
 * constant changing value is the quietest breaking change in C: nothing fails
 * to compile, and `diffSurfaces` reports it as a changed signature rather than
 * as nothing at all. Include guards are excluded — every header has one, none
 * of them is API, and their names change with the path.
 */
function parseMacro(line: string): SurfaceEntry | null {
  const match = /^#\s*define\s+(\w+)\s*(\([^)]*\))?\s*(.*)$/.exec(line);
  if (!match) return null;

  const name = match[1]!;
  if (/^_+|_H(_|PP)?$|_INCLUDED$|_GUARD$/i.test(name)) return null;
  // A version macro's value changes on every single release and its change is
  // never the reason anything broke. Reporting it would put a guaranteed
  // finding at the top of every C upgrade, which is how a reader learns to
  // skim past the ones that matter.
  if (VERSION_MACRO.test(name)) return null;

  const params = match[2] ?? '';
  const body = match[3]?.trim() ?? '';

  return {
    name,
    kind: params ? 'function' : 'variable',
    signature: collapse(`#define ${name}${params}${body ? ` ${body}` : ''}`),
    members: [],
    requiredMembers: [],
  };
}

/**
 * `struct Foo { ... }`, `class Foo { ... }`, `enum Bar { ... }`, and their
 * `typedef`'d forms.
 *
 * The body is read for members, because a struct losing a field breaks every
 * consumer that touched it and is the single most common C breaking change
 * after a signature move. Nested braces are counted rather than matched on the
 * first `}`, which would end a struct at its first anonymous union.
 */
function parseAggregate(
  lines: readonly string[],
  start: number,
  namespacePath: readonly string[],
): { entry: SurfaceEntry; endLine: number } | null {
  const head = lines[start]!.trim();
  const match =
    /^(?:typedef\s+)?(?:template\s*<[^>]*>\s*)?(struct|class|union|enum)(?:\s+class|\s+struct)?\s+(?:\w+_(?:API|EXPORT)\s+)?(\w+)?\s*(?::[^{]*)?\s*\{/.exec(
      head,
    );
  if (!match) return null;

  const keyword = match[1]!;
  let depth = 0;
  let end = start;
  const body: string[] = [];

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    // The head line is excluded so that `depth` inside the body starts at
    // zero: the aggregate's own opening brace would otherwise put every one of
    // its members at depth 1, where `aggregateMembers` reads them as belonging
    // to a nested type and drops all of them.
    if (i > start) body.push(line);
    if (depth <= 0 && i >= start) {
      end = i;
      break;
    }
    end = i;
  }

  // An anonymous aggregate takes its name from the typedef that closes it —
  // `typedef struct { int x; } Point;` is `Point` to every consumer.
  const tail = lines[end]!;
  const trailing = /\}\s*(\w+)\s*;/.exec(tail);
  const name = match[2] ?? trailing?.[1];
  if (!name) return null;
  const qualifiedName = qualify(namespacePath, name);

  return {
    entry: {
      name: qualifiedName,
      kind: kindOfAggregate(keyword),
      signature: collapse(`${keyword} ${qualifiedName}`),
      members: aggregateMembers(body.join('\n'), keyword),
      requiredMembers: [],
    },
    endLine: end,
  };
}

function kindOfAggregate(keyword: string): SurfaceKind {
  if (keyword === 'enum') return 'enum';
  if (keyword === 'class') return 'class';
  return 'interface';
}

/**
 * Field and method names inside an aggregate body.
 *
 * Everything after a `private:` or `protected:` label is dropped: those members
 * are not reachable by a consumer, so their removal cannot break one, and a C++
 * class that reorganises its internals would otherwise produce a page of
 * findings that are all wrong.
 */
function aggregateMembers(body: string, keyword: string): string[] {
  if (keyword === 'enum') {
    return [
      ...new Set(
        body
          .replace(/\{|\}[^}]*$/g, '')
          .split(',')
          .map((part) => /^\s*(\w+)/.exec(part)?.[1])
          .filter((name): name is string => Boolean(name)),
      ),
    ];
  }

  const members: string[] = [];
  // C++'s default access differs by keyword: everything before the first
  // label is private in a `class` and public in a `struct`. Getting this
  // wrong is not cosmetic — it puts every private field of every class into
  // the compared surface, and a library tidying its internals then reports as
  // dozens of removed members no consumer could ever have touched.
  let visible = keyword !== 'class';
  let depth = 0;

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();

    const access = /^(public|private|protected)\s*:/.exec(line);
    if (access) {
      visible = access[1] === 'public';
      continue;
    }

    // Only the aggregate's own level: a nested type's fields belong to it.
    const before = depth;
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (before > 0 || !visible) continue;

    // `return foo(x);` has the shape of a method declaration and is not one.
    // Excluding the keywords is what stops a class with an inline body
    // contributing members called `return`, `if`, and `sizeof` — which is how
    // FastLED came to report seven hundred removed exports for a release that
    // had reorganised some inline code.
    const method = /(\w+)\s*\([^)]*\)\s*(?:const\s*)?(?:noexcept\s*)?[;{=]/.exec(line);
    if (method?.[1] && !RESERVED.has(method[1]) && !/^operator\b/.test(line)) {
      members.push(method[1]);
      continue;
    }
    if (method?.[1]) continue;

    const field = /^[\w:<>,\s*&[\]]+?(\w+)\s*(?:\[[^\]]*\]\s*)?(?:=\s*[^;]+)?;/.exec(line);
    // A declaration with no name — `uint8_t;`, or a `using` alias the regex
    // reached the end of — captures its own type. Excluding the primitives
    // stops a class contributing a member called `uint8_t`.
    if (field?.[1] && !RESERVED.has(field[1]) && !PRIMITIVE.test(field[1])) members.push(field[1]);
  }

  return [...new Set(members)];
}

/**
 * A function, typedef, or extern variable declaration.
 *
 * The signature keeps parameter *types* and drops parameter *names*, because
 * renaming a parameter is not a breaking change in C and reporting it as a
 * changed signature would fire on every tidy-up commit. What remains — arity,
 * types, return type, constness — is exactly the set that does break a caller.
 */
function parseDeclaration(statement: string, namespacePath: readonly string[] = []): SurfaceEntry | null {
  const text = statement.trim().replace(/\s+/g, ' ');
  if (!text || text.startsWith('#')) return null;

  const typedef = /^typedef\s+(.+?)\s*;$/.exec(text);
  if (typedef) {
    // `typedef int (*handler)(void)` — a function-pointer typedef, whose name
    // is inside the parens rather than at the end.
    const pointer = /\(\s*\*\s*(\w+)\s*\)/.exec(typedef[1]!);
    const name = pointer?.[1] ?? /(\w+)\s*(?:\[[^\]]*\])?$/.exec(typedef[1]!)?.[1];
    if (!name || RESERVED.has(name)) return null;
    return {
      name: qualify(namespacePath, name),
      kind: 'type',
      signature: collapse(text),
      members: [],
      requiredMembers: [],
    };
  }

  const fn =
    /^(?:(?:extern|static|inline|constexpr|virtual|explicit|friend|\w+_API|\w+_EXPORT|EXTERN_C|__declspec\([^)]*\))\s+)*((?:const\s+|unsigned\s+|signed\s+|struct\s+|enum\s+|class\s+)*[\w:]+(?:\s*<[^>]*>)?[\s*&]+)(\w+)\s*\(([^)]*)\)\s*(const)?\s*(?:noexcept)?\s*[;{]$/.exec(
      text,
    );
  if (fn) {
    const returnType = collapse(fn[1]!);
    const name = fn[2]!;
    if (RESERVED.has(name)) return null;
    return {
      name: qualify(namespacePath, name),
      kind: 'function',
      signature: `${returnType} ${name}(${parameterTypes(fn[3]!)})${fn[4] ? ' const' : ''}`,
      members: [],
      requiredMembers: [],
    };
  }

  const variable = /^extern\s+((?:const\s+)?[\w:]+[\s*&]+)(\w+)\s*(?:\[[^\]]*\])?\s*;$/.exec(text);
  if (variable) {
    const name = variable[2]!;
    if (RESERVED.has(name)) return null;
    return {
      name: qualify(namespacePath, name),
      kind: 'variable',
      signature: collapse(text.replace(/;$/, '')),
      members: [],
      requiredMembers: [],
    };
  }

  return null;
}

function qualify(namespacePath: readonly string[], name: string): string {
  return [...namespacePath, name].join('.');
}

/**
 * `int fd, const char *path` -> `int, const char *`.
 *
 * A name is dropped only where a type remains, so `void` and `...` survive and
 * a single-word parameter list (`foo(handle)`, K&R style) is left alone rather
 * than reduced to nothing.
 */
function parameterTypes(params: string): string {
  const trimmed = params.trim();
  if (!trimmed || trimmed === 'void') return trimmed;

  return splitParameters(trimmed)
    .map((param) => {
      const withoutDefault = param.split('=')[0]!.trim();
      const stripped = withoutDefault.replace(/\s*\[[^\]]*\]\s*$/, '');
      const tokens = stripped.split(/(?<=[\s*&])/);
      if (tokens.length < 2) return stripped;
      const withoutName = stripped.replace(/\b\w+\s*$/, '').trim();
      return withoutName || stripped;
    })
    .join(', ');
}

/** Split on commas that are not inside `<>` or `()`. */
function splitParameters(params: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of params) {
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    else if (ch === '>' || ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

/**
 * Join a statement that wraps across lines, up to its `;` or `{`.
 *
 * Capped at eight lines. A declaration longer than that is a macro table or a
 * formatted initialiser, not a signature, and following it to the end of the
 * file is how a parser turns one odd header into a minute of CPU time.
 */
function joinStatement(
  lines: readonly string[],
  start: number,
): { text: string; endLine: number } | null {
  let text = '';
  for (let i = start; i < lines.length && i < start + 8; i++) {
    const line = lines[i]!.trim();
    // A blank line or a directive ends the statement, whatever comes after.
    // Without this the join runs from `#pragma once` straight through to the
    // `class Foo {` four lines below, reports the whole run as one
    // unrecognisable statement, and skips past the class — which is how a
    // header full of types came to parse as a handful of loose methods.
    if (!line || line.startsWith('#')) return null;
    text = text ? `${text} ${line}` : line;
    if (line.endsWith(';') || line.endsWith('{')) return { text, endLine: i };
    if (line.endsWith('}')) return null;
  }
  return null;
}

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, '')
    // Line continuations, so a multi-line macro reads as the one line it is.
    .replace(/\\\n/g, ' ');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Type names that are never a member's own name. */
const PRIMITIVE = /^(u?int(8|16|32|64|max|ptr)?_t|size_t|ssize_t|ptrdiff_t|wchar_t|char\d*_t)$/;

/**
 * Keywords a name-shaped capture group can pick up when a declaration does not
 * match the shape it looked like.
 */
const RESERVED = new Set([
  'if',
  'else',
  'for',
  'while',
  'switch',
  'return',
  'sizeof',
  'typedef',
  'struct',
  'union',
  'enum',
  'class',
  'namespace',
  'template',
  'typename',
  'operator',
  'using',
  'const',
  'static',
  'extern',
  'inline',
  'void',
  'int',
  'char',
  'float',
  'double',
  'long',
  'short',
  'unsigned',
  'signed',
  'bool',
  'auto',
]);
