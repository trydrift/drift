import type { DependencyKind } from '../../types.js';
import { basename, type DependencyMap, type ManifestParser } from './types.js';

/**
 * Arduino and PlatformIO — the embedded C++ world.
 *
 * Two manifests, one registry. A library published to the Arduino Library
 * Manager ships a `library.properties` whose `depends=` field names the
 * libraries it needs; a PlatformIO project declares the same libraries in
 * `platformio.ini`'s `lib_deps`. They are the same ecosystem in every sense
 * Drift cares about — the same libraries, the same header-include graph, the
 * same versions — so they share one parser and one ecosystem name.
 *
 * Neither format has a lockfile. PlatformIO resolves `lib_deps` on every build
 * and records what it chose in `.pio/`, which is build output rather than a
 * committed record of intent, so it is not read.
 */
export const arduinoParser: ManifestParser = {
  ecosystem: 'arduino',
  name: 'arduino',

  handles(path) {
    const base = basename(path);
    return base === 'library.properties' || base === 'platformio.ini';
  },

  isLockfile() {
    return false;
  },

  parse(content, path) {
    return basename(path) === 'platformio.ini'
      ? parsePlatformIO(content)
      : parseLibraryProperties(content);
  },
};

/**
 * `depends=ArduinoJson (>=6.0.0), Adafruit GFX Library, WiFi (^1.2.7)`
 *
 * Arduino library names contain spaces — "Adafruit GFX Library" is one
 * dependency, not three — so the split is on commas and nothing else. The
 * version constraint is parenthesised and optional; most declarations have
 * none at all, which is a real fact about the ecosystem and is recorded as a
 * null version rather than invented.
 */
function parseLibraryProperties(content: string): DependencyMap {
  const out: DependencyMap = new Map();

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;

    const match = /^depends\s*=\s*(.*)$/i.exec(line);
    if (!match) continue;

    for (const entry of match[1]!.split(',')) {
      const parsed = parseArduinoDependency(entry);
      if (parsed) out.set(parsed.name, { version: parsed.version, kind: 'runtime' });
    }
  }

  return out;
}

/** `Name (>=1.2.3)` — the constraint is kept verbatim, brackets stripped. */
function parseArduinoDependency(entry: string): { name: string; version: string | null } | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;

  const withConstraint = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(trimmed);
  if (withConstraint) {
    const name = withConstraint[1]!.trim();
    const version = withConstraint[2]!.trim();
    return name ? { name, version: version || null } : null;
  }

  return { name: trimmed, version: null };
}

/**
 * `platformio.ini` — an INI file whose `lib_deps` is a multi-line list.
 *
 * Every documented spec form appears in real projects and all of them are
 * read:
 *
 *   ArduinoJson                     no constraint
 *   ArduinoJson@^6.19.4             owner-less, with a constraint
 *   bblanchon/ArduinoJson@6.19.4    the registry's canonical form
 *   Wire                            a framework library, no registry entry
 *   https://github.com/x/y.git      a VCS source
 *
 * The VCS form is deliberately skipped rather than half-parsed. There is no
 * registry version list behind a bare git URL, so a Drift entry for one could
 * only ever say "no versions available" — which reads as a broken lookup
 * rather than as the design of the thing being looked at.
 *
 * `lib_deps` under `[env:*]` sections is a build dependency of that
 * environment; the values are unioned, because a library that any environment
 * needs is a library this project depends on.
 */
function parsePlatformIO(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const lines = content.split('\n');

  let inLibDeps = false;
  for (const rawLine of lines) {
    const withoutComment = rawLine.split(/\s+[;#]/)[0]!;
    const line = withoutComment.trim();

    if (/^\[/.test(line)) {
      inLibDeps = false;
      continue;
    }

    // `lib_deps_base`, `lib_deps_external`, and friends are user-defined
    // variables under `[common]` that a real `lib_deps` then interpolates.
    // They are not PlatformIO keys, but they are where large projects — ESPHome
    // among them — actually keep their dependency list, and reading only the
    // literal `lib_deps` would find a project's libraries missing.
    const assignment = /^(lib_deps[\w.]*|lib_extra_dirs|lib_ignore)\s*=\s*(.*)$/.exec(line);
    if (assignment) {
      inLibDeps = assignment[1]!.startsWith('lib_deps');
      if (inLibDeps && assignment[2]) addPlatformIODependency(out, assignment[2]!, 'runtime');
      continue;
    }

    // A continuation line: indented, and part of the previous assignment.
    const isContinuation = inLibDeps && /^\s/.test(withoutComment) && line !== '';
    if (isContinuation) {
      addPlatformIODependency(out, line, 'runtime');
      continue;
    }

    if (line !== '') inLibDeps = false;
  }

  return out;
}

function addPlatformIODependency(map: DependencyMap, spec: string, kind: DependencyKind): void {
  const trimmed = spec.trim();
  if (!trimmed) return;
  // A URL, a local path, or a git ref — no registry behind any of them.
  if (/^[a-z+]+:\/\//i.test(trimmed) || trimmed.startsWith('file://') || trimmed.startsWith('.')) return;
  // `${common.lib_deps_base}` is an interpolation of another variable, whose
  // own entries are read where they are declared.
  if (trimmed.includes('${')) return;
  if (/\.(git|zip|tar\.gz)$/i.test(trimmed)) return;

  // `owner/Name@^6.19.4` — the owner disambiguates forks in the registry but is
  // not part of the library's identity, and `library.properties` never carries
  // one. Dropping it is what lets the same library declared in both manifests
  // be recognised as one dependency.
  const at = trimmed.lastIndexOf('@');
  const hasConstraint = at > 0;
  const nameWithOwner = hasConstraint ? trimmed.slice(0, at) : trimmed;
  const version = hasConstraint ? trimmed.slice(at + 1).trim() : null;

  const slash = nameWithOwner.lastIndexOf('/');
  const name = (slash === -1 ? nameWithOwner : nameWithOwner.slice(slash + 1)).trim();
  if (!name) return;

  map.set(name, { version: version || null, kind });
}
