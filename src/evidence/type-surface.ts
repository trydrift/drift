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
  | 'entry-point-moved'
  /**
   * A whole importable unit is gone.
   *
   * Sibling of `entry-point-moved` and reported for the same reason: the fix is
   * one line per importing file, and a reader shown the hundreds of symbol
   * removals underneath it instead will reach for hundreds of wrong ones.
   */
  | 'package-removed'
  /**
   * A constant's assigned value changed; its declared type did not.
   *
   * Distinct from `signature-changed` on purpose: "update argument order and
   * count" is nonsense remediation for a value that takes no arguments, and a
   * named constant changing value does not by itself mean call sites need
   * editing — only code that depends on the concrete number, zero value, or
   * serialised form does.
   */
  | 'constant-value-changed';

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
  // No manifest and no declaration fallback is a fact about the fetch, not
  // about the package: a yanked version, a private registry, a CDN that has not
  // mirrored this release. Saying "publishes no declarations" there would be
  // Drift reporting its own reach as the package's shortcoming. But if
  // DefinitelyTyped can still answer, take that evidence instead of stopping.
  if (!manifest && !entryPath) throw new VersionUnavailableError(packageName, version);
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
    !manifest || options.followDependencies === false
      ? []
      : await mergeDependencySurfaces(manifest, sources, api);

  return api.size > 0
    ? { api, entryPath, viaDependencies, ownSymbols, subpaths: subpathsOf(manifest?.exports) }
    : null;
}

/** Raised when a published version could not be read at all. */
export class VersionUnavailableError extends Error {
  constructor(
    readonly packageName: string,
    readonly version: string,
  ) {
    super(`${packageName}@${version} could not be fetched`);
    this.name = 'VersionUnavailableError';
  }
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
    // A dependency Drift cannot reach costs its symbols, never the comparison:
    // the rest of this package's surface is still worth diffing.
    const surface = await fetchTypeSurface(specifier, resolved, { followDependencies: false }).catch(
      () => null,
    );
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

  for (const candidate of conventionalTypeEntries(packageName)) {
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
 * Last-chance declaration entry points packages commonly publish.
 *
 * Phaser is the concrete regression: its manifest does declare
 * `"types": "./types/phaser.d.ts"`, but keeping the package-named fallback here
 * protects the same layout when a package omits the field or an older manifest
 * parser misses it.
 */
export function conventionalTypeEntries(packageName: string): string[] {
  const base = packageName.split('/').pop()?.replace(/^@/, '') || packageName;
  return [
    'index.d.ts',
    'dist/index.d.ts',
    'lib/index.d.ts',
    'types/index.d.ts',
    `types/${base}.d.ts`,
  ];
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
export function relativeReExports(content: string): string[] {
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

/** Extract the declaration shapes Drift compares from a `.d.ts` source file. */
export function extractExports(
  content: string,
  fileName: string,
  into: SurfaceApi = new Map(),
  aliases: ExportAlias[] = [],
): SurfaceApi {
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

  void fileName;
  for (const parsed of declarationEntries(content)) {
    add(locals, parsed.entry);
    if (parsed.exported) add(into, parsed.entry);
  }

  collectExportSpecifiers(content, locals, into, aliases);
  collectExportAssignments(content, locals, into);
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
  content: string,
  locals: SurfaceApi,
  into: SurfaceApi,
  aliases: ExportAlias[],
): void {
  const pattern = /\bexport\s+(?:type\s+)?\{([^}]+)\}(?:\s+from\s+['"][^'"]+['"])?\s*;/g;
  for (const match of content.matchAll(pattern)) {
    for (const { exported, local } of exportBindings(match[1] ?? '')) {
      if (into.has(exported)) continue;

      const entry = locals.get(local);
      if (entry) into.set(exported, renameEntry(entry, exported));
      else aliases.push({ exported, local });
    }
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
 * `declare module "pkg" { export = Phaser; }`
 *
 * Older and global-first declaration files often publish a namespace this way.
 * Phaser's generated declarations are exactly this shape: almost all of the
 * API lives under `declare namespace Phaser`, then the module exports that
 * namespace by assignment. Treating only `export declare` as public made Drift
 * fetch Phaser's `.d.ts` successfully and still report "no declarations".
 */
function collectExportAssignments(content: string, locals: SurfaceApi, into: SurfaceApi): void {
  for (const match of content.matchAll(/\bexport\s*=\s*([A-Za-z_$][\w$]*)\s*;/g)) {
    const local = match[1]!;
    for (const entry of locals.values()) {
      if (entry.name !== local && !entry.name.startsWith(`${local}.`)) continue;
      if (!into.has(entry.name)) into.set(entry.name, entry);
    }
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

function collapse(text: string): string {
  return text
    .replace(/\/\*(?:[^*]|\*(?!\/))*\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ParsedDeclaration {
  entry: SurfaceEntry;
  exported: boolean;
}

function declarationEntries(content: string): ParsedDeclaration[] {
  const entries: ParsedDeclaration[] = [];

  collectSimpleDeclarations(
    content,
    /\b(export\s+)?(?:declare\s+)?function\s+([A-Za-z_$][\w$]*)(?:<[^>{}]*>)?\s*\(/g,
    'function',
    entries,
  );
  collectSimpleDeclarations(
    content,
    /\b(export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g,
    'variable',
    entries,
  );
  collectSimpleDeclarations(
    content,
    /\b(export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\b/g,
    'type',
    entries,
  );

  collectBlockDeclarations(
    content,
    /\b(export\s+)?(?:declare\s+)?class\s+([A-Za-z_$][\w$]*)(?![\w$])[^{;]*\{/g,
    'class',
    entries,
  );
  collectBlockDeclarations(
    content,
    /\b(export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)(?![\w$])[^{;]*\{/g,
    'interface',
    entries,
  );
  collectBlockDeclarations(
    content,
    /\b(export\s+)?(?:declare\s+)?enum\s+([A-Za-z_$][\w$]*)(?![\w$])[^{;]*\{/g,
    'enum',
    entries,
  );

  collectNamespaces(content, '', false, entries);

  return entries;
}

function collectNamespaces(
  content: string,
  prefix: string,
  exportedParent: boolean,
  entries: ParsedDeclaration[],
): void {
  const pattern =
    /\b(export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\{/g;

  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    const open = content.indexOf('{', match.index);
    const close = matchingBraceOffset(content, open);
    if (open < 0 || close < 0) continue;

    const exported = exportedParent || Boolean(match[1]);
    const name = prefix ? `${prefix}.${match[2]!}` : match[2]!;
    const body = content.slice(open + 1, close);

    entries.push({
      exported,
      entry: {
        name,
        kind: 'namespace',
        signature: `namespace ${name}`,
        members: namespaceMemberNames(body),
        requiredMembers: [],
      },
    });

    collectNamespaceDeclarations(body, name, exported, entries);
    collectNamespaces(body, name, exported, entries);
    pattern.lastIndex = close + 1;
  }
}

function collectNamespaceDeclarations(
  body: string,
  prefix: string,
  exported: boolean,
  entries: ParsedDeclaration[],
): void {
  const direct = withoutNestedNamespaces(body);
  const add = (
    name: string,
    kind: SurfaceKind,
    signature: string,
    members: string[] = [],
    requiredMembers: string[] = [],
  ) => {
    entries.push({
      exported,
      entry: {
        name: `${prefix}.${name}`,
        kind,
        signature: collapse(signature.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`), `${prefix}.${name}`)),
        members,
        requiredMembers,
      },
    });
  };

  for (const match of direct.matchAll(/\b(?:declare\s+)?function\s+([A-Za-z_$][\w$]*)(?:<[^>{}]*>)?\s*\(/g)) {
    const start = match.index ?? 0;
    add(match[1]!, 'function', direct.slice(start, declarationEndOffset(direct, start)));
  }

  for (const match of direct.matchAll(/\b(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g)) {
    const start = match.index ?? 0;
    add(match[1]!, 'variable', direct.slice(start, declarationEndOffset(direct, start)));
  }

  for (const match of direct.matchAll(/\b(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\b/g)) {
    const start = match.index ?? 0;
    add(match[1]!, 'type', direct.slice(start, declarationEndOffset(direct, start)));
  }

  for (const match of direct.matchAll(/\b(?:declare\s+)?class\s+([A-Za-z_$][\w$]*)[^{;]*\{/g)) {
    const start = match.index ?? 0;
    const open = direct.indexOf('{', start);
    const close = matchingBraceOffset(direct, open);
    const bodyText = open >= 0 && close > open ? direct.slice(open + 1, close) : '';
    const members = typeMembers(bodyText, true);
    add(
      match[1]!,
      'class',
      direct.slice(start, open >= 0 ? open : declarationEndOffset(direct, start)),
      members.map((member) => member.name),
      members.filter((member) => member.required).map((member) => member.name),
    );
  }

  for (const match of direct.matchAll(/\b(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)[^{;]*\{/g)) {
    const start = match.index ?? 0;
    const open = direct.indexOf('{', start);
    const close = matchingBraceOffset(direct, open);
    const bodyText = open >= 0 && close > open ? direct.slice(open + 1, close) : '';
    const members = typeMembers(bodyText, false);
    add(
      match[1]!,
      'interface',
      direct.slice(start, open >= 0 ? open : declarationEndOffset(direct, start)),
      members.map((member) => member.name),
      members.filter((member) => member.required).map((member) => member.name),
    );
  }

  for (const match of direct.matchAll(/\b(?:declare\s+)?enum\s+([A-Za-z_$][\w$]*)[^{;]*\{/g)) {
    const start = match.index ?? 0;
    const open = direct.indexOf('{', start);
    const close = matchingBraceOffset(direct, open);
    const bodyText = open >= 0 && close > open ? direct.slice(open + 1, close) : '';
    add(
      match[1]!,
      'enum',
      direct.slice(start, open >= 0 ? open : declarationEndOffset(direct, start)),
      enumMembers(bodyText).map((member) => member.name),
    );
  }
}

function withoutNestedNamespaces(content: string): string {
  const ranges: Array<[number, number]> = [];
  const pattern =
    /\b(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\{/g;

  for (const match of content.matchAll(pattern)) {
    const open = content.indexOf('{', match.index);
    const close = matchingBraceOffset(content, open);
    if (open >= 0 && close >= 0) ranges.push([match.index ?? 0, close + 1]);
  }

  if (ranges.length === 0) return content;
  const chars = [...content];
  for (const [start, end] of ranges) {
    for (let i = start; i < end; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}

function namespaceMemberNames(body: string): string[] {
  const direct = withoutNestedNamespaces(body);
  const names = new Set<string>();

  for (const match of body.matchAll(/\b(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]!);
  }
  for (const match of direct.matchAll(/\b(?:declare\s+)?(?:function|class|interface|enum|type)\s+([A-Za-z_$][\w$]*)\b/g)) {
    names.add(match[1]!);
  }
  for (const match of direct.matchAll(/\b(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g)) {
    names.add(match[1]!);
  }

  return [...names];
}

function collectSimpleDeclarations(
  content: string,
  pattern: RegExp,
  kind: Extract<SurfaceKind, 'function' | 'variable' | 'type'>,
  entries: ParsedDeclaration[],
): void {
  for (const match of content.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = declarationEndOffset(content, start);
    entries.push({
      exported: Boolean(match[1]),
      entry: {
        name: match[2]!,
        kind,
        signature: collapse(content.slice(start, end)),
        members: [],
        requiredMembers: [],
      },
    });
  }
}

function collectBlockDeclarations(
  content: string,
  pattern: RegExp,
  kind: Extract<SurfaceKind, 'class' | 'interface' | 'enum'>,
  entries: ParsedDeclaration[],
): void {
  for (const match of content.matchAll(pattern)) {
    const start = match.index ?? 0;
    const open = content.indexOf('{', start);
    const close = matchingBraceOffset(content, open);
    const end = close >= 0 ? close + 1 : declarationEndOffset(content, start);
    const body = open >= 0 && close > open ? content.slice(open + 1, close) : '';
    const members = kind === 'enum' ? enumMembers(body) : typeMembers(body, kind === 'class');

    entries.push({
      exported: Boolean(match[1]),
      entry: {
        name: match[2]!,
        kind,
        signature: collapse(content.slice(start, open >= 0 ? open : end)),
        members: members.map((member) => member.name),
        requiredMembers: members.filter((member) => member.required).map((member) => member.name),
      },
    });
  }
}

function declarationEndOffset(content: string, start: number): number {
  const semicolon = content.indexOf(';', start);
  const brace = content.indexOf('{', start);
  if (brace >= 0 && (semicolon < 0 || brace < semicolon)) {
    const close = matchingBraceOffset(content, brace);
    return close >= 0 ? close + 1 : content.length;
  }
  return semicolon >= 0 ? semicolon + 1 : content.length;
}

function matchingBraceOffset(content: string, open: number): number {
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    const char = content[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function enumMembers(body: string): Array<{ name: string; required: boolean }> {
  return body
    .split(',')
    .map((part) => /^[\s\n]*([A-Za-z_$][\w$]*)/.exec(part)?.[1])
    .filter((name): name is string => Boolean(name))
    .map((name) => ({ name, required: false }));
}

function typeMembers(body: string, classBody: boolean): Array<{ name: string; required: boolean }> {
  const members: Array<{ name: string; required: boolean }> = [];
  const pattern =
    /(?:^|[;\n])\s*((?:public|protected|private|readonly|static|abstract|declare|override)\s+)*(#?[A-Za-z_$][\w$]*)(\?)?\s*(\(|:)/g;

  for (const match of body.matchAll(pattern)) {
    const modifiers = match[1] ?? '';
    const name = match[2]!;
    if (name === 'constructor' || modifiers.includes('private') || name.startsWith('#')) continue;
    members.push({
      name,
      required: classBody ? match[4] === ':' && !match[3] : !match[3],
    });
  }

  return members;
}

function exportBindings(list: string): Array<{ exported: string; local: string }> {
  const bindings: Array<{ exported: string; local: string }> = [];
  for (const part of list.split(',')) {
    const cleaned = part.replace(/\btype\s+/g, '').trim();
    if (!cleaned) continue;
    const [local, exported] = cleaned.split(/\s+as\s+/).map((piece) => piece.trim());
    if (!local) continue;
    bindings.push({ local, exported: exported || local });
  }
  return bindings;
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

    if (
      oldEntry.signature !== newEntry.signature &&
      oldEntry.kind !== 'interface' &&
      oldEntry.kind !== 'class' &&
      // Renaming a type parameter changes the text of a declaration without
      // changing a single thing about how it can be called. `zod` renamed `T`
      // to `Inner` across its 3.x line and, read as text, every generic export
      // it has "changed signature" — dozens of findings, each pointing at
      // working code, none of them true. Two declarations that differ only in
      // what their type parameters are spelled are the same declaration.
      !alphaEquivalent(oldEntry.signature, newEntry.signature)
    ) {
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

/**
 * Do two declarations differ only in what their type parameters are called?
 *
 * A type parameter is a bound name; renaming one is invisible to every caller,
 * exactly as renaming a function's local variable is. Comparing signatures as
 * raw text cannot see that, and the cost is not theoretical — a single
 * library-wide rename turns every generic export it has into a reported
 * breaking change, which is the kind of confident wrongness that gets a tool
 * switched off.
 *
 * Each declaration's own parameters are renamed to positional placeholders and
 * the results compared. Only the lists that actually declare parameters are
 * collected — a `<...>` group immediately followed by `(` — so a *use* like
 * `Promise<T>` is never mistaken for a declaration.
 *
 * The failure mode is one-sided by construction: a type parameter that happens
 * to share a name with a real type in the same signature can only ever cause a
 * rename-only difference to be missed, never a real change to be hidden, since
 * any other textual difference survives the substitution.
 */
export function alphaEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const left = normalizeTypeParameters(a);
  return left === normalizeTypeParameters(b) && left !== null;
}

function normalizeTypeParameters(signature: string): string | null {
  const declared = declaredTypeParameters(signature);
  if (declared.length === 0) return null;

  let normalized = signature;
  declared.forEach((name, position) => {
    normalized = normalized.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g'), `\u0000T${position}`);
  });
  return normalized;
}

/** Names bound by every `<...>` group that introduces type parameters. */
function declaredTypeParameters(signature: string): string[] {
  const names: string[] = [];

  for (let i = 0; i < signature.length; i++) {
    if (signature[i] !== '<') continue;

    const end = matchingAngle(signature, i);
    if (end === -1) continue;

    // A declaration list is followed by the thing it parameterises. Anything
    // else — `Promise<T>`, `Record<string, T>` — is a use, not a binding.
    const next = signature.slice(end + 1).trimStart()[0];
    if (next !== '(') {
      i = end;
      continue;
    }

    for (const entry of splitTopLevel(signature.slice(i + 1, end))) {
      const identifier = /^\s*(?:const\s+)?([A-Za-z_$][\w$]*)/.exec(entry);
      if (identifier && !names.includes(identifier[1]!)) names.push(identifier[1]!);
    }
    i = end;
  }

  return names;
}

/** Index of the `>` closing the `<` at `start`, or -1. */
function matchingAngle(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '<') depth += 1;
    else if (text[i] === '>') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on commas that are not nested inside brackets of any kind. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const character of text) {
    if ('<([{'.includes(character)) depth += 1;
    else if ('>)]}'.includes(character)) depth -= 1;

    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }

  if (current.trim()) parts.push(current);
  return parts;
}
