import type { DependencyKind } from '../../types.js';
import { basename, type DependencyMap, type ManifestParser } from './types.js';
import { findTable, parseTomlArray, parseTomlVersionValue, scanTomlTables } from './toml.js';
import { isCompiledPythonRequirements, isPythonRequirementsFile } from '../python-requirements.js';

const LOCKFILES = new Set(['poetry.lock', 'pipfile.lock', 'uv.lock', 'requirements.lock']);

export const pythonParser: ManifestParser = {
  ecosystem: 'pypi',
  name: 'pip/poetry/uv',

  handles(path) {
    const base = basename(path);
    if (path.includes('site-packages/') || path.includes('.venv/')) return false;
    return (
      base === 'pyproject.toml' ||
      base === 'setup.py' ||
      base === 'pipfile' ||
      LOCKFILES.has(base) ||
      isPythonRequirementsFile(base)
    );
  },

  isLockfile(path) {
    return LOCKFILES.has(basename(path));
  },

  parse(content, path) {
    const base = basename(path);
    if (base === 'pyproject.toml') return parsePyproject(content);
    if (base === 'poetry.lock' || base === 'uv.lock') return parsePoetryLock(content);
    if (base === 'pipfile') return parsePipfile(content);
    if (base === 'setup.py') return parseSetupPy(content);
    return parseRequirements(content);
  },
};

/**
 * PEP 508 requirement strings: `name[extra] >=1.0,<2.0 ; python_version<"3.9"`.
 * We keep the full specifier as the version so downgrades and pins survive.
 */
export function parseRequirementLine(line: string): { name: string; version: string | null } | null {
  let s = line.trim();
  if (!s || s.startsWith('#')) return null;

  // Skip pip directives (-r, -e, --index-url) and direct URLs.
  if (s.startsWith('-') || /^[a-z+]+:\/\//i.test(s)) return null;

  // Drop environment markers.
  s = s.split(';')[0]!.trim();
  // Compilers may put provenance on the requirement line itself.
  s = s.replace(/\s+#.*$/, '').trim();

  // `name @ https://...` direct references have no comparable version.
  if (/\s@\s/.test(s)) {
    const name = s.split('@')[0]!.trim();
    return name ? { name: normalizePyName(name), version: null } : null;
  }

  const match = /^([A-Za-z0-9._-]+)\s*(\[[^\]]*\])?\s*(.*)$/.exec(s);
  if (!match) return null;

  const name = normalizePyName(match[1]!);
  const spec = (match[3] ?? '').trim();
  return { name, version: spec || null };
}

/** PEP 503 normalisation, so `Flask_SQLAlchemy` and `flask-sqlalchemy` unify. */
export function normalizePyName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

function parseRequirements(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const lines = content.split('\n');
  const compiled = isCompiledPythonRequirements(content);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const parsed = parseRequirementLine(line);
    if (!parsed) continue;

    let provenance = line;
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const next = lines[cursor]!;
      if (!/^\s*#/.test(next)) break;
      provenance += `\n${next}`;
      index = cursor;
    }

    // Compilers identify source declarations with `# via -r requirements.in`.
    // Every other pin is part of the resolved graph, including pins whose
    // provenance is absent or ambiguous; uncertainty must not promote them.
    const directFromInput = /#\s*via\s+(?:-r|--requirement)\s+\S+\.in\b/i.test(provenance);
    out.set(parsed.name, {
      version: parsed.version,
      kind: compiled && !directFromInput ? 'transitive' : 'runtime',
    });
  }
  return out;
}

function parsePyproject(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const tables = scanTomlTables(content);

  // PEP 621: [project] dependencies = ["flask>=2.0"]
  const project = findTable(tables, 'project');
  const projectDeps = project?.entries.get('dependencies');
  if (projectDeps) {
    for (const req of parseTomlArray(projectDeps)) {
      const parsed = parseRequirementLine(req);
      if (parsed) out.set(parsed.name, { version: parsed.version, kind: 'runtime' });
    }
  }

  // PEP 621 optional groups.
  for (const table of tables) {
    if (table.header !== 'project.optional-dependencies') continue;
    for (const value of table.entries.values()) {
      for (const req of parseTomlArray(value)) {
        const parsed = parseRequirementLine(req);
        if (parsed && !out.has(parsed.name)) {
          out.set(parsed.name, { version: parsed.version, kind: 'optional' });
        }
      }
    }
  }

  // Poetry: [tool.poetry.dependencies] flask = "^2.0"
  for (const table of tables) {
    const isPoetryRuntime = table.header === 'tool.poetry.dependencies';
    const isPoetryDev =
      table.header === 'tool.poetry.dev-dependencies' ||
      /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(table.header);
    if (!isPoetryRuntime && !isPoetryDev) continue;

    for (const [key, value] of table.entries) {
      // Poetry declares the interpreter constraint here; it isn't a package.
      if (key === 'python') continue;
      const name = normalizePyName(key);
      const version = parseTomlVersionValue(value);
      const kind: DependencyKind = isPoetryDev ? 'dev' : 'runtime';
      if (!out.has(name) || !isPoetryDev) out.set(name, { version, kind });
    }
  }

  return out;
}

function parsePoetryLock(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  for (const table of scanTomlTables(content)) {
    if (table.header !== 'package') continue;
    const name = table.entries.get('name');
    const version = table.entries.get('version');
    if (!name || !version) continue;
    out.set(normalizePyName(unquoteValue(name)), {
      version: unquoteValue(version),
      kind: 'transitive',
    });
  }
  return out;
}

function parsePipfile(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  for (const table of scanTomlTables(content)) {
    const kind: DependencyKind | null =
      table.header === 'packages' ? 'runtime' : table.header === 'dev-packages' ? 'dev' : null;
    if (!kind) continue;
    for (const [key, value] of table.entries) {
      const version = parseTomlVersionValue(value);
      out.set(normalizePyName(key), { version: version === '*' ? null : version, kind });
    }
  }
  return out;
}

/** Best-effort scrape of `install_requires=[...]` from a setup.py literal. */
function parseSetupPy(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const block = /install_requires\s*=\s*\[([\s\S]*?)\]/.exec(content)?.[1];
  if (!block) return out;
  for (const match of block.matchAll(/["']([^"']+)["']/g)) {
    const parsed = parseRequirementLine(match[1]!);
    if (parsed) out.set(parsed.name, { version: parsed.version, kind: 'runtime' });
  }
  return out;
}

function unquoteValue(s: string): string {
  return s.trim().replace(/^["']|["']$/g, '');
}
