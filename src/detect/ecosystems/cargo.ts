import type { DependencyKind } from '../../types.js';
import {
  basename,
  type CargoDependencyPlacement,
  type CargoDependencySection,
  type DependencyMap,
  type ManifestParser,
} from './types.js';
import { parseTomlVersionValue, scanTomlTables, unquote } from './toml.js';

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
    const placement = placementForHeader(table.header);
    if (placement && !placement.name) {
      // Table form: [dependencies] serde = "1.0"  /  serde = { version = "1.0" }
      for (const [key, value] of table.entries) {
        const version = parseTomlVersionValue(value);
        setIfStronger(out, key, entryForPlacement(version, placement));
      }
      continue;
    }

    // Nested form: [dependencies.serde] \n version = "1.0"
    if (placement?.name) {
      const raw = table.entries.get('version');
      const version = raw ? parseTomlVersionValue(raw) ?? raw.replace(/^["']|["']$/g, '') : null;
      setIfStronger(out, placement.name, entryForPlacement(version, placement));
    }
  }

  return out;
}

type CargoDependencyLocation = CargoDependencyPlacement & { name?: string };

function entryForPlacement(
  version: string | null,
  placement: CargoDependencyLocation,
): { version: string | null; kind: DependencyKind; cargo: CargoDependencyPlacement } {
  const cargo: CargoDependencyPlacement = {
    section: placement.section,
    ...(placement.target ? { target: placement.target } : {}),
  };
  return {
    version,
    kind: kindForSection(placement.section),
    cargo,
  };
}

function kindForSection(section: CargoDependencySection): DependencyKind {
  return section === 'dependencies' ? 'runtime' : 'dev';
}

function placementForHeader(header: string): CargoDependencyLocation | null {
  const parts = splitDottedHeader(header);
  if (parts[0] === 'workspace') parts.shift();

  if (isCargoDependencySection(parts[0])) {
    return parts.length === 1
      ? { section: parts[0] }
      : parts.length === 2
        ? { section: parts[0], name: parts[1] }
        : null;
  }

  if (parts[0] !== 'target' || parts.length < 3) return null;
  const target = parts[1];
  const section = parts[2];
  if (!target || !isCargoDependencySection(section)) return null;

  return parts.length === 3
    ? { section, target }
    : parts.length === 4
      ? { section, target, name: parts[3] }
      : null;
}

function isCargoDependencySection(value: string | undefined): value is CargoDependencySection {
  return value === 'dependencies' || value === 'dev-dependencies' || value === 'build-dependencies';
}

function splitDottedHeader(header: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < header.length; i++) {
    const ch = header[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '.' && !inSingle && !inDouble) {
      parts.push(unquote(header.slice(start, i).trim()));
      start = i + 1;
    }
  }

  parts.push(unquote(header.slice(start).trim()));
  return parts.filter(Boolean);
}

/** Runtime declarations take precedence over dev/build ones for the same crate. */
function setIfStronger(
  map: DependencyMap,
  name: string,
  entry: { version: string | null; kind: DependencyKind; cargo?: CargoDependencyPlacement },
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
