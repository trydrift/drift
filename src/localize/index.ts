import type {
  BreakingChange,
  Confidence,
  DependencyChange,
  Ecosystem,
  ImpactSite,
  ModuleIncompatibleUsage,
} from '../types.js';
import type { Logger } from '../util/logger.js';
import { importKeys, unitAtLine, type FileIndex, type ImportRecord, type RepoIndex } from '../index/metarag.js';
import { isRuntimeConfigPath, type SourceFile } from '../index/walk.js';
import { withinMember } from '../detect/workspace.js';
import { moduleMapKey, type ModuleMaps } from './modules.js';
import { acceptsCallOfArity, callCannotResolveTo } from '../evidence/type-surface.js';
import {
  checkRuntimeCompatibility,
  findRuntimeDeclarations,
} from '../rationale/runtime.js';

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
 *
 * Before any of that, a match has to *resolve*. A matcher can only say the
 * characters are present, and the difference between a tool and a grep is
 * everything that happens between the match and the site: `this.render()` is a
 * method on the enclosing class, `private render()` is a declaration,
 * `overlay.render()` next to that declaration is a call to it, and in a
 * language whose imports enumerate their bindings a bare `render` in a file
 * that imported only `{ mount }` is not this package's `render` at all. Each
 * of those is dropped rather than downgraded, because a low-confidence finding
 * still costs a developer the read — and Svelte's `render` gaining two optional
 * options once produced seven of them in a repository that had never called it.
 *
 * Two things widen that search without widening the noise, and both are worth
 * naming because they are what separates this from grep with extra steps:
 *
 *   **The names come from the package.** `importKeysFor` still knows that
 *   `pillow` is imported as `PIL`, but it is the fallback now. When
 *   `src/localize/modules.ts` could read the published artefact — the wheel,
 *   the jar, the `.nupkg`, the gem, the Hex tarball, Packagist's autoload map
 *   — the join runs against what the package *says* it provides. That is what
 *   makes PHP, Elixir, and Swift localizable at all, and what stops a
 *   `jackson-core` finding landing in a file that imports only
 *   `jackson-databind`.
 *
 *   **The import graph is followed, not just queried.** A barrel file that
 *   re-exports `axios` puts every one of its own importers one edge away from
 *   a change nobody would find by searching for `import axios`. Those files
 *   are reached through `RepoIndex.localImporters` and reported at reduced
 *   confidence, because the binding is inherited rather than observed. Only
 *   genuine re-exports propagate: a module that *wraps* a dependency is the
 *   module that breaks, and its callers have nothing to fix.
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
  /** Every workspace member, used to keep runtime declarations out of siblings. */
  members?: readonly string[];
  /**
   * Module names read from the published artefacts, keyed by `moduleMapKey`.
   *
   * Absent means "nobody asked the registry", which is an ordinary state —
   * the audit and the tests both run without it — and the name heuristics take
   * over. It never means "the package provides no modules".
   */
  moduleMaps?: ModuleMaps;
  /**
   * How far to follow this repository's own re-export edges. `0` disables it.
   *
   * Three is deliberate rather than arbitrary: `feature -> index barrel ->
   * package barrel -> dependency` is the deepest chain that occurs in ordinary
   * layouts, and each extra hop multiplies the candidate set while the
   * confidence attached to it is already `low`.
   */
  maxReExportDepth?: number;
}

export function localize(
  breakingChanges: readonly BreakingChange[],
  dependencyChanges: readonly DependencyChange[],
  index: RepoIndex,
  files: readonly SourceFile[],
  options: LocalizeOptions,
): ImpactSite[] {
  const { logger, maxSitesPerChange = 100, member, members, moduleMaps, maxReExportDepth = 3 } = options;

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

  /**
   * `candidateFiles` walks this repository's re-export graph from every
   * importer of a dependency, up to `maxReExportDepth` edges out — work that
   * depends only on *which dependency* changed, never on which breaking
   * change within it. A major bump routinely produces a dozen or more
   * `BreakingChange`s for the same dependency, and without this cache the
   * same graph walk ran once per change: identical input, identical output,
   * paid for again each time. Keyed by dependency name because
   * `ecosystemsByName`, `moduleMaps` and `maxReExportDepth` are all constant
   * for the whole call — only the dependency varies the result. The
   * endpoint-change path (`removed-endpoint`/`changed-endpoint`) returns a
   * different, kind-dependent shape and is deliberately excluded so it can
   * never be served from — or poison — this cache.
   */
  const candidateFilesCache = new Map<
    string,
    { files: FileIndex[]; names: string[]; reach: Reach }
  >();

  for (const change of breakingChanges) {
    // A runtime requirement has no code symbol. Searching source for "Node.js"
    // matches comments and documentation, which is a pure false positive — the
    // fix lives in CI config, engine fields, and container images.
    if (change.kind === 'runtime-requirement') {
      sites.push(...localizeRuntimeRequirement(change, contentByPath, member, members));
      continue;
    }

    if (change.kind === 'module-system-change') {
      sites.push(
        ...inMember(
          localizeModuleSystemChange(
            change,
            index,
            contentByPath,
            ecosystemsByName.get(change.dependency) ?? [],
            moduleMaps,
          ),
          member,
        ),
      );
      continue;
    }

    const isEndpointChange =
      change.kind === 'removed-endpoint' || change.kind === 'changed-endpoint';
    const cached = isEndpointChange ? undefined : candidateFilesCache.get(change.dependency);
    const { files: candidateFileList, names, reach } =
      cached ??
      candidateFiles(
        change,
        index,
        ecosystemsByName.get(change.dependency) ?? [],
        moduleMaps,
        maxReExportDepth,
        indexByPath,
      );
    if (!isEndpointChange && !cached) {
      candidateFilesCache.set(change.dependency, { files: candidateFileList, names, reach });
    }
    const candidates = candidateFileList.filter(
      (file) => member === undefined || withinMember(file.path, member),
    );

    if (candidates.length === 0) {
      logger.debug(`No importers found for ${change.dependency}; ${change.id} has no impact sites`);
      continue;
    }

    const found = searchFiles(
      change,
      candidates,
      contentByPath,
      indexByPath,
      maxSitesPerChange,
      names,
      reach,
    );
    sites.push(...found);

    if (found.length >= maxSitesPerChange) {
      logger.warn(
        `${change.dependency}: ${change.summary} matched at least ${maxSitesPerChange} locations; the plan lists the first ${maxSitesPerChange}.`,
      );
    }
  }

  return sites;
}

function localizeModuleSystemChange(
  change: BreakingChange,
  index: RepoIndex,
  contentByPath: Map<string, string>,
  ecosystemsForName: readonly Ecosystem[],
  moduleMaps: ModuleMaps | undefined,
): ImpactSite[] {
  const incompatible = change.moduleSystem?.incompatibleUsage ?? [];
  if (incompatible.length === 0) return [];
  const affectedSpecifiers = change.moduleSystem?.affectedSpecifiers;
  const affectedSpecifierPatterns = change.moduleSystem?.affectedSpecifierPatterns;

  const { names, exact } = candidateNames(change.dependency, ecosystemsForName, moduleMaps);
  const candidates = new Set<string>();
  for (const name of names) {
    for (const path of index.importers.get(name) ?? []) candidates.add(path);
  }
  if (candidates.size === 0 && !exact) {
    for (const [key, importerPaths] of index.importers) {
      if (!matchesImportName(key, names)) continue;
      for (const path of importerPaths) candidates.add(path);
    }
  }

  const sites: ImpactSite[] = [];
  for (const file of index.files) {
    if (!candidates.has(file.path)) continue;
    const content = contentByPath.get(file.path);
    if (!content) continue;
    const lines = content.split('\n');

    for (const record of file.imports) {
      if (!matchesImportName(record, names)) continue;
      if (!specifierIsAffected(record.specifier, affectedSpecifiers, affectedSpecifierPatterns)) continue;
      if (!loadStyleIsIncompatible(record, incompatible)) continue;

      const line = lines[record.line - 1] ?? '';
      const unit = unitAtLine(file, record.line);
      const column = line.indexOf(record.specifier);
      sites.push({
        breakingChangeId: change.id,
        file: file.path,
        line: record.line,
        excerpt: line.trim().slice(0, 200),
        enclosingSymbol: unit?.name,
        matchedSymbol: record.loadStyle === 'commonjs-require' ? 'require' : record.specifier,
        ...(column >= 0 ? { column, matchedText: record.specifier } : {}),
        confidence: 'high',
      });
    }
  }

  return dedupeSites(sites);
}

function specifierIsAffected(
  specifier: string,
  exact: readonly string[] | undefined,
  patterns: readonly string[] | undefined,
): boolean {
  if (!exact?.length && !patterns?.length) return true;
  if (exact?.includes(specifier)) return true;
  return patterns?.some((pattern) => specifierMatchesPattern(specifier, pattern)) ?? false;
}

function specifierMatchesPattern(specifier: string, pattern: string): boolean {
  const stars = [...pattern.matchAll(/\*/g)];
  if (stars.length !== 1) return false;
  const [prefix, suffix] = pattern.split('*') as [string, string];
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return false;
  return specifier.length > prefix.length + suffix.length;
}

function loadStyleIsIncompatible(
  record: ImportRecord,
  incompatible: readonly ModuleIncompatibleUsage[],
): boolean {
  switch (record.loadStyle) {
    case 'commonjs-require':
      return incompatible.includes('require');
    case 'esm-static':
      return incompatible.includes('static-import');
    case 'esm-dynamic':
      return incompatible.includes('dynamic-import');
    case 're-export':
      return incompatible.includes('re-export');
    default:
      return false;
  }
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
  member?: string,
  allMembers?: readonly string[],
): ImpactSite[] {
  const runtime = change.runtime?.runtime;
  const requirement = change.runtime?.requirement;
  if (!runtime || !requirement) return [];

  const files = [...contentByPath].map(([path, content]) => ({ path, content }));
  const declarations = findRuntimeDeclarations(files, runtime, member, allMembers);
  const compatibility = checkRuntimeCompatibility(runtime, declarations, requirement);
  return compatibility
    .filter((declaration) => declaration.verdict !== 'compatible')
    .map((declaration) => ({
      breakingChangeId: change.id,
      file: declaration.file,
      line: declaration.line,
      excerpt: files.find((file) => file.path === declaration.file)?.content.split('\n')[declaration.line - 1]?.trim().slice(0, 200) ?? '',
      matchedSymbol: runtime,
      confidence: 'high' as const,
    }));
}

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
  moduleMaps: ModuleMaps | undefined,
  maxReExportDepth: number,
  byPath: Map<string, FileIndex>,
): { files: FileIndex[]; names: string[]; reach: Reach } {
  const isEndpointChange =
    change.kind === 'removed-endpoint' || change.kind === 'changed-endpoint';
  if (isEndpointChange) return { files: index.files, names: [], reach: new Map() };

  const { names, exact } = candidateNames(change.dependency, ecosystemsForName, moduleMaps);
  const paths = new Set<string>();

  for (const name of names) {
    for (const path of index.importers.get(name) ?? []) paths.add(path);
  }

  // Prefix match catches Go module paths and Java package prefixes, where the
  // manifest coordinate and the import path share a root but are not equal.
  //
  // Skipped outright when the names came from the published artefact, because
  // there the approximation is not a safety net but a leak: the whole value of
  // reading `jackson-core`'s jar is knowing it ships nothing under
  // `...jackson.databind`, and a prefix walk would hand that finding straight
  // back to a file importing the sibling artifact.
  if (paths.size === 0 && !exact) {
    for (const [key, importerPaths] of index.importers) {
      if (matchesImportName(key, names)) {
        for (const path of importerPaths) paths.add(path);
      }
    }
  }

  const reach: Reach = new Map();
  for (const path of paths) reach.set(path, { direct: true, inherited: new Set() });

  if (maxReExportDepth > 0) {
    reachThroughReExports(index, names, reach, maxReExportDepth, byPath);
  }

  return { files: index.files.filter((f) => reach.has(f.path)), names, reach };
}

/**
 * Every name this dependency might be imported under, best source first.
 *
 * When the published artefact answered, its answer is used *instead of* the
 * heuristics, not alongside them. That is the whole point: mixing a fact with
 * a guess produces the guess's false positives with the fact's air of
 * authority. The dependency's own name is kept regardless, because in most
 * ecosystems it really is the import name and an artefact that lists modules
 * has no reason to repeat it.
 */
function candidateNames(
  dependency: string,
  ecosystemsForName: readonly Ecosystem[],
  moduleMaps: ModuleMaps | undefined,
): { names: string[]; exact: boolean } {
  const fromArtefact = new Set<string>();
  for (const ecosystem of ecosystemsForName) {
    const map = moduleMaps?.get(moduleMapKey(ecosystem, dependency));
    for (const name of map?.names ?? []) fromArtefact.add(name);
  }
  if (fromArtefact.size > 0) {
    return { names: [...new Set([...fromArtefact, dependency])], exact: true };
  }

  const names =
    ecosystemsForName.length > 0
      ? [...new Set(ecosystemsForName.flatMap((eco) => importKeysFor(dependency, eco)))]
      : importKeysFor(dependency, undefined);
  return { names, exact: false };
}

/**
 * How a file came to be a candidate, and what it inherited if indirectly.
 *
 * `direct` files import the dependency themselves. The rest reached it through
 * one or more of this repository's own re-export edges, and `inherited` holds
 * the names they took across the last one — which is what keeps a transitive
 * site's confidence honest: a name the importing file actually asked for by
 * name is worth more than one that arrived under `export *`.
 */
type Reach = Map<string, { direct: boolean; inherited: Set<string> }>;

/**
 * Walk outward from the direct importers along re-export edges.
 *
 * The rule that keeps this from becoming a whole-repository search is that
 * only a *forwarding* import extends the frontier. `export { Foo } from 'pkg'`
 * forwards; `import { Foo } from 'pkg'` does not. In C the distinction does not
 * exist — an `#include` is a textual splice and everything it pulled in comes
 * with it — which is why a header that includes `<zlib.h>` really does put
 * every file including that header in range, and why the C localizer needed
 * this more than any other.
 */
function reachThroughReExports(
  index: RepoIndex,
  names: readonly string[],
  reach: Reach,
  maxDepth: number,
  // Built once per `localize` call rather than once per breaking change. A
  // repository with five thousand files and a package reporting two hundred
  // removals paid for a million map insertions to answer a question whose
  // answer never changed between them.
  byPath: Map<string, FileIndex>,
): void {
  // A frontier is only extended by files that forward what they imported.
  let frontier = [...reach.keys()].filter((path) => forwards(byPath.get(path), names));

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];

    for (const path of frontier) {
      for (const edge of index.localImporters.get(path) ?? []) {
        if (reach.size >= MAX_REACHED_FILES) return;
        const existing = reach.get(edge.from);
        if (existing) {
          for (const binding of edge.bindings) existing.inherited.add(binding);
          continue;
        }
        reach.set(edge.from, { direct: false, inherited: new Set(edge.bindings) });
        // The chain continues only where this file forwards too.
        if (edge.reExport) next.push(edge.from);
      }
    }

    frontier = next;
  }
}

/**
 * A ceiling on the transitive set.
 *
 * A repository whose root barrel re-exports a dependency puts every file in
 * the project one edge away from it, and a "finding" spanning nine hundred
 * files is not a finding — it is a reason to stop reading the report. The cap
 * is high enough that ordinary layouts never touch it and low enough that a
 * pathological one degrades to the direct importers plus a large sample.
 */
const MAX_REACHED_FILES = 400;

/** Does this file forward one of the named packages on to its own importers? */
function forwards(file: FileIndex | undefined, names: readonly string[]): boolean {
  if (!file) return false;
  return file.imports.some(
    (record) =>
      record.reExport === true &&
      (names.length === 0 || matchesImportName(record, names)),
  );
}

/** Does an import identify one of the given candidate names, under any key? */
function matchesImportName(record: ImportRecord | string, names: readonly string[]): boolean {
  const keys = typeof record === 'string' ? [record] : importKeys(record);
  return keys.some((key) => names.some((name) => identifies(key, name) || identifies(name, key)));
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
  // `\\` is PHP's namespace separator, and a PSR-4 root is an ancestor of the
  // namespace a class lives in exactly the way a Go module path is an ancestor
  // of a package path.
  return next === '/' || next === '.' || next === ':' || next === '\\';
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
    // Everything below is a *fallback*. The artefact-backed resolver in
    // `modules.ts` answers all four of these from the package itself, and does
    // it correctly; these rules exist for the run where the registry was
    // unreachable, and they are the ecosystems' own naming conventions rather
    // than a table of names somebody happened to know.
    case 'packagist': {
      // Composer coordinates are `vendor/package` and PSR-4 roots are
      // overwhelmingly `Vendor\Package`, StudlyCased from the same words.
      const [vendor, pkg] = dependency.split('/');
      if (vendor && pkg) {
        names.add(`${studly(vendor)}\\${studly(pkg)}`);
        names.add(studly(vendor));
      }
      break;
    }
    case 'hex': {
      // Elixir modules are the package name StudlyCased; an Erlang package's
      // modules keep the bare atom.
      names.add(studly(dependency));
      names.add(dependency.toLowerCase());
      break;
    }
    case 'swift': {
      // Swift packages are identified by `owner/repo` here, there being no
      // registry, and a repository conventionally names its module after
      // itself minus the `swift-` the community prefixes to make it findable.
      const repo = dependency.split('/').pop() ?? dependency;
      names.add(repo);
      names.add(studly(repo));
      if (repo.toLowerCase().startsWith('swift-')) names.add(studly(repo.slice(6)));
      break;
    }
    case 'cocoapods':
      // A pod name that cannot be an identifier is underscored to make one.
      names.add(dependency.replace(/[-.]/g, '_'));
      break;
    case 'opam':
      // dune names a library's module after the package with the first letter
      // capitalised, and a sub-library `pkg.sub` as `Pkg_sub`.
      names.add(studly(dependency.replace(/\./g, '_')));
      names.add(capitalize(dependency.replace(/\./g, '_')));
      break;
    default:
      break;
  }

  return [...names];
}

/** `phoenix_live_view` -> `PhoenixLiveView`; `guzzlehttp` -> `Guzzlehttp`. */
function studly(name: string): string {
  return name
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => capitalize(part))
    .join('');
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
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

/**
 * A file split into lines, and the two masked views of it, computed once.
 *
 * `searchFiles` runs once per breaking change, and a package like Twisted
 * reports dozens of them against overlapping sets of candidate files — so the
 * same file was being split and masked once per finding. On a scan of Scrapy
 * that made `maskComments` twenty per cent of all CPU the process burned, every
 * repetition producing a character-for-character identical answer.
 *
 * Keyed on the index entry rather than on the path or the content: index
 * entries are built once per scan and handed to every `localize` call, so
 * object identity is exactly the right notion of "the same file" here, and a
 * `WeakMap` means a stale index is collected rather than pinned.
 *
 * Both views are lazy. A change whose symbols are all plain identifiers never
 * reads the string-preserving view, and computing it anyway doubled the cost of
 * the most expensive step for nothing.
 */
interface MaskedFile {
  readonly lines: readonly string[];
  /** Comments stripped, string *contents* kept — for symbols that live in one. */
  withStrings(): readonly string[];
  /** Comments stripped and string contents blanked — for identifiers. */
  withoutStrings(): readonly string[];
}

const maskedFiles = new WeakMap<FileIndex, MaskedFile>();

function maskedFor(candidate: FileIndex, content: string): MaskedFile {
  const cached = maskedFiles.get(candidate);
  if (cached) return cached;

  const lines = content.split('\n');
  let kept: readonly string[] | undefined;
  let blanked: readonly string[] | undefined;
  const view: MaskedFile = {
    lines,
    withStrings: () => (kept ??= maskComments(lines, { blankStrings: false })),
    withoutStrings: () => (blanked ??= maskComments(lines, { blankStrings: true })),
  };

  maskedFiles.set(candidate, view);
  return view;
}

function searchFiles(
  change: BreakingChange,
  candidates: readonly FileIndex[],
  contentByPath: Map<string, string>,
  indexByPath: Map<string, FileIndex>,
  limit: number,
  names: readonly string[],
  reach: Reach,
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
        : candidate.imports.filter((i) => matchesImportName(i, names));
    const importedNames = new Set(relevantImports.flatMap((i) => i.bindings));
    const importsDependency = relevantImports.length > 0;
    // A file that never imported the dependency but inherited its names across
    // a re-export edge. Its bindings are real — they are the names it asked the
    // barrel for — but they were never observed against the dependency itself,
    // so `confidenceFor` refuses to call any of them `high`.
    const inherited = reach.get(candidate.path);
    const indirect = inherited !== undefined && !inherited.direct;

    // Names this file provably got from somewhere *else*, and the lines every
    // import in it occupies. Both exist to answer questions about a specific
    // line rather than about the file as a whole — see `shadowed` and
    // `breaksTheImport`.
    const foreignNames = new Set(
      candidate.imports
        .filter((i) => !matchesImportName(i, names))
        .flatMap((i) => i.bindings)
        .filter((binding) => binding !== '*'),
    );

    /**
     * Names this file defines itself.
     *
     * A repository that declares its own `parse`, `Client`, or `render` has
     * shadowed the dependency's symbol of the same name for the whole module,
     * and every mention below the definition is the local one. This was the
     * single largest remaining source of confident-looking false positives in
     * the ecosystems whose imports bind nothing by name, where there was no
     * import binding to contradict the match.
     */
    const locallyDefined = new Set(
      candidate.units
        .filter((unit) => unit.kind !== 'method')
        .map((unit) => unit.name),
    );
    /**
     * Methods this file declares, by their bare name.
     *
     * Kept apart from `locallyDefined` because a method is only reached through
     * a receiver, so it shadows less: `client.request()` is not the local
     * `request` merely because some class in the file has one. It shadows
     * exactly as far as the receiver is unknown to this dependency — see where
     * this is read.
     */
    const locallyDefinedMethods = new Set(
      candidate.units
        .filter((unit) => unit.kind === 'method')
        .map((unit) => unit.name.split('.').pop() ?? unit.name),
    );
    /**
     * Lines that *declare* something, by the name they declare.
     *
     * A declaration is never a call into a dependency, whatever it is called.
     * `private render(): void {` matches an invocation search for `render` as
     * readily as `this.render()` does, and both were reported against Svelte's
     * `render` in a repository whose only relationship to it was owning a class
     * with a method of the same name.
     *
     * Variables are excluded: `const parse = pkg.parse` declares a name *and*
     * uses the dependency on one line, and that line is a real site.
     */
    const declarations = new Map<number, Set<string>>();
    for (const unit of candidate.units) {
      if (unit.kind === 'variable') continue;
      const bare = unit.name.split('.').pop() ?? unit.name;
      const declared = declarations.get(unit.startLine) ?? new Set<string>();
      declared.add(unit.name);
      declared.add(bare);
      declarations.set(unit.startLine, declared);
    }
    /**
     * Can an unbound name in this file be ruled out as the dependency's?
     *
     * Only where the language's imports say everything they bring into scope.
     * In TypeScript, Python, Go, Rust and Java an import enumerates its
     * bindings, so a bare `render` in a file whose only Svelte import is
     * `{ mount }` is provably not Svelte's `render` — it is a global, a local,
     * or something from another package. In Dart, C, Swift or C# an import
     * makes a whole namespace visible without naming any of it, so the same
     * absence proves nothing at all and the match keeps its low-confidence
     * report.
     *
     * A wildcard (`import *`, `use foo::*`) or a synthesised record forfeits
     * this for the file: neither enumerates anything.
     */
    const bindingsEnumerated =
      ENUMERATED_IMPORT_LANGUAGES.has(candidate.language) &&
      importsDependency &&
      !indirect &&
      relevantImports.every((i) => i.synthetic !== true && !i.bindings.includes('*'));
    // Synthetic records are call sites the index inferred, not import lines.
    // Excluding them here is what lets `Jason.encode!(body)` be reported as the
    // site it is rather than suppressed as the import it is not.
    const importLines = new Set(
      candidate.imports.filter((i) => i.synthetic !== true).map((i) => i.line),
    );
    const importStatementBreaks = breaksTheImport(change.kind);
    // A changed signature is a fact about invocations. Whether this file has
    // any is a per-file question, because the answer depends on the language
    // it is written in — see `callsAreParenthesised`.
    const invocationOnly =
      breaksOnlyAtTheCall(change.kind) && callsAreParenthesised(candidate.language);

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
    //
    // Computed once per file for the whole scan, and each view only if a symbol
    // actually reads it. See `maskedFor`.
    const view = maskedFor(candidate, content);
    const { lines } = view;

    for (const symbol of change.symbols) {
      const derivedOwner = ownerForDerivedSymbol(change, symbol);
      const ownerBindings = derivedOwner
        ? bindingsForOwner(derivedOwner, relevantImports, content, inherited?.inherited)
        : new Set<string>();
      const receiverBindings = derivedOwner
        ? receiversConstructedFrom(content, ownerBindings)
        : new Set<string>();
      const dependencyOwnedReceivers = new Set([...ownerBindings, ...receiverBindings]);
      const directlyImportedLeaf = derivedOwner
        ? directlyImportsQualifiedLeaf(change, symbol, relevantImports)
        : importedNames.has(symbol);
      const topLevelQualifiedLeaf = derivedOwner
        ? qualifiedLeafBelongsToDependencyRoot(change, symbol, names)
        : false;

      const matcher = invocationOnly ? invocationMatcherFor(symbol) : matcherFor(symbol);
      if (!matcher) continue;

      // The name in this file belongs to a different package. `Certificate` in
      // a file that writes `from twisted.internet.ssl import Certificate` is
      // Twisted's class, whatever cryptography did to a class of the same name,
      // and reporting it is a false positive no reviewer can act on.
      if (shadowed(symbol, importedNames, foreignNames)) continue;
      if (definedLocally(symbol, importedNames, locallyDefined)) continue;

      const inString = livesInStringLiteral(symbol);
      const masked = inString ? view.withStrings() : view.withoutStrings();
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
        matcher.lastIndex = 0;
        const hit = matcher.exec(searchable);
        if (
          !hit &&
          !(invocationOnly && callOpensOnNextLine(symbol, searchable, masked[i + 1]))
        ) {
          continue;
        }

        // What is written immediately before the match decides whether it is a
        // use of this dependency at all, and neither rule can be expressed in
        // the matcher because both are about a *different* name.
        if (hit && qualifiedByAnother(
          searchable,
          hit.index,
          importedNames,
          foreignNames,
          locallyDefined,
          candidate.language,
          dependencyOwnedReceivers,
        )) {
          continue;
        }
        if (hit && isAtomLiteral(searchable, hit.index, candidate.language)) continue;

        // Everything from here to the push is one question: does this
        // occurrence of the name *resolve* to the dependency's symbol? A
        // matcher can only say the characters are there.
        //
        // `chain` is the qualifying path written before the match —
        // `os.path.join` gives `['os', 'path']`, `this.render()` gives
        // `['this']`, a bare `render()` gives nothing. Its root is what decides
        // where the name came from, which is why the whole chain is read rather
        // than the receiver alone: `os` is the import, `path` is a name only
        // Python's own module system knows.
        const chain = hit ? receiverChainOf(searchable, hit.index, candidate.language) : undefined;
        const root = chain?.[0];
        // A path rooted in a name this file bound from the dependency, or in
        // the dependency's own module name, is the dependency's symbol.
        const resolvedByPath =
          root !== undefined &&
          (importedNames.has(root) || importedNames.has('*') || matchesImportName(root, names));

        // Surface diffs retain a bare leaf beside a qualified member so direct
        // imports and destructuring can still be found. The leaf itself is not
        // ownership evidence. Keep it only when this occurrence is directly
        // imported, inherited through a re-export, qualified by the imported
        // owner (including an alias/module path), or reached through a receiver
        // constructed from that owner. This is name-agnostic: `find`, `open`,
        // `parse`, and every future generic leaf follow the same rule.
        let resolvedByOwner = false;
        if (derivedOwner && !directlyImportedLeaf) {
          const inheritedLeaf = topLevelQualifiedLeaf && (inherited?.inherited.has(symbol) ?? false);
          const ownerOnPath =
            root !== undefined &&
            (ownerBindings.has(root) || receiverBindings.has(root) || Boolean(chain?.some((part) => ownerBindings.has(part))));
          if (!inheritedLeaf && !ownerOnPath) continue;
          resolvedByOwner = ownerOnPath;
        }

        // `this.render()`, `self.render()`, `super.render()` — a member of the
        // enclosing object, which no import ever binds. This is the single
        // largest class of false positive a name search produces in
        // object-oriented code, and no reviewer can act on one: the method is
        // right there in the same file.
        if (!resolvedByPath && root !== undefined && SELF_REFERENCES.has(root)) continue;

        // A method of the same name is declared in this file and the receiver
        // is not the dependency's. `overlay.render()` beside `private
        // render()` is the local one.
        if (!resolvedByPath && root !== undefined && locallyDefinedMethods.has(symbol)) continue;

        // The declaration itself, not a call into anything.
        if (declarations.get(i + 1)?.has(symbol)) continue;

        // Nothing in this file brought the name in from this dependency, in a
        // language where an import would have had to say so.
        //
        // Only for a plain identifier. A module specifier or URL path
        // (`@scope/pkg`, `/v1/users`) is never bound by anything and appears
        // only as data, and a dotted symbol (`Todo.__init__`) already carries
        // enough of its own qualification that a bare name collision is not
        // the likely explanation — the argument this rule rests on is about
        // short identifiers being reused, and neither of those is one.
        const bound =
          importedNames.has(symbol) ||
          importedNames.has(symbol.split('.')[0] ?? symbol) ||
          importedNames.has('*');
        const resolvable = !symbol.includes('.') && !livesInStringLiteral(symbol);
        if (bindingsEnumerated && resolvable && !bound && !resolvedByPath && !resolvedByOwner) continue;

        // The compiler's answer, reached without a compiler: this call passes
        // arguments the new signature still accepts, in positions whose type
        // did not move. Nothing here has anything to change, so it is not a
        // site. See `acceptsCallOfArity` for why a call is only exposed to the
        // parameters it actually fills.
        if (invocationOnly && unaffectedByTheNewSignature(change, masked, i, hit)) continue;

        const unit = fileIndex ? unitAtLine(fileIndex, i + 1) : undefined;
        // A member access (`x.symbol`) whose receiver is not something this
        // file provably bound from the dependency. `chain` is absent only for
        // an unqualified match, and for the call-opens-on-next-line fallback,
        // where there is no match index on this line to read a receiver from.
        const unboundReceiver = root !== undefined && !resolvedByPath && !resolvedByOwner;

        sites.push({
          breakingChangeId: change.id,
          file: candidate.path,
          line: i + 1,
          excerpt: line.trim().slice(0, 200),
          enclosingSymbol: unit?.name,
          matchedSymbol: symbol,
          // The exact occurrence, not just the line. `masked` is
          // offset-preserving (see `maskComments`), so an index into it is an
          // index into `line`. Absent on the call-opens-on-next-line
          // fallback, where there is no match on this line to point at — and
          // absent is honest there, since a fix plan must not invent a
          // position Drift never established.
          ...(hit ? { column: hit.index, matchedText: hit[0] } : {}),
          confidence: confidenceFor(symbol, importedNames, importsDependency, indirect, inherited?.inherited, unboundReceiver, resolvedByOwner),
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

  const escaped = trimmed
    .replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    .replace(/\\\./g, '(?:\\.|::)');
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

/**
 * Does the new signature still accept this exact call?
 *
 * The surface diff already asks whether a signature change is safe for every
 * caller and reports it when it is not. That is the right default with no call
 * sites in front of it, but it is answered again here with one in hand, where
 * the question is narrower and the answer is often no change at all: a call is
 * only exposed to the parameters it actually fills.
 *
 * This is what stopped a zod 3 → 4 upgrade reporting 81 sites of
 * `z.string()`, `z.boolean()` and `z.number()`. Those pass nothing, both
 * declarations accept nothing, and both return the same type — so every one of
 * them compiled before and compiles after, and each was being handed to an
 * agent that spent tokens rediscovering exactly that.
 */
function unaffectedByTheNewSignature(
  change: BreakingChange,
  masked: readonly string[],
  line: number,
  hit: RegExpExecArray | null,
): boolean {
  if (!change.before || !change.after) return false;
  // Only the plain-call spelling is read. JSX passes its props as an element,
  // and the `callOpensOnNextLine` fallback has no match index to start from —
  // neither gives a paren to count from, and inventing one would be guessing.
  if (!hit || !hit[0].endsWith('(')) return false;

  const open = hit.index + hit[0].length - 1;
  const arity = callArity(masked, line, open);
  if (arity === null) return false;

  // Two ways a call site has nothing to do with a changed signature: the new
  // declaration still accepts it, or the old one never did — the latter being
  // a name this file shares with the dependency's symbol rather than a use of
  // it. See `acceptsCallOfArity` and `callCannotResolveTo`.
  return (
    acceptsCallOfArity(change.before, change.after, arity) || callCannotResolveTo(change.before, arity)
  );
}

/**
 * How many arguments this call actually passes, or null when that cannot be
 * read with confidence.
 *
 * Only ever used to *suppress* a finding, so every ambiguity resolves to null
 * and leaves the site reported. An argument list that runs off the end of the
 * window, nests unevenly, or contains punctuation this cannot account for is
 * exactly the case where a guess would be a missed break.
 *
 * `masked` has comments stripped and string contents blanked, so a paren or a
 * comma inside a literal is already gone by the time this counts them.
 */
function callArity(masked: readonly string[], line: number, open: number): number | null {
  let depth = 0;
  let commas = 0;
  let content = false;

  for (let i = line; i < masked.length && i < line + ARGUMENT_LIST_WINDOW; i++) {
    const text = masked[i]!;
    for (let column = i === line ? open : 0; column < text.length; column++) {
      const char = text[column]!;

      if (char === '(' || char === '[' || char === '{') {
        depth += 1;
        if (depth > 1) content = true;
        continue;
      }

      if (char === ')' || char === ']' || char === '}') {
        depth -= 1;
        if (depth < 0) return null;
        if (depth === 0) {
          // A bracket that closed the argument list must be the paren that
          // opened it; anything else means the scan lost its place.
          if (char !== ')') return null;
          return content ? commas + 1 : 0;
        }
        continue;
      }

      if (depth === 1 && char === ',') {
        commas += 1;
        content = true;
        continue;
      }

      // A backtick opens a template literal, whose `${}` interpolations the
      // masking does not blank — the punctuation inside them would be counted
      // as if it were part of the argument list.
      if (char === '`') return null;
      if (!/\s/.test(char)) content = true;
    }
  }

  return null;
}

/**
 * How far an argument list may run before this stops trying to read it. A
 * genuinely long call is rare; a scan that has lost its place is not, and the
 * cost of continuing is a wrong count on a line nobody asked about.
 */
const ARGUMENT_LIST_WINDOW = 200;

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
  /^\s*(?:@?import\b|from\s+[\w.]+\s+import\b|#\s*include\b|-include(?:_lib)?\(|using\s+(?:static\s+)?[\w.]+\s*;|(?:pub\s+)?use\s+[\w:\\]|alias\s+[A-Z]|require\s+[A-Z]|require(?:_relative|_once)?\s*[("'`]|include(?:_once)?\s*[("']|open\s+[A-Z]|extern\s+crate\b|package\s+[\w.]+\s*;)/;

/**
 * Is the match a member of something that belongs to somebody else?
 *
 * `Scope.push(...)` is a call on Phoenix's own `Scope` module, whatever Plug
 * did to a function called `push`. The receiver is the evidence and it is
 * right there in the text: a name bound from another package's import, or
 * declared in this very file. Phoenix's router was reported as using Plug's
 * `push` on that exact line, and no reviewer could have acted on it.
 *
 * Only a *known* receiver counts. `client.request()` where `client` is a local
 * variable proves nothing either way, and treating an unknown receiver as
 * disqualifying would suppress most real findings in object-oriented code.
 */
function qualifiedByAnother(
  line: string,
  at: number,
  importedNames: ReadonlySet<string>,
  foreignNames: ReadonlySet<string>,
  locallyDefined: ReadonlySet<string>,
  language: FileIndex['language'],
  dependencyOwnedReceivers: ReadonlySet<string> = new Set(),
): boolean {
  const receiver = receiverChainOf(line, at, language)?.at(-1);
  if (!receiver) return false;
  // A receiver this file bound from *this* dependency is the opposite signal.
  if (importedNames.has(receiver) || importedNames.has('*')) return false;
  if (dependencyOwnedReceivers.has(receiver)) return false;
  return foreignNames.has(receiver) || locallyDefined.has(receiver);
}

/**
 * The qualifying path written before a match, outermost name first.
 *
 * `os.path.join(` gives `['os', 'path']`, `Foo::Bar::baz` gives `['Foo',
 * 'Bar']`, and a bare `join(` gives nothing. The whole chain matters because
 * the two ends answer different questions: the root says which import (if any)
 * the name came from, and the last element is the receiver a shadowing rule
 * asks about.
 *
 * `->` counts only in PHP. It is the member operator there, and `$this->render()`
 * is unreadable without it — but in Elixir a `case` clause is written
 * `:ok -> render(conn)`, and reading `ok` as a receiver would quietly demote
 * every finding in an idiomatic pipeline.
 */
function receiverChainOf(
  line: string,
  at: number,
  language: FileIndex['language'],
): string[] | undefined {
  const pattern =
    language === 'php'
      ? /([A-Za-z_$][\w$]*)\s*(?:\.|::|->)\s*$/
      : /([A-Za-z_$][\w$]*)\s*(?:\.|::)\s*$/;

  const chain: string[] = [];
  let before = line.slice(0, at);

  // Deep enough for any real qualified path; a bound in case of a pathological
  // line rather than a semantic limit.
  for (let depth = 0; depth < 8; depth++) {
    const match = pattern.exec(before);
    if (!match) break;
    chain.unshift(match[1]!);
    before = before.slice(0, match.index);
  }

  return chain.length > 0 ? chain : undefined;
}

/**
 * Names that always refer to the enclosing object, never to an import.
 *
 * Every language that has one spells it as an ordinary identifier before a
 * member operator, which is exactly what a receiver looks like — so without
 * this list `this.render()` reads as a use of whatever `render` the dependency
 * happens to export.
 */
const SELF_REFERENCES = new Set(['this', '$this', 'self', 'Self', 'super', 'cls', 'me']);

/**
 * Languages whose import statements enumerate every name they bring into scope.
 *
 * The distinction is not stylistic. `from svelte import mount` and `import {
 * mount } from 'svelte'` are complete statements about what became visible, so
 * a name that is not among them came from somewhere else. `import 'package:dio
 * /dio.dart'`, `#include <zlib.h>`, `using System.Text;` and `import Foundation`
 * name no bindings at all and make everything visible, so the same reasoning
 * applied there would suppress every finding in those ecosystems.
 */
const ENUMERATED_IMPORT_LANGUAGES = new Set<FileIndex['language']>([
  'typescript',
  'javascript',
  'python',
  'go',
  'rust',
  'java',
]);

/**
 * `:push` is an atom, not a call.
 *
 * Elixir, Erlang and Ruby all spell a bare symbolic constant with a leading
 * colon, and `{:push, message, state}` is a tuple tag rather than a use of
 * anything. `::` is excluded because in every language that has it — C++,
 * Rust, PHP, Ruby's own scope operator — it introduces a real reference.
 */
function isAtomLiteral(line: string, at: number, language: FileIndex['language']): boolean {
  if (language !== 'elixir' && language !== 'erlang' && language !== 'ruby') return false;
  return line[at - 1] === ':' && line[at - 2] !== ':';
}

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

  const escaped = trimmed
    .replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    .replace(/\\\./g, '(?:\\.|::)');

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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The owner of a qualified symbol when `symbol` is a derived bare leaf. */
function ownerForDerivedSymbol(change: BreakingChange, symbol: string): string | undefined {
  if (symbol.includes('.') || symbol.includes('::')) return undefined;
  for (const candidate of change.symbols) {
    if (candidate === symbol || (!candidate.includes('.') && !candidate.includes('::'))) continue;
    const parts = candidate.split(/[.:]+/).filter(Boolean);
    if (parts.at(-1) === symbol && parts.length >= 2) return parts.at(-2);
  }
  return undefined;
}

function qualifiedCandidatesForLeaf(change: BreakingChange, symbol: string): string[] {
  return change.symbols.filter((candidate) => {
    if (candidate === symbol || (!candidate.includes('.') && !candidate.includes('::'))) return false;
    return candidate.split(/[.:]+/).filter(Boolean).at(-1) === symbol;
  });
}

function normalizedApiPath(value: string): string {
  return value
    .replace(/^@/, '')
    .replace(/::|[\\/]/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '')
    .toLowerCase();
}

/**
 * A bare imported leaf belongs to a qualified finding only when the import's
 * module is the finding's actual owner path. Merely importing the same package
 * is insufficient: `QueryDataOptions.onError` is not the top-level `onError`
 * exported from `@apollo/client/link/error`, and an internal
 * `Backend.load_pem_private_key` is not cryptography's public serialization
 * function of the same name.
 */
function directlyImportsQualifiedLeaf(
  change: BreakingChange,
  symbol: string,
  imports: readonly ImportRecord[],
): boolean {
  for (const candidate of qualifiedCandidatesForLeaf(change, symbol)) {
    const parts = candidate.split(/[.:]+/).filter(Boolean);
    const ownerPath = normalizedApiPath(parts.slice(0, -1).join('.'));
    if (!ownerPath) continue;
    for (const record of imports) {
      if (!record.bindings.includes(symbol)) continue;
      const paths = new Set([record.specifier, record.packageName, ...importKeys(record)].map(normalizedApiPath));
      if (paths.has(ownerPath)) return true;
      // Re-export inference needs the concrete module specifier. The package
      // root is too broad: every internal path starts with `cryptography`, but
      // importing one public function from that package does not make it an
      // internal Backend method with the same leaf.
      for (const importedPath of [normalizedApiPath(record.specifier)]) {
        if (!ownerPath.startsWith(`${importedPath}.`)) continue;
        const implementationSuffix = ownerPath.slice(importedPath.length + 1).split('.');
        // Static Python APIs are often re-exported one level above a lowercase
        // implementation module (`cryptography.x509.base.Certificate` from
        // `cryptography.x509`). Permit that accountable path relation, but not
        // a class/member suffix such as `Backend.load_*` or
        // `QueryDataOptions.onError`.
        if (implementationSuffix.every((part) => /^[a-z_][a-z0-9_]*$/.test(part))) return true;
      }
    }
  }
  return false;
}

function qualifiedLeafBelongsToDependencyRoot(
  change: BreakingChange,
  symbol: string,
  dependencyNames: readonly string[],
): boolean {
  const roots = new Set(dependencyNames.map(normalizedApiPath));
  return qualifiedCandidatesForLeaf(change, symbol).some((candidate) => {
    const parts = candidate.split(/[.:]+/).filter(Boolean);
    return roots.has(normalizedApiPath(parts.slice(0, -1).join('.')));
  });
}

function bindingsForOwner(
  owner: string,
  imports: readonly ImportRecord[],
  content: string,
  inherited: ReadonlySet<string> | undefined,
): Set<string> {
  const bindings = new Set<string>();
  if (inherited?.has(owner)) bindings.add(owner);

  const lines = content.split('\n');
  for (const record of imports) {
    if (record.bindings.includes(owner) || record.bindings.includes('*')) bindings.add(owner);
    const line = lines[record.line - 1] ?? '';
    const alias = new RegExp(`\\b${escapeRegExp(owner)}\\s+as\\s+([A-Za-z_$][\\w$]*)`).exec(line)?.[1];
    if (alias) bindings.add(alias);
  }
  return bindings;
}

function receiversConstructedFrom(content: string, owners: ReadonlySet<string>): Set<string> {
  const receivers = new Set<string>();
  for (const owner of owners) {
    const escaped = escapeRegExp(owner);
    const patterns = [
      new RegExp(`\\b(?:const|let|var|final|auto)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:new\\s+)?${escaped}\\s*[({]`, 'g'),
      new RegExp(`^\\s*([A-Za-z_$][\\w$]*)\\s*=\\s*${escaped}\\s*\\(`, 'gm'),
      new RegExp(`\\b${escaped}(?:\\s*<[^;=(){}]+>)?\\s+([A-Za-z_$][\\w$]*)\\s*(?:[({;=])`, 'g'),
    ];
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) if (match[1]) receivers.add(match[1]);
    }
  }
  return receivers;
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

/**
 * Is the matched name one this file declares itself?
 *
 * A repository with its own `function parse()` has bound that name for the
 * whole module, so every mention of it is the local one — the same argument
 * `shadowed` makes about another package's import, applied to the file's own
 * declarations. An explicit import of the dependency's symbol wins, because a
 * file that both imports `parse` and defines something else called `parse`
 * would not compile in most of these languages, and where it would, the import
 * is the stronger evidence.
 *
 * Methods are excluded deliberately. `client.request()` calling into a
 * dependency is not shadowed by some unrelated class in the same file having a
 * `request` method, and treating it as though it were would hide real findings
 * in exactly the object-oriented code where they are most common.
 */
function definedLocally(
  symbol: string,
  importedNames: Set<string>,
  locallyDefined: ReadonlySet<string>,
): boolean {
  if (importedNames.has(symbol) || importedNames.has('*')) return false;
  // A dotted symbol is reached through its root, and the root is what a local
  // declaration could shadow.
  const root = symbol.split('.')[0] ?? symbol;
  if (importedNames.has(root)) return false;
  return locallyDefined.has(symbol) || (symbol !== root && locallyDefined.has(root));
}

function confidenceFor(
  symbol: string,
  importedNames: Set<string>,
  importsDependency: boolean,
  indirect: boolean,
  inherited: ReadonlySet<string> | undefined,
  unboundReceiver: boolean,
  resolvedByOwner = false,
): Confidence {
  const root = symbol.split('.')[0] ?? symbol;

  // Reached across the repository's own re-export edges rather than by an
  // import of the dependency. `medium` is the ceiling and it has to be earned:
  // the file asked the barrel for this name specifically. A name that arrived
  // under `export *` is a possibility, not an observation.
  if (indirect) {
    if (!inherited) return 'low';
    return inherited.has(symbol) || inherited.has(root) ? 'medium' : 'low';
  }

  if (importedNames.has(symbol) || importedNames.has(root) || importedNames.has('*')) {
    return 'high';
  }

  if (resolvedByOwner) return 'high';

  // A member access on a receiver this file did not bind from the dependency
  // — `dirs.find(...)` in a file that merely happens to import `zod` too —
  // is not evidence of dependency usage, whatever `importsDependency` says.
  // Importing the package at all does not make every generic method name
  // (`find`, `flatten`, `omit`, ...) elsewhere in the file a use of it.
  if (unboundReceiver) return 'low';

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
  // `%` opens a comment in Erlang, `(*` in OCaml, `--` in nothing Drift reads
  // but Haskell — the first two are languages the localizer now searches, and
  // a comment in them was previously read as code.
  if (trimmed.startsWith('%') || trimmed.startsWith('(*')) return true;
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
/**
 * Blank out what is not code, **without changing any offset**.
 *
 * Every branch below appends exactly as many characters as it consumes, so
 * an index into a masked line is also an index into the raw line. Two things
 * depend on that. Impact sites record the column a symbol matched at
 * (`ImpactSite.column`), and a fix plan anchors its edit to that exact
 * occurrence rather than to the whole line — neither is sound if masking can
 * shift an index.
 *
 * Block comments used to be *elided* rather than blanked, which broke both
 * and was a latent false-match bug in its own right: eliding joined the code
 * on either side of an inline comment into one token, so a symbol could match
 * a line that never contained it.
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
          result += ' '.repeat(rawLine.length - i);
          i = rawLine.length;
          break;
        }
        result += ' '.repeat(end + 2 - i);
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
          result += ' '.repeat(rawLine.length - i);
          i = rawLine.length;
          break;
        }
        result += ' '.repeat(end + 2 - i);
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
