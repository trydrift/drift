import { createHash } from 'node:crypto';
import type { DependencyChange, Ecosystem } from '../types.js';
import type { Logger } from '../util/logger.js';
import { readArchive, type ArchiveEntry } from '../util/archive.js';
import { fetchJson, fetchText } from '../util/http.js';
import { mapWithConcurrency } from '../util/http.js';

/**
 * What a package is called *inside* your source code.
 *
 * Localization is a join, and this file supplies one side of it. The other
 * side — what a file imports — is read from the file and is never in doubt.
 * This side used to be a guess: `beautifulsoup4` is imported as `bs4`, so
 * Drift carried a table of aliases, and the table was wrong in the way tables
 * are always wrong. It could only contain packages someone had thought of, and
 * a package it had not thought of produced *silence* — no finding, no warning,
 * no way to tell "this repository does not use it" from "Drift did not know
 * what to look for". That is the worst failure Drift has, because it reads as
 * reassurance.
 *
 * So the guess is replaced with a reading. Every ecosystem here answers the
 * question from the artefact the registry actually published:
 *
 *   Python    the wheel's `top_level.txt`, or its `RECORD` file listing
 *   Maven     the package directories of the classfiles inside the jar
 *   NuGet     the namespaces in the assembly's ECMA-335 metadata
 *   Composer  the PSR-4 and PSR-0 roots in the package's own autoload map
 *   Hex       every `defmodule` in the released tarball, and every `-module`
 *   RubyGems  the gem's `lib/` require paths and its top-level constants
 *   SwiftPM   the library and target names in the package's `Package.swift`
 *   CocoaPods the podspec's `module_name`
 *
 * Three properties hold for all of them, and they are the reason this is worth
 * the network calls:
 *
 *   - **Nothing is installed or executed.** Archives are opened in memory and
 *     read, the way `src/evidence/surface` already opens a `.nupkg`. A gem's
 *     extconf, a wheel's build backend, and a Composer script never run.
 *   - **Failure is silent and safe.** Every resolver returns `undefined` on
 *     any problem, and the caller falls back to the old name heuristics. A
 *     rate-limited registry degrades Drift to what it was, never below it.
 *   - **The answer is cached per process**, and only the answer — a few dozen
 *     strings — never the archive it was read from. A repository with six
 *     hundred dependencies pays one download each and holds none of them.
 *
 * This is also the piece that makes PHP, Elixir, and Swift localizable at all.
 * Their capability rows said "Drift does not localize usages in this ecosystem
 * yet" for one shared reason — the package name does not determine the name
 * used in source — and that reason stops being true the moment the package
 * itself is asked.
 */

/** What one dependency provides, as its own published artefact describes it. */
export interface ModuleMap {
  /**
   * Import keys this package provably provides — module names, namespaces,
   * PSR-4 roots, require paths. Joined against `RepoIndex.importers`.
   */
  names: string[];
  /** Where the answer came from, in words a developer can check. */
  source: string;
}

export type ModuleMaps = Map<string, ModuleMap>;

/** Key under which a dependency's map is stored. */
export function moduleMapKey(ecosystem: Ecosystem, name: string): string {
  return `${ecosystem}|${name}`;
}

export interface ResolveOptions {
  logger: Logger;
  timeoutMs?: number;
  concurrency?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Read the module map for every dependency that moved.
 *
 * Resolution runs concurrently and independently: one package's registry being
 * down cannot delay or degrade another's. A dependency with no resolver, or
 * one whose resolver came up empty, is simply absent from the result, and the
 * localizer treats absence as "use the heuristics" rather than as "no modules".
 */
export async function resolveModuleMaps(
  changes: readonly DependencyChange[],
  options: ResolveOptions,
): Promise<ModuleMaps> {
  const wanted = new Map<string, DependencyChange>();
  for (const change of changes) {
    if (!RESOLVERS[change.ecosystem]) continue;
    const key = moduleMapKey(change.ecosystem, change.name);
    if (!wanted.has(key)) wanted.set(key, change);
  }

  const maps: ModuleMaps = new Map();
  if (wanted.size === 0) return maps;

  const entries = [...wanted.entries()];
  const results = await mapWithConcurrency(
    entries,
    options.concurrency ?? 6,
    async ([key, change]) => {
      const version = change.to ?? change.from;
      if (!version) return [key, undefined] as const;
      try {
        const map = await cached(`${key}|${version}`, () =>
          RESOLVERS[change.ecosystem]!(change.name, version, {
            timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          }),
        );
        return [key, map] as const;
      } catch (err) {
        // A resolver throwing is a bug in Drift, not a fact about the package.
        // It must cost this one dependency its precision and nothing else.
        options.logger.debug(`Module map failed for ${key}: ${(err as Error).message}`);
        return [key, undefined] as const;
      }
    },
  );

  for (const [key, map] of results) {
    if (map && map.names.length > 0) maps.set(key, map);
  }

  options.logger.debug(`Resolved ${maps.size} of ${wanted.size} module map(s) from published artefacts`);
  return maps;
}

interface ResolverOptions {
  timeoutMs: number;
}

type Resolver = (
  name: string,
  version: string,
  options: ResolverOptions,
) => Promise<ModuleMap | undefined>;

/* ---------------- Python ---------------- */

/**
 * A wheel says what it installs, in two places, and both are text.
 *
 * `top_level.txt` is the direct answer and most wheels ship it. `RECORD` is
 * the fallback and is never absent, because the installer needs it to
 * uninstall — every file the wheel lays down is listed there, so the top-level
 * importable names are the distinct first path segments that are not metadata
 * directories.
 */
const pypiModules: Resolver = async (name, version, { timeoutMs }) => {
  const meta = await fetchJson<{ urls?: { packagetype?: string; url?: string; filename?: string }[] }>(
    `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`,
    { timeoutMs, immutable: true },
  );

  const wheel = meta?.urls?.find((u) => u.packagetype === 'bdist_wheel' && u.url);
  if (!wheel?.url) return undefined;

  const entries = await fetchArchive(wheel.url, timeoutMs);
  if (!entries) return undefined;

  const topLevel = entries.find((e) => /(^|\/)[^/]+\.dist-info\/top_level\.txt$/.test(e.path));
  if (topLevel) {
    const names = decode(topLevel)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    if (names.length > 0) {
      return { names: [...new Set(names)], source: `${wheel.filename ?? 'wheel'} top_level.txt` };
    }
  }

  const record = entries.find((e) => /(^|\/)[^/]+\.dist-info\/RECORD$/.test(e.path));
  if (!record) return undefined;

  const names = new Set<string>();
  for (const line of decode(record).split('\n')) {
    const path = line.split(',')[0]?.trim();
    if (!path) continue;
    const first = path.split('/')[0]!;
    if (!first || first.startsWith('.') || /\.(dist-info|data)$/.test(first)) continue;
    // A single-module distribution lays down `foo.py` rather than `foo/`.
    names.add(first.endsWith('.py') ? first.slice(0, -3) : first);
  }
  // A wheel that only ships scripts or data has no importable name, and
  // claiming one would send the search somewhere arbitrary.
  names.delete('');
  return names.size > 0
    ? { names: [...names], source: `${wheel.filename ?? 'wheel'} RECORD` }
    : undefined;
};

/* ---------------- Maven ---------------- */

/**
 * A jar's directory structure *is* its package list.
 *
 * `com/fasterxml/jackson/databind/JsonNode.class` says, with no inference at
 * all, that this artifact ships `com.fasterxml.jackson.databind`. That matters
 * here more than in most ecosystems because the Maven coordinate and the Java
 * package routinely disagree — `com.fasterxml.jackson.core:jackson-databind`
 * ships nothing under `com.fasterxml.jackson.core` — and the group-prefix
 * proxy Drift used before would attribute a `jackson-core` change to a file
 * that imports only `jackson-databind`.
 */
const mavenModules: Resolver = async (name, version, { timeoutMs }) => {
  const [groupId, artifactId] = name.split(':');
  if (!groupId || !artifactId) return undefined;

  const path = groupId.replace(/\./g, '/');
  const url = `https://repo1.maven.org/maven2/${path}/${artifactId}/${version}/${artifactId}-${version}.jar`;
  const entries = await fetchArchive(url, timeoutMs);
  if (!entries) return undefined;

  const packages = new Set<string>();
  for (const entry of entries) {
    if (!entry.path.endsWith('.class')) continue;
    if (entry.path.startsWith('META-INF/')) continue;
    const directory = entry.path.split('/').slice(0, -1);
    if (directory.length === 0) continue;
    packages.add(directory.join('.'));
  }

  return packages.size > 0
    ? { names: [...packages], source: `${artifactId}-${version}.jar` }
    : undefined;
};

/* ---------------- NuGet ---------------- */

/**
 * The namespaces in the shipped assembly, read from its own metadata.
 *
 * Drift already parses ECMA-335 out of a `.nupkg` for the surface diff, so the
 * namespace list is a by-product of a reader that exists and is tested. The
 * two-segment namespace proxy it replaces was a real source of both errors:
 * `Microsoft.Extensions.Logging` and `Microsoft.Extensions.Http` collapse to
 * the same proxy, and a package publishing under an unrelated root namespace
 * matched nothing at all.
 */
const nugetModules: Resolver = async (name, version, { timeoutMs }) => {
  const id = name.toLowerCase();
  const normalized = version.toLowerCase();
  const url =
    `https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(id)}/${encodeURIComponent(normalized)}/` +
    `${encodeURIComponent(id)}.${encodeURIComponent(normalized)}.nupkg`;

  const entries = await fetchArchive(url, timeoutMs);
  if (!entries) return undefined;

  const { readAssembly } = await import('../evidence/surface/ecma335.js');
  const namespaces = new Set<string>();

  // Every managed assembly in the package, not just the one the surface diff
  // picks: a package that ships one assembly per target framework declares the
  // same namespaces in each, and a package that ships several distinct
  // assemblies declares different ones. Reading all of them and taking the
  // union is right in both cases.
  for (const entry of entries) {
    if (!/^lib\/.+\.dll$/i.test(entry.path) && !/^ref\/.+\.dll$/i.test(entry.path)) continue;
    let types;
    try {
      types = readAssembly(entry.read());
    } catch {
      continue;
    }
    for (const type of types ?? []) {
      const dot = type.fullName.lastIndexOf('.');
      if (dot > 0) namespaces.add(type.fullName.slice(0, dot));
    }
    if (namespaces.size > 0) break;
  }

  return namespaces.size > 0
    ? { names: [...namespaces], source: `${name} ${version} assembly metadata` }
    : undefined;
};

/* ---------------- Composer ---------------- */

/**
 * PSR-4 is a map from namespace to directory, and Composer publishes it.
 *
 * This is the whole reason PHP was previously marked "no static analysis". The
 * capability note was accurate about the problem — a namespace does not
 * determine a package — and wrong about it being unsolvable, because the
 * package's own `composer.json` states the mapping outright, and Packagist
 * serves that file as JSON for every version ever published. No clone, no
 * install, no autoloader generation: one request.
 */
const composerModules: Resolver = async (name, version, { timeoutMs }) => {
  const metadata = await fetchJson<{
    packages?: Record<string, { version?: string; autoload?: PhpAutoload | null }[]>;
  }>(`https://repo.packagist.org/p2/${name.toLowerCase()}.json`, { timeoutMs });

  const releases = metadata?.packages?.[name.toLowerCase()];
  if (!releases?.length) return undefined;

  // Packagist serves this endpoint "minified" (`composer/2.0`): the first
  // entry is complete and every later one carries only the fields that changed
  // from the entry before it. Reading a matched release directly therefore
  // finds an object with no `autoload` at all for almost every version — which
  // is exactly how this resolver silently returned nothing for PHP until the
  // format was read properly. Fields are merged forward, and an explicit
  // `null` means the field was removed rather than unchanged.
  const wanted = version.replace(/^v/, '');
  let autoload: PhpAutoload | undefined;
  let found = false;
  for (const entry of releases) {
    if (entry.autoload !== undefined) autoload = entry.autoload ?? undefined;
    if ((entry.version ?? '').replace(/^v/, '') === wanted) {
      found = true;
      break;
    }
  }
  // A version Packagist has never heard of — a private fork, a dev branch, a
  // typo. The newest release's map is a better answer than the oldest one the
  // walk happened to end on, and a PSR-4 root almost never moves.
  if (!found) autoload = releases[0]!.autoload ?? undefined;

  const namespaces = new Set<string>();
  for (const section of [autoload?.['psr-4'], autoload?.['psr-0']]) {
    for (const prefix of Object.keys(section ?? {})) {
      const trimmed = prefix.replace(/\\+$/, '');
      if (trimmed) namespaces.add(trimmed);
    }
  }

  // A package that autoloads by classmap or plain files declares no namespace
  // root. Guessing `Vendor\Package` from the coordinate would be exactly the
  // inference this file exists to remove, so it declines instead.
  return namespaces.size > 0
    ? { names: [...namespaces], source: `${name} composer.json autoload` }
    : undefined;
};

interface PhpAutoload {
  'psr-4'?: Record<string, unknown>;
  'psr-0'?: Record<string, unknown>;
}

/* ---------------- Hex ---------------- */

/**
 * Every module a Hex package defines, read from the release tarball.
 *
 * Elixir and Erlang have no import statement that names a package, which is
 * why localization here was previously declined outright. What they do have is
 * a module namespace that is global and flat: `Jason.decode!` names a module
 * that exactly one package defines. So the join Drift needs is module -> package,
 * and the tarball answers it exhaustively — `defmodule` in Elixir sources,
 * `-module` in Erlang ones.
 *
 * A Hex tarball is a tar containing a `contents.tar.gz`, which is the tar the
 * sources are actually in. Both layers are read in memory.
 */
const hexModules: Resolver = async (name, version, { timeoutMs }) => {
  const outer = await fetchArchive(
    `https://repo.hex.pm/tarballs/${encodeURIComponent(name)}-${encodeURIComponent(version)}.tar`,
    timeoutMs,
  );
  if (!outer) return undefined;

  const contents = outer.find((e) => e.path === 'contents.tar.gz' || e.path.endsWith('/contents.tar.gz'));
  if (!contents) return undefined;

  let inner: ArchiveEntry[];
  try {
    inner = readArchive(contents.read());
  } catch {
    return undefined;
  }

  const modules = new Set<string>();
  for (const entry of inner) {
    // Only what the package ships as library code. A tarball's `test/` tree
    // defines modules with names like `Test` and `Support`, and indexing those
    // would join a generic word in someone's application to this package.
    if (!/^(lib|src)\//.test(entry.path)) continue;
    if (/\.(ex|exs)$/.test(entry.path)) {
      for (const module of elixirModulesIn(decode(entry))) modules.add(module);
      continue;
    }
    if (/\.erl$/.test(entry.path)) {
      const match = /^\s*-module\(\s*'?([a-z][\w]*)'?\s*\)/m.exec(decode(entry));
      if (match?.[1]) modules.add(match[1]);
    }
  }

  if (modules.size === 0) return undefined;

  // The root of each module is what an `alias Foo.Bar` line registers, so both
  // the full name and its root have to be joinable.
  const roots = new Set<string>();
  for (const module of modules) roots.add(module.split('.')[0]!);

  return {
    names: [...new Set([...modules, ...roots])],
    source: `${name} ${version} hex tarball`,
  };
};

/**
 * Every module an Elixir source defines, by its real name.
 *
 * Two details decide whether this list is usable, and both were learned from
 * `jason` — a small, exemplary package that yields the names `Test` and
 * `Unescape` to a naive `defmodule` scan:
 *
 *   - **`@moduledoc` is a string, and its examples contain code.** Jason's
 *     encoder documents itself with a `defmodule Test do` sample. Indexing it
 *     would attach every mention of `Test` in someone's application to Jason.
 *   - **`defmodule` nests, and a nested one is not top level.**
 *     `Unescape` inside `Jason.Decoder` is `Jason.Decoder.Unescape`, which is
 *     the name that can actually be called, and the only one worth indexing.
 *
 * Nesting is tracked by indentation rather than by matching `end`, because
 * indentation is what `mix format` guarantees and `end` is what a one-line
 * `defmodule X, do: ...` does not have.
 */
export function elixirModulesIn(source: string): string[] {
  const modules: string[] = [];
  const stack: { indent: number; name: string }[] = [];
  let inHeredoc = false;

  for (const line of source.split('\n')) {
    // A `"""` opens or closes a heredoc, which is where documentation — and
    // the example code inside it — lives.
    const fences = (line.match(/"""/g) ?? []).length;
    if (inHeredoc) {
      if (fences % 2 === 1) inHeredoc = false;
      continue;
    }
    if (fences % 2 === 1) {
      inHeredoc = true;
      continue;
    }

    const match = /^(\s*)defmodule\s+([A-Z][\w.]*)/.exec(line);
    if (!match) continue;

    const indent = match[1]!.length;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();

    const parent = stack[stack.length - 1]?.name;
    const name = parent ? `${parent}.${match[2]!}` : match[2]!;
    stack.push({ indent, name });
    modules.push(name);
  }

  return modules;
}

/* ---------------- RubyGems ---------------- */

/**
 * A gem's require paths and the constants it defines.
 *
 * Ruby has the same shape of problem as Elixir and a worse version of it: not
 * only does `require "active_support"` not name the gem `activesupport`, most
 * Ruby never writes the `require` at all because Bundler did it. So both halves
 * are read out of the `.gem` — the `lib/` paths (which is what a `require`
 * line says) and the top-level `module`/`class` names (which is what the rest
 * of the code says).
 *
 * A `.gem` is a tar containing `data.tar.gz`, the same two-layer arrangement
 * Hex uses.
 */
const rubygemsModules: Resolver = async (name, version, { timeoutMs }) => {
  const outer = await fetchArchive(
    `https://rubygems.org/downloads/${encodeURIComponent(name)}-${encodeURIComponent(version)}.gem`,
    timeoutMs,
  );
  if (!outer) return undefined;

  const data = outer.find((e) => e.path === 'data.tar.gz' || e.path.endsWith('/data.tar.gz'));
  if (!data) return undefined;

  let inner: ArchiveEntry[];
  try {
    inner = readArchive(data.read());
  } catch {
    return undefined;
  }

  const requirePaths = new Set<string>();
  const constants = new Set<string>();

  for (const entry of inner) {
    const match = /^lib\/(.+)\.rb$/.exec(entry.path);
    if (!match?.[1]) continue;
    requirePaths.add(match[1]);
    requirePaths.add(match[1].split('/')[0]!);

    // Only the shallow files, and only their top-level declarations. A gem's
    // deep internals define hundreds of constants nobody outside it names, and
    // indexing them turns a common word into a repository-wide match.
    if (match[1].split('/').length > 2) continue;
    for (const declaration of decode(entry).matchAll(/^(?:module|class)\s+([A-Z][\w:]*)/gm)) {
      constants.add(declaration[1]!.split('::')[0]!);
    }
  }

  if (requirePaths.size === 0 && constants.size === 0) return undefined;

  return {
    names: [...new Set([...requirePaths, ...constants])],
    source: `${name}-${version}.gem`,
  };
};

/* ---------------- SwiftPM ---------------- */

/**
 * The module names a Swift package vends, from its own manifest.
 *
 * `import Alamofire` names a *module*, and SwiftPM lets a package call its
 * modules anything: `apple/swift-log` vends `Logging`. Drift identifies Swift
 * packages by `owner/repo` (there being no registry), so the manifest is one
 * raw fetch away at the tag the resolved version names.
 *
 * `Package.swift` is Swift code and could compute these names at evaluation
 * time. Drift reads the literal declarations and does not run it — the same
 * decision, for the same reason, as the detector that reads its dependencies.
 */
const swiftModules: Resolver = async (name, version, { timeoutMs }) => {
  const [owner, repo] = name.split('/');
  if (!owner || !repo) return undefined;

  // A published Swift tag is `1.2.3` or `v1.2.3` and there is no way to know
  // which without asking; both are cheap.
  for (const tag of [version, `v${version}`]) {
    const manifest = await fetchText(
      `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(tag)}/Package.swift`,
      { timeoutMs, immutable: true },
    );
    if (!manifest) continue;

    const modules = new Set<string>();
    for (const match of manifest.matchAll(/\.(?:library|target|executableTarget)\s*\(\s*name:\s*"([^"]+)"/g)) {
      modules.add(match[1]!);
    }
    // A library product usually shares its name with its target; where it does
    // not, the `targets:` list names the modules that actually get imported.
    for (const match of manifest.matchAll(/targets:\s*\[([^\]]*)\]/g)) {
      for (const quoted of match[1]!.matchAll(/"([^"]+)"/g)) modules.add(quoted[1]!);
    }

    if (modules.size > 0) return { names: [...modules], source: `${name}@${tag} Package.swift` };
  }

  return undefined;
};

/* ---------------- CocoaPods ---------------- */

/**
 * A pod's module name, from the podspec the CDN serves.
 *
 * `import Alamofire` in a CocoaPods project imports the pod's *module*, which
 * defaults to the pod name but is overridden often enough — and by exactly the
 * pods most likely to matter — that guessing it was not defensible. The CDN
 * shards specs by the MD5 of the pod name, which is why the hash is computed
 * here rather than a path being assembled from the name alone.
 */
const cocoapodsModules: Resolver = async (name, version, { timeoutMs }) => {
  const hash = createHash('md5').update(name).digest('hex');
  const shard = `${hash[0]}/${hash[1]}/${hash[2]}`;
  const spec = await fetchJson<{ module_name?: string; name?: string }>(
    `https://cdn.cocoapods.org/Specs/${shard}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/${encodeURIComponent(name)}.podspec.json`,
    { timeoutMs, immutable: true },
  );
  if (!spec) return undefined;

  // A pod name with a dot or a hyphen cannot be a module name; CocoaPods
  // replaces those with underscores when it generates one.
  const declared = spec.module_name ?? (spec.name ?? name).replace(/[-.]/g, '_');
  return { names: [...new Set([declared, name])], source: `${name} ${version} podspec` };
};

/* ---------------- registry ---------------- */

const RESOLVERS: Partial<Record<Ecosystem, Resolver>> = {
  pypi: pypiModules,
  maven: mavenModules,
  nuget: nugetModules,
  packagist: composerModules,
  hex: hexModules,
  rubygems: rubygemsModules,
  swift: swiftModules,
  cocoapods: cocoapodsModules,
};

/** Ecosystems whose module map is read from the published artefact. */
export const ARTIFACT_BACKED_ECOSYSTEMS: readonly Ecosystem[] = Object.keys(
  RESOLVERS,
) as Ecosystem[];

/* ---------------- fetching ---------------- */

/**
 * A cap on what will be pulled into memory to read a name list.
 *
 * A jar is megabytes and a wheel with native extensions can be a hundred. The
 * question being answered here — what is this package called in source? — is
 * never worth that, and the fallback heuristics are one line away.
 */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

async function fetchArchive(url: string, timeoutMs: number): Promise<ArchiveEntry[] | undefined> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'drift-bot/0.1 (+https://github.com/trydrift/drift)' },
    });
    if (!response.ok) return undefined;

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_ARCHIVE_BYTES) {
      void response.body?.cancel();
      return undefined;
    }

    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > MAX_ARCHIVE_BYTES) return undefined;
    return readArchive(body);
  } catch {
    return undefined;
  }
}

/**
 * The answer, cached; never the archive it came from.
 *
 * The first version of this cached the decompressed `ArchiveEntry[]` per URL,
 * which was a memory leak wearing a cache's clothes: each entry closes over
 * the whole archive buffer, so a sweep of GitLab — six hundred and thirty gems,
 * each a few megabytes — retained every byte of every gem for the life of the
 * process, and the run died partway through. What is worth keeping is the
 * output: a few dozen strings per package, and the `null` that records a
 * package whose registry had nothing to say, so a second caller does not go and
 * ask again.
 *
 * `inFlight` matters as much as the cache. Localization is called per
 * dependency from three different places, and without it the same package is
 * downloaded once per concurrent caller.
 */
const resolved = new Map<string, ModuleMap | null>();
const inFlight = new Map<string, Promise<ModuleMap | undefined>>();

function cached(
  key: string,
  compute: () => Promise<ModuleMap | undefined>,
): Promise<ModuleMap | undefined> {
  const done = resolved.get(key);
  if (done !== undefined) return Promise.resolve(done ?? undefined);

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = compute()
    .then((map) => {
      resolved.set(key, map ?? null);
      return map;
    })
    .catch(() => {
      resolved.set(key, null);
      return undefined;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}

/** Reset the in-process module-map cache. Tests only. */
export function resetModuleMapCache(): void {
  resolved.clear();
  inFlight.clear();
}

function decode(entry: ArchiveEntry): string {
  try {
    return entry.read().toString('utf8');
  } catch {
    return '';
  }
}
