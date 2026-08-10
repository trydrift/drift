import type { BreakingChange, Confidence, DependencyChange, Ecosystem, ImpactSite } from '../types.js';
import type { Logger } from '../util/logger.js';
import { unitAtLine, type FileIndex, type RepoIndex } from '../index/metarag.js';
import { isRuntimeConfigPath, type SourceFile } from '../index/walk.js';
import { withinMember } from '../detect/workspace.js';

/**
 * Localization: where does this breaking change actually bite?
 *
 * The precision lever is the import graph. A file that never imports `express`
 * cannot be broken by an `express` change, no matter how many times the word
 * "Router" appears in it. Searching only importers is what keeps Drift from
 * producing the kind of noisy, mostly-wrong report that gets a tool switched
 * off after one run.
 *
 * Confidence is assigned per site, because the same breaking change can land
 * with very different certainty in different files:
 *
 *   high   — the file imports the dependency AND the matched symbol is one it
 *            actually bound from that import.
 *   medium — the file imports the dependency and the symbol appears in it.
 *   low    — the symbol appears but the import link could not be established
 *            (dynamic import, re-export barrel, or an ecosystem where the
 *            package name and module name differ).
 */

export interface LocalizeOptions {
  logger: Logger;
  /** Cap per breaking change, so one common word can't flood the plan. */
  maxSitesPerChange?: number;
  /**
   * Restrict impact sites to one workspace member's directory.
   *
   * A bump in `packages/api/package.json` is a fact about `packages/api`. A
   * sibling that happens to share the dependency declares its own version and
   * gets its own analysis; attributing api's bump to web's files was Drift's
   * oldest known wrong answer.
   *
   * The *index* stays repository-wide, so an import that crosses a package
   * boundary still resolves — only the sites are scoped.
   */
  member?: string;
}

export function localize(
  breakingChanges: readonly BreakingChange[],
  dependencyChanges: readonly DependencyChange[],
  index: RepoIndex,
  files: readonly SourceFile[],
  options: LocalizeOptions,
): ImpactSite[] {
  const { logger, maxSitesPerChange = 100, member } = options;

  const contentByPath = new Map(files.map((f) => [f.path, f.content]));
  const indexByPath = new Map(index.files.map((f) => [f.path, f]));
  // Keyed by name alone, but the *value* is every ecosystem seen for that
  // name — an npm package and a PyPI package sharing a name are two distinct
  // identities, and neither should silently overwrite the other the way a
  // `Map<name, ecosystem>` would.
  const ecosystemsByName = new Map<string, Ecosystem[]>();
  for (const c of dependencyChanges) {
    const list = ecosystemsByName.get(c.name);
    if (list) {
      if (!list.includes(c.ecosystem)) list.push(c.ecosystem);
    } else {
      ecosystemsByName.set(c.name, [c.ecosystem]);
    }
  }

  const sites: ImpactSite[] = [];

  for (const change of breakingChanges) {
    // A runtime requirement has no code symbol. Searching source for "Node.js"
    // matches comments and documentation, which is a pure false positive — the
    // fix lives in CI config, engine fields, and container images.
    if (change.kind === 'runtime-requirement') {
      sites.push(...inMember(localizeRuntimeRequirement(change, contentByPath), member));
      continue;
    }

    const { files: candidateFileList, names } = candidateFiles(
      change,
      index,
      ecosystemsByName.get(change.dependency) ?? [],
    );
    const candidates = candidateFileList.filter(
      (file) => member === undefined || withinMember(file.path, member),
    );

    if (candidates.length === 0) {
      logger.debug(`No importers found for ${change.dependency}; ${change.id} has no impact sites`);
      continue;
    }

    const found = searchFiles(change, candidates, contentByPath, indexByPath, maxSitesPerChange, names);
    sites.push(...found);

    if (found.length >= maxSitesPerChange) {
      logger.warn(
        `${change.dependency}: ${change.summary} matched at least ${maxSitesPerChange} locations; the plan lists the first ${maxSitesPerChange}.`,
      );
    }
  }

  return sites;
}

function inMember(sites: readonly ImpactSite[], member: string | undefined): ImpactSite[] {
  return member === undefined ? [...sites] : sites.filter((site) => withinMember(site.file, member));
}

/**
 * Locate a runtime-version requirement.
 *
 * Targets the places a runtime version is actually declared — CI workflows,
 * engine fields, version files, container images — and matches the declaration
 * line rather than the runtime's name. `.nvmrc` and friends contain nothing but
 * the version, so the whole file is the site.
 */
function localizeRuntimeRequirement(
  change: BreakingChange,
  contentByPath: Map<string, string>,
): ImpactSite[] {
  const runtime = (change.symbols[0] ?? 'node').toLowerCase().replace('.js', '');
  const declaration = DECLARATION_MATCHERS[runtime] ?? DECLARATION_MATCHERS.node!;

  const sites: ImpactSite[] = [];

  for (const [path, content] of contentByPath) {
    if (!isRuntimeConfigPath(path)) continue;

    const bare = /(^|\/)\.(nvmrc|node-version|ruby-version|python-version|tool-versions)$/.test(path);
    if (bare) {
      sites.push({
        breakingChangeId: change.id,
        file: path,
        line: 1,
        excerpt: content.trim().split('\n')[0]?.slice(0, 200) ?? '',
        matchedSymbol: change.symbols[0] ?? runtime,
        confidence: 'high',
      });
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!declaration.test(line)) continue;

      sites.push({
        breakingChangeId: change.id,
        file: path,
        line: i + 1,
        excerpt: line.trim().slice(0, 200),
        matchedSymbol: change.symbols[0] ?? runtime,
        confidence: 'high',
      });
    }
  }

  return sites;
}

/** Where each runtime's version is declared, per file convention. */
const DECLARATION_MATCHERS: Record<string, RegExp> = {
  node: /node[-_]?version\s*:|"node"\s*:|FROM\s+node:|engines/i,
  python: /python[-_]?version\s*:|requires-python|python_requires|FROM\s+python:/i,
  ruby: /ruby[-_]?version\s*:|^\s*ruby\s+["']|FROM\s+ruby:/i,
  go: /go[-_]?version\s*:|^go\s+\d|FROM\s+golang:/i,
  java: /java[-_]?version\s*:|<maven\.compiler|FROM\s+(?:openjdk|eclipse-temurin):/i,
  rust: /rust[-_]?version\s*:|channel\s*=|FROM\s+rust:/i,
};

/**
 * Files worth searching for a given breaking change.
 *
 * OpenAPI-derived changes are the exception to the import-graph rule: an HTTP
 * endpoint has no import edge, so those fall back to a whole-repo search. The
 * symbols there are URL paths, which are specific enough not to over-match.
 */
function candidateFiles(
  change: BreakingChange,
  index: RepoIndex,
  ecosystemsForName: readonly Ecosystem[],
): { files: FileIndex[]; names: string[] } {
  const isEndpointChange =
    change.kind === 'removed-endpoint' || change.kind === 'changed-endpoint';
  if (isEndpointChange) return { files: index.files, names: [] };

  const names =
    ecosystemsForName.length > 0
      ? [...new Set(ecosystemsForName.flatMap((eco) => importKeysFor(change.dependency, eco)))]
      : importKeysFor(change.dependency, undefined);
  const paths = new Set<string>();

  for (const name of names) {
    for (const path of index.importers.get(name) ?? []) paths.add(path);
  }

  // Prefix match catches Go module paths and Java package prefixes, where the
  // manifest coordinate and the import path share a root but are not equal.
  if (paths.size === 0) {
    for (const [key, importerPaths] of index.importers) {
      if (matchesImportName(key, names)) {
        for (const path of importerPaths) paths.add(path);
      }
    }
  }

  return { files: index.files.filter((f) => paths.has(f.path)), names };
}

/** Does an import's package name identify one of the given candidate names? */
function matchesImportName(packageName: string, names: readonly string[]): boolean {
  return names.some((name) => identifies(packageName, name) || identifies(name, packageName));
}

/**
 * Is `longer` the same identity as `shorter`, or a path beneath it?
 *
 * A bare `startsWith` is wrong in both directions that matter. `crypto` would
 * claim `crypto-js`, and `pytest` would claim `pytest-cov` — different packages
 * with different maintainers, whose only relationship is a shared prefix. The
 * prefix rule exists for Go module paths and Java package roots, where the
 * manifest coordinate really is an ancestor of the import path, so the next
 * character has to be the separator that makes it one.
 */
function identifies(longer: string, shorter: string): boolean {
  if (longer === shorter) return true;
  if (!longer.startsWith(shorter)) return false;
  const next = longer[shorter.length];
  return next === '/' || next === '.' || next === ':';
}

/**
 * Candidate module names for a package.
 *
 * Package name and import name diverge often enough to matter: `beautifulsoup4`
 * is imported as `bs4`, `pillow` as `PIL`. A wrong guess here means silently
 * finding nothing, so the aliases are explicit and the raw name is always kept
 * as a candidate.
 */
function importKeysFor(dependency: string, ecosystem: Ecosystem | undefined): string[] {
  const names = new Set<string>([dependency]);

  switch (ecosystem) {
    case 'pypi': {
      const normalized = dependency.toLowerCase().replace(/-/g, '_');
      names.add(normalized);
      const alias = PYPI_MODULE_ALIASES[dependency.toLowerCase()];
      if (alias) names.add(alias);
      break;
    }
    case 'maven': {
      // `group:artifact` -> the group is what appears in an import statement.
      const [group] = dependency.split(':');
      if (group) names.add(group);
      break;
    }
    case 'cargo':
      names.add(dependency.replace(/-/g, '_'));
      break;
    // C and C++: the join is against `includeRoot`, which lowercases and drops
    // the header extension, so these keys must be lowercased to meet it. Conan
    // and vcpkg names carry separators the include path usually does not
    // (`nlohmann_json` is included as `<nlohmann/json.hpp>`, `libpng` as
    // `<png.h>`), so each separator-stripped form is offered as a candidate
    // rather than one guess being made and the rest silently lost.
    case 'conan':
    case 'vcpkg':
    case 'arduino': {
      const lower = dependency.toLowerCase();
      names.add(lower);
      names.add(lower.replace(/[-_]/g, ''));
      names.add(lower.replace(/[-_]/g, '/'));
      const alias = C_INCLUDE_ALIASES[lower];
      if (alias) names.add(alias);
      // `libfoo` is included as `<foo.h>` about as often as `<libfoo.h>`.
      if (lower.startsWith('lib') && lower.length > 4) names.add(lower.slice(3));
      break;
    }
    default:
      break;
  }

  return [...names];
}

/**
 * Package name -> include root, where the rule above cannot get there.
 *
 * Short and explicit for the same reason `PYPI_MODULE_ALIASES` is: a wrong
 * guess here does not produce a wrong finding, it produces silence, which is
 * the failure mode nobody notices.
 */
const C_INCLUDE_ALIASES: Record<string, string> = {
  // Only the ones the rules above cannot reach. An entry that merely repeats
  // the lowercased name (`fmt` -> `fmt`) or that the `lib` prefix rule already
  // covers (`libpng` -> `png`) is noise pretending to be knowledge.
  nlohmann_json: 'nlohmann',
  'libjpeg-turbo': 'jpeglib',
  libxml2: 'libxml',
  sdl: 'sdl2',
  protobuf: 'google',
  grpc: 'grpcpp',
  abseil: 'absl',
  'ms-gsl': 'gsl',
  'gtest': 'gtest',
};

/** Distribution name -> import name, for cases the normalisation rule misses. */
const PYPI_MODULE_ALIASES: Record<string, string> = {
  beautifulsoup4: 'bs4',
  pillow: 'PIL',
  'pyyaml': 'yaml',
  'python-dateutil': 'dateutil',
  'msgpack-python': 'msgpack',
  'attrs': 'attr',
  'scikit-learn': 'sklearn',
  'opencv-python': 'cv2',
  'python-dotenv': 'dotenv',
  'protobuf': 'google',
  'google-cloud-storage': 'google',
  'psycopg2-binary': 'psycopg2',
  'mysqlclient': 'MySQLdb',
  'django-cors-headers': 'corsheaders',
  'djangorestframework': 'rest_framework',
  'pytest-cov': 'pytest_cov',
  'typing-extensions': 'typing_extensions',
};

function searchFiles(
  change: BreakingChange,
  candidates: readonly FileIndex[],
  contentByPath: Map<string, string>,
  indexByPath: Map<string, FileIndex>,
  limit: number,
  names: readonly string[],
): ImpactSite[] {
  const sites: ImpactSite[] = [];

  for (const candidate of candidates) {
    if (sites.length >= limit) break;

    const content = contentByPath.get(candidate.path);
    if (!content) continue;

    const fileIndex = indexByPath.get(candidate.path);
    // Only bindings from imports of *this* dependency count as evidence —
    // an unrelated import in the same file must not inflate confidence.
    const relevantImports =
      names.length === 0
        ? candidate.imports
        : candidate.imports.filter((i) => matchesImportName(i.packageName, names));
    const importedNames = new Set(relevantImports.flatMap((i) => i.bindings));
    const importsDependency = relevantImports.length > 0;

    // Names this file provably got from somewhere *else*, and the lines every
    // import in it occupies. Both exist to answer questions about a specific
    // line rather than about the file as a whole — see `shadowed` and
    // `breaksTheImport`.
    const foreignNames = new Set(
      candidate.imports
        .filter((i) => !matchesImportName(i.packageName, names))
        .flatMap((i) => i.bindings)
        .filter((binding) => binding !== '*'),
    );
    const importLines = new Set(candidate.imports.map((i) => i.line));
    const importStatementBreaks = breaksTheImport(change.kind);
    // A changed signature is a fact about invocations. Whether this file has
    // any is a per-file question, because the answer depends on the language
    // it is written in — see `callsAreParenthesised`.
    const invocationOnly =
      breaksOnlyAtTheCall(change.kind) && callsAreParenthesised(candidate.language);

    const lines = content.split('\n');
    // Two views of the same file, because two kinds of symbol need opposite
    // things from a string literal.
    //
    // A URL path or a scoped package name *lives* inside one —
    // `fetch('/api/v1/users')`, `from '@scope/pkg'` — so blanking strings
    // would find nothing at all. An identifier does not: a bare word inside a
    // docstring is prose, and matching it is how `define` came to be reported
    // as an affected site on the line `" to define format set a colon at the
    // end of the o"`. Both views strip comments; only one keeps string
    // contents, and `matcherFor`'s symbol shape decides which a symbol reads.
    const withStrings = maskComments(lines, { blankStrings: false });
    const withoutStrings = maskComments(lines, { blankStrings: true });

    for (const symbol of change.symbols) {
      const matcher = invocationOnly ? invocationMatcherFor(symbol) : matcherFor(symbol);
      if (!matcher) continue;

      // The name in this file belongs to a different package. `Certificate` in
      // a file that writes `from twisted.internet.ssl import Certificate` is
      // Twisted's class, whatever cryptography did to a class of the same name,
      // and reporting it is a false positive no reviewer can act on.
      if (shadowed(symbol, importedNames, foreignNames)) continue;

      const inString = livesInStringLiteral(symbol);
      const masked = inString ? withStrings : withoutStrings;
      // A module specifier only ever appears on an import line, so suppressing
      // those would suppress the finding entirely. The rule below is about
      // identifiers, which have somewhere else to be.
      const importLineIsASite = importStatementBreaks || inString;

      for (let i = 0; i < lines.length && sites.length < limit; i++) {
        const line = lines[i]!;
        if (isCommentOnly(line)) continue;

        // An import statement is a site only when the change breaks the import
        // itself. A symbol that changed shape — a class that became a variable,
        // a function that gained a parameter — is still importable under the
        // same name from the same module, so the fix lives at the call, and
        // listing the import line beside it is noise that makes the finding
        // look like it was produced by grep.
        if (!importLineIsASite && (importLines.has(i + 1) || isImportStatement(line))) continue;

        const searchable = masked[i]!;
        // The argument list is allowed to start on the next line, which is how
        // a long call gets formatted by every formatter in wide use.
        if (
          !matcher.test(searchable) &&
          !(invocationOnly && callOpensOnNextLine(symbol, searchable, masked[i + 1]))
        ) {
          continue;
        }

        const unit = fileIndex ? unitAtLine(fileIndex, i + 1) : undefined;

        sites.push({
          breakingChangeId: change.id,
          file: candidate.path,
          line: i + 1,
          excerpt: line.trim().slice(0, 200),
          enclosingSymbol: unit?.name,
          matchedSymbol: symbol,
          confidence: confidenceFor(symbol, importedNames, importsDependency),
        });
      }
    }
  }

  return dedupeSites(sites);
}

/**
 * Does this kind of change break the import statement itself?
 *
 * Only three do. If an export was removed, renamed, or moved to another module,
 * the line naming it is the thing that stops working, and it is the first line
 * anyone has to edit. Every other kind — a changed signature, a class that
 * became a variable, a new required field, a different default — leaves the
 * import valid: the name still exists, in the same module, spelled the same
 * way. Reporting the import for those tells a developer to go and look at a
 * line where there is nothing to do.
 *
 * `unknown` counts as breaking, because a finding Drift could not classify is
 * exactly where the cost of a missed site outweighs the cost of an extra one.
 */
function breaksTheImport(kind: BreakingChange['kind']): boolean {
  return (
    kind === 'removed-export' ||
    kind === 'renamed-export' ||
    kind === 'moved-export' ||
    kind === 'unknown'
  );
}

/**
 * Does this kind of change only bite where the symbol is *invoked*?
 *
 * A changed signature is a statement about argument lists. The name itself
 * keeps working everywhere else: `const Comp = asChild ? Slot : "button"`
 * stores a reference, `export { Slot }` re-exports one, `typeof Slot` asks
 * about a type — none of them pass arguments, so none of them have anything to
 * update, and reporting them is how a signature finding comes to list a line
 * where the answer is "yes, that is the name, and?".
 *
 * Only the signature kinds qualify. A removed export breaks the mere mention;
 * a changed default or a new required field lands in object literals and
 * config, which are not calls at all.
 */
function breaksOnlyAtTheCall(kind: BreakingChange['kind']): boolean {
  return kind === 'signature-change';
}

/**
 * Are calls in this language reliably written with parentheses?
 *
 * The invocation rule is only safe where an argument list is punctuation rather
 * than convention. Ruby's `render Slot, locals: {}` and Elixir's pipelines call
 * without a paren in sight, so applying the rule there would trade a handful of
 * false positives for silence on whole ecosystems. Those languages keep the
 * plain identifier search.
 */
function callsAreParenthesised(language: FileIndex['language']): boolean {
  return !UNPARENTHESISED_CALL_LANGUAGES.has(language);
}

const UNPARENTHESISED_CALL_LANGUAGES = new Set<FileIndex['language']>([
  'ruby',
  'elixir',
  'erlang',
  'ocaml',
  'other',
  'config',
]);

/**
 * Build a matcher that only fires where the symbol is actually applied.
 *
 * Five shapes count, and they are the five ways a language spells "pass these
 * arguments to this thing":
 *
 *   `Slot(props)`          — the plain call
 *   `Slot<T>(props)`       — the call with explicit type arguments
 *   `new Slot(props)`      — construction, whose arguments are the signature
 *   `<Slot ...>`           — JSX, where the props object *is* the argument
 *   `@Slot(...)`           — a decorator, which is a call with syntax sugar
 */
function invocationMatcherFor(symbol: string): RegExp | null {
  const trimmed = symbol.trim();
  if (!trimmed || trimmed.length < 2) return null;
  // A path-like symbol is a URL or a module specifier, never a callee.
  if (trimmed.startsWith('/') || trimmed.startsWith('@')) return matcherFor(trimmed);

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const leading = /^\w/.test(trimmed) ? '\\b' : '(?<![\\w$])';
  // A type-argument list may contain nested angle brackets but never a brace,
  // a semicolon, or an assignment — those end the expression instead.
  const typeArguments = '(?:\\s*<[^;={}()]*>)?';

  return new RegExp(
    // The JSX alternative refuses a word character before the `<`, which is
    // what separates the element `<Slot ...>` from the type `Array<Slot>`.
    `(?:new\\s+)?${leading}${escaped}${typeArguments}\\s*\\(` +
      `|(?<![\\w$])<${escaped}(?![\\w$])`,
  );
}

/** `foo(` split across two lines by a formatter is still `foo(`. */
function callOpensOnNextLine(symbol: string, line: string, next: string | undefined): boolean {
  if (next === undefined || !/^\s*\(/.test(next)) return false;
  const trimmed = symbol.trim();
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const leading = /^\w/.test(trimmed) ? '\\b' : '(?<![\\w$])';
  return new RegExp(`${leading}${escaped}\\s*$`).test(line);
}

/**
 * Import statements, for the languages whose imports the index does not parse.
 *
 * `ImportRecord.line` is the precise answer and is preferred; this covers the
 * rest — PHP, Swift, Elixir, and anything that reached the walker as `other` —
 * where the alternative is to fall back to the old behaviour of reporting the
 * import line for every kind of change.
 */
function isImportStatement(line: string): boolean {
  return IMPORT_STATEMENT.test(line);
}

const IMPORT_STATEMENT =
  /^\s*(?:@?import\b|from\s+[\w.]+\s+import\b|#\s*include\b|using\s+(?:static\s+)?[\w.]+\s*;|(?:pub\s+)?use\s+[\w:]|require(?:_relative|_once)?\s*[("'`]|include(?:_once)?\s*[("']|open\s+[A-Z]|extern\s+crate\b|package\s+[\w.]+\s*;)/;

/**
 * Is the matched name bound from a *different* dependency in this file?
 *
 * A file that imports both `cryptography` and `twisted` contains one `Certificate`,
 * and the import that binds it says whose it is. When another package's import
 * binds the name and this dependency's imports do not, every occurrence in the
 * file refers to the other package — not some of them, all of them, because a
 * name has one binding in a scope.
 *
 * Dotted symbols are checked on their root for the same reason `confidenceFor`
 * is: `base.Certificate` is reachable as `base` plus an attribute.
 */
function shadowed(
  symbol: string,
  importedNames: Set<string>,
  foreignNames: Set<string>,
): boolean {
  const root = symbol.split('.')[0] ?? symbol;
  if (importedNames.has(symbol) || importedNames.has(root) || importedNames.has('*')) return false;
  return foreignNames.has(symbol) || foreignNames.has(root);
}

/**
 * Build a word-boundary matcher for a symbol.
 *
 * Word boundaries are essential: without them `get` matches `getUserById`,
 * `forget`, and every other substring, which is precisely the over-matching
 * that destroys a reviewer's confidence in the report.
 */
function matcherFor(symbol: string): RegExp | null {
  const trimmed = symbol.trim();
  if (!trimmed || trimmed.length < 2) return null;

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

  // URL paths: match as a string fragment rather than an identifier, since
  // `/users` is not an identifier in any language.
  if (trimmed.startsWith('/')) return new RegExp(escaped);

  // `\b` is defined against word characters, so anchoring it next to `@` or `/`
  // never matches — `\b@scope/pkg\b` finds nothing at all, silently. Apply each
  // boundary only where the adjacent character is actually a word character.
  const leading = /^\w/.test(trimmed) ? '\\b' : '(?<![\\w$])';
  const trailing = /\w$/.test(trimmed) ? '\\b' : '(?![\\w$])';

  return new RegExp(`${leading}${escaped}${trailing}`);
}

/**
 * Is this symbol something a developer writes *inside* a string?
 *
 * URL paths and package specifiers are: they are data, and the only place they
 * ever appear is a literal. Everything else is an identifier, written as code,
 * and a match inside a string is prose that happens to share a word.
 */
function livesInStringLiteral(symbol: string): boolean {
  const trimmed = symbol.trim();
  return trimmed.startsWith('/') || trimmed.startsWith('@') || trimmed.includes('/');
}

function confidenceFor(
  symbol: string,
  importedNames: Set<string>,
  importsDependency: boolean,
): Confidence {
  const root = symbol.split('.')[0] ?? symbol;
  if (importedNames.has(symbol) || importedNames.has(root) || importedNames.has('*')) {
    return 'high';
  }
  return importsDependency ? 'medium' : 'low';
}

/**
 * Collapse multiple symbol matches on the same line.
 *
 * A line like `client.request(oldOption)` can match two symbols from the same
 * breaking change; a reviewer should see one site, not two.
 */
function dedupeSites(sites: readonly ImpactSite[]): ImpactSite[] {
  const seen = new Map<string, ImpactSite>();
  for (const site of sites) {
    const key = `${site.breakingChangeId}|${site.file}|${site.line}`;
    const existing = seen.get(key);
    if (!existing || rank(site.confidence) > rank(existing.confidence)) seen.set(key, site);
  }
  return [...seen.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
  );
}

function rank(confidence: Confidence): number {
  return confidence === 'high' ? 2 : confidence === 'medium' ? 1 : 0;
}

/** Line comments only. A trailing comment on real code is still a real site. */
function isCommentOnly(line: string): boolean {
  const trimmed = line.trim();
  // `#` opens a comment in Python, Ruby, and YAML — and a preprocessor
  // directive in C, where `#include <zlib.h>` is the most important line in
  // the file for exactly the finding that says zlib.h is gone.
  if (trimmed.startsWith('#')) return !PREPROCESSOR.test(trimmed);
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

const PREPROCESSOR =
  /^#\s*(include|define|undef|if|ifdef|ifndef|elif|else|endif|pragma|error|warning|line)\b/;

/**
 * Strip comments from every line, optionally blanking string contents too.
 *
 * State is carried across lines, so a block comment or a docstring that opened
 * earlier keeps swallowing text until it closes — a continuation line inside
 * one carries no marker of its own and would otherwise read as real code.
 *
 * Triple-quoted strings are handled because Python docstrings are where the
 * worst false positives lived: a paragraph of English describing what a method
 * does is not a use of an API that happens to share one of its words.
 *
 * `blankStrings` replaces string *contents* with spaces while keeping the
 * quotes, so every column outside the literal stays where it was. The excerpt
 * shown to a developer is always the untouched source line; only the search
 * runs against this.
 */
function maskComments(
  lines: readonly string[],
  options: { blankStrings: boolean },
): string[] {
  const masked: string[] = [];
  let inBlockComment = false;
  let triple: string | null = null;

  for (const rawLine of lines) {
    let result = '';
    let i = 0;
    let quote: string | null = null;

    while (i < rawLine.length) {
      const ch = rawLine[i]!;

      if (triple) {
        const end = rawLine.indexOf(triple, i);
        if (end === -1) {
          result += ' '.repeat(rawLine.length - i);
          i = rawLine.length;
          break;
        }
        result += ' '.repeat(end - i + triple.length);
        i = end + triple.length;
        triple = null;
        continue;
      }

      if (inBlockComment) {
        const end = rawLine.indexOf('*/', i);
        if (end === -1) {
          i = rawLine.length;
          break;
        }
        i = end + 2;
        inBlockComment = false;
        continue;
      }

      if (quote) {
        if (ch === '\\') {
          result += options.blankStrings ? '  ' : `\\${rawLine[i + 1] ?? ''}`;
          i += 2;
          continue;
        }
        result += options.blankStrings && ch !== quote ? ' ' : ch;
        if (ch === quote) quote = null;
        i += 1;
        continue;
      }

      // Triple quotes are checked before single ones: `"""` read as an empty
      // string followed by a stray quote is what let the rest of a Python
      // docstring's opening line through as if it were code.
      const three = rawLine.slice(i, i + 3);
      if (three === '"""' || three === "'''") {
        const close = rawLine.indexOf(three, i + 3);
        if (close === -1) {
          triple = three;
          result += ' '.repeat(rawLine.length - i);
          i = rawLine.length;
          break;
        }
        result += ' '.repeat(close + 3 - i);
        i = close + 3;
        continue;
      }

      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        result += ch;
        i += 1;
        continue;
      }

      if (ch === '/' && rawLine[i + 1] === '*') {
        const end = rawLine.indexOf('*/', i + 2);
        if (end === -1) {
          inBlockComment = true;
          i = rawLine.length;
          break;
        }
        i = end + 2;
        continue;
      }

      result += ch;
      i += 1;
    }

    masked.push(result);
  }

  return masked;
}
