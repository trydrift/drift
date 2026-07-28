import type { DependencyKind } from '../../types.js';
import { basename, type DependencyMap, type ManifestParser } from './types.js';
import { parseTomlVersionValue, scanTomlTables } from './toml.js';

export const cargoParser: ManifestParser = {
  ecosystem: 'cargo',
  name: 'cargo',

  handles(path) {
    const base = basename(path);
    return base === 'cargo.toml' || base === 'cargo.lock';
  },

  isLockfile(path) {
    return basename(path) === 'cargo.lock';
  },

  parse(content, path) {
    return basename(path) === 'cargo.lock' ? parseCargoLock(content) : parseCargoToml(content);
  },
};

function parseCargoToml(content: string): DependencyMap {
  const out: DependencyMap = new Map();

  for (const table of scanTomlTables(content)) {
    const kind = kindForHeader(table.header);
    if (kind) {
      // Table form: [dependencies] serde = "1.0"  /  serde = { version = "1.0" }
      for (const [key, value] of table.entries) {
        const version = parseTomlVersionValue(value);
        setIfStronger(out, key, { version, kind });
      }
      continue;
    }

    // Nested form: [dependencies.serde] \n version = "1.0"
    const nested = /^(?:workspace\.)?(dependencies|dev-dependencies|build-dependencies)\.(.+)$/.exec(
      table.header,
    );
    if (nested) {
      const nestedKind = kindForHeader(nested[1]!) ?? 'runtime';
      const raw = table.entries.get('version');
      const version = raw ? parseTomlVersionValue(raw) ?? raw.replace(/^["']|["']$/g, '') : null;
      setIfStronger(out, nested[2]!, { version, kind: nestedKind });
    }
  }

  return out;
}

function kindForHeader(header: string): DependencyKind | null {
  const normalized = header.replace(/^workspace\./, '').replace(/^target\.[^.]+\./, '');
  if (normalized === 'dependencies') return 'runtime';
  if (normalized === 'dev-dependencies') return 'dev';
  if (normalized === 'build-dependencies') return 'dev';
  return null;
}

/** Runtime declarations take precedence over dev/build ones for the same crate. */
function setIfStronger(
  map: DependencyMap,
  name: string,
  entry: { version: string | null; kind: DependencyKind },
): void {
  const existing = map.get(name);
  if (existing && existing.kind === 'runtime' && entry.kind !== 'runtime') return;
  map.set(name, entry);
}

function parseCargoLock(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  for (const table of scanTomlTables(content)) {
    if (table.header !== 'package') continue;
    const name = table.entries.get('name')?.replace(/^["']|["']$/g, '');
    const version = table.entries.get('version')?.replace(/^["']|["']$/g, '');
    if (name && version) out.set(name, { version, kind: 'transitive' });
  }
  return out;
}
