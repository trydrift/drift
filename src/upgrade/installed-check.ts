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
  const suffix = `#${name}`;
  for (const key of surface.api.keys()) if (key.endsWith(suffix)) return true;
  return false;
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
  /** Injected for tests. Defaults to the real npm type-surface fetch. */
  fetchSurface?: (name: string, version: string) => Promise<TypeSurface | null>;
}

/**
 * Check every imported name against the surface of the version installed.
 *
 * Packages are checked concurrently because each is an independent network
 * fetch, and the surface cache in `type-surface.ts` already collapses repeated
 * work across them.
 */
export async function checkInstalled(request: InstalledCheckRequest): Promise<InstalledCheckResult> {
  const fetch = request.fetchSurface ?? ((name, version) => fetchTypeSurface(name, version));

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

      let surface: TypeSurface | null = null;
      try {
        surface = await fetch(packageName, entry.version);
      } catch {
        surface = null;
      }

      if (!surface) {
        return {
          packageName,
          installedVersion: entry.version,
          checked: 0,
          missing: [],
          unchecked: {
            reason: 'no-surface',
            detail: `No type declarations were readable for ${packageName}@${entry.version}, so what it exports could not be established.`,
          },
        };
      }

      // The load-bearing refusal. An incompletely expanded surface cannot
      // support "this name does not exist" for anything.
      if (surface.incomplete) {
        return {
          packageName,
          installedVersion: entry.version,
          checked: 0,
          missing: [],
          unchecked: {
            reason: 'incomplete-surface',
            detail:
              `The public re-export graph of ${packageName}@${entry.version} could not be fully expanded, ` +
              'so a name missing from it is not necessarily missing from the package.',
          },
        };
      }

      const missing: MissingImport[] = [];
      let checked = 0;
      let ambiguous = 0;
      for (const { file, record } of imports) {
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
          // Two or more bindings and no source to disambiguate them. Reporting
          // any of these would be a guess, so none is reported and the fact is
          // counted rather than hidden.
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

      if (checked === 0 && ambiguous > 0) {
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
