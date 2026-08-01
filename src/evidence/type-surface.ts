import ts from 'typescript';
import { fetchJson, fetchText } from '../util/http.js';

/**
 * TypeScript declaration-surface diffing.
 *
 * Changelogs lie by omission — the single most common cause of a "minor"
 * upgrade breaking a build is a removal nobody wrote down. This module reads
 * the actual `.d.ts` of both versions and diffs the exported API, which makes
 * it the highest-weight evidence Drift can produce for npm packages.
 *
 * Declarations are fetched from jsDelivr rather than installed, because Drift
 * must be able to compare the *old* version, which by definition is no longer
 * in `node_modules` after the upgrade. Fetching also keeps Drift from ever
 * executing third-party install scripts.
 */

export type SurfaceKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'enum'
  | 'namespace';

export interface SurfaceEntry {
  name: string;
  kind: SurfaceKind;
  /** Normalised declaration text, whitespace-collapsed, for comparison. */
  signature: string;
  /** Member names for classes/interfaces/enums, so we can diff them too. */
  members: string[];
  /** Required member names, so optional -> required is detectable. */
  requiredMembers: string[];
  /**
   * The dependency this symbol is actually declared in.
   *
   * A wrapper package's own declarations can be one line long while its entire
   * API lives in packages it re-exports. `via` records where the declaration
   * came from so a finding can say so rather than implying the wrapper declared
   * it. Absent means the package declares the symbol itself.
   */
  via?: string;
}

export type SurfaceApi = Map<string, SurfaceEntry>;

export type SurfaceChangeKind =
  | 'export-removed'
  | 'signature-changed'
  | 'kind-changed'
  | 'member-removed'
  | 'member-now-required'
  | 'entry-point-moved';

export interface SurfaceChange {
  kind: SurfaceChangeKind;
  symbol: string;
  detail: string;
  before?: string;
  after?: string;
}

const JSDELIVR_DATA = 'https://data.jsdelivr.com/v1/packages/npm';
const JSDELIVR_CDN = 'https://cdn.jsdelivr.net/npm';

export interface TypeSurface {
  api: SurfaceApi;
  entryPath: string;
  /**
   * Dependencies whose declarations were folded into this surface.
   *
   * Non-empty means the comparison covers code this package does not itself
   * declare, which is the only way a thin wrapper can be compared at all.
   */
  viaDependencies: string[];
  /** Symbols this package declares itself, before any dependency was followed. */
  ownSymbols: number;
  /** Other entry points the package publishes, from its `exports` map. */
  subpaths: string[];
}

/** Fetch and parse the public type surface of one published npm version. */
export async function fetchTypeSurface(
  packageName: string,
  version: string,
  options: { followDependencies?: boolean } = {},
): Promise<TypeSurface | null> {
  const manifest = await fetchManifest(packageName, version);
  const entryPath = await resolveTypesEntry(packageName, version, manifest);
  if (!entryPath) return null;

  const sources = await collectDeclarationSources(packageName, version, entryPath);
  if (sources.length === 0) return null;

  const api: SurfaceApi = new Map();
  // `export { a as b } from './other'` names something declared in a file this
  // one does not contain, so aliases are resolved after every source has been
  // parsed rather than as each is read.
  const aliases: ExportAlias[] = [];
  for (const source of sources) extractExports(source.content, source.path, api, aliases);
  resolveAliases(api, aliases);

  const ownSymbols = api.size;
  const viaDependencies =
    options.followDependencies === false
      ? []
      : await mergeDependencySurfaces(manifest, sources, api);

  return api.size > 0
    ? { api, entryPath, viaDependencies, ownSymbols, subpaths: subpathsOf(manifest?.exports) }
    : null;
}

interface Manifest {
  types?: string;
  typings?: string;
  exports?: unknown;
  main?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function fetchManifest(packageName: string, version: string): Promise<Manifest | null> {
  return fetchJson<Manifest>(`${JSDELIVR_CDN}/${packageName}@${version}/package.json`);
}

/* ------------------------------------------------------------------ */
/* Dependencies a package publishes its API through                    */
/* ------------------------------------------------------------------ */

/**
 * How many dependencies one package's surface may be assembled from.
 *
 * A wrapper has a handful; anything past that is a package whose own
 * declarations are the API, and following further only buys latency.
 */
const MAX_FOLLOWED_DEPENDENCIES = 8;

/**
 * Fold the declarations of re-exported dependencies into this surface.
 *
 * Some packages declare almost nothing of their own. `@octokit/rest`'s entry
 * declaration is eight lines: it imports `Octokit` from `@octokit/core`, the
 * endpoint methods from `@octokit/plugin-rest-endpoint-methods` and the
 * paginator from `@octokit/plugin-paginate-rest`, and re-exports the
 * composition. Comparing only those eight lines across 21 → 22 finds nothing —
 * they are textually identical — while every API the developer actually calls
 * moved underneath, because the wrapper's dependency ranges moved a major
 * version each.
 *
 * So the symbols the entry pulls in from its own dependencies are resolved at
 * the version *this* release pins, and compared as part of this package's
 * surface. That is what the developer upgrades when they upgrade the wrapper,
 * and it is the difference between "could not verify" and an answer.
 */
async function mergeDependencySurfaces(
  manifest: Manifest | null,
  sources: readonly DeclarationSource[],
  api: SurfaceApi,
): Promise<string[]> {
  const declared = { ...manifest?.dependencies, ...manifest?.peerDependencies };
  if (Object.keys(declared).length === 0) return [];

  const wanted = externalReferences(sources, api);
  const followed: string[] = [];

  for (const [specifier, reference] of wanted) {
    if (followed.length >= MAX_FOLLOWED_DEPENDENCIES) break;
    const range = declared[specifier];
    if (!range) continue;

    const resolved = await resolveDependencyVersion(specifier, range);
    if (!resolved) continue;

    // One level only. The dependency's own dependencies are its business; a
    // second hop multiplies requests without changing what this package
    // exposes, and a cycle would otherwise be reachable.
    const surface = await fetchTypeSurface(specifier, resolved, { followDependencies: false });
    if (!surface) continue;

    let merged = 0;
    for (const [exportedAs, declaredAs] of reference.names(surface.api)) {
      const entry = surface.api.get(declaredAs);
      if (!entry) continue;
      // Keyed by origin so a wrapper and its dependency can both publish a
      // symbol of the same name without one silently masking the other.
      const key = reference.reExported.has(exportedAs) ? exportedAs : `${specifier}#${exportedAs}`;
      if (api.has(key)) continue;
      api.set(key, { ...renameEntry(entry, exportedAs), via: specifier });
      merged += 1;
    }

    if (merged > 0) followed.push(`${specifier}@${resolved}`);
  }

  return followed;
}

/**
 * A dependency this package's entry declarations pull symbols out of.
 *
 * `names` is resolved against the dependency's actual surface rather than
 * decided up front, because `export * from "pkg"` means "whatever that package
 * exports" and that set is only known once it has been read.
 */
interface ExternalReference {
  /** Explicitly named bindings: exported name → name declared in the dependency. */
  named: Map<string, string>;
  /** Whether the entry does `export * from` this dependency. */
  star: boolean;
  /** Names re-exported verbatim, which are therefore this package's own exports. */
  reExported: Set<string>;
  names(api: SurfaceApi): Array<[string, string]>;
}

/**
 * Bare-specifier imports and re-exports, and which of them matter.
 *
 * An import is only followed when an exported declaration actually mentions the
 * local it bound — importing a type for internal use says nothing about this
 * package's contract, and following it would attribute an unrelated
 * dependency's churn to this upgrade.
 */
export function externalReferences(
  sources: readonly DeclarationSource[],
  api: SurfaceApi,
): Map<string, ExternalReference> {
  const out = new Map<string, ExternalReference>();
  const reference = (specifier: string): ExternalReference => {
    const existing = out.get(specifier);
    if (existing) return existing;
    const created: ExternalReference = {
      named: new Map(),
      star: false,
      reExported: new Set(),
      names(depApi) {
        if (!this.star) return [...this.named];
        const all = [...depApi.keys()].map((name): [string, string] => [name, name]);
        return [...this.named, ...all.filter(([name]) => !this.named.has(name))];
      },
    };
    out.set(specifier, created);
    return created;
  };

  const signatures = [...api.values()].map((entry) => entry.signature).join('\n');
  const referenced = (local: string): boolean =>
    new RegExp(`\\b${escapeRegExp(local)}\\b`).test(signatures);

  for (const source of sources) {
    for (const statement of bareModuleBindings(source.content)) {
      if (isRelative(statement.specifier)) continue;

      const entry = reference(statement.specifier);
      if (statement.kind === 'export' && statement.star) {
        entry.star = true;
        continue;
      }

      for (const binding of statement.bindings) {
        if (statement.kind === 'export') {
          entry.named.set(binding.local, binding.imported);
          entry.reExported.add(binding.local);
        } else if (referenced(binding.local)) {
          // `import { Octokit as Core }` used by an exported declaration: the
          // symbol is part of this package's contract under the name the
          // dependency gives it, not under the local alias.
          entry.named.set(binding.imported, binding.imported);
        }
      }
    }
  }

  return out;
}

interface ModuleBinding {
  /** Name inside the dependency. */
  imported: string;
  /** Name bound locally, or re-exported as. */
  local: string;
}

interface ModuleStatement {
  kind: 'import' | 'export';
  specifier: string;
  star: boolean;
  bindings: ModuleBinding[];
}

/** Every `import`/`export … from '…'` in a declaration file. */
function bareModuleBindings(content: string): ModuleStatement[] {
  const out: ModuleStatement[] = [];

  const pattern =
    /\b(import|export)\s+(?:type\s+)?(?:(\*(?:\s+as\s+\w+)?)|(\{[^}]*\})|(\w+))\s+from\s+['"]([^'"]+)['"]/g;

  for (const match of content.matchAll(pattern)) {
    const [, keyword = '', star, braces, defaultBinding, specifier = ''] = match;
    const kind = keyword === 'export' ? 'export' : 'import';

    if (star) {
      out.push({ kind, specifier, star: true, bindings: [] });
      continue;
    }

    if (defaultBinding) {
      out.push({ kind, specifier, star: false, bindings: [{ imported: 'default', local: defaultBinding }] });
      continue;
    }

    const bindings: ModuleBinding[] = [];
    for (const part of (braces ?? '').replace(/[{}]/g, '').split(',')) {
      const cleaned = part.replace(/\btype\s+/g, '').trim();
      if (!cleaned) continue;
      const [imported, local] = cleaned.split(/\s+as\s+/).map((piece) => piece.trim());
      if (!imported) continue;
      bindings.push({ imported, local: local || imported });
    }
    if (bindings.length > 0) out.push({ kind, specifier, star: false, bindings });
  }

  return out;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

/**
 * The version of a dependency a given release actually pins.
 *
 * jsDelivr resolves a range the same way a package manager would, which keeps
 * Drift from having to download and sort a full packument for every hop.
 */
async function resolveDependencyVersion(name: string, range: string): Promise<string | null> {
  const resolved = await fetchJson<{ version?: string }>(
    `${JSDELIVR_DATA}/${name}/resolved?specifier=${encodeURIComponent(range)}`,
  );
  return resolved?.version ?? null;
}

/** Named entry points other than the root, from an `exports` map. */
export function subpathsOf(exportsField: unknown): string[] {
  if (!exportsField || typeof exportsField !== 'object') return [];
  return Object.keys(exportsField as Record<string, unknown>)
    .filter((key) => key.startsWith('./') && !key.endsWith('package.json'))
    .slice(0, 20);
}

/**
 * Locate the package's type declarations.
 *
 * Checks `types`/`typings`, then the `exports` map (modern packages put types
 * only there), then conventional fallbacks, then DefinitelyTyped. A package
 * with no declarations simply yields no evidence from this source.
 */
async function resolveTypesEntry(
  packageName: string,
  version: string,
  pkg: Manifest | null,
): Promise<string | null> {
  if (pkg) {
    const declared = pkg.types ?? pkg.typings ?? typesFromExports(pkg.exports);
    if (declared) {
      // A `types` field routinely points at a directory or an extensionless
      // path (`"types": "dist/source"`) rather than a `.d.ts` file. Fetching it
      // verbatim 404s and silently costs us the strongest evidence we have, so
      // try the conventional expansions before giving up.
      for (const candidate of expandTypesEntry(normalizePath(declared))) {
        if (await exists(packageName, version, candidate)) return candidate;
      }
    }

    // A JS entry point often has a sibling declaration file.
    if (pkg.main) {
      const sibling = normalizePath(pkg.main).replace(/\.(c|m)?js$/, '.d.ts');
      if (await exists(packageName, version, sibling)) return sibling;
    }
  }

  for (const candidate of ['index.d.ts', 'dist/index.d.ts', 'lib/index.d.ts', 'types/index.d.ts']) {
    if (await exists(packageName, version, candidate)) return candidate;
  }

  // DefinitelyTyped ships types for the same *major* line, so this is only a
  // sound comparison when both sides resolve; mismatches yield no evidence.
  const dtName = packageName.startsWith('@')
    ? `@types/${packageName.slice(1).replace('/', '__')}`
    : `@types/${packageName}`;
  if (await exists(dtName, 'latest', 'index.d.ts')) return `@types:${dtName}`;

  return null;
}

/**
 * Candidate paths a `types` field could mean, most likely first.
 *
 * Covers the file itself, the extensionless form, and the directory form —
 * `"types": "dist/source"` means `dist/source/index.d.ts` in practice.
 */
export function expandTypesEntry(declared: string): string[] {
  if (/\.d\.(c|m)?ts$/.test(declared)) return [declared, declared.replace(/\.d\.(c|m)?ts$/, '.d.ts')];

  // `.d.cts` and `.d.mts` must be recognised *before* the extension is
  // stripped. Treating `index.d.cts` as an extensionless path produced
  // `index.d.d.ts`, which 404s — and losing the entry point costs the whole
  // computed diff, which is the strongest evidence Drift has. That is exactly
  // how zod 4 was reported as having no breaking changes.
  const base = declared.replace(/\.(c|m)?[jt]s$/, '').replace(/\/$/, '');
  return [`${base}.d.ts`, `${base}.d.cts`, `${base}.d.mts`, `${base}/index.d.ts`, declared];
}

export function typesFromExports(exportsField: unknown): string | null {
  // `"exports": { ".": "./lib/entry.js" }` — the shorthand form, where the
  // subpath maps straight to a file with no conditions at all. There is no
  // `types` condition to find, but the sibling declaration next to that file is
  // the package's entry surface, and `expandTypesEntry` knows how to look for
  // it. typescript 7 publishes exactly this shape.
  if (typeof exportsField === 'string') return exportsField;
  if (!exportsField || typeof exportsField !== 'object') return null;

  // Walk the conditional-exports tree looking for any `types` condition,
  // preferring the root entry (".") when one exists.
  const visit = (node: unknown, depth: number): string | null => {
    if (depth > 6 || !node) return null;
    // A subpath that maps straight to a file, with no conditions under it.
    if (typeof node === 'string') return depth > 0 ? node : null;
    if (typeof node !== 'object') return null;
    const record = node as Record<string, unknown>;

    const types = record.types ?? record.typings;
    if (typeof types === 'string') return types;

    const preferred = ['.', 'import', 'require', 'default', 'node'];
    for (const key of [...preferred, ...Object.keys(record)]) {
      if (!(key in record)) continue;
      const found = visit(record[key], depth + 1);
      if (found) return found;
    }
    return null;
  };

  return visit(exportsField, 0);
}

export interface DeclarationSource {
  path: string;
  content: string;
}

/**
 * Fetch the entry declaration and follow its re-exports.
 *
 * Barrel files (`export * from './client'`) are near-universal, so reading only
 * the entry point would see almost nothing. The traversal is depth- and
 * count-bounded because we are walking an untrusted package's file graph.
 */
async function collectDeclarationSources(
  packageName: string,
  version: string,
  entryPath: string,
): Promise<DeclarationSource[]> {
  if (entryPath.startsWith('@types:')) {
    const dtName = entryPath.slice('@types:'.length);
    const content = await fetchText(`${JSDELIVR_CDN}/${dtName}@latest/index.d.ts`);
    return content ? [{ path: 'index.d.ts', content }] : [];
  }

  const MAX_FILES = 25;
  // Each re-export now expands to five candidate paths rather than two, so the
  // queue holds candidate *groups* and stops at the first that resolves. A
  // package with a thirty-line barrel costs thirty-odd requests, not a hundred
  // and fifty.
  const sources: DeclarationSource[] = [];
  const seen = new Set<string>();
  const queue: string[][] = [[entryPath]];

  while (queue.length > 0 && sources.length < MAX_FILES) {
    const candidates = queue.shift()!.filter((path) => !seen.has(path));
    if (candidates.length === 0) continue;

    let resolved: DeclarationSource | null = null;
    for (const path of candidates) {
      seen.add(path);
      const content = await fetchText(`${JSDELIVR_CDN}/${packageName}@${version}/${path}`, {
        retries: 0,
      });
      if (content) {
        resolved = { path, content };
        break;
      }
    }
    if (!resolved) continue;

    sources.push(resolved);

    for (const specifier of relativeReExports(resolved.content)) {
      queue.push(resolveRelative(resolved.path, specifier));
    }
  }

  return sources;
}

/**
 * `export * from './x'` / `export { a } from './x'` — relative targets only.
 *
 * `export type { … } from` counts. Omitting it skipped the file behind every
 * type-only barrel, which is how a package's interfaces — the part of an API
 * most likely to have a breaking change in it — went unread while the diff
 * still reported itself as a comparison.
 */
function relativeReExports(content: string): string[] {
  const out = new Set<string>();
  const pattern =
    /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"](\.[^'"]+)['"]/g;
  for (const match of content.matchAll(pattern)) out.add(match[1]!);
  return [...out];
}

/**
 * Candidate paths a relative specifier could resolve to, most likely first.
 *
 * A dual-published package writes its CommonJS declarations against `.cjs`
 * specifiers (`export * from "./external.cjs"`), and its ESM ones against
 * `.js`. Stripping only `.js`/`.ts` left `external.cjs` intact and probed
 * `external.cjs.d.ts`, so every re-export in the CJS half of such a package
 * resolved to nothing — the entry file parsed, contributed no symbols of its
 * own, and the surface came back empty.
 */
export function resolveRelative(fromPath: string, specifier: string): string[] {
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const joined = normalizePath(dir ? `${dir}/${specifier}` : specifier);
  const base = joined.replace(/\.(d\.(c|m)?ts|(c|m)?js|(c|m)?ts)$/, '');
  return [
    `${base}.d.ts`,
    `${base}.d.cts`,
    `${base}.d.mts`,
    `${base}/index.d.ts`,
    `${base}/index.d.cts`,
  ];
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.replace(/^\.\//, '').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

async function exists(packageName: string, version: string, path: string): Promise<boolean> {
  const content = await fetchText(`${JSDELIVR_CDN}/${packageName}@${version}/${path}`, { retries: 0 });
  return content !== null;
}

/**
 * Extract exported declarations using the TypeScript compiler's own parser.
 *
 * Using the real parser rather than regexes matters here: overloads, generics,
 * and multi-line signatures are exactly the constructs that break naive
 * matching, and they are also the ones most likely to have changed.
 */
export function extractExports(
  content: string,
  fileName: string,
  into: SurfaceApi = new Map(),
  aliases: ExportAlias[] = [],
): SurfaceApi {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  // Every declaration in the file, exported or not, keyed by its declared name.
  // An `export { objectType as object }` statement names a local that is
  // itself unexported, so the local declarations have to be on hand before the
  // export statements can be understood.
  const locals = new Map<string, SurfaceEntry>();

  const add = (target: SurfaceApi, entry: SurfaceEntry): void => {
    const existing = target.get(entry.name);
    // Function overloads appear as sibling declarations; concatenating their
    // signatures means losing one is detected as a change.
    if (existing && existing.kind === entry.kind) {
      existing.signature = `${existing.signature} | ${entry.signature}`;
      existing.members = [...new Set([...existing.members, ...entry.members])];
      existing.requiredMembers = [...new Set([...existing.requiredMembers, ...entry.requiredMembers])];
    } else if (!existing) {
      target.set(entry.name, entry);
    }
  };

  const visit = (node: ts.Node): void => {
    const entry = toSurfaceEntry(node, source);
    if (entry) add(locals, entry);

    if (isExported(node)) {
      if (entry) add(into, entry);
    } else if (ts.isExportDeclaration(node)) {
      collectExportSpecifiers(node, locals, into, aliases);
    }

    // Descend into ambient module/namespace bodies, whose contents are
    // exported even when the inner declarations lack a modifier.
    if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
      node.body.statements.forEach(visit);
    }
  };

  source.statements.forEach(visit);
  return into;
}

/** One `export { local as exported }` binding whose local is declared elsewhere. */
export interface ExportAlias {
  exported: string;
  local: string;
}

/**
 * `export { a, b as c }` — the half of a package's surface a declaration-only
 * walk used to miss entirely.
 *
 * This is not a rare style. zod 3 declares its whole ergonomic API as private
 * locals (`declare const objectType`) and publishes it in one renaming export
 * statement (`export { objectType as object, stringType as string, … }`), so
 * `z.object` and `z.string` were absent from the *old* side of every zod diff
 * while zod 4's plain `export declare function object` was present on the new
 * side. The comparison therefore saw the entire user-facing API as newly added
 * — additions are non-breaking by construction — and reported that a 3 → 4
 * major upgrade touched nothing this repository uses.
 */
function collectExportSpecifiers(
  node: ts.ExportDeclaration,
  locals: SurfaceApi,
  into: SurfaceApi,
  aliases: ExportAlias[],
): void {
  const bindings = node.exportClause;
  if (!bindings || !ts.isNamedExports(bindings)) return;

  for (const specifier of bindings.elements) {
    const exported = specifier.name.text;
    const local = specifier.propertyName?.text ?? exported;
    if (into.has(exported)) continue;

    const entry = locals.get(local);
    if (entry) into.set(exported, renameEntry(entry, exported));
    else aliases.push({ exported, local });
  }
}

/**
 * Resolve aliases that pointed at another file, once every file is parsed.
 *
 * Left unresolved these are simply absent, which is the pre-existing behaviour
 * and never invents a symbol that is not there.
 */
function resolveAliases(api: SurfaceApi, aliases: readonly ExportAlias[]): void {
  for (const alias of aliases) {
    if (api.has(alias.exported)) continue;
    const entry = api.get(alias.local);
    if (entry) api.set(alias.exported, renameEntry(entry, alias.exported));
  }
}

/**
 * The same declaration under its published name.
 *
 * The local name is substituted inside the signature text too, because the
 * signature is compared verbatim: leaving `declare const objectType` on one
 * side and `declare function object` on the other would report a change every
 * time a package renamed a private local, which says nothing about its API.
 */
function renameEntry(entry: SurfaceEntry, name: string): SurfaceEntry {
  return {
    ...entry,
    name,
    signature: entry.signature.replace(new RegExp(`\\b${escapeRegExp(entry.name)}\\b`, 'g'), name),
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function toSurfaceEntry(node: ts.Node, source: ts.SourceFile): SurfaceEntry | null {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return {
      name: node.name.text,
      kind: 'function',
      // The body is irrelevant to the contract; only the signature is.
      signature: collapse(node.getText(source).replace(/\{[\s\S]*$/, '')),
      members: [],
      requiredMembers: [],
    };
  }

  if (ts.isClassDeclaration(node) && node.name) {
    const members = node.members
      .filter((m) => !hasPrivateModifier(m))
      .map((m) => m.name?.getText(source))
      .filter((n): n is string => Boolean(n));
    return {
      name: node.name.text,
      kind: 'class',
      signature: collapse(signatureOfClassLike(node, source)),
      members,
      requiredMembers: node.members
        .filter((m) => ts.isPropertyDeclaration(m) && !m.questionToken && !hasPrivateModifier(m))
        .map((m) => m.name?.getText(source))
        .filter((n): n is string => Boolean(n)),
    };
  }

  if (ts.isInterfaceDeclaration(node)) {
    const members = node.members.map((m) => m.name?.getText(source)).filter((n): n is string => Boolean(n));
    const requiredMembers = node.members
      .filter((m) => (ts.isPropertySignature(m) || ts.isMethodSignature(m)) && !m.questionToken)
      .map((m) => m.name?.getText(source))
      .filter((n): n is string => Boolean(n));
    return {
      name: node.name.text,
      kind: 'interface',
      signature: collapse(node.getText(source)),
      members,
      requiredMembers,
    };
  }

  if (ts.isTypeAliasDeclaration(node)) {
    return {
      name: node.name.text,
      kind: 'type',
      signature: collapse(node.getText(source)),
      members: [],
      requiredMembers: [],
    };
  }

  if (ts.isEnumDeclaration(node)) {
    return {
      name: node.name.text,
      kind: 'enum',
      signature: collapse(node.getText(source)),
      members: node.members.map((m) => m.name.getText(source)),
      requiredMembers: [],
    };
  }

  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0];
    if (declaration && ts.isIdentifier(declaration.name)) {
      return {
        name: declaration.name.text,
        kind: 'variable',
        signature: collapse(node.getText(source)),
        members: [],
        requiredMembers: [],
      };
    }
  }

  if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
    return {
      name: node.name.text,
      kind: 'namespace',
      signature: `namespace ${node.name.text}`,
      members: [],
      requiredMembers: [],
    };
  }

  return null;
}

/** Class signature without the body — heritage and type params are the contract. */
function signatureOfClassLike(node: ts.ClassDeclaration, source: ts.SourceFile): string {
  const name = node.name?.text ?? '';
  const typeParams = node.typeParameters?.map((p) => p.getText(source)).join(', ') ?? '';
  const heritage = node.heritageClauses?.map((h) => h.getText(source)).join(' ') ?? '';
  return `class ${name}${typeParams ? `<${typeParams}>` : ''} ${heritage}`.trim();
}

function hasPrivateModifier(member: ts.ClassElement): boolean {
  const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
  if (modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) return true;
  return member.name?.getText().startsWith('#') ?? false;
}

function collapse(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Diff two type surfaces.
 *
 * Only *removals and tightenings* are reported. Additions are non-breaking by
 * construction and reporting them would flood the plan with noise that a
 * reviewer then has to filter — which is how trust in a tool like this dies.
 */
/**
 * Kinds that describe the same thing to a caller.
 *
 * `declare const f: (x: A) => B` and `declare function f(x: A): B` are one API
 * to everyone who calls `f`, and packages move between the two forms for
 * internal reasons. Reporting that as "changed from a variable to a function"
 * would be a finding about the package's source style. Whether the *signature*
 * changed is still compared, which is the part a caller can break on.
 */
function interchangeable(a: SurfaceKind, b: SurfaceKind): boolean {
  const callable = (kind: SurfaceKind): boolean => kind === 'variable' || kind === 'function';
  return callable(a) && callable(b);
}

/**
 * The upgrade that did not remove one export but relocated all of them.
 *
 * `typescript` 7 is the case that made this necessary: its root entry point
 * publishes a single `version` constant, and the compiler API moved to
 * `typescript/unstable/*` subpaths. Diffing surfaces reports that truthfully —
 * as several hundred separate removals — and an agent handed "`ScriptTarget`
 * was removed, replace it" will invent a replacement, because there is no
 * per-symbol fix to make. The whole-import path changed.
 *
 * So the shape is named before the removals are listed, and the entry points
 * the new version actually publishes are named with it, since those are read
 * off the new package's own `exports` map rather than guessed at.
 */
export function entryPointMoved(
  packageName: string,
  before: TypeSurface,
  after: TypeSurface,
): SurfaceChange | null {
  // Small surfaces move for ordinary reasons; this is about a package whose
  // entire published API stopped being reachable where it used to be.
  const MIN_SYMBOLS = 20;
  if (before.api.size < MIN_SYMBOLS) return null;

  let survived = 0;
  for (const key of before.api.keys()) if (after.api.has(key)) survived += 1;
  if (survived > before.api.size * 0.1) return null;
  if (after.api.size > before.api.size * 0.1) return null;

  const others = after.subpaths.filter((path) => path !== '.');
  const where =
    others.length > 0
      ? ` The new version publishes ${others.length} other entry point${others.length === 1 ? '' : 's'}: ${others.join(', ')}. Import from the one that carries the API you use, rather than replacing the symbols individually.`
      : ' Nothing in the new version publishes the old symbols under the old import path.';

  return {
    kind: 'entry-point-moved',
    symbol: packageName,
    detail:
      `Importing \`${packageName}\` no longer gives you its API: the root entry point went from ` +
      `${before.api.size} exported symbols to ${after.api.size}.${where}`,
    before: `${before.entryPath} — ${before.api.size} exports`,
    after: `${after.entryPath} — ${after.api.size} exports`,
  };
}

export function diffSurfaces(before: SurfaceApi, after: SurfaceApi): SurfaceChange[] {
  const changes: SurfaceChange[] = [];

  for (const [key, oldEntry] of before) {
    const newEntry = after.get(key);
    const name = oldEntry.name;
    // Where the declaration lives, when that is not the package being upgraded.
    // "`Octokit` is no longer exported" is confusing when `@octokit/rest`'s own
    // file never declared it; naming the dependency turns the finding into
    // something a developer can go and read.
    const origin = oldEntry.via ? ` (declared in ${oldEntry.via})` : '';

    if (!newEntry) {
      changes.push({
        kind: 'export-removed',
        symbol: name,
        detail: `\`${name}\` is no longer exported (was a ${oldEntry.kind})${origin}.`,
        before: oldEntry.signature,
      });
      continue;
    }

    if (oldEntry.kind !== newEntry.kind && !interchangeable(oldEntry.kind, newEntry.kind)) {
      changes.push({
        kind: 'kind-changed',
        symbol: name,
        detail: `\`${name}\` changed from a ${oldEntry.kind} to a ${newEntry.kind}${origin}.`,
        before: oldEntry.signature,
        after: newEntry.signature,
      });
      continue;
    }

    for (const member of oldEntry.members) {
      if (!newEntry.members.includes(member)) {
        changes.push({
          kind: 'member-removed',
          symbol: `${name}.${member}`,
          detail: `\`${name}.${member}\` was removed${origin}.`,
        });
      }
    }

    const wasRequired = new Set(oldEntry.requiredMembers);
    for (const member of newEntry.requiredMembers) {
      if (!wasRequired.has(member) && oldEntry.members.includes(member)) {
        changes.push({
          kind: 'member-now-required',
          symbol: `${name}.${member}`,
          detail: `\`${name}.${member}\` is now required; it was previously optional${origin}.`,
        });
      }
    }

    if (oldEntry.signature !== newEntry.signature && oldEntry.kind !== 'interface' && oldEntry.kind !== 'class') {
      changes.push({
        kind: 'signature-changed',
        symbol: name,
        detail: `The signature of \`${name}\` changed${origin}.`,
        before: oldEntry.signature,
        after: newEntry.signature,
      });
    }
  }

  return changes;
}
