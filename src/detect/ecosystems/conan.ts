import type { DependencyKind } from '../../types.js';
import { basename, tryJson, type DependencyMap, type ManifestParser } from './types.js';

/**
 * Conan — the C and C++ package manager with a central index.
 *
 * A Conan requirement is one string, `name/version`, optionally carrying a
 * user/channel (`zlib/1.3.1@company/stable`) and, in a lockfile, a recipe
 * revision (`zlib/1.3.1#5c0f3a1...`). Everything after the version is identity,
 * not version, so it is stripped: a revision moving with no version change is
 * the same dependency at the same version, and reporting it as a bump would
 * fire on every `conan lock create`.
 *
 * Two manifest shapes exist and both are common. `conanfile.txt` is an INI
 * file, which is read exactly. `conanfile.py` is a Python class, which is not —
 * Drift reads the literal `requires` declarations that nearly every real recipe
 * contains and does not attempt to evaluate Python. A version computed at
 * recipe-evaluation time is invisible, and the capability matrix says so.
 */
export const conanParser: ManifestParser = {
  ecosystem: 'conan',
  name: 'conan',

  handles(path) {
    const base = basename(path);
    return base === 'conanfile.txt' || base === 'conanfile.py' || base === 'conan.lock';
  },

  isLockfile(path) {
    return basename(path) === 'conan.lock';
  },

  parse(content, path) {
    const base = basename(path);
    if (base === 'conan.lock') return parseConanLock(content);
    if (base === 'conanfile.py') return parseConanfilePy(content);
    return parseConanfileTxt(content);
  },
};

/** `[requires]` / `[tool_requires]` / `[test_requires]`, one reference per line. */
function parseConanfileTxt(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  let kind: DependencyKind | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.split('#')[0]!.trim();
    if (!line) continue;

    const section = /^\[([\w_]+)\]$/.exec(line);
    if (section) {
      kind = kindForSection(section[1]!);
      continue;
    }

    if (!kind) continue;
    add(out, line, kind);
  }

  return out;
}

/**
 * `conanfile.py`, read as text.
 *
 * Covers the three forms the Conan docs teach: the class attribute
 * (`requires = "zlib/1.3.1"`, single or tuple), the method call
 * (`self.requires("zlib/1.3.1")`), and their `tool_requires` /
 * `test_requires` siblings. A reference built by string concatenation is not
 * matched, and is not guessed at either.
 */
function parseConanfilePy(content: string): DependencyMap {
  const out: DependencyMap = new Map();

  const calls = /\bself\.(requires|tool_requires|build_requires|test_requires)\s*\(\s*(["'])([^"']+)\2/g;
  for (const match of content.matchAll(calls)) {
    add(out, match[3]!, kindForSection(match[1]!) ?? 'runtime');
  }

  const attributes = /^\s*(requires|tool_requires|build_requires|test_requires)\s*=\s*(.+)$/gm;
  for (const match of content.matchAll(attributes)) {
    const kind = kindForSection(match[1]!) ?? 'runtime';
    for (const literal of match[2]!.matchAll(/(["'])([^"']+)\1/g)) {
      add(out, literal[2]!, kind);
    }
  }

  return out;
}

/**
 * `conan.lock` — a JSON document whose `requires` array holds full references.
 *
 * Both lockfile generations are read: Conan 2 nests the arrays at the root,
 * Conan 1 put them under `graph_lock.nodes[*].ref`. A repository mid-migration
 * has one of each, and refusing to read the older one would report a project
 * as having no dependencies at all.
 */
function parseConanLock(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const doc = tryJson<{
    requires?: string[];
    build_requires?: string[];
    python_requires?: string[];
    graph_lock?: { nodes?: Record<string, { ref?: string }> };
  }>(content);
  if (!doc) return out;

  for (const reference of doc.requires ?? []) add(out, reference, 'transitive');
  for (const reference of doc.build_requires ?? []) add(out, reference, 'dev');
  for (const node of Object.values(doc.graph_lock?.nodes ?? {})) {
    if (node.ref) add(out, node.ref, 'transitive');
  }

  return out;
}

function kindForSection(section: string): DependencyKind | null {
  switch (section.toLowerCase()) {
    case 'requires':
      return 'runtime';
    case 'tool_requires':
    case 'build_requires':
    case 'test_requires':
      return 'dev';
    default:
      return null;
  }
}

/**
 * Split one Conan reference into a name and a version.
 *
 * Version ranges are written `zlib/[>=1.2 <2]`, and the brackets are kept
 * verbatim as the raw range — normalisation is `detect/version.ts`'s job, and
 * a parser that quietly resolves a range to a point version would report a
 * bump that never happened.
 */
function add(map: DependencyMap, reference: string, kind: DependencyKind): void {
  const parsed = parseConanReference(reference);
  if (!parsed) return;

  const existing = map.get(parsed.name);
  if (existing && existing.kind === 'runtime' && kind !== 'runtime') return;
  map.set(parsed.name, { version: parsed.version, kind });
}

export function parseConanReference(reference: string): { name: string; version: string | null } | null {
  // Strip the recipe revision (`#rev`) and the package id (`:id`) — identity,
  // not version — then the user/channel, which Conan 2 keeps for compatibility.
  const withoutRevision = reference.split('#')[0]!.split(':')[0]!.trim();
  const withoutChannel = withoutRevision.split('@')[0]!.trim();
  if (!withoutChannel) return null;

  const slash = withoutChannel.indexOf('/');
  if (slash === -1) return { name: withoutChannel, version: null };

  const name = withoutChannel.slice(0, slash).trim();
  const version = withoutChannel.slice(slash + 1).trim();
  if (!name) return null;
  return { name, version: version || null };
}
