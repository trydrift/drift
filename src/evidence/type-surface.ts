import { fetchArchive, fetchJson, fetchText, mapWithConcurrency } from '../util/http.js';
import { count, measure } from '../util/profile.js';
import { readComputed, writeComputed } from '../util/artifact-cache.js';
import { readArchive, type ArchiveEntry } from '../util/archive.js';
import { withArticle } from '../util/prose.js';
import type { ModuleIncompatibleUsage, ModuleSystem } from '../types.js';

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
  | 'namespace'
  /**
   * A public symbol Drift can prove *exists* but whose declaration it could
   * not statically resolve — a Python explicit re-export (`from x import Foo`
   * listed in `__all__`) whose target lives in a package that was not parsed.
   * Paired with {@link SurfaceEntry.shapeUnknown}; never produced by a source
   * a parser could actually read, so `signature`/`members` carry no meaning
   * and {@link diffSurfaces} skips every shape comparison for it.
   */
  | 'unknown';

/** How a single callable parameter may be supplied by a caller. */
export type CallableParamKind =
  | 'positional-only'
  | 'positional-or-keyword'
  | 'keyword-only'
  | 'var-positional'
  | 'var-keyword';

export interface CallableParam {
  name: string;
  kind: CallableParamKind;
  /** A caller must supply it — no default, not a variadic. */
  required: boolean;
}

/**
 * A deterministic, language-neutral account of a callable's parameters, in
 * source order. Enough to decide caller compatibility; not a type system.
 */
export interface CallableShape {
  parameters: CallableParam[];
}

export interface SurfaceEntry {
  name: string;
  kind: SurfaceKind;
  /** Normalised declaration text, whitespace-collapsed, for comparison. */
  signature: string;
  /** Member names for classes/interfaces/enums, so we can diff them too. */
  members: string[];
  /** Optional semantic signatures for members whose identity is not enough. */
  memberSignatures?: Record<string, string>;
  /** Required member names, so optional -> required is detectable. */
  requiredMembers: string[];
  /**
   * The public symbol is known to exist, but its shape could not be resolved.
   *
   * Set only for a Python explicit re-export (`from pkg import Foo` with
   * `Foo` in `__all__`) whose target declaration Drift could not find in the
   * package it parsed — typically because the target is in a third-party
   * package. Existence is proven; `kind`/`signature`/`members` are
   * placeholders. {@link diffSurfaces} treats a shape-unknown entry as
   * present (so no `export-removed`) but compares none of its shape (so no
   * speculative `kind-changed`/`signature-changed`/`member-removed`). A
   * shape-unknown symbol that later goes missing entirely is still a real
   * `export-removed`, because existence genuinely disappeared.
   */
  shapeUnknown?: boolean;
  /**
   * The dependency this symbol is actually declared in.
   *
   * A wrapper package's own declarations can be one line long while its entire
   * API lives in packages it re-exports. `via` records where the declaration
   * came from so a finding can say so rather than implying the wrapper declared
   * it. Absent means the package declares the symbol itself.
   */
  via?: string;
  /**
   * A language-neutral description of how this symbol can be *called*, when the
   * producing reader can supply one.
   *
   * The human-readable {@link signature} is for display and for the TypeScript
   * text diff; it loses structure a Python signature needs to answer the only
   * question a call-site cares about — "can every call the old shape accepted
   * still be accepted by the new one". A single `defaults=N` count cannot say
   * which parameters are optional, which are keyword-only, where the
   * positional-only boundary is, or whether `*args`/`**kwargs` are present, so
   * {@link diffSurfaces} could not tell a safe optional-parameter addition
   * (`f(a)` → `f(a, b=None)`) from a real break and reported both. Set today by
   * the Python surface reader; absent for readers that do not populate it, in
   * which case the text diff is used exactly as before.
   */
  callable?: CallableShape;
  /**
   * Interfaces and classes this one inherits from.
   *
   * Resolved into `members` once every source has been read, because a base
   * declared in another file is not known while this one is being parsed.
   * Without it, the single most common refactor a growing library does —
   * lifting shared members into a base interface — reports every lifted member
   * as removed. One tidy-up, twenty findings, none of them true, and an agent
   * dispatched to restore methods that are still callable.
   */
  extends?: string[];
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
  | 'constant-value-changed'
  | 'commonjs-entry-removed'
  | 'exports-require-condition-removed'
  | 'package-type-changed'
  /**
   * The artifact now needs a newer language runtime than it did.
   *
   * Not an API change and not localizable to a call site: every consumer is
   * affected or none is, depending on one fact about their toolchain. Carried
   * here because the differ is what observes it — japicmp reads the class file
   * format version out of the bytecode — and `analyze` turns it into the
   * `runtime-requirement` breaking change the rest of the pipeline already
   * knows how to reason about.
   */
  | 'runtime-requirement-raised';

export interface SurfaceChange {
  kind: SurfaceChangeKind;
  symbol: string;
  detail: string;
  before?: string;
  after?: string;
  /** See `StructuredFinding.changed`. Only ever set on `signature-changed`. */
  changed?: 'parameters' | 'return-type' | 'both';
  /** The old declaration kind, set for removals and kind changes. */
  fromKind?: string;
  toKind?: string;
  moduleSystem?: {
    from?: ModuleSystem;
    to?: ModuleSystem;
    incompatibleUsage: ModuleIncompatibleUsage[];
    affectedSpecifiers?: string[];
    affectedSpecifierPatterns?: string[];
  };
}

const JSDELIVR_DATA = 'https://data.jsdelivr.com/v1/packages/npm';
const JSDELIVR_CDN = 'https://cdn.jsdelivr.net/npm';
const NPM_REGISTRY = 'https://registry.npmjs.org';
const MAX_NPM_TARBALL_BYTES = 50 * 1024 * 1024;
const MAX_NPM_UNPACKED_BYTES = 200 * 1024 * 1024;
const MAX_NPM_DECLARATION_BYTES = 20 * 1024 * 1024;

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
  /**
   * A public re-export edge could not be fully expanded.
   *
   * Set when the bounded re-export traversal stopped at {@link MAX_REEXPORT_DEPTH},
   * ran out of {@link MAX_TOTAL_FOLLOWED_PACKAGES} budget, or failed to fetch a
   * package that this surface re-exports from. It means a symbol absent from
   * this surface is not necessarily absent from the package's real API, so
   * {@link diffSurfaces} must not turn a via-dependency miss into a confident
   * `export-removed`. A cycle is *not* incompleteness — it terminates with the
   * full set of symbols reachable without looping.
   */
  incomplete: boolean;
}

/**
 * Context threaded through a bounded public re-export traversal.
 *
 * `vue` re-exports `@vue/runtime-dom`, which re-exports `@vue/runtime-core`,
 * which re-exports `@vue/reactivity` — and `ref`/`computed`/`watch` are only
 * declared in that last hop. Following one level saw them as removed. The
 * traversal now recurses along *public re-export edges only* (`export * from`,
 * `export { x } from`), carrying a shared package budget and a visited set so
 * cycles terminate and the total work stays deterministically bounded.
 */
export interface ReexportTraversal {
  /** How many re-export hops deep this fetch already is. 0 at the entry package. */
  depth: number;
  /** `name@version` nodes already on the current path — cycle guard. */
  visited: ReadonlySet<string>;
  /** Shared across the whole traversal: total packages still allowed to follow. */
  budget: { remaining: number };
}

/**
 * Surfaces already fetched in this process, keyed by exactly what decides
 * their content.
 *
 * A published version is immutable, so reading one twice can only ever produce
 * the same answer — and a scan reads the same one constantly: every candidate
 * follows up to eight of its own dependencies, and a repository's dependencies
 * overlap heavily (half the npm ecosystem's declarations lead back to the same
 * handful of packages). Without this, each of those repeats the whole
 * cost: a file listing, up to twenty-five declaration fetches, and the parse
 * over all of them.
 *
 * The promise is cached rather than the value, so two callers that ask at the
 * same time — which is the normal case at concurrency 8 — share one fetch
 * instead of racing to do identical work.
 *
 * Only a *surface* is remembered. A rejection is evicted, and so is `null`:
 * both mean "nothing was read", and this module cannot tell a package that
 * publishes no declarations from one whose declarations timed out — every
 * fetch under it answers `null` for either. Keeping that would turn one slow
 * response into "this package has no type surface" for the rest of the scan,
 * and quietly downgrade the strongest evidence Drift has for every later
 * candidate that depends on it. Retrying costs almost nothing when the answer
 * really was "no declarations", because the HTTP layer has already cached each
 * of those responses; it costs a second chance when it was not.
 *
 * Callers must treat the result as read-only; it is now shared.
 */
const surfaces = new Map<string, Promise<TypeSurface | null>>();

/** Fetch and parse the public type surface of one published npm version. */
export function fetchTypeSurface(
  packageName: string,
  version: string,
  options: { followDependencies?: boolean; traversal?: ReexportTraversal; subpath?: string } = {},
): Promise<TypeSurface | null> {
  // A traversal-scoped fetch depends on the path that reached it (visited set,
  // remaining budget), so it is not safe to share through the process-wide
  // memo keyed only by `(package, version)`. Compute it directly; the HTTP and
  // disk layers still absorb the repeated cost of the immutable pieces.
  if (options.traversal) {
    // Reached only after the parent already spent one unit of the shared
    // {@link MAX_TOTAL_FOLLOWED_PACKAGES} budget on this package, so this
    // counter is an exact tally of packages entered through a recursive public
    // re-export follow — the quantity the global bound constrains. Test seam.
    recursivePublicFollows += 1;
    return measure('surface', packageName, () => computeTypeSurface(packageName, version, options));
  }

  const key =
    `${packageName}@${version}#${options.followDependencies === false ? 'own' : 'deps'}` +
    (options.subpath ? `#${options.subpath}` : '');
  const cached = surfaces.get(key);
  if (cached) {
    count('surface.cache.hit');
    return cached;
  }

  count('surface.cache.miss');
  const pending = measure('surface', packageName, () => computeTypeSurface(packageName, version, options));
  surfaces.set(key, pending);
  pending.then(
    (surface) => {
      if (!surface) surfaces.delete(key);
    },
    () => surfaces.delete(key),
  );
  return pending;
}

/**
 * Packages entered through a recursive public re-export follow since the last
 * {@link clearTypeSurfaceCache}. Each increment is charged one unit of the
 * shared {@link MAX_TOTAL_FOLLOWED_PACKAGES} budget, so a single top-level
 * {@link fetchTypeSurface} must never leave this above that ceiling. Test seam
 * for the global-bound regression test.
 */
let recursivePublicFollows = 0;

/** Recursive public re-export follows since the last cache clear. Test seam. */
export function recursivePublicFollowCount(): number {
  return recursivePublicFollows;
}

/** Drop every memoized surface. Test seam, and the counterpart to `clearHttpCache`. */
export function clearTypeSurfaceCache(): void {
  surfaces.clear();
  listings.clear();
  npmArtifacts.clear();
  recursivePublicFollows = 0;
}

/**
 * Bump when `extractExports`, `resolveAliases`, `resolveInheritedMembers`, or
 * anything else that turns declaration text into a `SurfaceEntry` changes in a
 * way that could change their output. Part of the disk-cache key below, so a
 * fixed parser invalidates every entry it could have got wrong — the same
 * reason `src/evidence/surface/python.ts` fingerprints its reader, except that
 * script is a single template string this module cannot hash as cheaply
 * (2000+ lines of the parser it *is*, not calls into one), so the version is
 * hand-maintained here instead. No TTL: a published version's declarations
 * cannot change, so the only way this cache can be wrong is an unbumped parser
 * change, not staleness.
 */
const SURFACE_PARSER_VERSION = 6;

/** Storable form of {@link TypeSurface} — `Map` is not JSON. */
type StoredSurface = Omit<TypeSurface, 'api'> & { api: [string, SurfaceEntry][] };

function diskCacheKey(
  packageName: string,
  version: string,
  followDependencies: boolean,
  subpath?: string,
): string {
  return (
    `npm-surface:v${SURFACE_PARSER_VERSION}:${packageName}@${version}#${followDependencies ? 'deps' : 'own'}` +
    (subpath ? `#${subpath}` : '')
  );
}

/**
 * The declaration file a dependency publishes at one of its subpaths.
 *
 * `export * from 'lit-element/lit-element.js'` names an entry point, and the
 * package's `exports` map is what says which declaration file serves it. The
 * map is consulted first — it is the package's own answer — and the raw path is
 * expanded as a fallback for packages that publish subpaths without one.
 * `null` when the version publishes no such declaration, which is a hole in
 * the parent's surface and is reported as one rather than guessed past.
 */
async function resolveSubpathTypesEntry(
  packageName: string,
  version: string,
  pkg: Manifest | null,
  subpath: string,
): Promise<string | null> {
  const declared = typesFromExports(subpathExport(pkg?.exports, subpath));
  const candidates = [
    ...(declared ? expandTypesEntry(normalizePath(declared)) : []),
    ...expandTypesEntry(normalizePath(subpath)),
  ];

  const wanted = [...new Set(candidates)];
  const published = await firstPublished(packageName, version, wanted);
  if (published !== undefined) return published;
  for (const candidate of wanted) {
    if (await exists(packageName, version, candidate)) return candidate;
  }
  return null;
}

/** `@scope/pkg/sub` -> `@scope/pkg`; `lit-element/lit-element.js` -> `lit-element`. */
function packageOfSpecifier(specifier: string): string {
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0] ?? specifier;
}

/** The `exports` entry for `./<subpath>`, however the package spells the key. */
function subpathExport(exportsField: unknown, subpath: string): unknown {
  if (!exportsField || typeof exportsField !== 'object') return undefined;
  const record = exportsField as Record<string, unknown>;
  for (const key of [`./${subpath}`, subpath]) {
    if (key in record) return record[key];
  }
  return undefined;
}

async function computeTypeSurface(
  packageName: string,
  version: string,
  options: { followDependencies?: boolean; traversal?: ReexportTraversal; subpath?: string },
): Promise<TypeSurface | null> {
  const followDependencies = options.followDependencies !== false;
  const key = diskCacheKey(packageName, version, followDependencies, options.subpath);
  const remembered = await readComputed<StoredSurface>(key);
  if (remembered) {
    count('surface.diskCache.hit');
    return { ...remembered, incomplete: remembered.incomplete ?? false, api: new Map(remembered.api) };
  }
  count('surface.diskCache.miss');

  let manifest = await fetchManifest(packageName, version);
  // A subpath edge names one of the package's entry points, not its root, so
  // the root `types` field is the wrong file to read.
  let entryPath = options.subpath
    ? await resolveSubpathTypesEntry(packageName, version, manifest, options.subpath)
    : await resolveOwnTypesEntry(packageName, version, manifest);
  let collected = entryPath
    ? await measure('surface-sources', packageName, () =>
        collectDeclarationSources(packageName, version, entryPath!),
      )
    : { sources: [] as DeclarationSource[], truncated: false };

  // jsDelivr is the low-latency path, not the authority. If it cannot produce
  // a declaration surface, inspect the exact immutable artifact named by the
  // npm registry. A successful archive inspection can prove absence; a failed
  // download or malformed archive cannot.
  if (!entryPath || collected.sources.length === 0) {
    const artifact = await fetchNpmArtifact(packageName, version);
    if (!artifact) throw new ArtifactUnavailableError(packageName, version);
    manifest = artifact.manifest;
    // A subpath that publishes no declarations is not the package root. `pino`
    // ships `lib/symbols.js` and no `lib/symbols.d.ts`, so this fallback
    // handed back `pino.d.ts` and `require('pino/lib/symbols')` was judged
    // against the root API — which does not export `streamSym`, and reported
    // it missing from a file that never imported the root at all. There is no
    // surface for that entry point, and saying so is the honest answer.
    entryPath = options.subpath
      ? await resolveSubpathTypesEntryFromListing(manifest, options.subpath, artifact.files)
      : resolveOwnTypesEntryFromListing(packageName, manifest, artifact.files);
    if (entryPath) {
      collected = await measure('surface-sources', packageName, () =>
        collectDeclarationSources(packageName, version, entryPath!, artifact),
      );
      if (collected.sources.length === 0) throw new ArtifactUnavailableError(packageName, version);
    }
  }

  if (!entryPath) {
    // The subpath has to reach here too. DefinitelyTyped ships a declaration
    // file per entry point — `@types/react-dom` publishes `client.d.ts` and
    // `server.d.ts` beside its index — and resolving every one of them to the
    // index meant `react-dom/client` was judged against a surface that does
    // not export `hydrateRoot`. The own-types path above already threads it
    // through `resolveSubpathTypesEntry`; this branch did not.
    entryPath = await resolveDefinitelyTypedEntry(packageName, version, options.subpath);
    if (!entryPath) return null;
    collected = await measure('surface-sources', packageName, () =>
      collectDeclarationSources(packageName, version, entryPath!),
    );
  }
  const sources = collected.sources;
  // Whether the declaration walk read the package's whole graph. Folded into
  // `incomplete` below, because a surface assembled from a quarter of a
  // package cannot support a claim that a symbol is absent from it.
  const sourcesTruncated = collected.truncated;
  count('surface.declarationFiles', sources.length);
  if (sources.length === 0) return null;

  const api: SurfaceApi = new Map();
  // `export { a as b } from './other'` names something declared in a file this
  // one does not contain, so aliases are resolved after every source has been
  // parsed rather than as each is read.
  const aliases: ExportAlias[] = [];
  for (const source of sources) extractExports(source.content, source.path, api, aliases, packageName);
  resolveAliases(api, aliases);
  resolveInheritedMembers(api);

  const ownSymbols = api.size;
  const dependencyMerge =
    !manifest || !followDependencies
      ? { followed: [], attempted: false, incomplete: false }
      : await measure('surface-deps', packageName, () =>
          mergeDependencySurfaces(manifest, sources, api, `${packageName}@${version}`, options.traversal),
        );

  const result: TypeSurface | null =
    api.size > 0
      ? {
          api,
          entryPath,
          viaDependencies: dependencyMerge.followed,
          ownSymbols,
          subpaths: subpathsOf(manifest?.exports),
          // Two different ways of not having read the whole API, and either is
          // enough to make an absence meaningless: a public re-export edge that
          // could not be expanded, or a declaration graph larger than the file
          // budget. The second was silent until now, which is how a surface
          // holding 25 of graphql's 116 files reported itself complete.
          incomplete: dependencyMerge.incomplete || sourcesTruncated,
        }
      : null;

  // Only remembered when nothing about the answer depends on live registry
  // state. `dependencyMerge.attempted` is true exactly when a `dependencies`
  // range in the manifest needed resolving against *whatever currently
  // satisfies it* — a fact about the registry right now, not about
  // `packageName@version` alone, since a newer release matching the same
  // range can exist tomorrow (or the same range can fail to resolve today and
  // succeed on a retry). Caching indefinitely on either outcome — a
  // successful merge, or an attempt that resolved nothing (a transient
  // failure, not a fact about this version) — would freeze the wrong answer
  // in with no TTL to age it back out. `attempted` is deliberately not the
  // same test as `viaDependencies.length === 0`: a package whose dependency
  // resolution was attempted but merged zero symbols (every candidate failed
  // to fetch, say) still has `viaDependencies: []`, and must not be persisted
  // either — the naive gate would have cached exactly that failure as if it
  // were a dependency-free package's real answer. Only a surface where
  // resolution was never required at all — no dependencies declared, none
  // referenced, or `followDependencies: false` — is safe to remember
  // indefinitely.
  if (result && !dependencyMerge.attempted && !result.incomplete) {
    await writeComputed(key, { ...result, api: [...result.api] } satisfies StoredSurface);
  }

  return result;
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

/** The exact npm artifact could not be obtained and inspected authoritatively. */
export class ArtifactUnavailableError extends Error {
  constructor(
    readonly packageName: string,
    readonly version: string,
  ) {
    super(`${packageName}@${version} artifact could not be inspected`);
    this.name = 'ArtifactUnavailableError';
  }
}

interface Manifest {
  version?: string;
  types?: string;
  typings?: string;
  type?: string;
  exports?: unknown;
  main?: string;
  module?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function fetchManifest(packageName: string, version: string): Promise<Manifest | null> {
  return fetchJson<Manifest>(`${JSDELIVR_CDN}/${packageName}@${version}/package.json`);
}

export async function diffPackageModuleMetadata(
  packageName: string,
  from: string,
  to: string,
): Promise<SurfaceChange[]> {
  const [before, after] = await Promise.all([
    fetchManifest(packageName, from),
    fetchManifest(packageName, to),
  ]);
  if (!before || !after) return [];

  const beforeCjs = commonJsCompatibility(packageName, before);
  const afterCjs = commonJsCompatibility(packageName, after);
  const changes: SurfaceChange[] = [];

  const removedRequireConditions = [...beforeCjs.requireConditions].filter(
    (condition) => !afterCjs.requireConditions.has(condition) && !afterCjs.commonJsExports.has(condition),
  );
  for (const removed of removedRequireConditions) {
    const affected = specifierForExportPath(packageName, removed);
    const affectedKey = isExportPattern(removed) ? 'affectedSpecifierPatterns' : 'affectedSpecifiers';
    changes.push({
      kind: 'exports-require-condition-removed',
      symbol: packageName,
      detail:
        removed === '.'
          ? 'The root CommonJS export condition was removed'
          : `The CommonJS export condition for ${removed} was removed`,
      before: [...beforeCjs.requireConditions].sort().join('\n'),
      after: [...afterCjs.requireConditions].sort().join('\n') || '(none)',
      moduleSystem: {
        from: 'dual',
        to: 'esm',
        incompatibleUsage: ['require'],
        [affectedKey]: [affected],
      },
    });
  }

  const rootRequireConditionRemoved = removedRequireConditions.includes('.');
  if (beforeCjs.hasRootCommonJsEntry && !afterCjs.hasRootCommonJsEntry && !rootRequireConditionRemoved) {
    changes.push({
      kind: 'commonjs-entry-removed',
      symbol: packageName,
      detail: 'The package no longer exposes a CommonJS-compatible entry point',
      before: beforeCjs.entrySummary,
      after: afterCjs.entrySummary,
      moduleSystem: {
        from: 'dual',
        to: 'esm',
        incompatibleUsage: ['require'],
        affectedSpecifiers: [packageName],
      },
    });
  } else if (
    before.type !== after.type
    && after.type === 'module'
    && !afterCjs.hasRootCommonJsEntry
    && !rootRequireConditionRemoved
  ) {
    changes.push({
      kind: 'package-type-changed',
      symbol: packageName,
      detail: 'The package type changed to ESM without a CommonJS-compatible entry point',
      before: packageTypeSummary(before),
      after: packageTypeSummary(after),
      moduleSystem: {
        from: 'dual',
        to: 'esm',
        incompatibleUsage: ['require'],
        affectedSpecifiers: [packageName],
      },
    });
  }

  return dedupeModuleMetadataChanges(changes);
}

interface CommonJsCompatibility {
  hasRootCommonJsEntry: boolean;
  requireConditions: Set<string>;
  commonJsExports: Set<string>;
  entrySummary: string;
}

function commonJsCompatibility(packageName: string, manifest: Manifest): CommonJsCompatibility {
  const requireConditions = requireConditionsIn(manifest.exports);
  const commonJsExports = commonJsExportsIn(manifest.exports, manifest);
  const hasRootCommonJsEntry =
    manifest.exports !== undefined
      ? commonJsExports.has('.')
      : entryLooksCommonJs(manifest.main, manifest) || entryLooksCommonJs('./index.js', manifest);

  const entrySummary = [
    `type: ${manifest.type ?? '(absent)'}`,
    manifest.exports === undefined && manifest.main ? `main: ${manifest.main}` : '',
    manifest.module ? `module: ${manifest.module}` : '',
    requireConditions.size > 0
      ? `exports.require: ${[...requireConditions].sort().map((path) => specifierForExportPath(packageName, path)).join(', ')}`
      : '',
    commonJsExports.size > 0
      ? `exports.commonjs: ${[...commonJsExports].sort().map((path) => specifierForExportPath(packageName, path)).join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n') || '(no CommonJS-compatible entry point detected)';

  return { hasRootCommonJsEntry, requireConditions, commonJsExports, entrySummary };
}

function requireConditionsIn(exportsField: unknown): Set<string> {
  const out = new Set<string>();
  visitExports(exportsField, '.', out);
  return out;
}

function visitExports(value: unknown, path: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const nested of value) visitExports(nested, path, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const entries = Object.entries(value as Record<string, unknown>);
  const isSubpathMap = entries.some(([key]) => key === '.' || key.startsWith('./'));
  for (const [key, nested] of entries) {
    if (key === 'require') out.add(path);
    if (isSubpathMap && (key === '.' || key.startsWith('./'))) visitExports(nested, key, out);
    else if (typeof nested === 'object') visitExports(nested, path, out);
  }
}

function commonJsExportsIn(exportsField: unknown, manifest: Manifest): Set<string> {
  const out = new Set<string>();
  visitCommonJsExports(exportsField, '.', manifest, out);
  return out;
}

function visitCommonJsExports(value: unknown, path: string, manifest: Manifest, out: Set<string>): void {
  if (exportValueLooksCommonJs(value, manifest)) out.add(path);
  if (Array.isArray(value)) {
    for (const nested of value) visitCommonJsExports(nested, path, manifest, out);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const entries = Object.entries(value as Record<string, unknown>);
  const isSubpathMap = entries.some(([key]) => key === '.' || key.startsWith('./'));
  if (!isSubpathMap) return;
  for (const [key, nested] of entries) {
    if (key === '.' || key.startsWith('./')) visitCommonJsExports(nested, key, manifest, out);
  }
}

function specifierForExportPath(packageName: string, exportPath: string): string {
  if (exportPath === '.') return packageName;
  return `${packageName}/${exportPath.replace(/^\.\//, '')}`;
}

function isExportPattern(exportPath: string): boolean {
  return exportPath.includes('*');
}

function exportValueLooksCommonJs(value: unknown, manifest: Manifest): boolean {
  if (typeof value === 'string') return entryLooksCommonJs(value, manifest);
  if (Array.isArray(value)) return value.some((nested) => exportValueLooksCommonJs(nested, manifest));
  if (!value || typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  if ('require' in record) return exportRequireValueLooksCommonJs(record.require);
  if ('node' in record && exportValueLooksCommonJs(record.node, manifest)) return true;
  if ('default' in record) return exportValueLooksCommonJs(record.default, manifest);
  return false;
}

/**
 * A target selected through an explicit `exports.require` condition is part of
 * the package's CommonJS contract. Ambiguous `.js` files must not be
 * reinterpreted using the root package `type`: dual-package build layouts can
 * place a nearer `type: commonjs` marker beside that target. An explicit ESM
 * extension remains contradictory evidence.
 */
function exportRequireValueLooksCommonJs(value: unknown): boolean {
  if (typeof value === 'string') return !/\.mjs$/i.test(value);
  if (Array.isArray(value)) return value.some(exportRequireValueLooksCommonJs);
  if (!value || typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  if ('require' in record) return exportRequireValueLooksCommonJs(record.require);
  if ('node' in record && exportRequireValueLooksCommonJs(record.node)) return true;
  if ('default' in record) return exportRequireValueLooksCommonJs(record.default);
  return false;
}

function entryLooksCommonJs(entry: string | undefined, manifest: Manifest): boolean {
  if (!entry) return false;
  if (/\.cjs$/i.test(entry)) return true;
  if (/\.mjs$/i.test(entry)) return false;
  if (/\.[jt]sx?$/i.test(entry)) return manifest.type !== 'module';
  return manifest.type !== 'module';
}

function packageTypeSummary(manifest: Manifest): string {
  return `type: ${manifest.type ?? '(absent)'}\n${manifest.main ? `main: ${manifest.main}` : 'main: (absent)'}`;
}

function dedupeModuleMetadataChanges(changes: SurfaceChange[]): SurfaceChange[] {
  const seen = new Set<string>();
  return changes.filter((change) => {
    const exact = change.moduleSystem?.affectedSpecifiers?.join(',') ?? '';
    const patterns = change.moduleSystem?.affectedSpecifierPatterns?.join(',') ?? '';
    const key = `${change.kind}:${exact}:${patterns}:${change.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* What a published version actually contains                          */
/* ------------------------------------------------------------------ */

/** One flat file listing per package version, for this process's lifetime. */
const listings = new Map<string, Promise<ReadonlySet<string> | null>>();
const npmArtifacts = new Map<string, Promise<NpmArtifact | null>>();

interface NpmArtifact {
  manifest: Manifest;
  /** Safe package-root paths only; archive wrapper `package/` is removed. */
  files: ReadonlyMap<string, ArchiveEntry>;
}

interface NpmVersionMetadata {
  version?: string;
  dist?: { tarball?: string };
}

/** Read one exact npm release artifact without extracting or executing it. */
function fetchNpmArtifact(packageName: string, version: string): Promise<NpmArtifact | null> {
  const key = `${packageName}@${version}`;
  const cached = npmArtifacts.get(key);
  if (cached) return cached;

  const encodedName = encodeURIComponent(packageName).replaceAll('%40', '@');
  const pending = (async (): Promise<NpmArtifact | null> => {
    const metadata = await fetchJson<NpmVersionMetadata>(
      `${NPM_REGISTRY}/${encodedName}/${encodeURIComponent(version)}`,
      { immutable: true },
    );
    if (!metadata?.dist?.tarball || metadata.version !== version) return null;

    const downloaded = await fetchArchive(metadata.dist.tarball, {
      maxBytes: MAX_NPM_TARBALL_BYTES,
      timeoutMs: 60_000,
      retries: 2,
    });
    if (!downloaded.ok) return null;

    let entries: ArchiveEntry[];
    try {
      entries = readArchive(downloaded.bytes, { maxDecompressedBytes: MAX_NPM_UNPACKED_BYTES });
    } catch {
      return null;
    }
    if (entries.length === 0) return null;

    const totalSize = entries.reduce((sum, entry) => sum + Math.max(0, entry.size), 0);
    if (!Number.isSafeInteger(totalSize) || totalSize > MAX_NPM_UNPACKED_BYTES) return null;

    const files = new Map<string, ArchiveEntry>();
    for (const entry of entries) {
      const safe = safeNpmArchivePath(entry.path);
      if (safe === null) return null;
      if (!safe || files.has(safe)) continue;
      files.set(safe, entry);
    }

    const packageJson = files.get('package.json');
    if (!packageJson || packageJson.size > 1024 * 1024) return null;
    let manifest: Manifest;
    try {
      manifest = JSON.parse(packageJson.read().toString('utf8')) as Manifest;
    } catch {
      return null;
    }
    if (manifest.version !== version) return null;
    return { manifest, files };
  })();

  npmArtifacts.set(key, pending);
  pending.then((artifact) => {
    if (!artifact) npmArtifacts.delete(key);
  }, () => npmArtifacts.delete(key));
  return pending;
}

/** Reject absolute/traversing archive names before exposing package-root paths. */
function safeNpmArchivePath(raw: string): string | null {
  const path = raw.replaceAll('\\', '/');
  if (!path || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:\//.test(path)) return null;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..')) return null;
  while (segments[0] === '.' || segments[0] === '') segments.shift();
  if (segments[0] === 'package') segments.shift();
  return segments.join('/');
}

/**
 * Every file a published version contains, as one request.
 *
 * Resolving a package's declarations used to be done entirely by guessing and
 * probing: five candidate paths for the `types` field, five conventional entry
 * points, and five more for each of the twenty-five re-exports the traversal
 * follows — each one a CDN round trip that usually 404s, each one waited on
 * before the next was tried. On a package with a wide barrel file that is
 * *hundreds* of sequential requests to learn something jsDelivr will state
 * outright in a single one.
 *
 * So the listing is fetched once and every "does this path exist" question is
 * answered from memory. A version's contents cannot change, so it is cached as
 * immutable and shared by both the entry-point resolution and the traversal.
 *
 * `null` when the listing is unavailable — a tag rather than an exact version,
 * a CDN that will not answer — and every caller falls back to probing, which
 * is what they did before this existed.
 */
function fileListing(packageName: string, version: string): Promise<ReadonlySet<string> | null> {
  const key = `${packageName}@${version}`;
  const cached = listings.get(key);
  if (cached) return cached;

  const pending = fetchJson<{ files?: { name?: string }[] }>(
    `${JSDELIVR_DATA}/${packageName}@${version}?structure=flat`,
    { immutable: true, retries: 0 },
  )
    .then((body) => {
      if (!body?.files) return null;
      // jsDelivr names every file from the package root with a leading slash;
      // every path Drift asks about is relative, so the slash comes off here
      // rather than at each of the call sites.
      return new Set(
        body.files
          .map((file) => file.name)
          .filter((name): name is string => typeof name === 'string')
          .map((name) => (name.startsWith('/') ? name.slice(1) : name)),
      ) as ReadonlySet<string>;
    })
    .catch(() => null);

  listings.set(key, pending);
  return pending;
}

/**
 * The first of `candidates` this version actually publishes.
 *
 * `undefined` — as distinct from `null` — means the listing could not be read,
 * so the caller has to probe rather than conclude the paths are absent.
 */
async function firstPublished(
  packageName: string,
  version: string,
  candidates: readonly string[],
): Promise<string | null | undefined> {
  const listing = await fileListing(packageName, version);
  if (!listing) return undefined;
  return candidates.find((candidate) => listing.has(candidate)) ?? null;
}

/* ------------------------------------------------------------------ */
/* Dependencies a package publishes its API through                    */
/* ------------------------------------------------------------------ */

/**
 * How many *implementation-only* dependencies one package's surface may be
 * assembled from — a dependency whose symbols merely appear in an exported
 * signature, not one this package re-exports.
 *
 * A wrapper has a handful; anything past that is a package whose own
 * declarations are the API, and following further only buys latency. Silent
 * truncation past this bound is acceptable *here* because an implementation
 * reference cannot carry part of the package's own public API — see
 * {@link isPublicReexportEdge}. Public re-export edges are deliberately *not*
 * governed by this count: they are bounded only by {@link MAX_REEXPORT_DEPTH}
 * and {@link MAX_TOTAL_FOLLOWED_PACKAGES}, and any public edge left unfollowed
 * marks the surface {@link TypeSurface.incomplete}.
 */
const MAX_IMPLEMENTATION_DEPENDENCIES = 8;

/** Concurrency for the version-resolve and non-recursive surface-fetch waves. */
const DEPENDENCY_FETCH_WIDTH = 8;

/**
 * How many public re-export hops the traversal will follow from the entry
 * package. `vue -> @vue/runtime-dom -> @vue/runtime-core -> @vue/reactivity` is
 * three; four leaves headroom for one more wrapper layer without letting an
 * adversarial graph walk forever.
 */
const MAX_REEXPORT_DEPTH = 4;

/**
 * Total packages any single entry-surface traversal may follow, across every
 * hop and branch. A deterministic ceiling on the work one `fetchTypeSurface`
 * can trigger; hitting it marks the surface {@link TypeSurface.incomplete}
 * rather than silently dropping symbols.
 */
const MAX_TOTAL_FOLLOWED_PACKAGES = 24;

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
/**
 * What merging a package's dependency-followed symbols in actually decided.
 *
 * `followed` is what {@link computeTypeSurface} exposes as `viaDependencies` —
 * the dependencies that contributed at least one symbol. `attempted` is a
 * separate question a caller deciding whether this result is safe to cache
 * indefinitely needs answered, and `followed.length === 0` cannot answer it:
 * that is also true when live range-based resolution was tried and failed
 * (a transient fetch error, an unreachable dependency), not only when none
 * was needed at all. Only `attempted === false` means the answer is pure in
 * `(packageName, version)` — see the write gate in `computeTypeSurface`.
 */
interface DependencyMergeResult {
  followed: string[];
  attempted: boolean;
  /**
   * A public re-export edge could not be fully expanded — depth or budget
   * exhausted, or a re-exported package failed to fetch. Propagated to
   * {@link TypeSurface.incomplete} so a via-dependency miss is not reported as
   * a confident removal.
   */
  incomplete: boolean;
}

/** Does this reference bring symbols in through a public re-export statement? */
function isPublicReexportEdge(reference: ExternalReference): boolean {
  return reference.star || reference.reExported.size > 0;
}

async function mergeDependencySurfaces(
  manifest: Manifest | null,
  sources: readonly DeclarationSource[],
  api: SurfaceApi,
  selfNode: string,
  traversal: ReexportTraversal | undefined,
): Promise<DependencyMergeResult> {
  const declared = { ...manifest?.dependencies, ...manifest?.peerDependencies };

  // An `export * from '<module>'` whose package this manifest does not declare
  // can never be followed, and dropping it silently is how a surface came back
  // claiming to be whole while missing an entire module's exports.
  //
  // `@types/graceful-fs` is the case, and it is one line long:
  //
  //     export * from "fs";
  //
  // `fs` is a Node builtin, so it is in no manifest. This has to be computed
  // before the no-dependencies return below, not after: `graceful-fs` declares
  // no dependencies at all, so that return is the one that fires, and a check
  // placed after it never runs for precisely the packages it exists for. The
  // surface reported `incomplete: false` holding one symbol — `gracefulify` —
  // and every other name it re-exports was called missing from a list that
  // said it was complete.
  //
  // Only star edges count. A named re-export names what it takes, so the
  // symbols it contributes are known even when the target is not read; a star
  // takes everything, and what "everything" is cannot be known without it.
  const unfollowableStar = [...externalReferences(sources, api)].some(
    ([specifier, reference]) => reference.star && !declared[packageOfSpecifier(specifier)],
  );

  if (Object.keys(declared).length === 0) {
    return { followed: [], attempted: false, incomplete: unfollowableStar };
  }

  const depth = traversal?.depth ?? 0;
  const budget = traversal?.budget ?? { remaining: MAX_TOTAL_FOLLOWED_PACKAGES };
  const visited = new Set<string>([...(traversal?.visited ?? []), selfNode]);

  // A re-export can name a *subpath* of a dependency rather than the
  // dependency itself: `lit@2` publishes nothing of its own and is entirely
  // `export * from 'lit-element/lit-element.js'`. Matching the specifier
  // against `dependencies` verbatim never found `lit-element`, so the edge was
  // dropped, no symbols were merged, and the whole package resolved to "no
  // public surface". The package is what carries the version range; the
  // subpath is which of its entry points to read.
  const wanted = [...externalReferences(sources, api)]
    .map(([specifier, reference]) => {
      const pkg = packageOfSpecifier(specifier);
      const subpath = specifier.length > pkg.length ? specifier.slice(pkg.length + 1) : undefined;
      return { specifier, reference, pkg, subpath };
    })
    .filter((edge) => declared[edge.pkg]);

  const attempted = wanted.length > 0;
  if (!attempted) return { followed: [], attempted: false, incomplete: unfollowableStar };

  const followed: string[] = [];
  let incomplete = false;

  // The traversal is split into three phases so its output is a pure function
  // of the (deterministic) reference order and the entry budget — never of
  // which network response happened to land first:
  //
  //   1. resolve every dependency's pinned version, concurrently. Each answer
  //      depends only on (specifier, range), so order cannot matter.
  //   2. decide, synchronously and strictly in reference order, which edges to
  //      follow and how much recursion budget each draws. No await here.
  //   3. fetch the planned surfaces and merge them in reference order.
  //      Non-recursive fetches run concurrently; the recursive descent runs
  //      one edge at a time so the *shared* budget is drawn down in a single
  //      deterministic depth-first order rather than a race between subtrees.

  // Phase 1 — versions.
  const resolvedVersions = await mapWithConcurrency(wanted, DEPENDENCY_FETCH_WIDTH, (edge) =>
    resolveDependencyVersion(edge.pkg, declared[edge.pkg]!),
  );

  // Phase 2 — plan.
  interface EdgePlan {
    specifier: string;
    /** The dependency that carries the version range. */
    pkg: string;
    /** Which of its entry points this edge names, when not the root. */
    subpath: string | undefined;
    reference: ExternalReference;
    resolved: string;
    /** A genuine `export * from` / `export { x } from` edge. */
    publicEdge: boolean;
    /** Recurse into this edge's own re-exports (public edge, within depth+budget, not a cycle). */
    recurse: boolean;
  }
  const plan: EdgePlan[] = [];
  let implementationFollows = 0;
  for (const [index, { specifier, reference, pkg, subpath }] of wanted.entries()) {
    const resolved = resolvedVersions[index];
    const publicEdge = isPublicReexportEdge(reference);

    if (!resolved) {
      // A public re-export edge whose version could not be resolved is a hole
      // in this surface — not evidence the dependency exports nothing, so a
      // symbol missing beyond it must not become a confident `export-removed`.
      // An implementation-only edge that fails to resolve is skipped as before.
      if (publicEdge) incomplete = true;
      continue;
    }

    const cycle = visited.has(`${specifier}@${resolved}`);

    if (!publicEdge) {
      // Implementation-only dependency: bounded, and silent truncation past the
      // bound is acceptable — it cannot hide part of this package's own API.
      if (implementationFollows >= MAX_IMPLEMENTATION_DEPENDENCIES) continue;
      implementationFollows += 1;
      plan.push({ specifier, pkg, subpath, reference, resolved, publicEdge, recurse: false });
      continue;
    }

    // Public re-export edge — always inspected, never dropped for a count.
    // Recurse when depth and budget allow and it is not a cycle; otherwise the
    // immediate surface is still fetched (one bounded fetch) but this surface
    // is marked incomplete, because a symbol absent beyond an unfollowed hop
    // cannot be told apart from a removal. A cycle is *not* incompleteness — it
    // terminates with everything reachable without looping.
    const canRecurse = !cycle && depth < MAX_REEXPORT_DEPTH && budget.remaining > 0;
    if (canRecurse) budget.remaining -= 1;
    else if (!cycle) incomplete = true;
    plan.push({ specifier, pkg, subpath, reference, resolved, publicEdge, recurse: canRecurse });
  }

  // Phase 3 — fetch and merge.
  const fetchedSurfaces = new Array<TypeSurface | null>(plan.length);
  await mapWithConcurrency(
    plan.map((entry, index) => ({ entry, index })),
    DEPENDENCY_FETCH_WIDTH,
    async ({ entry, index }) => {
      if (entry.recurse) return; // fetched in the sequential pass below
      fetchedSurfaces[index] = await fetchTypeSurface(entry.pkg, entry.resolved, {
        followDependencies: false,
        ...(entry.subpath ? { subpath: entry.subpath } : {}),
      }).catch(() => null);
    },
  );
  for (const [index, entry] of plan.entries()) {
    if (!entry.recurse) continue;
    fetchedSurfaces[index] = await fetchTypeSurface(entry.pkg, entry.resolved, {
      followDependencies: true,
      ...(entry.subpath ? { subpath: entry.subpath } : {}),
      traversal: {
        depth: depth + 1,
        visited: new Set([...visited, `${entry.specifier}@${entry.resolved}`]),
        budget,
      },
    }).catch(() => null);
  }

  for (const [index, entry] of plan.entries()) {
    const surface = fetchedSurfaces[index];
    // A public edge whose surface could not be fetched at all, or whose own
    // traversal came back incomplete, propagates that incompleteness up.
    if (entry.publicEdge && !surface) incomplete = true;
    if (surface?.incomplete) incomplete = true;
    if (!surface) continue;

    let merged = 0;
    for (const [exportedAs, declaredAs] of entry.reference.names(surface.api)) {
      const declEntry = surface.api.get(declaredAs);
      if (!declEntry) continue;
      // A name the parent genuinely re-exports — `export { x } from` or
      // `export * from` — is one of the parent's *own* public exports and is
      // keyed bare, so a leaf removal three hops down still lines up with the
      // wrapper's symbol on the other side of the diff. An implementation
      // import that merely surfaced in a signature is keyed by origin, so it
      // cannot silently mask a same-named symbol the wrapper declares itself.
      const key =
        entry.reference.star || entry.reference.reExported.has(exportedAs)
          ? exportedAs
          : `${entry.specifier}#${exportedAs}`;
      if (api.has(key)) continue;
      api.set(key, { ...renameEntry(declEntry, exportedAs), via: entry.specifier });
      merged += 1;
    }

    if (merged > 0) followed.push(`${entry.specifier}@${entry.resolved}`);
  }

  return { followed, attempted, incomplete: incomplete || unfollowableStar };
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
async function resolveOwnTypesEntry(
  packageName: string,
  version: string,
  pkg: Manifest | null,
): Promise<string | null> {
  // Every path this function would otherwise probe for, in the order it would
  // have probed them. Asked of the listing as one question, so the common case
  // costs no requests at all beyond the listing itself; a version with no
  // listing falls back to the same sequential probing as before.
  const wanted = typeEntryCandidates(packageName, pkg);

  const published = await firstPublished(packageName, version, wanted);
  if (published !== undefined) {
    if (published) return published;
  } else {
    for (const candidate of wanted) {
      if (await exists(packageName, version, candidate)) return candidate;
    }
  }

  return null;
}

function resolveOwnTypesEntryFromListing(
  packageName: string,
  pkg: Manifest,
  files: ReadonlyMap<string, ArchiveEntry>,
): string | null {
  return typeEntryCandidates(packageName, pkg).find((candidate) => files.has(candidate)) ?? null;
}

/**
 * The declaration file for one entry point, read from the published artifact.
 *
 * `null` is a real answer and the reason this exists: an entry point can ship
 * JavaScript and no declarations, and the root's `types` field describes a
 * different module. `pino` publishes `lib/symbols.js` with no
 * `lib/symbols.d.ts`, and falling back to `pino.d.ts` had
 * `require('pino/lib/symbols')` judged against the root API — which does not
 * export `streamSym`, so a name that is genuinely there was reported missing.
 */
function resolveSubpathTypesEntryFromListing(
  pkg: Manifest,
  subpath: string,
  files: ReadonlyMap<string, ArchiveEntry>,
): string | null {
  const declared = typesFromExports(subpathExport(pkg?.exports, subpath));
  const candidates = [
    ...(declared ? expandTypesEntry(normalizePath(declared)) : []),
    ...expandTypesEntry(normalizePath(subpath)),
  ];
  return [...new Set(candidates)].find((candidate) => files.has(candidate)) ?? null;
}

function typeEntryCandidates(packageName: string, pkg: Manifest | null): string[] {
  const wanted: string[] = [];
  if (pkg) {
    const declared = pkg.types ?? pkg.typings ?? typesFromExports(pkg.exports);
    // A `types` field routinely points at a directory or an extensionless
    // path (`"types": "dist/source"`) rather than a `.d.ts` file. Fetching it
    // verbatim 404s and silently costs us the strongest evidence we have, so
    // try the conventional expansions before giving up.
    if (declared) wanted.push(...expandTypesEntry(normalizePath(declared)));
    // A JS entry point often has a sibling declaration file.
    if (pkg.main) wanted.push(normalizePath(pkg.main).replace(/\.(c|m)?js$/, '.d.ts'));
  }
  wanted.push(...conventionalTypeEntries(packageName));
  return [...new Set(wanted)];
}

/**
 * The `@types/<pkg>` release line that documents *this* version.
 *
 * DefinitelyTyped versions its packages to match the major (and usually the
 * minor) of what they describe: `@types/express@4` is express 4's API,
 * `@types/express@5` is express 5's. Resolving both sides to `latest` — the
 * same bytes twice — is what made every `@types`-only package incomparable,
 * and it is a large slice of npm: express, lodash and everything else whose
 * declarations live outside the package.
 *
 * The major line is a convention, not a guarantee, so a range that does not
 * resolve falls back to `latest` rather than failing. When *both* sides fall
 * back the entry paths are equal, and `computeTypeSurface` still declines to
 * compare — nothing was learned, and saying so is the point.
 */
export async function resolveDefinitelyTypedEntry(
  packageName: string,
  version: string,
  subpath?: string,
): Promise<string | null> {
  const dtName = packageName.startsWith('@')
    ? `@types/${packageName.slice(1).replace('/', '__')}`
    : `@types/${packageName}`;

  // A subpath is its own declaration file, and DefinitelyTyped ships them
  // beside the index: `@types/react-dom` publishes `client.d.ts`, `server.d.ts`
  // and `server.edge.d.ts`. Resolving every one of them to `index.d.ts` meant
  // `import { hydrateRoot } from 'react-dom/client'` was judged against the
  // root entry, which does not export it — thirty-three correct imports across
  // the corpus reported as naming something that does not exist.
  //
  // The subpath rides on the entry path so `definitelyTypedTarget` can hand it
  // back to the walk as the file to start from.
  const file = subpath ? `${subpath}.d.ts` : 'index.d.ts';
  const suffix = subpath ? `#${subpath}` : '';

  const major = /^\D*(\d+)\./.exec(version)?.[1] ?? /^\D*(\d+)$/.exec(version)?.[1];
  if (major && (await exists(dtName, major, file))) return `@types:${dtName}@${major}${suffix}`;
  if (await exists(dtName, 'latest', file)) return `@types:${dtName}@latest${suffix}`;

  // A subpath DefinitelyTyped does not publish gets no answer, rather than the
  // root's. Falling back looked harmless — the package still resolved — but it
  // handed one entry point's declarations to a question asked about a
  // different one, and nothing downstream could tell the substitute from the
  // real thing. `require('pino/lib/symbols')` reaches an internal module with
  // no declarations anywhere; it was judged against `@types/pino`'s root and
  // `streamSym` was reported missing from a module that does define it.
  //
  // `null` here surfaces as "no declarations were readable for that entry
  // point", which is what is actually known.
  return null;
}

/** Split `@types:@types/express@4` into the package and the range to fetch. */
export function definitelyTypedTarget(entryPath: string): {
  name: string;
  range: string;
  subpath?: string;
} {
  const raw = entryPath.slice('@types:'.length);
  // `@types:@types/react-dom@19#client` — the subpath, when one was resolved,
  // names the declaration file the walk must start from rather than `index`.
  const hash = raw.indexOf('#');
  const spec = hash === -1 ? raw : raw.slice(0, hash);
  const subpath = hash === -1 ? undefined : raw.slice(hash + 1);

  const at = spec.lastIndexOf('@');
  // `lastIndexOf` lands on the version separator, never on the scope's own
  // leading `@`, because the range is always appended.
  const base =
    at > 0 ? { name: spec.slice(0, at), range: spec.slice(at + 1) } : { name: spec, range: 'latest' };
  return subpath ? { ...base, subpath } : base;
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
  const candidates = [`${base}.d.ts`, `${base}.d.cts`, `${base}.d.mts`, `${base}/index.d.ts`];

  // A JavaScript file is never a declaration file, so it must not survive as
  // the last-resort candidate. `uuid@9` publishes no `types` field and an
  // `exports` map whose only reachable string is `./dist/esm-browser/index.js`;
  // that path exists, so it was selected as the types entry, parsed as
  // TypeScript to zero exported symbols, and the package was reported as
  // having no public surface — while `@types/uuid@9` sat unread, because the
  // DefinitelyTyped fallback only runs when *no* entry was found at all.
  if (!/\.(c|m)?js$/.test(declared)) candidates.push(declared);
  return candidates;
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
  artifact?: NpmArtifact,
): Promise<{ sources: DeclarationSource[]; truncated: boolean }> {
  // A DefinitelyTyped package is read the same way as any other. Returning its
  // entry file alone was a silent amputation: `@types/semver` declares seven
  // types in `index.d.ts` and publishes its entire function API through forty
  // `import x = require("./functions/y")` re-exports in sibling files, none of
  // which were ever fetched — so `valid`, `satisfies`, `coerce` and `gt` were
  // absent from a surface that reported itself complete. The only thing that
  // differs here is which CDN path the files are read from.
  const dt = entryPath.startsWith('@types:') ? definitelyTypedTarget(entryPath) : null;
  const cdnBase = dt ? `${dt.name}@${dt.range}` : `${packageName}@${version}`;
  const startPath = dt ? (dt.subpath ? `${dt.subpath}.d.ts` : 'index.d.ts') : entryPath;

  // A DefinitelyTyped range (`4`, `latest`) is not an exact version, so there
  // is no file listing to ask — candidates are probed in order, which is the
  // same path taken for any package whose listing is unavailable.
  const listing = dt
    ? null
    : artifact
      ? (new Set(artifact.files.keys()) as ReadonlySet<string>)
      : await fileListing(packageName, version);
  let declarationBytes = 0;

  // Each re-export expands to five candidate paths rather than two, so the
  // queue holds candidate *groups* and stops at the first that resolves. With
  // a listing to consult, "which of these five" costs nothing and the group is
  // one fetch; without one it degrades to probing them in order, as before.
  const sources: DeclarationSource[] = [];
  const seen = new Set<string>();
  const queue: string[][] = [[startPath]];

  const resolveGroup = async (candidates: readonly string[]): Promise<DeclarationSource | null> => {
    const published = listing ? (candidates.find((path) => listing.has(path)) ?? null) : undefined;
    for (const path of published === undefined ? candidates : published ? [published] : []) {
      let content: string | null;
      if (artifact) {
        const entry = artifact.files.get(path);
        if (!entry || entry.size > MAX_NPM_DECLARATION_BYTES - declarationBytes) return null;
        const bytes = entry.read();
        declarationBytes += bytes.length;
        if (declarationBytes > MAX_NPM_DECLARATION_BYTES) return null;
        content = bytes.toString('utf8');
      } else {
        content = await fetchText(`${JSDELIVR_CDN}/${cdnBase}/${path}`, {
          retries: 0,
        });
      }
      if (content) return { path, content };
    }
    return null;
  };

  // A barrel file names thirty siblings at once, and reading them one after
  // another means thirty sequential round trips to a CDN for files that have
  // nothing to do with each other. Each level of the traversal is fetched as
  // one wave instead — bounded, because this is still someone else's CDN, and
  // in input order, so which sources are read (and therefore which symbols win
  // a name collision) does not depend on which response happened to land first.
  // Whether the file budget stopped this walk short of the package's real
  // declaration graph.
  //
  // It routinely does. graphql's entry reaches 116 declaration files and the
  // budget is 25, so three quarters of the package is never read — and which
  // quarter survives is decided by breadth-first arrival order, not by
  // anything meaningful. `./type/index.js` lands inside the budget and
  // `GraphQLSchema` is found; `./utilities/index.js` does not and
  // `buildSchema`, `printSchema` and thirty siblings are simply absent.
  //
  // Reporting that as a complete surface is the part that does real damage.
  // `diffSurfaces` survives it because a symbol missing from *both* sides
  // cancels out, but anything asking a single surface "does this export
  // exist?" is told no, confidently, about an API that is right there in the
  // package. So the walk now says when it gave up.
  let truncated = false;

  while (queue.length > 0 && sources.length < MAX_FILES) {
    const wave: string[][] = [];
    while (queue.length > 0 && wave.length + sources.length < MAX_FILES) {
      const candidates = queue.shift()!.filter((path) => !seen.has(path));
      for (const path of candidates) seen.add(path);
      if (candidates.length > 0) wave.push(candidates);
    }
    if (wave.length === 0) continue;

    const resolved = await mapWithConcurrency(wave, DECLARATION_FETCH_CONCURRENCY, (candidates) =>
      resolveGroup(candidates),
    );

    for (const source of resolved) {
      // A file that resolved and was then dropped for want of budget is a
      // symbol set this surface does not contain and cannot account for.
      if (source && sources.length >= MAX_FILES) truncated = true;
      if (!source || sources.length >= MAX_FILES) continue;
      sources.push(source);
      for (const specifier of relativeReExports(source.content)) {
        queue.push(resolveRelative(source.path, specifier));
      }
      for (const specifier of tripleSlashReferences(source.content)) {
        queue.push(resolveRelative(source.path, specifier));
      }
      for (const specifier of relativeImports(source.content)) {
        queue.push(resolveRelative(source.path, specifier));
      }
    }
  }

  // Anything still queued is a file the walk knew about and never read — but
  // only if it is genuinely unread. The queue holds candidate *groups*, five
  // speculative paths per re-export (`./x.d.ts`, `./x/index.d.ts`, …), and a
  // group whose every path was already visited represents no unread file at
  // all. Counting those as truncation marked zod and yaml incomplete when
  // their graphs had been read in full, which refused perfectly good surfaces
  // and — through the `writeComputed` gate — stopped caching them too.
  const residualUnread = queue.some((group) => group.some((path) => !seen.has(path)));
  if (residualUnread) truncated = true;

  return { sources, truncated };
}

/** How many declaration files of one package are fetched at once. */
const DECLARATION_FETCH_CONCURRENCY = 8;

/**
 * How many declaration files one package's surface is assembled from.
 *
 * Was 25, which is below what ordinary packages need, and the shortfall was
 * silent. Measured against real ones:
 *
 *   graphql@17.0.2   25 files -> 275 symbols, truncated   150 -> 590, complete
 *   zod@4.5.4        25 files -> 955 symbols, truncated   150 -> 1261, complete
 *   yaml@2.9.0       25 files -> 107 symbols, truncated   150 -> 111, complete
 *
 * graphql alone reaches 116 files. At 25 it lost `buildSchema`, `parse` and
 * `execute` — three of the most-imported names in the package — and reported
 * the result as a complete API.
 *
 * Raising it looks like it should cost more and costs less. A truncated
 * surface is never persisted (see the `writeComputed` gate: it refuses
 * anything `incomplete`), so every scan re-fetched those 25 files from the CDN
 * again, every time, forever. A complete surface is written once and read from
 * disk after that. The one-off 1.7s replaces a recurring 0.77s.
 *
 * The environment override exists so the next person to question this number
 * can measure it the way it was measured, rather than argue about it.
 */
const MAX_FILES = Number(process.env.DRIFT_MAX_DECLARATION_FILES) || 150;

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
    // Whitespace after `export` and around `from` is optional: a minified
    // declaration file writes `export{x}from"./y"`, and requiring a space made
    // every re-export in such a file invisible. `\bexport\b` still refuses to
    // match inside an identifier like `exporttype`.
    /\bexport\b\s*(?:type\b\s*)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"](\.[^'"]+)['"]/g;
  for (const match of content.matchAll(pattern)) out.add(match[1]!);

  // `import semverValid = require("./functions/valid")` — TypeScript's
  // import-equals form, which a declaration file pairs with a plain
  // `export { semverValid as valid }` further down. No `export … from`
  // statement is ever written, so matching only that form saw a file with
  // nothing to follow: `@types/semver` publishes its entire function API
  // through forty of these, and its surface came back holding the seven types
  // its entry file happens to declare. The name bound here is resolved by
  // `collectExportSpecifiers` once the target file has been read; this is only
  // what puts the target in the queue.
  const importEquals = /\bimport\s+[A-Za-z_$][\w$]*\s*=\s*require\((['"])(\.[^'"]+)\1\)/g;
  for (const match of content.matchAll(importEquals)) out.add(match[2]!);

  return [...out];
}

/**
 * `import { Socket } from "./socket.js"`, when this file re-exports the binding.
 *
 * socket.io-client's entry file imports `Socket`, `Manager` and `SocketOptions`
 * from siblings and publishes them in one `export { … }` list carrying no
 * `from` clause. `collectExportSpecifiers` files those as aliases to resolve
 * once every file is read, but nothing ever queued the file that declares them,
 * so `resolveAliases` had nothing to resolve against — and `Socket`, the type
 * most of that package's users name, was missing from a surface that reported
 * itself complete.
 *
 * Only files holding such a list are followed. Queueing every relative import
 * would spend the declaration-file budget on files contributing nothing but
 * private locals, and exhausting that budget marks the surface incomplete —
 * trading a wrong answer for no answer rather than for a right one.
 */
export function relativeImports(content: string): string[] {
  // An `export { … }` with no `from` is the only form that produces an alias
  // needing another file to resolve it.
  // The whitespace belongs *inside* the lookahead. Written as `\}\s*(?!from)`
  // the `\s*` backtracks to zero width, the lookahead then sits on the space
  // rather than on `from`, and `export { x } from './y'` — which needs no
  // alias resolved — matched anyway.
  if (!/\bexport\b\s*\{[^}]*\}(?!\s*from)/.test(content)) return [];

  const out = new Set<string>();
  const pattern = /\bimport\b[^'"]*?\bfrom\s*['"](\.[^'"]+)['"]/g;
  for (const match of content.matchAll(pattern)) out.add(match[1]!);
  return [...out];
}

/**
 * The bodies of `declare module 'pkg' { … }` blocks belonging to this package.
 *
 * Restricted to blocks naming the package under analysis, because the same
 * syntax is how a package *augments someone else's* module — `declare module
 * 'express' { interface Request { user: User } }`. Crediting those would put
 * `Request` in this package's surface and let the check answer "yes, that
 * export exists" about a package that never published it, which is a wrong
 * answer in the direction that hides real breakage.
 *
 * A DefinitelyTyped package declares the module it provides types *for*, so
 * `@types/react` is matched against `declare module 'react'` as well.
 */
function ambientModuleBodies(content: string, packageName?: string): string[] {
  if (!packageName) return [];

  const owned = new Set([packageName, packageName.replace(/^@types\//, '')]);
  const bodies: string[] = [];
  const pattern = /\bdeclare\s+module\s+['"]([^'"]+)['"]\s*\{/g;

  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    const open = content.indexOf('{', match.index);
    const close = matchingBraceOffset(content, open);
    if (open < 0 || close < 0) continue;
    // A subpath entry (`declare module 'pkg/config'`) is still this package.
    const declared = match[1]!;
    if (owned.has(declared) || [...owned].some((name) => declared.startsWith(`${name}/`))) {
      bodies.push(content.slice(open + 1, close));
    }
    pattern.lastIndex = close + 1;
  }
  return bodies;
}

/**
 * `/// <reference path="./other.d.ts" />` — the composition mechanism
 * ambient/global declaration files use instead of `export ... from`.
 *
 * @types/node's own entry point is the concrete case: `index.d.ts` declares
 * zero exports of its own and is nothing but sixty of these, selecting
 * TypeScript-version-specific files and pulling in every builtin module.
 * Without following them, `collectDeclarationSources` read one file, found
 * no exports in it, and Drift reported a DefinitelyTyped package — one of
 * the most widely depended-on packages in the npm ecosystem — as publishing
 * no TypeScript declarations at all.
 */
export function tripleSlashReferences(content: string): string[] {
  const out = new Set<string>();
  const pattern = /\/\/\/\s*<reference\s+path=["']([^"']+)["']\s*\/>/g;
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
  const published = await firstPublished(packageName, version, [path]);
  if (published !== undefined) return published !== null;
  const content = await fetchText(`${JSDELIVR_CDN}/${packageName}@${version}/${path}`, { retries: 0 });
  return content !== null;
}

/** Extract the declaration shapes Drift compares from a `.d.ts` source file. */
export function extractExports(
  content: string,
  fileName: string,
  into: SurfaceApi = new Map(),
  aliases: ExportAlias[] = [],
  packageName?: string,
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

  // Every pattern below reads declarations, and a comment is not one. Masked
  // rather than stripped so that `signature` slices keep their offsets.
  const source = maskComments(content);

  for (const parsed of declarationEntries(source)) {
    add(locals, parsed.entry);
    if (parsed.exported) add(into, parsed.entry);
  }

  // Inside `declare module 'pkg' { … }` every declaration is exported whether
  // or not it says so, and the rest of this parser only credits a symbol whose
  // `export` keyword is written out. mongoose is the case that matters: its
  // API is split across twenty-five `types/*.d.ts` files reached by
  // triple-slash reference, each re-opening `declare module 'mongoose'` and
  // declaring a bare `class Document` / `namespace Types`. All of it parsed as
  // private locals, so the surface came back holding 604 symbols and still
  // reported `Document` — the type most of the package's users name — as
  // absent, which is the most confident kind of wrong.
  for (const body of ambientModuleBodies(source, packageName)) {
    for (const parsed of declarationEntries(body)) add(into, parsed.entry);
    // `declare module 'cypress' { interface CypressNpmApi { … } const cypress:
    // CypressNpmApi; export = cypress }`.
    //
    // This block is the package speaking about itself, so its `export =`
    // outranks one in a file the package merely bundles. cypress ships
    // `cy-blob-util`, `cy-bluebird`, `lodash` and `sinon` declarations beside
    // its own, one of those claimed `default` first, and the ordinary guard —
    // first writer wins — then locked out the real module. `defineConfig`, the
    // one export a `cypress.config.js` actually names, existed nowhere in a
    // 223-symbol surface.
    collectExportAssignments(body, locals, into, { override: true });
  }

  collectNamespaceImports(source, locals);
  collectStarAsReExports(source, into);
  collectExportSpecifiers(source, locals, into, aliases);
  collectExportAssignments(source, locals, into);
  collectDefaultExports(source, locals, into);
  // Within one file, bases are already all known. A surface assembled from
  // several files resolves again in `fetchTypeSurface`, once every source has
  // been read; doing it here as well is what makes `extractExports` usable on
  // its own, which is how it is tested.
  resolveInheritedMembers(into, locals);
  return into;
}

/**
 * Fold each declaration's inherited members into its own list.
 *
 * A caller does not care which link of the chain declares `get()`; they care
 * that `client.get()` compiles. Comparing only own-members means the most
 * routine refactor a library can do — lifting shared members into a base —
 * reports every one of them as removed, which is exactly the kind of confident
 * wrongness that gets an agent dispatched to fix working code.
 *
 * Bases outside this surface (a type from another package, a built-in) are
 * simply not resolved: their members were invisible before this ran and are
 * invisible after, which is the same answer, never a worse one.
 */
function resolveInheritedMembers(api: SurfaceApi, extra?: SurfaceApi): void {
  const lookup = (name: string): SurfaceEntry | undefined => api.get(name) ?? extra?.get(name);

  const flatten = (entry: SurfaceEntry, seen: Set<string>): void => {
    // A cyclic `extends` is not valid TypeScript, but a surface assembled from
    // several files can still present one; recursing into it would hang.
    if (!entry.extends || seen.has(entry.name)) return;
    seen.add(entry.name);

    for (const base of entry.extends) {
      const parent = lookup(base);
      if (!parent || parent === entry) continue;
      flatten(parent, seen);

      entry.members = [...new Set([...entry.members, ...parent.members])];
      entry.requiredMembers = [...new Set([...entry.requiredMembers, ...parent.requiredMembers])];
    }
  };

  for (const entry of api.values()) flatten(entry, new Set());
}

/** One `export { local as exported }` binding whose local is declared elsewhere. */
export interface ExportAlias {
  exported: string;
  local: string;
}

/**
 * `import * as z from './x'` — a namespace binding that is later exported.
 *
 * zod's entry file is the whole case for this. It ends:
 *
 *   import * as z from "./v4/classic/external.js";
 *   export * from "./v4/classic/external.js";
 *   export { z, z as default };
 *
 * The star export expands and contributes 891 symbols, so the surface looks
 * healthy — and `z`, the one name essentially every consumer of zod imports,
 * is not among them. `collectExportSpecifiers` looks `z` up in `locals`, finds
 * nothing (a namespace binding declares no type), files it as an unresolved
 * alias, and `resolveAliases` drops it. The surface then reports itself
 * complete while missing the package's entry point, and thirteen correct
 * imports in this very repository were reported as errors because of it.
 *
 * What the namespace object *is* cannot be resolved here: it stands for every
 * export of another module, which may not even have been read yet. But that it
 * **exists** is not in doubt — the file says so. That is exactly the
 * distinction {@link SurfaceEntry.shapeUnknown} carries, and this is its first
 * producer on the npm side (the Python provider is the other). `diffSurfaces`
 * treats such an entry as present and compares none of its shape, so this can
 * never manufacture a `kind-changed` or `signature-changed` finding — it can
 * only stop a real export from being called missing.
 */
function collectNamespaceImports(content: string, locals: SurfaceApi): void {
  const bind = (name: string): void => {
    if (locals.has(name)) return;
    locals.set(name, {
      name,
      kind: 'namespace',
      signature: '',
      members: [],
      requiredMembers: [],
      shapeUnknown: true,
    });
  };

  for (const match of content.matchAll(/\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]+['"]/g)) {
    bind(match[1]!);
  }

  // `import { d as UserConfig } from "./types-CYHmmaKd.mjs"`, paired further
  // down with `export { …, UserConfig, defineConfig }`.
  //
  // A bundler that mangles its chunk exports publishes every public name this
  // way: `tsdown` imports `d as UserConfig` and `t as defineConfig` from two
  // generated chunks and re-exports them from its entry. The export statement
  // names `UserConfig`, no declaration in this file declares it, and the
  // target file exports `d` — so the alias resolved to nothing and both names
  // a consumer actually writes were reported absent from a 106-symbol surface.
  //
  // The binding is shape-unknown for the same reason the `import =` form is:
  // what `d` refers to lives in another file under another name. That it is
  // exported under this name is certain, which is all a presence check needs.
  for (const match of content.matchAll(
    /\bimport\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g,
  )) {
    for (const { exported } of exportBindings(match[1] ?? '')) bind(exported);
  }

  // `import semverValid = require("./functions/valid")`, paired further down
  // with `export { semverValid as valid }`. This is how `@types/semver`
  // publishes its entire function API — forty of them — and why `valid`,
  // `satisfies`, `coerce` and `gt` were absent from its surface.
  //
  // The binding cannot be resolved to the target's own declaration, and that
  // is not a shortcut being taken here. `functions/valid.d.ts` ends in
  // `export = valid`, which `collectExportAssignments` deliberately republishes
  // under `default` rather than its internal name — so forty sibling files each
  // contribute a `default` key to one flat surface and collide, and picking the
  // right one back out is not possible from this side. What *is* certain is
  // that the module exists and is exported under the name the export statement
  // gives it, which is precisely a shape-unknown entry: no false absence, and
  // no invented shape to compare.
  for (const match of content.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s*=\s*require\(['"][^'"]+['"]\)/g)) {
    bind(match[1]!);
  }

  // `import KEYS from "./visitor-keys.js"` paired with `export { KEYS }`.
  // A default import binds a name the file then re-exports, and
  // `eslint-visitor-keys` publishes `KEYS` exactly that way: the export
  // statement names it, no declaration in this file declares it, and it was
  // dropped as an unresolvable alias — so a surface of three symbols omitted
  // the one most consumers import.
  // The name may stand alone (`import KEYS from './k'`) or lead a named
  // clause (`import KEYS, { other } from './k'`), and both bind it.
  for (const match of content.matchAll(
    /\bimport\s+(?!type\s)([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s+from\s+['"][^'"]+['"]/g,
  )) {
    bind(match[1]!);
  }
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
/**
 * `export * as JSONOutput from "./schema.js"` — a whole module published as one
 * name.
 *
 * `typedoc` publishes `JSONOutput` and `OptionDefaults` exactly this way, two
 * barrels deep. Every sibling in the same statements resolved, so the surface
 * looked healthy at 282 symbols while the two names that form its serialization
 * and defaults API were absent.
 *
 * The file is already queued for reading by `relativeReExports`; what was
 * missing is anything binding the *name*. Its members are that file's exports,
 * which this side cannot see — so the entry is shape-unknown rather than empty,
 * which would read as a namespace that exports nothing.
 */
function collectStarAsReExports(content: string, into: SurfaceApi): void {
  // `export type * as ESTree from './estree.ts'` is the same publication with
  // the values left out, and `meriyah` uses exactly that form for the namespace
  // `prettier` imports from it.
  const pattern = /\bexport\b\s*(?:type\b\s*)?\*\s+as\s+([A-Za-z_$][\w$]*)\s*from\s*['"][^'"]+['"]/g;

  for (const match of content.matchAll(pattern)) {
    const name = match[1]!;
    if (into.has(name)) continue;
    into.set(name, {
      name,
      kind: 'namespace',
      signature: '',
      members: [],
      requiredMembers: [],
      shapeUnknown: true,
    });
  }
}

function collectExportSpecifiers(
  content: string,
  locals: SurfaceApi,
  into: SurfaceApi,
  aliases: ExportAlias[],
): void {
  // `ansis` ships its whole colour API as one minified `export{a as default,
  // Ansis,…,a as blue,a as magenta,…};` with no space after `export`. Requiring
  // one left its surface holding the two `export type` aliases it happens to
  // spell out, and every colour it actually publishes was reported missing.
  const pattern = /\bexport\b\s*(?:type\b\s*)?\{([^}]+)\}(?:\s*from\s*['"][^'"]+['"])?\s*;/g;
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
function collectExportAssignments(
  content: string,
  locals: SurfaceApi,
  into: SurfaceApi,
  options: { override?: boolean } = {},
): void {
  // The trailing semicolon is optional. `export = LRUCache` with no semicolon
  // is valid TypeScript and is what `lru-cache@7` ships; requiring one meant
  // its entire API — a `declare class` plus a `declare namespace`, the whole
  // package — parsed to zero exported symbols, and the version pair was
  // reported as having no comparable surface at all.
  for (const match of content.matchAll(/\bexport\s*=\s*([A-Za-z_$][\w$.]*)\s*(?:;|$)/gm)) {
    // `export = G` means the module *is* `G`, so `G` is an identifier internal
    // to the package and not a name any consumer can write: an importer binds
    // the module to a name of its own choosing. `glob@8` calls it `G`, so Drift
    // reported `G.sync` and `G.hasMagic` -- symbols that appear in no consumer
    // anywhere, and read as gibberish in a report -- while the line to find
    // says `glob.sync(...)`.
    //
    // So the declarations are published *only* under `default`, the one name
    // the module is reachable by. Keeping the local name as well was tried and
    // is worse in both directions: it puts `G` in front of a reader, and it
    // reports every change twice, once under each name (26 findings for glob
    // 8 -> 13, where there are 13). Nothing is lost -- a named import off an
    // `export =` namespace (`import { Glob } from 'glob'`) still matches,
    // because `default.Glob` contributes the bare leaf `Glob`.
    republishAs('default', match[1]!, locals, into, options.override);
    // `export = chai` where `chai`'s type is named rather than written inline.
    adoptNamedTypeMembers('default', match[1]!, locals, into, options.override);
  }
}

/**
 * Copy `local` and its members into `into` under the name consumers reach them
 * by.
 *
 * The local identifier is kept as well, never replaced: it is frequently the
 * conventional name too (`LRUCache`), and dropping it would lose a real symbol
 * to gain a synthetic one.
 */
/**
 * `declare const chai: Chai.ChaiStatic; export = chai;`
 *
 * The module's whole API is the members of a type declared elsewhere in the
 * file, so the published `default` entry carries the const's own (empty)
 * member list. `import { assert } from 'chai'` — how eslint's eight hundred
 * test files reach it — was therefore reported as naming something chai does
 * not export.
 *
 * Only a bare named type is followed, and only when the entry has no members
 * of its own: a union or an intersection is not one type's member list, and
 * guessing at which half a name came from would be inventing an answer.
 */
function adoptNamedTypeMembers(
  published: string,
  local: string,
  locals: SurfaceApi,
  into: SurfaceApi,
  override = false,
): void {
  const entry = into.get(published);
  if (!entry || (entry.members.length > 0 && !override)) return;

  const declared = locals.get(local);
  if (!declared) return;

  // A declaration needs no semicolon, and without one the statement scan runs
  // past it: cypress writes `const cypress: CypressNpmApi` and then, on the
  // next line, `export = cypress`, so the recorded signature reads
  // `const cypress: CypressNpmApi export = cypress }`. Anchoring the type name
  // to the end of that never matched, and `default` kept the members of an
  // unrelated interface instead.
  //
  // The trailing clause is dropped rather than the anchor loosened, so a union
  // or an intersection is still refused: those are not one type's member list,
  // and picking a side would be inventing an answer.
  const signature = declared.signature
    .replace(/\s*\bexport\s*=[\s\S]*$/, '')
    .replace(/\s*\}\s*$/, '')
    .trim();
  const typeName = /:\s*([A-Za-z_$][\w$.]*)\s*;?\s*$/.exec(signature)?.[1];
  const target = typeName ? locals.get(typeName) : undefined;
  if (!target) return;

  entry.members = [...target.members];
  entry.requiredMembers = [...target.requiredMembers];
}

function republishAs(
  published: string,
  local: string,
  locals: SurfaceApi,
  into: SurfaceApi,
  override = false,
): void {
  const declared = locals.get(local);
  if (declared && (override || !into.has(published))) into.set(published, renameEntry(declared, published));
  for (const entry of locals.values()) {
    if (!entry.name.startsWith(`${local}.`)) continue;
    const name = `${published}.${entry.name.slice(local.length + 1)}`;
    if (override || !into.has(name)) into.set(name, renameEntry(entry, name));
  }
}

/**
 * `export default class Telnet { … }`, and the other default-export forms.
 *
 * A default export's *published* name is `default` — it is the only name an
 * importer can reach it by, and the local identifier is the package's own
 * business. So the declaration is republished under that name, which is also
 * what keeps a purely local rename from reading as a removal plus an addition.
 *
 * Its members come with it, and they are the part that matters: a consumer
 * writes `client.exec(…)`, so `default.exec` is what localization has to have.
 */
function collectDefaultExports(content: string, locals: SurfaceApi, into: SurfaceApi): void {
  for (const match of content.matchAll(
    /\bexport\s+default\s+(?:abstract\s+)?(?:class|function|enum|const|let|var)?\s*([A-Za-z_$][\w$]*)/g,
  )) {
    const local = match[1]!;
    if (!locals.has(local)) continue;
    republishAs('default', local, locals, into);
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

  for (const found of functionDeclarations(content)) {
    entries.push({
      exported: found.exported,
      entry: {
        name: found.name,
        kind: 'function',
        signature: collapse(content.slice(found.start, declarationEndOffset(content, found.start))),
        members: [],
        requiredMembers: [],
      },
    });
  }
  collectSimpleDeclarations(
    content,
    /\b(export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g,
    'variable',
    entries,
  );
  collectVariableDeclarators(content, entries);
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
    collectNamespaceExportSpecifiers(body, name, exported, entries);
    pattern.lastIndex = close + 1;
  }
}

/**
 * `declare namespace N { export { X } }` — a name the namespace publishes but
 * does not declare.
 *
 * `@fastify/ajv-compiler` declares `StandaloneValidator` at file scope, lists
 * it in `export { StandaloneValidator }` inside `declare namespace AjvCompiler`,
 * and ends with `export = AjvCompiler`. Only declarations inside the body were
 * collected, so `AjvCompiler.StandaloneValidator` never existed for
 * `republishAs` to copy to `default.StandaloneValidator`, and a named import of
 * it was reported as missing.
 *
 * The entry is shape-unknown: the declaration it refers to lives outside this
 * body, and naming a shape here would be inventing one. Presence is what an
 * export list establishes, and presence is what this records.
 */
function collectNamespaceExportSpecifiers(
  body: string,
  prefix: string,
  exported: boolean,
  entries: ParsedDeclaration[],
): void {
  const direct = withoutNestedNamespaces(body);

  for (const match of direct.matchAll(/\bexport\b\s*\{([^}]+)\}\s*;?/g)) {
    for (const { exported: name } of exportBindings(match[1] ?? '')) {
      entries.push({
        exported,
        entry: {
          name: `${prefix}.${name}`,
          kind: 'namespace',
          signature: '',
          members: [],
          requiredMembers: [],
          shapeUnknown: true,
        },
      });
    }
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

  for (const found of functionDeclarations(direct)) {
    add(found.name, 'function', direct.slice(found.start, declarationEndOffset(direct, found.start)));
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

/**
 * Every `function` declaration in a `.d.ts`, including the generic ones.
 *
 * A regex cannot do this job, and the version that tried is the reason Drift
 * told a developer that `z.object` had been deleted from zod 4. Its type
 * parameter list is `<T extends … = Partial<Record<never, core.SomeType>>>`,
 * and the pattern matched it with `<[^>{}]*>` — a character class that stops
 * dead at the first `>`, which here closes `Record<…>` and leaves `>>(`
 * where the pattern demanded `(`. The declaration was therefore not extracted
 * at all, so the diff saw `object` present in zod 3 and absent in zod 4 and
 * reported a removal. Its neighbours `strictObject` and `looseObject`, whose
 * type parameters happen not to nest, came through fine — which is what made
 * the finding so plausible and so wrong.
 *
 * Nesting is a matching problem, so it is matched rather than approximated:
 * find the name, and if a type parameter list follows, walk it to its real
 * close before insisting on the parameter list's `(`.
 */
function functionDeclarations(content: string): Array<{ name: string; exported: boolean; start: number }> {
  const found: Array<{ name: string; exported: boolean; start: number }> = [];
  const pattern = /\b(export\s+)?(?:declare\s+)?function\s+([A-Za-z_$][\w$]*)/g;

  for (const match of content.matchAll(pattern)) {
    let at = (match.index ?? 0) + match[0].length;
    while (at < content.length && /\s/.test(content[at]!)) at += 1;

    if (content[at] === '<') {
      const close = typeParameterEnd(content, at);
      if (close < 0) continue;
      at = close + 1;
      while (at < content.length && /\s/.test(content[at]!)) at += 1;
    }

    // Without this the word `function` inside a type position — `type F =
    // function` never appears, but `declare function` split across a comment
    // can — would be admitted as a declaration it is not.
    if (content[at] !== '(') continue;
    found.push({ name: match[2]!, exported: Boolean(match[1]), start: match.index ?? 0 });
  }

  return found;
}

/**
 * The `>` that closes the type parameter list opened at `open`.
 *
 * Arrow types are the reason this is not simple bracket counting: a constraint
 * like `<T extends (x: A) => B>` contains a `>` that closes nothing, and
 * counting it would end the list early and put the walk back into the same
 * class of error this function exists to avoid.
 */
function typeParameterEnd(content: string, open: number): number {
  let depth = 0;

  for (let i = open; i < content.length; i++) {
    const char = content[i];
    if (char === '<') depth += 1;
    else if (char === '>') {
      if (content[i - 1] === '=') continue;
      depth -= 1;
      if (depth === 0) return i;
    } else if (char === '(' && depth === 0) {
      return -1;
    }
  }

  return -1;
}

/**
 * The same source with every comment blanked out, character for character.
 *
 * The declaration patterns match `[^{;]*` between a name and its opening
 * brace, and that crosses newlines — so a doc comment containing the word
 * `class` starts a match that runs all the way to the *next real*
 * declaration's brace and swallows it. `@grpc/grpc-js` writes "A class for
 * storing metadata" above `export declare class Metadata`, and the parser came
 * away with a class named `for` and no `Metadata` at all. The two type aliases
 * beside it parsed normally, so the surface looked perfectly healthy while
 * missing the one symbol most of that package's users name.
 *
 * Comments become spaces rather than being removed, because every `signature`
 * is sliced out of this string by offset and shortening it would corrupt all
 * of them. Newlines are kept for the same reason.
 */
export function maskComments(content: string): string {
  let out = '';
  let i = 0;

  while (i < content.length) {
    const char = content[i]!;
    const next = content[i + 1];

    if (char === '/' && next === '*') {
      const end = content.indexOf('*/', i + 2);
      const stop = end < 0 ? content.length : end + 2;
      for (let j = i; j < stop; j++) out += content[j] === '\n' ? '\n' : ' ';
      i = stop;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < content.length && content[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }

    // A string may contain `//` or `/*` and is not a comment.
    if (char === '"' || char === "'" || char === '`') {
      out += char;
      i += 1;
      while (i < content.length) {
        const inner = content[i]!;
        out += inner;
        i += 1;
        if (inner === '\\') {
          if (i < content.length) {
            out += content[i];
            i += 1;
          }
          continue;
        }
        if (inner === char) break;
      }
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}

/**
 * `declare const Ansis: new (o?: N) => A, a: A, fg: Q;` — every name but the first.
 *
 * One `const` statement can introduce several bindings, and the declaration
 * pattern captures only the identifier next to the keyword. `ansis@4.3.1`
 * declares its entire runtime this way and then publishes it through one
 * renaming export list (`export{a as blue, a as magenta, …}`): `a` was never
 * recorded as a local, so every one of those aliases resolved to nothing and
 * the package's whole colour API was reported missing.
 *
 * Splitting on commas has to respect nesting, or `const x: Map<string, number>`
 * would split inside the type argument list and invent a binding called
 * `number`. The depth rules are `declarationEndOffset`'s, including its
 * treatment of `=>` as an arrow rather than the close of a type-argument list.
 */
function collectVariableDeclarators(content: string, entries: ParsedDeclaration[]): void {
  const pattern = /\b(export\s+)?(?:declare\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*/g;

  for (const match of content.matchAll(pattern)) {
    const start = match.index ?? 0;
    const statement = content.slice(start, declarationEndOffset(content, start));

    for (const declarator of trailingDeclarators(statement)) {
      const members = variableMembers(declarator);
      const name = /^\s*([A-Za-z_$][\w$]*)/.exec(declarator)?.[1];
      if (!name) continue;

      entries.push({
        exported: Boolean(match[1]),
        entry: {
          name,
          kind: 'variable',
          signature: collapse(`declare const ${declarator.trim()}`),
          members: members.map((member) => member.name),
          requiredMembers: members.filter((member) => member.required).map((member) => member.name),
        },
      });
    }
  }
}

/** The declarators of a `const`/`let`/`var` statement after the first. */
function trailingDeclarators(statement: string): string[] {
  const head = /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+/.exec(statement);
  if (!head) return [];

  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let angle = 0;
  const parts: string[] = [];
  let current = '';

  for (let i = head[0].length; i < statement.length; i++) {
    const char = statement[i]!;

    if (char === '(') paren += 1;
    else if (char === ')') paren -= 1;
    else if (char === '[') bracket += 1;
    else if (char === ']') bracket -= 1;
    else if (char === '<') angle += 1;
    else if (char === '>' && statement[i - 1] !== '=') angle = Math.max(0, angle - 1);
    else if (char === '{') brace += 1;
    else if (char === '}') brace -= 1;
    else if (paren <= 0 && bracket <= 0 && brace <= 0 && angle <= 0) {
      if (char === ',') {
        parts.push(current);
        current = '';
        continue;
      }
      if (char === ';') break;
    }

    current += char;
  }
  parts.push(current);

  return parts.slice(1).filter((part) => part.trim() !== '');
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
    const declaration = content.slice(start, end);
    // `type Options = { retries?: number }` is an interface to everyone who
    // uses it, and reading its members is what lets the two spellings compare
    // as one thing. It also closes a gap of its own: a member dropped from a
    // type alias was previously invisible, because only interfaces and classes
    // had members to diff at all.
    const members =
      kind === 'type' ? aliasMembers(declaration) : kind === 'variable' ? variableMembers(declaration) : [];

    entries.push({
      exported: Boolean(match[1]),
      entry: {
        name: match[2]!,
        kind,
        signature: collapse(declaration),
        members: members.map((member) => member.name),
        requiredMembers: members.filter((member) => member.required).map((member) => member.name),
      },
    });
  }
}

/**
 * The members of a type alias whose right-hand side is an object literal.
 *
 * Only that shape. `type Id = string` and `type Handler = (e: E) => void` have
 * no members, and `type A = B & C` names members this cannot see from here —
 * claiming an empty list for those would turn every one of them into a pile of
 * `member-removed` findings the moment anything else about them moved.
 */
function aliasMembers(declaration: string): Array<{ name: string; required: boolean }> {
  return literalTypeMembers(declaration, '=');
}

/**
 * `declare const execa: { sync(file: string): Result; … }` — the members of a
 * const whose type is written inline rather than named.
 *
 * `execa@5` publishes its whole API this way and exports it with `export =`,
 * so `sync` is reachable only as a member of the default export. Reading
 * members for type aliases but not for variables left that `default` entry
 * with an empty member list, and `import { sync } from 'execa'` — the form
 * jest's own test utilities use — was reported as naming something the package
 * does not export. `chai`'s `assert` is the same shape.
 */
function variableMembers(declaration: string): Array<{ name: string; required: boolean }> {
  return literalTypeMembers(declaration, ':');
}

function literalTypeMembers(
  declaration: string,
  separator: string,
): Array<{ name: string; required: boolean }> {
  const assignment = declaration.indexOf(separator);
  if (assignment < 0) return [];

  const rest = declaration.slice(assignment + 1);
  const open = rest.indexOf('{');
  if (open < 0 || rest.slice(0, open).trim() !== '') return [];

  const close = matchingBraceOffset(rest, open);
  if (close < 0) return [];
  // Anything after the closing brace makes this an intersection or a union,
  // not a plain object type.
  if (rest.slice(close + 1).replace(/;\s*$/, '').trim() !== '') return [];

  return typeMembers(rest.slice(open + 1, close), false);
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
    const heritage = open >= 0 ? inheritedNames(content.slice(start, open)) : [];

    entries.push({
      exported: Boolean(match[1]),
      entry: {
        name: match[2]!,
        kind,
        signature: collapse(content.slice(start, open >= 0 ? open : end)),
        members: members.map((member) => member.name),
        requiredMembers: members.filter((member) => member.required).map((member) => member.name),
        ...(heritage.length > 0 ? { extends: heritage } : {}),
      },
    });
  }
}

/**
 * The bases named in an `extends`/`implements` clause, without their type
 * arguments.
 *
 * `interface Client extends Base<Options>, Loggable` inherits from `Base` and
 * `Loggable`; the argument list says how, not from what.
 */
function inheritedNames(header: string): string[] {
  const clause = /\b(?:extends|implements)\s+([\s\S]+)$/.exec(header);
  if (!clause) return [];

  return splitTopLevel(clause[1]!)
    .map((part) => /^\s*([A-Za-z_$][\w$]*)/.exec(part.replace(/\bimplements\b/g, ','))?.[1])
    .filter((name): name is string => Boolean(name));
}

/**
 * Where a declaration ends — the terminating `;`, or the close of the body it
 * opens.
 *
 * The distinction that matters is which `{` opens a *body*. Only one at the
 * top level of the declaration does: `interface X {`, `class C {`, `enum E {`.
 * A brace nested inside a parameter list, an index signature, or a type
 * argument is part of a type annotation, and the declaration continues past
 * its close.
 *
 * Reading the first `{` as a body regardless of nesting is what truncated
 * every declaration whose parameters contain an inline object type. zod 3
 * declares `declare const string: (params?: RawCreateParams & { coerce?:
 * true; }) => ZodString;`, whose first `{` is two levels in and whose first
 * `;` is inside it — so the declaration was cut at that brace, losing `) =>
 * ZodString` and with it the entire return type and the closing paren. A
 * signature that stops mid-type cannot be parsed by `callSignature`, so
 * `onlyRelaxesCallers` had nothing to compare and every such symbol was
 * reported as a signature change against call sites that were already
 * correct.
 */
function declarationEndOffset(content: string, start: number): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let angle = 0;

  for (let i = start; i < content.length; i++) {
    const char = content[i];

    if (char === '(') paren += 1;
    else if (char === ')') paren -= 1;
    else if (char === '[') bracket += 1;
    else if (char === ']') bracket -= 1;
    else if (char === '<') angle += 1;
    // `=>` is an arrow, not the close of a type-argument list — the same rule
    // `parameterListStart` follows. Angle depth never goes negative, because a
    // stray `>` is far more likely to be a comparison than an unbalanced list.
    else if (char === '>' && content[i - 1] !== '=') angle = Math.max(0, angle - 1);
    else if (char === '{') {
      if (paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
        const close = matchingBraceOffset(content, i);
        return close >= 0 ? close + 1 : content.length;
      }
      brace += 1;
    } else if (char === '}') brace -= 1;
    else if (char === ';' && paren <= 0 && bracket <= 0 && brace <= 0 && angle <= 0) {
      return i + 1;
    }
  }

  return content.length;
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
  // A generic method is followed by `<`, not by `(` or `:`, and admitting only
  // the latter two dropped every one of them from every interface and class
  // Drift reads. cypress declares `defineConfig<ComponentDevServerOpts = any>(
  // config: …)` one line above the plain `defineComponentFramework(config: …)`:
  // the plain one was a member, the generic one did not exist, and
  // `cypress.config.js`'s only import was reported as naming something the
  // package does not export.
  //
  // The cost was never limited to presence checks — a generic method removed
  // between two versions was invisible to the diff as well, on both sides.
  const pattern =
    /(?:^|[;\n])\s*((?:public|protected|private|readonly|static|abstract|declare|override)\s+)*(#?[A-Za-z_$][\w$]*)(\?)?\s*(\(|:|<)/g;

  for (const match of body.matchAll(pattern)) {
    const modifiers = match[1] ?? '';
    const name = match[2]!;
    if (name === 'constructor' || modifiers.includes('private') || name.startsWith('#')) continue;
    members.push({
      name,
      // A generic method is a method: `<` marks a type-parameter list, never a
      // property annotation, so it is required exactly as `(` is.
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
  if (callable(a) && callable(b)) return true;

  // `interface Options { … }` and `type Options = { … }` are the same thing to
  // everyone who annotates a variable with it, passes one, or returns one, and
  // libraries move between them for internal reasons — a type alias composes,
  // an interface merges. The members are still compared, which is where a
  // caller can actually break; whether the author wrote `interface` or `type`
  // is not a finding about their API.
  const shape = (kind: SurfaceKind): boolean => kind === 'interface' || kind === 'type';
  return shape(a) && shape(b);
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

export function diffSurfaces(
  before: SurfaceApi,
  after: SurfaceApi,
  context: { beforeComplete?: boolean; afterComplete?: boolean } = {},
): SurfaceChange[] {
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
      // The new surface stopped short of fully expanding its public re-export
      // graph, and this symbol came in through a followed dependency. Its
      // absence here is as likely to be Drift's truncated traversal as a real
      // removal, so the comparison is left incomplete rather than asserting a
      // removal it cannot stand behind. A symbol the package declares itself is
      // still reported — traversal limits never hid those.
      if (context.afterComplete === false && oldEntry.via) continue;

      changes.push({
        kind: 'export-removed',
        // A shape-unknown symbol going missing is still a real removal —
        // existence, the one thing that entry did assert, has disappeared —
        // but its `kind` was never real, so it is not quoted as one.
        symbol: name,
        detail: oldEntry.shapeUnknown
          ? `\`${name}\` is no longer exported${origin}.`
          : `\`${name}\` is no longer exported (was ${withArticle(oldEntry.kind)})${origin}.`,
        before: oldEntry.signature,
        ...(oldEntry.shapeUnknown ? {} : { fromKind: oldEntry.kind }),
      });
      continue;
    }

    // One side is a public symbol Drift proved exists but could not resolve to
    // a declaration (a Python explicit re-export into `__all__` whose target
    // was not in the parsed package). `newEntry` is present, so there is no
    // removal; and its `kind`/`signature`/`members` are placeholders, so every
    // comparison below would be inventing a change out of a value that was
    // never the package's. Existence matched — say nothing more.
    if (oldEntry.shapeUnknown || newEntry.shapeUnknown) continue;

    if (oldEntry.kind !== newEntry.kind && !interchangeable(oldEntry.kind, newEntry.kind)) {
      changes.push({
        kind: 'kind-changed',
        symbol: name,
        detail: `\`${name}\` changed from ${withArticle(oldEntry.kind)} to ${withArticle(newEntry.kind)}${origin}.`,
        before: oldEntry.signature,
        after: newEntry.signature,
        fromKind: oldEntry.kind,
        toKind: newEntry.kind,
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
      } else {
        const beforeMember = oldEntry.memberSignatures?.[member];
        const afterMember = newEntry.memberSignatures?.[member];
        if (beforeMember && afterMember && beforeMember !== afterMember) {
          changes.push({
            kind: 'signature-changed',
            symbol: `${name}.${member}`,
            detail: `The signature of \`${name}.${member}\` changed${origin}.`,
            before: beforeMember,
            after: afterMember,
          });
        }
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

    // Import qualifiers are normalized away *first*, and every later test runs
    // on the result. Applying it as one more independent escape hatch — which
    // is what it used to be — cannot see a change that is harmless in two ways
    // at once, and that combination is the ordinary shape of a minor release
    // rather than an exotic one. `@sveltejs/kit` grew `sveltekit()` into
    // `sveltekit(config?)` and, in the same release, started spelling its own
    // return type `Promise<Plugin[]>` instead of `Promise<import("vite").
    // Plugin[]>`. Each half is dismissed on its own; together they passed
    // through all three tests and reported a breaking change against a call
    // that is still `sveltekit()` and still compiles.
    const [oldSignature, newSignature] = comparableSignatures(oldEntry.signature, newEntry.signature);

    // When both sides carry a structured callable shape (the Python reader
    // supplies one), that shape is *authoritative* for caller compatibility.
    // The display signature is a lossy rendering — it does not encode the `/`
    // positional-only boundary or the bare `*` keyword-only boundary — so
    // `def f(a)` → `def f(a, /)` and `def f(a=1)` → `def f(*, a=1)` are real
    // breaks with byte-identical display text. Requiring display inequality
    // here would suppress them, so the structured verdict is not gated on it.
    // The display signature is still used only for `before`/`after` panels.
    const structuredCallableChange = Boolean(oldEntry.callable && newEntry.callable);

    const reportSignatureChange = structuredCallableChange
      ? !callableChangeIsBackwardCompatible(oldEntry.callable!, newEntry.callable!)
      : oldSignature !== newSignature &&
        oldEntry.kind !== 'interface' &&
        oldEntry.kind !== 'class' &&
        // Renaming a type parameter changes the text of a declaration without
        // changing a single thing about how it can be called. `zod` renamed `T`
        // to `Inner` across its 3.x line and, read as text, every generic export
        // it has "changed signature" — dozens of findings, each pointing at
        // working code, none of them true. Two declarations that differ only in
        // what their type parameters are spelled are the same declaration.
        !alphaEquivalent(oldSignature, newSignature) &&
        // And a call site cannot break on an argument it never passes. Growing
        // `f()` into `f(options?)` is the most common shape of a minor release,
        // and reporting it sends a developer to read code that was already
        // correct. See `onlyRelaxesCallers`.
        !onlyRelaxesCallers(oldSignature, newSignature);

    if (reportSignatureChange) {
      changes.push({
        kind: 'signature-changed',
        symbol: name,
        detail: `The signature of \`${name}\` changed${origin}.`,
        // The signatures the *package* publishes, not the normalized pair used
        // to decide. A reader comparing the panel against the `.d.ts` on disk
        // must find the same text in both.
        before: oldEntry.signature,
        after: newEntry.signature,
        // A structured callable break is, by construction, a parameter-list
        // incompatibility; `whatChanged` only reads call-signature text.
        ...(structuredCallableChange ? { changed: 'parameters' as const } : (whatChanged(oldSignature, newSignature) ?? {})),
      });
    }
  }

  return changes;
}

/**
 * Which part of a call actually moved: the parameters a caller supplies, the
 * value it gets back, or both.
 *
 * `null` when either side cannot be parsed as a call — an overload chain, a
 * declaration this comparison already runs conservatively for elsewhere —
 * rather than guessing.
 */
function whatChanged(before: string, after: string): { changed: 'parameters' | 'return-type' | 'both' } | null {
  const old = callSignature(before);
  const now = callSignature(after);
  if (!old || !now) return null;

  const returnChanged = !sameType(old.returns, now.returns);
  const parametersChanged =
    old.parameters.length !== now.parameters.length ||
    old.parameters.some((parameter, index) => {
      const replacement = now.parameters[index];
      return (
        !replacement ||
        parameter.optional !== replacement.optional ||
        parameter.rest !== replacement.rest ||
        !sameType(parameter.type, replacement.type)
      );
    });

  if (returnChanged && parametersChanged) return { changed: 'both' };
  if (returnChanged) return { changed: 'return-type' };
  if (parametersChanged) return { changed: 'parameters' };
  // Parseable on both sides, and neither piece moved by this test's lights —
  // reached only via a change this function does not model (e.g. a rest
  // parameter's own type), so there is nothing confident to say.
  return null;
}

/**
 * Does the new declaration accept everything the old one did, and only ask for
 * less?
 *
 * The question a surface diff is really being asked is not "did this text
 * change" but "can a call that compiled before stop compiling now". Those come
 * apart constantly, and the gap is where a tool like this loses its reader: a
 * release that grows `parse(input)` into `parse(input, options?)` has changed
 * every signature in its file and broken nobody, but a finding says otherwise
 * and an agent is then dispatched to fix code that was already correct. That
 * costs tokens, and worse, it teaches the developer that Drift's findings are
 * something to skim past.
 *
 * So the parameter lists are compared position by position, and the change is
 * dismissed only when every direction of movement is one a caller cannot
 * notice:
 *
 *   - a parameter that existed keeps its position and its type;
 *   - a parameter that was required may become optional, never the reverse;
 *   - anything genuinely new is optional, or a rest parameter.
 *
 * Everything else stands. `f(a)` becoming `f(b, a)` reorders what a caller
 * already passes, and `f(a?)` becoming `f(a)` makes a call that omitted it
 * fail — both are reported, which is the asymmetry to keep: a false positive
 * wastes an agent run, a false negative ships a break. Anything this cannot
 * parse confidently — overload chains, a return type that also moved — falls
 * through to being reported.
 */
export function onlyRelaxesCallers(before: string, after: string): boolean {
  // Overloads are joined with ` | ` by `extractExports`. Comparing a chain
  // position by position would be comparing the wrong pairs, and guessing
  // which overload answers which is exactly the confidence this must not have.
  if (before.includes(' | declare ') || after.includes(' | declare ')) return false;
  if (before.includes(' | export ') || after.includes(' | export ')) return false;

  const old = callSignature(before);
  const now = callSignature(after);
  if (!old || !now) return false;

  // A caller assigns the result. A different return type is a different
  // contract even when every parameter survived untouched.
  if (!sameType(old.returns, now.returns)) return false;
  if (now.parameters.length < old.parameters.length) return false;

  for (const [index, parameter] of old.parameters.entries()) {
    const replacement = now.parameters[index]!;
    if (!stillAccepts(parameter.type, replacement.type)) return false;
    // Required → optional loosens; optional → required breaks every call that
    // relied on the default.
    if (parameter.optional && !replacement.optional) return false;
  }

  return now.parameters
    .slice(old.parameters.length)
    .every((parameter) => parameter.optional || parameter.rest);
}

/**
 * Given two {@link CallableShape}s, can every call the old shape accepted still
 * be accepted by the new one?
 *
 * `true` only when that is provable. Any shape this does not model, and every
 * genuine tightening, returns `false` so the change is still reported — an
 * added optional parameter must not become a licence to wave through a real
 * break. This is the check that keeps a backward-compatible Python signature
 * expansion (`safe_url_string(url, encoding='utf8', path_encoding='utf8')` →
 * `…, quote_path=True`) from surfacing as `signature-changed`, while a new
 * required parameter, an optional-turned-required one, a removed parameter, a
 * dropped `**kwargs`, and a keyword-addressable rename all still do.
 */
export function callableChangeIsBackwardCompatible(before: CallableShape, after: CallableShape): boolean {
  const positional = (shape: CallableShape): CallableParam[] =>
    shape.parameters.filter((p) => p.kind === 'positional-only' || p.kind === 'positional-or-keyword');
  const hasVar = (shape: CallableShape, kind: CallableParamKind): boolean =>
    shape.parameters.some((p) => p.kind === kind);
  const keywordAddressable = (shape: CallableShape): CallableParam[] =>
    shape.parameters.filter((p) => p.kind === 'positional-or-keyword' || p.kind === 'keyword-only');
  const paramNamed = (shape: CallableShape, name: string): CallableParam | undefined =>
    shape.parameters.find((p) => p.name === name);

  const oldPositional = positional(before);
  const newPositional = positional(after);
  const oldMinPositional = oldPositional.filter((p) => p.required).length;
  const newMinPositional = newPositional.filter((p) => p.required).length;
  const oldMaxPositional = hasVar(before, 'var-positional') ? Infinity : oldPositional.length;
  const newMaxPositional = hasVar(after, 'var-positional') ? Infinity : newPositional.length;

  // A caller that passed the fewest positionals the old shape allowed must not
  // now be one argument short; a caller that passed the most must still fit.
  if (newMinPositional > oldMinPositional) return false;
  if (newMaxPositional < oldMaxPositional) return false;

  // The old shape had `*args`, so it accepted arbitrary trailing positionals —
  // and a caller could pass extra positionals *and* a same-named keyword when
  // `**kwargs` was also present. A new named positional slot in front of
  // `*args` turns `f(<that position>, name=…)` into a "multiple values for
  // argument" error and rebinds a positional a caller intended for `*args`.
  // Any change to the positional-param list ahead of `*args` (an addition, or
  // a keyword-only parameter reclassified into it) is therefore not provably
  // safe.
  if (hasVar(before, 'var-positional') && newPositional.length !== oldPositional.length) return false;

  // Positional slots that existed keep their meaning: a `positional-or-keyword`
  // parameter must not lose keyword addressability, and it must not be renamed.
  // A rename is not provably safe even when `**kwargs` remains: `f(a=0, **kw)` →
  // `f(b=0, **kw)` turns the old-valid `f(1, b=2)` (which bound `a=1`,
  // `kw={'b': 2}`) into `b=1` positionally *and* `b=2` by keyword — a "multiple
  // values for argument 'b'" error. `**kwargs` absorbs the old name's value but
  // does not stand in for the renamed slot.
  for (const [index, oldParam] of oldPositional.entries()) {
    if (oldParam.kind !== 'positional-or-keyword') continue;
    const newParam = newPositional[index];
    if (!newParam) {
      if (!hasVar(after, 'var-keyword')) return false;
      continue;
    }
    if (newParam.kind === 'positional-only') return false;
    if (newParam.name !== oldParam.name) return false;
  }

  // A positional-only parameter becoming keyword-addressable is normally a pure
  // relaxation — but not when the old shape had `**kwargs`. A caller could have
  // passed that name as a keyword (it landed in `**kwargs`) while also filling
  // the positional-only slot: `f(a, /, **kw)` → `f(a, **kw)` turns the
  // old-valid `f(1, a=2)` (`a=1`, `kw={'a': 2}`) into a "multiple values for
  // argument 'a'" error.
  if (hasVar(before, 'var-keyword')) {
    for (const oldParam of before.parameters) {
      if (oldParam.kind !== 'positional-only') continue;
      const newParam = paramNamed(after, oldParam.name);
      if (newParam && (newParam.kind === 'positional-or-keyword' || newParam.kind === 'keyword-only')) {
        return false;
      }
    }
  }

  // Arbitrary keyword arguments the old shape accepted via `**kwargs` must
  // still be accepted.
  if (hasVar(before, 'var-keyword') && !hasVar(after, 'var-keyword')) return false;

  // Every name the old shape accepted as a keyword must still be passable as
  // one — as the same-named keyword-capable parameter, or via `**kwargs`.
  if (!hasVar(after, 'var-keyword')) {
    for (const oldParam of keywordAddressable(before)) {
      const newParam = paramNamed(after, oldParam.name);
      if (!newParam || (newParam.kind !== 'positional-or-keyword' && newParam.kind !== 'keyword-only')) {
        return false;
      }
    }
  }

  // A keyword-only parameter the old shape did not require must not become
  // required — old callers never passed it.
  for (const newParam of after.parameters) {
    if (newParam.kind !== 'keyword-only' || !newParam.required) continue;
    const oldParam = paramNamed(before, newParam.name);
    if (!oldParam || oldParam.kind !== 'keyword-only' || !oldParam.required) return false;
  }

  // An old keyword-only parameter dropped entirely, with no `**kwargs` to
  // absorb it, is a removed accepted argument.
  if (!hasVar(after, 'var-keyword')) {
    for (const oldParam of before.parameters) {
      if (oldParam.kind === 'keyword-only' && !paramNamed(after, oldParam.name)) return false;
    }
  }

  // Losing `*args` when the old shape had it (and the new one cannot take the
  // extra positionals) is caught by the max-positional check above.
  return true;
}

/**
 * Can a call that passes exactly `arity` positional arguments still compile?
 *
 * `onlyRelaxesCallers` asks whether a signature change is safe for *every*
 * caller, and answers no the moment any parameter's type moves. That is the
 * right answer for the surface diff, which has no callers in front of it. It
 * is the wrong answer once a specific call site is in hand, because a call is
 * only exposed to the parameters it actually fills: `z.string()` passes
 * nothing, so `params` changing from `RawCreateParams & {…}` to `string |
 * $ZodStringParams` cannot reach it. Reporting that line asks a developer to
 * go and look at code with nothing in it to change.
 *
 * So this asks the narrower, per-site question. A call survives when some new
 * overload accepts that many arguments with the same return type, and every
 * position the call actually fills is unchanged or widened. Positions the call
 * leaves empty are not examined — there is no argument there to be wrong.
 *
 * Deliberately conservative in the same direction as everything else here. It
 * proves nothing about a call whose old declaration could not be parsed, or
 * that no old overload accepted in the first place, and it does not try to
 * decide assignability between two type expressions that merely look related —
 * `ZodTypeAny` to `core.SomeType` is a question for a type checker, and
 * guessing at it is how a real break ships.
 */
export function acceptsCallOfArity(before: string, after: string, arity: number): boolean {
  if (arity < 0) return false;

  // Normalized for the same reason `diffSurfaces` normalizes: the return types
  // are compared below, and `Promise<import("vite").Plugin[]>` against
  // `Promise<Plugin[]>` is a spelling difference that would otherwise leave
  // every call site of an unchanged function reported.
  const [left, right] = comparableSignatures(before, after);
  const olds = overloadChain(left).map(callSignature).filter((s): s is CallShape => s !== null);
  const news = overloadChain(right).map(callSignature).filter((s): s is CallShape => s !== null);
  if (olds.length === 0 || news.length === 0) return false;

  const accepting = olds.filter((shape) => admitsArity(shape, arity));
  // The call did not resolve against the old declaration either, so whatever
  // this line is, this change is not the reason to look at it.
  if (accepting.length === 0) return false;

  return accepting.every((old) =>
    news.some((now) => {
      if (!admitsArity(now, arity)) return false;
      if (!sameType(old.returns, now.returns)) return false;

      for (let index = 0; index < arity; index++) {
        const parameter = old.parameters[index];
        const replacement = now.parameters[index];
        // A rest parameter absorbs the position; its element type is not
        // compared, so it proves nothing and the call is left reported.
        if (!parameter || !replacement) return false;
        if (parameter.rest || replacement.rest) return false;
        if (!stillAccepts(parameter.type, replacement.type)) return false;
      }

      return true;
    }),
  );
}

/**
 * Could a call passing `arity` arguments ever have resolved to this
 * declaration?
 *
 * When no overload of the *old* declaration accepts that many arguments, this
 * line was never calling it. Overwhelmingly that means a name collision the
 * text search cannot see through: `z.string().optional()` is a method on the
 * schema object, and `z.optional(type)` is the free function that shares its
 * name and requires an argument. Reporting the method as a site of the
 * function's signature change points a developer at a line that has nothing to
 * do with the finding.
 *
 * The only other reading is that the call was already failing to compile
 * before the upgrade, which this change is likewise not the reason to look at.
 *
 * Requires a parseable old declaration. An alias like `declare const enum:
 * typeof createZodEnum` yields no call signature to test an arity against, and
 * an absence of evidence is not evidence of a mismatch.
 */
export function callCannotResolveTo(before: string, arity: number): boolean {
  if (arity < 0) return false;

  const olds = overloadChain(before).map(callSignature).filter((s): s is CallShape => s !== null);
  if (olds.length === 0) return false;

  return !olds.some((shape) => admitsArity(shape, arity));
}

/** Can this signature be called with exactly `arity` positional arguments? */
function admitsArity(shape: CallShape, arity: number): boolean {
  const required = shape.parameters.filter((parameter) => !parameter.optional && !parameter.rest).length;
  if (arity < required) return false;
  return shape.parameters.some((parameter) => parameter.rest) || arity <= shape.parameters.length;
}

/**
 * Split the chain `extractExports` joins with ` | ` back into declarations.
 *
 * Only a separator that begins a new declaration counts. A bare ` | ` is far
 * more often a union inside a parameter type — `params?: string | $ZodParams`
 * — and splitting on those would cut signatures in half.
 */
function overloadChain(signature: string): string[] {
  return signature
    .split(/ \| (?=(?:export\s+)?declare\b)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

type CallShape = { parameters: CallParameter[]; returns: string };

interface CallParameter {
  optional: boolean;
  rest: boolean;
  type: string;
}

/**
 * The parameter list and return type of a declaration, in either spelling.
 *
 * `declare function f(a): B` and `declare const f: (a) => B` are one contract
 * to a caller — the same reason `interchangeable` exists — so both are read
 * here rather than only the form that happens to be more common.
 */
function callSignature(signature: string): CallShape | null {
  const open = parameterListStart(signature);
  if (open < 0) return null;

  const close = matchingParenOffset(signature, open);
  if (close < 0) return null;

  const inside = signature.slice(open + 1, close);
  const tail = signature.slice(close + 1).trim();
  // `): R;` for a function declaration, `) => R;` for a const arrow.
  const returns = /^(?:=>|:)\s*([\s\S]*?)\s*;?$/.exec(tail)?.[1];
  if (returns === undefined) return null;

  const parameters: CallParameter[] = [];
  for (const part of splitTopLevel(inside)) {
    const text = part.trim();
    if (!text) continue;

    const declared = /^(\.\.\.)?\s*(?:readonly\s+)?([A-Za-z_$][\w$]*|\{[\s\S]*?\}|\[[\s\S]*?\])\s*(\?)?\s*:\s*([\s\S]+)$/.exec(
      text,
    );
    // An untyped or destructured-without-annotation parameter gives nothing to
    // compare; treating it as matching would be inventing agreement.
    if (!declared) return null;

    parameters.push({
      rest: Boolean(declared[1]),
      optional: Boolean(declared[3]) || Boolean(declared[1]),
      type: declared[4]!,
    });
  }

  return { parameters, returns };
}

/**
 * Where the value parameters begin — past the type parameters, if any.
 *
 * `f<T extends (x: A) => B>(y: T)` has a `(` inside its constraint that opens
 * nothing a caller passes, so the scan tracks angle depth and takes the first
 * `(` outside it.
 */
function parameterListStart(signature: string): number {
  let angle = 0;

  for (let i = 0; i < signature.length; i++) {
    const char = signature[i];
    if (char === '<') angle += 1;
    else if (char === '>' && signature[i - 1] !== '=') angle -= 1;
    else if (char === '(' && angle <= 0) return i;
  }

  return -1;
}

function matchingParenOffset(content: string, open: number): number {
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    if (content[i] === '(') depth += 1;
    else if (content[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Does every argument the old parameter type accepted still satisfy the new one?
 *
 * Textual equality and a grown union are the two easy cases, and for years they
 * were the only ones — which left the most common shape of a minor release
 * being reported as a break. A library adds an option:
 *
 *   before  options?: { props?: P; context?: Map<any, any>; idPrefix?: string }
 *   after   options?: { props?: P; context?: Map<any, any>; idPrefix?: string;
 *                       csp?: Csp; transformError?: (e: unknown) => unknown }
 *
 * Not one existing call has anything to change — every new member is optional —
 * but the two strings differ, so `onlyRelaxesCallers` said no and every call
 * site of `render` in the repository was handed to a developer to inspect. That
 * is a false positive with a paper trail, which is worse than a vague one: it
 * looks researched.
 *
 * So a type is compared by its shape when its shape is legible. Three
 * constructs are read, and each is the same question one level down:
 *
 *   objects  every member the caller could already pass survives, no optional
 *            member became required, and anything new is optional;
 *   tuples   element by element, with extra trailing elements optional;
 *   conditionals  identical check, then each branch.
 *
 * Everything else — mapped types, intersections, a bare type reference whose
 * definition lives in another file — is left to the textual tests. This never
 * proves two *named* types are compatible: `Csp` and `Csp` are equal as text
 * and unknown as declarations, and chasing that would need a type checker
 * rather than a diff. Being unable to decide always means reporting.
 */
function stillAccepts(before: string, after: string, depth = 0): boolean {
  if (sameType(before, after)) return true;
  if (widened(before, after)) return true;
  // A guard against a pathological declaration, not against ordinary nesting:
  // real option objects bottom out long before this.
  if (depth >= MAX_TYPE_DEPTH) return false;

  const old = before.trim();
  const now = after.trim();

  const conditionals = [parseConditional(old), parseConditional(now)] as const;
  if (conditionals[0] && conditionals[1]) {
    // The branch a call takes is decided by the check, so a check that moved is
    // a different function for some caller and nothing below it can be trusted.
    return (
      sameType(conditionals[0].check, conditionals[1].check) &&
      stillAccepts(conditionals[0].whenTrue, conditionals[1].whenTrue, depth + 1) &&
      stillAccepts(conditionals[0].whenFalse, conditionals[1].whenFalse, depth + 1)
    );
  }

  if (isWrapped(old, '{', '}') && isWrapped(now, '{', '}')) {
    return objectStillAccepts(old, now, depth);
  }
  if (isWrapped(old, '[', ']') && isWrapped(now, '[', ']')) {
    return tupleStillAccepts(old, now, depth);
  }

  return false;
}

const MAX_TYPE_DEPTH = 6;

/**
 * An object type, member by member.
 *
 * A removed member is not "the caller passes less now": TypeScript's excess
 * property check rejects an object literal carrying a property the target type
 * does not declare, and an object literal is how options are passed. So a
 * member that disappears breaks calls, and only additions that are optional are
 * free.
 */
function objectStillAccepts(before: string, after: string, depth: number): boolean {
  const old = objectMembers(before);
  const now = objectMembers(after);
  if (!old || !now) return false;

  for (const [name, member] of old) {
    const replacement = now.get(name);
    if (!replacement) return false;
    if (member.optional && !replacement.optional) return false;
    if (!stillAccepts(member.type, replacement.type, depth + 1)) return false;
  }

  for (const [name, member] of now) {
    if (!old.has(name) && !member.optional) return false;
  }

  return true;
}

/**
 * A tuple type, element by element.
 *
 * Worth reading because of rest parameters: `...args: [a: A, options?: O]` is
 * how a library spells "one required argument and an options bag", and the
 * whole option-object case above arrives inside one of these.
 */
function tupleStillAccepts(before: string, after: string, depth: number): boolean {
  const old = tupleElements(before);
  const now = tupleElements(after);
  if (!old || !now) return false;
  if (now.length < old.length) return false;

  for (const [index, element] of old.entries()) {
    const replacement = now[index]!;
    if (element.optional && !replacement.optional) return false;
    if (element.rest !== replacement.rest) return false;
    if (!stillAccepts(element.type, replacement.type, depth + 1)) return false;
  }

  return now.slice(old.length).every((element) => element.optional || element.rest);
}

interface TypeMember {
  optional: boolean;
  type: string;
}

/**
 * The members of an object type literal, or `null` when one of them is not a
 * plain property.
 *
 * Index signatures, call signatures, construct signatures and method shorthand
 * all mean something this comparison does not model, and a member it cannot
 * name is a member it cannot check for removal — so the whole type falls back
 * to the textual tests rather than being half-read.
 */
function objectMembers(type: string): Map<string, TypeMember> | null {
  const members = new Map<string, TypeMember>();

  for (const part of splitMembers(type.trim().slice(1, -1))) {
    const text = part.trim();
    if (!text) continue;

    const declared = /^(?:readonly\s+)?(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*(\?)?\s*:\s*([\s\S]+)$/.exec(text);
    if (!declared) return null;

    const name = declared[1] ?? declared[2] ?? declared[3]!;
    members.set(name, { optional: Boolean(declared[4]), type: declared[5]!.trim() });
  }

  return members;
}

interface TupleElement extends TypeMember {
  rest: boolean;
}

/**
 * The elements of a tuple type, labelled or not.
 *
 * Labels are documentation — `[component: C, options?: O]` and `[C, O?]` are
 * the same tuple — so a rename is not a change to anything a caller passes, and
 * elements are matched by position rather than by name.
 */
function tupleElements(type: string): TupleElement[] | null {
  const elements: TupleElement[] = [];

  for (const part of splitTopLevel(type.trim().slice(1, -1))) {
    const text = part.trim();
    if (!text) continue;

    const labelled = /^(\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*(\?)?\s*:\s*([\s\S]+)$/.exec(text);
    if (labelled) {
      elements.push({
        rest: Boolean(labelled[1]),
        optional: Boolean(labelled[3]) || Boolean(labelled[1]),
        type: labelled[4]!.trim(),
      });
      continue;
    }

    const bare = /^(\.\.\.)?\s*([\s\S]+?)(\?)?$/.exec(text);
    if (!bare) return null;
    elements.push({
      rest: Boolean(bare[1]),
      optional: Boolean(bare[3]) || Boolean(bare[1]),
      type: bare[2]!.trim(),
    });
  }

  return elements;
}

/** `A extends B ? T : F`, split at the top level, or `null` if it is not one. */
function parseConditional(type: string): { check: string; whenTrue: string; whenFalse: string } | null {
  let depth = 0;

  for (let i = 0; i < type.length; i++) {
    const character = type[i]!;
    if ('<([{'.includes(character)) depth += 1;
    else if ('>)]}'.includes(character)) {
      // `=>` is an arrow, not a closing bracket.
      if (!(character === '>' && type[i - 1] === '=')) depth -= 1;
    } else if (character === '?' && depth === 0) {
      const check = type.slice(0, i);
      if (!/\bextends\b/.test(check)) return null;
      const colon = topLevelColon(type, i + 1);
      if (colon === -1) return null;
      return {
        check: check.trim(),
        whenTrue: type.slice(i + 1, colon).trim(),
        whenFalse: type.slice(colon + 1).trim(),
      };
    }
  }

  return null;
}

/** The `:` matching a conditional's `?`, skipping any conditional nested in its true branch. */
function topLevelColon(type: string, from: number): number {
  let depth = 0;
  let pending = 0;

  for (let i = from; i < type.length; i++) {
    const character = type[i]!;
    if ('<([{'.includes(character)) depth += 1;
    else if ('>)]}'.includes(character)) {
      if (!(character === '>' && type[i - 1] === '=')) depth -= 1;
    } else if (depth === 0 && character === '?') pending += 1;
    else if (depth === 0 && character === ':') {
      if (pending === 0) return i;
      pending -= 1;
    }
  }

  return -1;
}

/** Split object-type members on the `;` or `,` that separates them. */
function splitMembers(body: string): string[] {
  return splitTopLevel(body, ';,');
}

/** Is this type wrapped in one matching pair of brackets, rather than merely containing them? */
function isWrapped(type: string, open: string, close: string): boolean {
  if (!type.startsWith(open) || !type.endsWith(close)) return false;

  let depth = 0;
  for (let i = 0; i < type.length; i++) {
    if (type[i] === open) depth += 1;
    else if (type[i] === close) {
      depth -= 1;
      if (depth === 0) return i === type.length - 1;
    }
  }
  return false;
}

/**
 * Did a parameter grow to accept everything it used to, and more?
 *
 * A parameter is the one position where accepting *more* is safe: `f(a: A)`
 * becoming `f(a: A | B)` still takes every argument that compiled before.
 * Libraries do this constantly — a function that took a string learns to take
 * a `URL` too — and reporting it sends a developer to inspect calls that were
 * never at risk.
 *
 * Only the union case, and only when the old type survives as a whole member
 * of the new one. Deciding assignability in general is a type checker's job,
 * and guessing at it is how a real narrowing gets waved through.
 */
function widened(before: string, after: string): boolean {
  const members = splitUnion(after);
  if (members.length < 2) return false;

  const old = splitUnion(before);
  return old.every((member) => members.some((candidate) => sameType(member, candidate)));
}

/** Split a type on `|` that is not nested inside brackets. */
function splitUnion(type: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const character of type) {
    if ('<([{'.includes(character)) depth += 1;
    else if ('>)]}'.includes(character)) depth -= 1;

    if (character === '|' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }

  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Two type annotations, compared without whitespace or a trailing `undefined` union. */
function sameType(a: string, b: string): boolean {
  const normalize = (text: string): string =>
    text
      .replace(/\s+/g, '')
      // `a?: T` and `a: T | undefined` express the same thing to a caller.
      .replace(/\|undefined$/, '');
  return normalize(a) === normalize(b);
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

/**
 * Same declaration, with an import path spelled out in one version and
 * dropped in the other.
 *
 * TypeScript prints a type by its qualified import path — `import("mod").Foo`
 * — whenever it cannot resolve `Foo` to something already in scope at the
 * point it is printing from, and by its bare name otherwise. Which of those
 * happens for the same underlying type can change release to release for
 * reasons that have nothing to do with the type itself: a re-export added
 * locally, a barrel file reorganised, a `.d.ts` bundler swapped out. Neither
 * a caller's arguments nor what it can do with the return value changes
 * either way, so this is compared with the qualifier stripped from both
 * sides rather than left to read as a different type.
 *
 * Stripping every qualifier blind would be a weaker check than it looks:
 * `import("svelte/compiler").PreprocessorGroup` and `import("some-other-lib"
 * ).PreprocessorGroup` both dequalify to the bare name `PreprocessorGroup`,
 * and nothing about that text says whether they are the same declaration or
 * two unrelated types that merely share a name. So a qualifier is only ever
 * dropped when doing so cannot hide that kind of disagreement: if the same
 * identifier is qualified on *both* sides, their modules have to match first;
 * a qualifier appearing on only one side is unconstrained, because that side
 * gives no module to check against and this is the case a re-export being
 * added or removed always produces. This is still not a proof that the
 * referenced declaration itself is unchanged — that would need an actual
 * type checker walking both versions' declaration graphs, not a text diff —
 * only that the two spellings are not provably different types.
 */
export function sameIgnoringImportQualifiers(a: string, b: string): boolean {
  if (a === b) return true;
  const [left, right] = comparableSignatures(a, b);
  return left === right;
}

/**
 * The same two declarations, with import qualifiers dropped when dropping them
 * cannot change the answer.
 *
 * Every structural comparison here — is this alpha-equivalent, does this only
 * relax callers, which half moved — should run on this pair rather than on the
 * raw text, because a qualifier appearing or disappearing is not a change any
 * of them are trying to detect, and leaving it in place makes each of them
 * answer "different" for a reason that has nothing to do with the question it
 * was asked.
 *
 * Returns the originals untouched whenever stripping would hide a real
 * disagreement — see {@link sameIgnoringImportQualifiers} for why the same
 * identifier qualified by two different modules must not be collapsed — so a
 * caller can use the result unconditionally without having to know which case
 * it got.
 */
function comparableSignatures(a: string, b: string): [string, string] {
  const qualifiersA = qualifiedReferences(a);
  const qualifiersB = qualifiedReferences(b);
  if (qualifiersA.size === 0 && qualifiersB.size === 0) return [a, b];

  for (const [name, moduleA] of qualifiersA) {
    const moduleB = qualifiersB.get(name);
    if (moduleB !== undefined && moduleB !== moduleA) return [a, b];
  }

  return [dequalifyImports(a), dequalifyImports(b)];
}

/** Every `import("module").Name` reference, keyed by the name it qualifies. */
function qualifiedReferences(signature: string): Map<string, string> {
  const refs = new Map<string, string>();
  const pattern = /\bimport\((["'])((?:(?!\1).)*)\1\)\.([A-Za-z_$][\w$]*)/g;
  for (const match of signature.matchAll(pattern)) {
    refs.set(match[3]!, match[2]!);
  }
  return refs;
}

function dequalifyImports(signature: string): string {
  return signature.replace(/\bimport\((["'])(?:(?!\1).)*\1\)\./g, '');
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

/**
 * Split on separators that are not nested inside brackets of any kind.
 *
 * The `>` of an arrow closes nothing. Counting it as a bracket leaves the depth
 * permanently short by one for the rest of the string, which is how
 * `f(cb: (x: A) => B, y: C)` came to be read as a single parameter named
 * something unparseable — and, through `callSignature` returning `null`,
 * every signature containing a callback was left undecidable.
 */
function splitTopLevel(text: string, separators = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < text.length; i++) {
    const character = text[i]!;
    if ('<([{'.includes(character)) depth += 1;
    else if ('>)]}'.includes(character)) {
      if (!(character === '>' && text[i - 1] === '=')) depth -= 1;
    }

    if (separators.includes(character) && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }

  if (current.trim()) parts.push(current);
  return parts;
}
