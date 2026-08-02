import type { DependencyKind } from '../../types.js';
import { basename, type DependencyMap, type ManifestParser } from './types.js';

/**
 * Dart and Flutter — `pubspec.yaml` and `pubspec.lock`.
 *
 * Flutter is not a separate ecosystem: a Flutter app is a Dart package whose
 * pubspec happens to depend on the `flutter` SDK. The same parser serves both,
 * and the SDK-sourced entries are deliberately dropped (see `versionOf`)
 * because "flutter: sdk: flutter" pins nothing Drift could ever upgrade.
 *
 * The YAML here is scanned rather than parsed. Pubspecs are shallow, regular,
 * and two levels deep in practice, and taking on a YAML dependency to read them
 * would cost more than it returns. Anything the scanner does not understand is
 * simply not reported — which degrades to "Drift saw no change", never to a
 * wrong version.
 */
export const pubParser: ManifestParser = {
  ecosystem: 'pub',
  name: 'pub',

  handles(path) {
    const base = basename(path);
    return base === 'pubspec.yaml' || base === 'pubspec.yml' || base === 'pubspec.lock';
  },

  isLockfile(path) {
    return basename(path) === 'pubspec.lock';
  },

  parse(content, path) {
    return basename(path) === 'pubspec.lock' ? parsePubspecLock(content) : parsePubspec(content);
  },
};

/** Top-level pubspec sections that hold dependencies, and what they mean. */
const SECTIONS: Record<string, DependencyKind> = {
  dependencies: 'runtime',
  dev_dependencies: 'dev',
  dependency_overrides: 'runtime',
};

function parsePubspec(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  let kind: DependencyKind | null = null;
  /** Indentation of the entries inside the current section. */
  let entryIndent: number | null = null;

  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replace(/\r$/, '');
    const line = stripComment(raw);
    if (!line.trim()) continue;

    const indent = line.length - line.trimStart().length;

    // A key at column zero either opens a dependency section or closes one.
    if (indent === 0) {
      const key = /^([A-Za-z_][\w-]*):/.exec(line.trim())?.[1];
      kind = key && key in SECTIONS ? SECTIONS[key]! : null;
      entryIndent = null;
      continue;
    }
    if (!kind) continue;

    const entry = /^\s*([A-Za-z_][\w.-]*)\s*:(.*)$/.exec(line);
    if (!entry) continue;

    // The first indented key sets the section's entry depth. Anything deeper is
    // that dependency's own configuration (`git:`, `path:`, `hosted:`), not a
    // sibling dependency — without this, `url:` under a `hosted:` block would
    // be reported as a package named "url".
    if (entryIndent === null) entryIndent = indent;
    if (indent > entryIndent) continue;
    if (indent < entryIndent) {
      kind = null;
      continue;
    }

    const name = entry[1]!;
    const inline = entry[2]!.trim();

    out.set(name, { version: versionOf(inline, lines, i, indent), kind });
  }

  return out;
}

/**
 * The version a pubspec entry pins, or `null` when it pins none.
 *
 * `null` is the right answer for more cases than it looks: an SDK dependency,
 * a git or path source, and a bare `foo:` with no constraint all resolve to
 * "no version Drift can compare", and reporting any of them as a version would
 * invent a change that never happened.
 */
function versionOf(inline: string, lines: readonly string[], index: number, indent: number): string | null {
  if (inline && inline !== '|' && inline !== '>') return unquote(inline);

  // A block-form entry: read its immediate children looking for `version:`. A
  // `sdk:`, `git:`, or `path:` child means there is no comparable version.
  for (let i = index + 1; i < lines.length; i++) {
    const line = stripComment(lines[i]!.replace(/\r$/, ''));
    if (!line.trim()) continue;

    const childIndent = line.length - line.trimStart().length;
    if (childIndent <= indent) break;

    const child = /^\s*([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (!child) continue;

    const key = child[1]!;
    if (key === 'sdk' || key === 'git' || key === 'path') return null;
    if (key === 'version') return unquote(child[2]!.trim()) || null;
  }

  return null;
}

/**
 * `pubspec.lock` resolved versions.
 *
 * The lock records `dependency: "direct main"` / `"direct dev"` /
 * `"transitive"` per package, which is better provenance than most lockfiles
 * offer — so unlike the generic lockfile default, these entries carry their
 * real kind rather than all being flattened to transitive.
 */
function parsePubspecLock(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const lines = content.split('\n');

  let inPackages = false;
  let name: string | null = null;
  let version: string | null = null;
  let kind: DependencyKind = 'transitive';

  const flush = () => {
    if (name && version) out.set(name, { version, kind });
    name = null;
    version = null;
    kind = 'transitive';
  };

  for (const raw of lines) {
    const line = stripComment(raw.replace(/\r$/, ''));
    if (!line.trim()) continue;

    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      flush();
      inPackages = /^packages\s*:/.test(line.trim());
      continue;
    }
    if (!inPackages) continue;

    // Two-space indent names a package; anything deeper describes it.
    if (indent === 2) {
      flush();
      name = /^\s*"?([A-Za-z_][\w.-]*)"?\s*:/.exec(line)?.[1] ?? null;
      continue;
    }
    if (!name) continue;

    const field = /^\s*([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (!field) continue;

    if (field[1] === 'version') version = unquote(field[2]!.trim()) || null;
    else if (field[1] === 'dependency') {
      const value = unquote(field[2]!.trim());
      kind = value.startsWith('direct dev') ? 'dev' : value.startsWith('direct') ? 'runtime' : 'transitive';
    }
  }

  flush();
  return out;
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    // Only a `#` that starts a token is a comment: `^1.2.3#build` is not.
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '').trim();
}
