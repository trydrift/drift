import { fetchTypeSurface, type TypeSurface } from '../evidence/type-surface.js';
import type { ImportRecord, RepoIndex } from '../index/metarag.js';
import type { Confidence } from '../types.js';

/**
 * Is this repository's code already wrong about the version it has installed?
 *
 * Every other answer Drift gives is about an upgrade: take these two published
 * versions, diff them, and find what the move would break. This one asks a
 * question that needs no upgrade at all — the dependency in `node_modules`
 * right now exports a set of names, this repository imports a set of names,
 * and an import that names something the installed version does not export is
 * an error that already exists. Nothing has to be upgraded for it to be true,
 * and no test has to run to find it.
 *
 * It happens for ordinary reasons. A range resolved forward on a fresh
 * `npm install` and took a major with it. A lockfile was regenerated on a
 * different machine. Someone bumped a dependency without reading what moved.
 * The build may even still pass, because a missing *type* export is invisible
 * at runtime and a missing *runtime* export is invisible until the line runs.
 *
 * # What this will not do
 *
 * It reports an import that cannot resolve. It does not report deep member
 * access — `thing.foo.bar()` where `bar` is gone — because the index records
 * what a file *binds*, not every property it later reaches through. That is a
 * real limit and it is stated rather than papered over: a clean result here
 * means "every name you import exists", not "your use of this package is
 * correct".
 *
 * # Why a missing name is so often not an error
 *
 * The failure mode this must not have is confident wrongness at scale. If a
 * surface is read incompletely, every legitimate import looks like a missing
 * export, and a developer is handed a page of false alarms — the exact inverse
 * of the property that makes Drift worth trusting. So the rule is inverted
 * from the usual one: a name is only reported missing when the surface it is
 * missing *from* is known to be complete. Every other outcome is `unknown`,
 * which is a fact about Drift rather than a claim about the code.
 *
 * `diffSurfaces` already refuses to call a via-dependency miss a removal when
 * traversal was incomplete. This is the same discipline applied at the same
 * boundary, for the same reason.
 */

/** One import that names something the installed version does not export. */
export interface MissingImport {
  /** The name as this file binds it. */
  symbol: string;
  /** Repo-relative path of the file that imports it. */
  file: string;
  /** 1-indexed line of the import statement. */
  line: number;
  /** The module specifier exactly as written. */
  specifier: string;
  /** Package the specifier resolves to. */
  packageName: string;
  /** The installed version its surface was read from. */
  installedVersion: string;
}

/** Why a package could not be checked, when it could not be. */
export type UncheckedReason =
  | 'no-surface'
  | 'incomplete-surface'
  /** The surface proves the module exists and nothing about what it exports. */
  | 'unenumerable-surface'
  /**
   * Most of what this repository imports from the package is absent from its
   * surface, which says more about the reading than the code.
   */
  | 'surface-disagrees'
  | 'unsupported-ecosystem'
  | 'no-imports'
  | 'version-unknown'
  /** Multi-name imports with no source to tell a rename from a second export. */
  | 'ambiguous-bindings'
  /**
   * Not one imported name resolved, which says more about the read than the code.
   *
   * `incomplete` answers "did the re-export traversal finish", not "is every
   * exported binding represented". Zod's entry ends with
   * `import * as z from "./v4/classic/external.js"; export { z }` — the star
   * expansion completes, 891 symbols are recorded, and the namespace object
   * `z` is not one of them because it is not a declaration the parser can
   * resolve. The surface is therefore complete *and* missing the single name
   * every consumer imports, and thirteen correct imports were reported as
   * errors.
   *
   * A repository where every name imported from a package is wrong is not a
   * thing that happens; a surface that failed to represent that package's
   * entry point is. So nothing resolving at all is treated as a failed read.
   * A partial result — some names found, some not — is left alone, because
   * that is what a real finding looks like.
   */
  | 'nothing-resolved';

export interface PackageOutcome {
  packageName: string;
  installedVersion: string | null;
  /** Names checked against the surface. */
  checked: number;
  missing: MissingImport[];
  /** Absent when the package was checked. */
  unchecked?: { reason: UncheckedReason; detail: string };
}

export interface InstalledCheckResult {
  packages: PackageOutcome[];
  /** Every missing import across every package, worst-first by file. */
  missing: MissingImport[];
  /** Packages whose surface was read completely and could therefore be judged. */
  checkedPackages: number;
  /** Packages that could not be judged, with a stated reason each. */
  uncheckedPackages: number;
}

/**
 * Names that are the module itself rather than one of its exports.
 *
 * `const glob = require('glob')` and `import glob from 'glob'` both bind the
 * module object; `import { glob } from 'glob'` binds an export that happens to
 * share its name. `bindings` cannot tell those apart — both are `['glob']` —
 * which is precisely why `ImportRecord.defaultBinding` exists. Checking a
 * module-object binding against the named surface would report every
 * `const x = require('pkg')` in the ecosystem as a missing export.
 *
 * A namespace import records *both* markers: `import * as pkg from 'pkg'`
 * binds `['*', 'pkg']`, where `*` says what the form is and `pkg` is the local
 * alias for the whole module. Stripping only `*` leaves the alias behind
 * looking exactly like a named import, which reported `pkg` itself as an
 * export the package does not have — so the presence of `*` disqualifies the
 * entire record rather than one of its entries. A namespace import names no
 * export at all; what it later reaches through the alias is member access,
 * which this check does not see.
 *
 * A dynamic `import()` binds nothing, and contributes nothing.
 */
function namedBindingsOf(record: ImportRecord): string[] {
  if (record.bindings.includes('*')) return [];
  const names = new Set(record.bindings);
  if (record.defaultBinding) names.delete(record.defaultBinding);
  return [...names].filter(Boolean);
}

/**
 * The names an import actually asks the package for.
 *
 * `ImportRecord.bindings` cannot answer this, and the reason is worth stating
 * because it decides whether this whole check can be trusted. A rename records
 * both halves and so does a two-name import:
 *
 *   import { a as renamed } from 'pkg'   ->  ['renamed', 'a']
 *   import { a, b }         from 'pkg'   ->  ['a', 'b']
 *
 * Only `a` exists upstream in the first; both do in the second. The orders are
 * not even consistent between the two extractors — `importBindings` pushes the
 * local alias first, `requireBindings` pushes the property first — so position
 * carries no signal either, and `['x','a','y','b']` for a double rename
 * interleaves the pairs with nothing marking them. Checking every binding
 * would report every local alias in the repository as a missing export;
 * checking one of them would miss real findings. Neither is acceptable, so
 * this reads the statement itself.
 *
 * Returns `null` when the line cannot be read or parsed, which the caller must
 * treat as "not checkable" rather than "nothing missing" — the same refusal
 * this module applies to an incomplete surface.
 */
export function externalNamesAt(source: string, line: number): string[] | null {
  const text = source.split('\n')[line - 1];
  if (text === undefined) return null;

  // `{ ... }` is the only form that names exports. A default, a namespace, or
  // a bare import names none, and `namedBindingsOf` has already dropped those.
  const braces = /\{([^}]*)\}/.exec(text);
  if (!braces) {
    // An opening brace with no closing one is a named import spread over
    // several lines, and `record.line` is only its first. Answering `[]` here
    // would say "this import asks for nothing", which is indistinguishable
    // from a correct empty answer and would quietly check none of the names it
    // really does import. Refusing is the honest outcome.
    return text.includes('{') ? null : [];
  }

  const names: string[] = [];
  for (const part of braces[1]!.split(',')) {
    const cleaned = part.replace(/\btype\s+/g, '').trim();
    if (!cleaned) continue;
    // `a as b` (ESM) and `a: b` (CommonJS destructuring) both name `a`
    // upstream and bind `b` locally. The left side is the export.
    const [imported] = cleaned.split(/\s+as\s+|:/).map((piece) => piece.trim());
    if (imported && /^[\w$]+$/.test(imported)) names.push(imported);
  }
  return names;
}

/**
 * Does the installed surface export this name?
 *
 * Keys are usually the exported name outright. They take a
 * `specifier#name` form only where a symbol arrived through a followed
 * dependency and was neither star-exported nor explicitly re-exported — 5 of
 * 332 entries for `vue@3.4.0`, where `ref`, `computed` and `createApp` are all
 * plain keys despite being declared three packages away. The direct lookup is
 * therefore the common path and the suffix scan is the safety net, not the
 * other way round.
 *
 * A hit is a hit regardless of `via`: a symbol reachable through a re-export
 * is a symbol the consumer can legitimately import.
 */
function surfaceExports(surface: TypeSurface, name: string): boolean {
  if (surface.api.has(name)) return true;

  // A package published with `export =` reaches its consumers through one
  // object, and `republishAs` records that object as `default` with its
  // members as `default.<member>` keys. `undici` is the case: `Agent` is not a
  // top-level key, it is `default.Agent`, and every named import of it was
  // reported missing from a package that plainly exports it.
  if (surface.api.has(`default.${name}`)) return true;
  const fallback = surface.api.get('default');
  if (fallback && (fallback.members ?? []).includes(name)) return true;

  const suffix = `#${name}`;
  for (const key of surface.api.keys()) if (key.endsWith(suffix)) return true;
  return false;
}

/**
 * Can this surface answer "does X exist" at all?
 *
 * Some packages declare their whole value API as a *type* and export one
 * constant of it — `declare namespace Sinon { … } declare const Sinon:
 * Sinon.SinonStatic; export = Sinon`. There are no declarations to copy, so
 * the surface comes back holding a bare `default` with no members: it proves
 * the module exists and says nothing whatever about what is on it. `sinon`,
 * `read-pkg` and `globals` all land here, and against such a surface *every*
 * named import looks missing.
 *
 * A surface like that is not evidence of absence. Refusing it is the same
 * discipline applied everywhere else in this module: an answer Drift cannot
 * stand behind is reported as unknown, never as a finding.
 */
function canProveAbsence(surface: TypeSurface): boolean {
  if (surface.incomplete) return false;

  const keys = [...surface.api.keys()];
  const named = keys.filter((key) => key !== 'default' && !key.startsWith('default.'));
  if (named.length > 0) return true;

  // Only `default` and things hanging off it. Answerable exactly when the
  // exported object's *members* were enumerated.
  //
  // The presence of `default.<name>` keys is not that evidence. `sinon`
  // publishes 46 of them and every one is a type from its `declare namespace`
  // -- `default.MatchPartialArguments`, `default.DeepPartialOrMatcher` --
  // while `default.members` is empty, because the values live on a
  // `declare const Sinon: Sinon.SinonStatic` that no declaration enumerates.
  // Reading those type keys as "the API was read" is what let `createSandbox`
  // be called missing from the package that defines it.
  const fallback = surface.api.get('default');
  return fallback ? (fallback.members ?? []).length > 0 : false;
}

/** Imports of one package across the whole repository, with their lines. */
function importsOf(index: RepoIndex, packageName: string): { file: string; record: ImportRecord }[] {
  const found: { file: string; record: ImportRecord }[] = [];
  for (const file of index.files) {
    for (const record of file.imports) {
      if (record.packageName === packageName) found.push({ file: file.path, record });
    }
  }
  return found;
}

/**
 * The entry point an import actually reaches.
 *
 * `import { defineConfig } from 'vitest/config'` asks a different entry point
 * than `vitest` does, and they publish different things: vitest's root surface
 * holds 140 symbols and no `defineConfig`, while `vitest/config` holds it.
 * Checking a subpath import against the root surface reported the single
 * most common line in a vitest project — its config file — as naming an export
 * that does not exist, ninety-two times across the corpus.
 *
 * `undefined` is the package root. A scoped package is its own root:
 * `@scope/pkg` has no subpath, `@scope/pkg/sub` has `sub`.
 */
function subpathOf(record: ImportRecord): string | undefined {
  const { specifier, packageName } = record;
  if (!specifier.startsWith(packageName)) return undefined;
  if (specifier.length <= packageName.length) return undefined;
  const rest = specifier.slice(packageName.length + 1);
  return rest.length > 0 ? rest : undefined;
}

export interface InstalledCheckRequest {
  index: RepoIndex;
  /** Installed version per package name, as resolved from the lockfile. */
  installed: ReadonlyMap<string, { version: string | null; ecosystem: string }>;
  /**
   * File contents by repo-relative path, so an import statement can be read
   * rather than inferred from the flat binding list. See `externalNamesAt`:
   * without this, a renamed import cannot be told from a two-name import, and
   * only single-name records can be judged.
   */
  contents?: ReadonlyMap<string, string>;
  /** Restrict the check to one package. */
  only?: string | undefined;
  /**
   * Injected for tests. Defaults to the real npm type-surface fetch.
   *
   * `subpath` selects the entry point: absent is the package root, `'config'`
   * is `pkg/config`. They are genuinely different surfaces and checking an
   * import against the wrong one invents missing exports.
   */
  fetchSurface?: (name: string, version: string, subpath?: string) => Promise<TypeSurface | null>;
}

/**
 * Check every imported name against the surface of the version installed.
 *
 * Packages are checked concurrently because each is an independent network
 * fetch, and the surface cache in `type-surface.ts` already collapses repeated
 * work across them.
 */
export async function checkInstalled(request: InstalledCheckRequest): Promise<InstalledCheckResult> {
  // The subpath is load-bearing and must reach the fetch. A two-parameter
  // closure here silently dropped it, so every `pkg/subpath` import was judged
  // against the package root -- 34% of the false findings across fifty public
  // repositories came through this one omission.
  const fetch =
    request.fetchSurface ??
    ((name, version, subpath) =>
      fetchTypeSurface(name, version, subpath ? { subpath } : {}));

  const names = [...request.installed.keys()]
    .filter((name) => (request.only ? name === request.only : true))
    .sort();

  const packages = await Promise.all(
    names.map(async (packageName): Promise<PackageOutcome> => {
      const entry = request.installed.get(packageName)!;
      const imports = importsOf(request.index, packageName);

      if (imports.length === 0) {
        return {
          packageName,
          installedVersion: entry.version,
          checked: 0,
          missing: [],
          unchecked: { reason: 'no-imports', detail: 'Nothing in this repository imports it.' },
        };
      }

      // The type surface is an npm capability. Every other ecosystem is
      // reported as not checked rather than guessed at.
      if (entry.ecosystem !== 'npm') {
        return {
          packageName,
          installedVersion: entry.version,
          checked: 0,
          missing: [],
          unchecked: {
            reason: 'unsupported-ecosystem',
            detail: `Drift reads an installed API surface for npm only; ${entry.ecosystem} is not checked.`,
          },
        };
      }

      if (!entry.version) {
        return {
          packageName,
          installedVersion: null,
          checked: 0,
          missing: [],
          unchecked: {
            reason: 'version-unknown',
            detail: 'No lockfile entry resolved this to one installed version.',
          },
        };
      }

      // An entry point at a time. `vitest` and `vitest/config` are different
      // surfaces publishing different names, and judging a subpath import
      // against the package root is how the most ordinary line in a vitest
      // project -- its config file -- came back naming an export that does
      // not exist.
      const groups = new Map<string, { file: string; record: ImportRecord }[]>();
      for (const item of imports) {
        const key = subpathOf(item.record) ?? '';
        const bucket = groups.get(key);
        if (bucket) bucket.push(item);
        else groups.set(key, [item]);
      }

      const missing: MissingImport[] = [];
      let checked = 0;
      let ambiguous = 0;
      const refusals: { reason: UncheckedReason; detail: string }[] = [];

      for (const [key, members] of groups) {
        const subpath = key === '' ? undefined : key;
        const shown = subpath ? `${packageName}/${subpath}` : packageName;

        let surface: TypeSurface | null = null;
        try {
          surface = await fetch(packageName, entry.version, subpath);
        } catch {
          surface = null;
        }

        if (!surface) {
          refusals.push({
            reason: 'no-surface',
            detail: `No type declarations were readable for ${shown}@${entry.version}, so what it exports could not be established.`,
          });
          continue;
        }

        // The load-bearing refusals. Neither an incompletely expanded graph
        // nor a surface that names no exports can support "this name does not
        // exist" -- and answering anyway is how 411 correct imports across
        // fifty public repositories were reported as errors.
        if (surface.incomplete) {
          refusals.push({
            reason: 'incomplete-surface',
            detail:
              `The public re-export graph of ${shown}@${entry.version} could not be fully expanded, ` +
              'so a name missing from it is not necessarily missing from the package.',
          });
          continue;
        }

        if (!canProveAbsence(surface)) {
          refusals.push({
            reason: 'unenumerable-surface',
            detail:
              `${shown}@${entry.version} publishes its API through a single exported value whose members could ` +
              'not be enumerated, so the surface proves the module exists and nothing about what is on it.',
          });
          continue;
        }

        for (const { file, record } of members) {
          const bound = namedBindingsOf(record);
          if (bound.length === 0) continue;

          // Prefer the statement itself. `bindings` conflates a rename with a
          // two-name import, and acting on that conflation would report every
          // local alias as a missing export.
          const source = request.contents?.get(file);
          const exact = source === undefined ? null : externalNamesAt(source, record.line);

          let names: string[];
          if (exact !== null) {
            names = exact;
          } else if (bound.length === 1) {
            // Unambiguous: one binding, no alias possible.
            names = bound;
          } else {
            // Two or more bindings and no source to disambiguate them.
            // Reporting any of these would be a guess, so none is reported and
            // the fact is counted rather than hidden.
            ambiguous += bound.length;
            continue;
          }

          for (const symbol of names) {
            checked += 1;
            if (surfaceExports(surface, symbol)) continue;
            missing.push({
              symbol,
              file,
              line: record.line,
              specifier: record.specifier,
              packageName,
              installedVersion: entry.version,
            });
          }
        }
      }

      // A surface that contradicts most of what the repository imports from it
      // is not evidence about the repository.
      //
      // Real breakage is narrow: a package removes an export or two and a
      // handful of lines stop resolving. A surface read wrongly is broad —
      // every name goes missing at once. Across fifty public repositories the
      // false findings arrived in exactly that shape: 14 of 14 names from
      // `fastify`, 8 of 8 from `chai`, every `graceful-fs` import, every
      // `react-dom` import. Each was a package whose API is plainly intact.
      //
      // So the ratio decides it. Below the threshold a finding stands on its
      // own; at or above it, the reading is the thing in doubt and nothing is
      // reported. This deliberately gives up real findings in packages where
      // almost everything is broken — a rarer event than a surface Drift
      // could not read, and the safer of the two mistakes.
      // A proportion only means something once enough names were checked to
      // form one. Three imports losing two is ordinary breakage — a package
      // dropped a couple of exports and the code has not caught up — and
      // refusing that would give away exactly the findings this exists to
      // make. Fourteen of fourteen is not breakage; no usable package removes
      // its whole API at once. So the ratio is consulted only above a floor
      // where the two cases are actually distinguishable.
      const MOST = 0.5;
      const ENOUGH_TO_JUDGE = 5;
      if (checked >= ENOUGH_TO_JUDGE && missing.length >= Math.ceil(checked * MOST)) {
        return {
          packageName,
          installedVersion: entry.version,
          checked: 0,
          missing: [],
          unchecked: {
            reason: 'surface-disagrees',
            detail:
              `${missing.length} of ${checked} names imported from ${packageName}@${entry.version} are absent from ` +
              'the surface Drift read. A package that had removed that much of its API would be unusable, so the ' +
              'reading is treated as wrong rather than the code.',
          },
        };
      }

      // Nothing was checkable. Report why, preferring the reason that explains
      // the most entry points rather than whichever happened to come first.
      if (checked === 0) {
        if (refusals.length > 0) {
          const tally = new Map<UncheckedReason, number>();
          for (const refusal of refusals) tally.set(refusal.reason, (tally.get(refusal.reason) ?? 0) + 1);
          const [reason] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]!;
          const detail = refusals.find((refusal) => refusal.reason === reason)!.detail;
          return { packageName, installedVersion: entry.version, checked: 0, missing: [], unchecked: { reason, detail } };
        }

        if (ambiguous > 0) {
          return {
            packageName,
            installedVersion: entry.version,
            checked: 0,
            missing: [],
            unchecked: {
              reason: 'ambiguous-bindings',
              detail:
                `Every import of ${packageName} binds more than one name, and without the source line a rename ` +
                'cannot be told from a second export.',
            },
          };
        }
      }

      return { packageName, installedVersion: entry.version, checked, missing };
    }),
  );

  const missing = packages
    .flatMap((outcome) => outcome.missing)
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return {
    packages,
    missing,
    checkedPackages: packages.filter((outcome) => !outcome.unchecked).length,
    uncheckedPackages: packages.filter((outcome) => outcome.unchecked).length,
  };
}

/**
 * Confidence in a missing-import finding.
 *
 * `high` is the only value produced, and only because the gate above already
 * refused every case that would not deserve it: the surface was read, it was
 * complete, the binding is a named import rather than the module object, and
 * the name is absent under both key forms. A finding that survives all of that
 * is not a guess.
 */
export const MISSING_IMPORT_CONFIDENCE: Confidence = 'high';
